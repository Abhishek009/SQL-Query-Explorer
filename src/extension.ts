import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

const LEGACY_PASSWORD_KEY = 'trino.connection.password';
const ACTIVE_CONNECTION_KEY = 'trino.activeConnection';

function passwordKey(id: string): string { return `trino.connection.password.${id}`; }

interface StoredConnection {
    id: string;
    name: string;
    url: string;
    user: string;
    catalog?: string;
    schema?: string;
}

interface TrinoPage {
    id?: string;
    nextUri?: string;
    columns?: Array<{ name: string }>;
    data?: unknown[][];
    error?: { message: string; errorName?: string };
}

interface TrinoQueryResult {
    columns: string[];
    rows: unknown[][];
}

/**
 * Saved connections live in the `trino.connections` setting; each password is
 * kept in Secret Storage under a key derived from the connection id.
 */
class ConnectionStore {
    private readonly changed = new vscode.EventEmitter<void>();
    public readonly onDidChange = this.changed.event;

    public constructor(private readonly context: vscode.ExtensionContext) {}

    public all(): StoredConnection[] {
        const stored = vscode.workspace.getConfiguration('trino').get<StoredConnection[]>('connections') ?? [];
        return stored.filter(connection => connection && connection.id && connection.url);
    }

    public get(id: string | undefined): StoredConnection | undefined {
        return id ? this.all().find(connection => connection.id === id) : undefined;
    }

    public get activeId(): string | undefined {
        return this.context.globalState.get<string>(ACTIVE_CONNECTION_KEY);
    }

    public async setActive(id: string | undefined): Promise<void> {
        await this.context.globalState.update(ACTIVE_CONNECTION_KEY, id);
        this.changed.fire();
    }

    public async save(connection: StoredConnection): Promise<void> {
        const connections = this.all();
        const index = connections.findIndex(existing => existing.id === connection.id);
        if (index >= 0) { connections[index] = connection; } else { connections.push(connection); }
        await this.write(connections);
    }

    public async remove(id: string): Promise<void> {
        await this.write(this.all().filter(connection => connection.id !== id));
        await this.context.secrets.delete(passwordKey(id));
        if (this.activeId === id) { await this.setActive(undefined); }
    }

    /** Moves a pre-multi-connection `trino.connection.*` setup into the list. */
    public async migrateLegacyConnection(): Promise<void> {
        if (this.all().length) { return; }
        const legacy = vscode.workspace.getConfiguration('trino.connection');
        const url = String(legacy.get('url') ?? '').trim();
        const user = String(legacy.get('user') ?? '').trim();
        if (!url || !user) { return; }
        const id = randomUUID();
        await this.save({
            id,
            name: String(legacy.get('name') ?? '').trim() || 'Trino Connection',
            url,
            user,
            catalog: String(legacy.get('catalog') ?? '').trim() || undefined,
            schema: String(legacy.get('schema') ?? '').trim() || undefined
        });
        const password = await this.context.secrets.get(LEGACY_PASSWORD_KEY);
        if (password) {
            await this.context.secrets.store(passwordKey(id), password);
            await this.context.secrets.delete(LEGACY_PASSWORD_KEY);
        }
        await this.setActive(id);
    }

    private async write(connections: StoredConnection[]): Promise<void> {
        await vscode.workspace.getConfiguration('trino').update('connections', connections, vscode.ConfigurationTarget.Global);
        this.changed.fire();
    }
}

class TrinoClient {
    public constructor(private readonly secrets: vscode.SecretStorage, private readonly connection: StoredConnection) {}

    public async catalogs(token?: vscode.CancellationToken): Promise<string[]> {
        return firstColumn(await this.query('SHOW CATALOGS', token));
    }

    public async schemas(catalog: string): Promise<string[]> {
        return firstColumn(await this.query(`SHOW SCHEMAS FROM ${quoteIdentifier(catalog)}`));
    }

    public async tables(catalog: string, schema: string): Promise<string[]> {
        return firstColumn(await this.query(`SHOW TABLES FROM ${quoteIdentifier(catalog)}.${quoteIdentifier(schema)}`));
    }

    public async query(statement: string, token?: vscode.CancellationToken): Promise<TrinoQueryResult> {
        const normalizedStatement = statement.trim().replace(/;+$/, '');
        if (!normalizedStatement) { throw new Error('Enter a SQL statement before running it.'); }
        const page = await this.runStatement(normalizedStatement, token);
        return { columns: (page.columns ?? []).map(column => column.name), rows: page.data ?? [] };
    }

    private async runStatement(statement: string, token?: vscode.CancellationToken): Promise<TrinoPage> {
        const { url: rawUrl, user, catalog, schema } = this.connection;
        if (!rawUrl || !user) { throw new Error('Configure the Trino URL and user before connecting.'); }
        const baseUrl = httpBaseUrl(rawUrl);
        if (!baseUrl) {
            throw new Error(`Could not read the Trino URL "${rawUrl}". Use http(s)://host:port or jdbc:trino://host:port.`);
        }

        const password = await this.secrets.get(passwordKey(this.connection.id));
        const headers: Record<string, string> = {
            'X-Trino-User': user,
            'Content-Type': 'text/plain'
        };
        if (catalog) { headers['X-Trino-Catalog'] = catalog; }
        if (schema) { headers['X-Trino-Schema'] = schema; }
        if (password) {
            headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
        }

        let response = await this.request(`${baseUrl}/v1/statement`, {
            method: 'POST', headers, body: statement, signal: token
        });
        let page = await this.readPage(response);
        const rows = [...(page.data ?? [])];
        let columns = page.columns;
        while (page.nextUri && !page.error) {
            response = await this.request(page.nextUri, { method: 'GET', headers, signal: token });
            page = await this.readPage(response);
            rows.push(...(page.data ?? []));
            columns ??= page.columns;
        }
        if (page.error) {
            throw new Error(page.error.message || page.error.errorName || 'Trino returned an error.');
        }
        return { ...page, columns, data: rows };
    }

    private async request(url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: vscode.CancellationToken }): Promise<Response> {
        const controller = new AbortController();
        const cancellation = init.signal?.onCancellationRequested(() => controller.abort());
        try {
            return await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: controller.signal });
        } catch (error) {
            if (controller.signal.aborted) { throw new Error('Trino request was cancelled.'); }
            throw error;
        } finally {
            cancellation?.dispose();
        }
    }

    private async readPage(response: Response): Promise<TrinoPage> {
        if (!response.ok) {
            const details = await response.text();
            if (/plain HTTP request was sent to HTTPS port/i.test(details)) {
                throw new Error('The coordinator expects HTTPS on this port. Turn on "Enable SSL / HTTPS" in the connection window, or add ?SSL=true to the JDBC URL.');
            }
            throw new Error(`Trino request failed (${response.status}): ${summarize(details) || response.statusText}`);
        }
        return response.json() as Promise<TrinoPage>;
    }
}

function firstColumn(result: TrinoQueryResult): string[] {
    return result.rows
        .map((row) => String(row[0] ?? ''))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
}

/** Proxies answer with HTML error pages; show their text instead of the markup. */
function summarize(body: string): string {
    const text = /<html/i.test(body)
        ? (/<title>([^<]+)<\/title>/i.exec(body)?.[1] ?? body.replace(/<[^>]*>/g, ' '))
        : body;
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

type ExplorerNodeKind = 'connection' | 'catalog' | 'schema' | 'table' | 'empty';

class TrinoExplorerProvider implements vscode.TreeDataProvider<ExplorerItem> {
    private readonly changed = new vscode.EventEmitter<ExplorerItem | undefined>();
    public readonly onDidChangeTreeData = this.changed.event;
    private readonly catalogsByConnection = new Map<string, string[]>();

    public constructor(private readonly store: ConnectionStore, private readonly secrets: vscode.SecretStorage) {}

    public getTreeItem(item: ExplorerItem): vscode.TreeItem { return item; }

    public async getChildren(element?: ExplorerItem): Promise<ExplorerItem[]> {
        if (!element) {
            const connections = this.store.all();
            if (!connections.length) { return [ExplorerItem.empty()]; }
            return connections.map(connection => ExplorerItem.connection(
                connection,
                this.catalogsByConnection.has(connection.id),
                this.store.activeId === connection.id
            ));
        }

        const connection = this.store.get(element.connectionId);
        if (!connection) { return []; }
        const client = new TrinoClient(this.secrets, connection);
        try {
            if (element.kind === 'connection') {
                const catalogs = this.catalogsByConnection.get(connection.id) ?? await this.loadCatalogs(client, connection);
                return catalogs.map(catalog => ExplorerItem.catalog(connection.id, catalog));
            }
            if (element.kind === 'catalog' && element.catalog) {
                const schemas = await client.schemas(element.catalog);
                return schemas.map(schema => ExplorerItem.schema(connection.id, element.catalog!, schema));
            }
            if (element.kind === 'schema' && element.catalog && element.schema) {
                const tables = await client.tables(element.catalog, element.schema);
                return tables.map(table => ExplorerItem.table(connection.id, element.catalog!, element.schema!, table));
            }
        } catch (error) {
            showConnectionError(error);
        }
        return [];
    }

    /** Loads and caches a connection's catalogs, marking it connected in the tree. */
    public async connect(connection: StoredConnection): Promise<void> {
        const client = new TrinoClient(this.secrets, connection);
        await this.loadCatalogs(client, connection);
        await this.store.setActive(connection.id);
    }

    public forget(id?: string): void {
        if (id) { this.catalogsByConnection.delete(id); } else { this.catalogsByConnection.clear(); }
        this.refresh();
    }

    public refresh(): void { this.changed.fire(undefined); }

    private async loadCatalogs(client: TrinoClient, connection: StoredConnection): Promise<string[]> {
        const catalogs = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Connecting to ${connection.name}…`, cancellable: true },
            (_, token) => client.catalogs(token)
        );
        this.catalogsByConnection.set(connection.id, catalogs);
        // Redraw so the node picks up its "Connected" description and icon.
        setTimeout(() => this.changed.fire(undefined), 0);
        return catalogs;
    }
}

class ExplorerItem extends vscode.TreeItem {
    private constructor(
        label: string,
        public readonly kind: ExplorerNodeKind,
        public readonly connectionId?: string,
        public readonly catalog?: string,
        public readonly schema?: string
    ) {
        super(label, kind === 'table' || kind === 'empty'
            ? vscode.TreeItemCollapsibleState.None
            : vscode.TreeItemCollapsibleState.Collapsed);
        this.contextValue = `trino.${kind}`;
    }

    public static empty(): ExplorerItem {
        const item = new ExplorerItem('Add a Trino connection', 'empty');
        item.iconPath = new vscode.ThemeIcon('add');
        item.command = { command: 'trino.addConnection', title: 'Add Trino Connection' };
        item.tooltip = 'Add a Trino coordinator to browse its catalogs.';
        return item;
    }

    public static connection(connection: StoredConnection, connected: boolean, active: boolean): ExplorerItem {
        const item = new ExplorerItem(connection.name, 'connection', connection.id);
        const endpoint = connection.url.replace(/^https?:\/\//, '');
        item.description = connected ? `${endpoint} • Connected` : endpoint;
        item.iconPath = new vscode.ThemeIcon(connected ? 'vm-active' : 'vm', active ? new vscode.ThemeColor('charts.green') : undefined);
        item.tooltip = new vscode.MarkdownString(
            `**${connection.name}**\n\n${connection.url}\n\nUser: \`${connection.user}\`${active ? '\n\nActive connection for SQL queries.' : ''}`
        );
        item.contextValue = active ? 'trino.connection.active' : 'trino.connection';
        return item;
    }

    public static catalog(connectionId: string, catalog: string): ExplorerItem {
        const item = new ExplorerItem(catalog, 'catalog', connectionId, catalog);
        item.iconPath = new vscode.ThemeIcon('database');
        item.tooltip = `Catalog: ${catalog}`;
        return item;
    }

    public static schema(connectionId: string, catalog: string, schema: string): ExplorerItem {
        const item = new ExplorerItem(schema, 'schema', connectionId, catalog, schema);
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.tooltip = `Schema: ${catalog}.${schema}`;
        return item;
    }

    public static table(connectionId: string, catalog: string, schema: string, table: string): ExplorerItem {
        const item = new ExplorerItem(table, 'table', connectionId, catalog, schema);
        item.description = 'TABLE';
        item.iconPath = new vscode.ThemeIcon('list-flat');
        item.tooltip = `${catalog}.${schema}.${table}`;
        return item;
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const store = new ConnectionStore(context);
    const provider = new TrinoExplorerProvider(store, context.secrets);
    void store.migrateLegacyConnection();

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('trinoCatalogs', provider),
        store.onDidChange(() => provider.refresh()),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('trino.connections')) { provider.refresh(); }
        })
    );

    const register = (command: string, handler: (...args: never[]) => unknown) => {
        context.subscriptions.push(vscode.commands.registerCommand(command, handler));
    };

    register('trino.addConnection', async () => {
        await showConnectionWindow(context, store, provider, undefined);
    });
    register('trino.editConnection', async (item?: ExplorerItem) => {
        const connection = store.get(item?.connectionId) ?? await pickConnection(store, 'Select a connection to edit');
        if (connection) { await showConnectionWindow(context, store, provider, connection); }
    });
    register('trino.removeConnection', async (item?: ExplorerItem) => {
        const connection = store.get(item?.connectionId) ?? await pickConnection(store, 'Select a connection to remove');
        if (!connection) { return; }
        const confirmed = await vscode.window.showWarningMessage(
            `Remove the Trino connection "${connection.name}"?`, { modal: true }, 'Remove'
        );
        if (confirmed !== 'Remove') { return; }
        await store.remove(connection.id);
        provider.forget(connection.id);
        vscode.window.showInformationMessage(`Removed Trino connection "${connection.name}".`);
    });
    register('trino.setActiveConnection', async (item?: ExplorerItem) => {
        const connection = store.get(item?.connectionId) ?? await pickConnection(store, 'Select the connection to use for queries');
        if (connection) {
            await store.setActive(connection.id);
            vscode.window.showInformationMessage(`Trino queries now run against "${connection.name}".`);
        }
    });
    register('trino.connect', async (item?: ExplorerItem) => {
        const connection = store.get(item?.connectionId) ?? await resolveConnection(store);
        if (!connection) { return; }
        try { await provider.connect(connection); }
        catch (error) { showConnectionError(error); }
    });
    register('trino.refreshCatalogs', async (item?: ExplorerItem) => {
        provider.forget(item?.connectionId);
        const connection = store.get(item?.connectionId);
        if (!connection) { return; }
        try { await provider.connect(connection); }
        catch (error) { showConnectionError(error); }
    });
    register('trino.configureConnection', async () => {
        const connection = store.get(store.activeId);
        await showConnectionWindow(context, store, provider, connection);
    });
    register('trino.openQuery', async () => { await openSqlQueryEditor(store); });
    register('trino.runActiveSql', async () => { await runActiveSql(store, context.secrets); });
}

async function pickConnection(store: ConnectionStore, placeHolder: string): Promise<StoredConnection | undefined> {
    const connections = store.all();
    if (!connections.length) {
        vscode.window.showErrorMessage('Add a Trino connection first.', 'Add Connection')
            .then(selection => { if (selection) { void vscode.commands.executeCommand('trino.addConnection'); } });
        return undefined;
    }
    if (connections.length === 1) { return connections[0]; }
    const picked = await vscode.window.showQuickPick(
        connections.map(connection => ({ label: connection.name, description: connection.url, id: connection.id })),
        { placeHolder }
    );
    return store.get(picked?.id);
}

/** The connection SQL runs against: the active one, or whatever the user picks. */
async function resolveConnection(store: ConnectionStore): Promise<StoredConnection | undefined> {
    const active = store.get(store.activeId);
    if (active) { return active; }
    const connection = await pickConnection(store, 'Select a Trino connection');
    if (connection) { await store.setActive(connection.id); }
    return connection;
}

async function openSqlQueryEditor(store: ConnectionStore): Promise<void> {
    const connection = await resolveConnection(store);
    if (!connection) { return; }
    const document = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: `-- Connection: ${connection.name}\nSELECT *\nFROM system.runtime.nodes\nLIMIT 10;`
    });
    await vscode.window.showTextDocument(document, { preview: false });
}

async function runActiveSql(store: ConnectionStore, secrets: vscode.SecretStorage): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
        vscode.window.showErrorMessage('Open a Trino SQL query editor before running a query.');
        return;
    }
    const connection = await resolveConnection(store);
    if (!connection) { return; }
    const selectedSql = editor.document.getText(editor.selection).trim();
    const sql = selectedSql || editor.document.getText();
    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Executing on ${connection.name}…`, cancellable: true },
            (_, token) => new TrinoClient(secrets, connection).query(sql, token)
        );
        showSqlResults(result, connection);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Trino query failed: ${message}`);
    }
}

function showSqlResults(result: TrinoQueryResult, connection: StoredConnection): void {
    const panel = vscode.window.createWebviewPanel('trinoQueryResults', `Trino Results — ${connection.name}`, vscode.ViewColumn.Beside, { enableScripts: false });
    panel.webview.html = sqlResultsHtml(panel.webview, result, connection);
}

async function showConnectionWindow(
    context: vscode.ExtensionContext,
    store: ConnectionStore,
    provider: TrinoExplorerProvider,
    existing: StoredConnection | undefined
): Promise<void> {
    const current = parseConnectionUrl(existing?.url ?? 'http://localhost:8080');
    const panel = vscode.window.createWebviewPanel(
        'trinoConnection',
        existing ? `Edit ${existing.name}` : 'New Trino Connection',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );
    const hasPassword = existing ? Boolean(await context.secrets.get(passwordKey(existing.id))) : false;
    panel.webview.html = connectionFormHtml(panel.webview, {
        name: existing?.name ?? 'Trino Connection',
        host: current.host,
        port: current.port,
        sslEnabled: current.sslEnabled,
        user: existing?.user ?? '',
        catalog: existing?.catalog ?? '',
        schema: existing?.schema ?? ''
    }, Boolean(existing), hasPassword);

    panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!isConnectionMessage(message)) { return; }
        const request = expandPastedUrl(message);
        const validation = validateConnection(request);
        if (validation) {
            void panel.webview.postMessage({ type: 'error', message: validation });
            return;
        }
        const id = existing?.id ?? randomUUID();
        const url = `${request.sslEnabled ? 'https' : 'http'}://${formatHost(request.host.trim())}:${request.port.trim()}`;
        await store.save({
            id,
            name: request.name.trim() || 'Trino Connection',
            url,
            user: request.user.trim(),
            catalog: request.catalog.trim() || undefined,
            schema: request.schema.trim() || undefined
        });
        if (request.clearPassword) { await context.secrets.delete(passwordKey(id)); }
        else if (request.password) { await context.secrets.store(passwordKey(id), request.password); }

        provider.forget(id);
        panel.dispose();
        vscode.window.showInformationMessage(`Trino connection saved: ${url}`);
        if (request.connect) {
            const saved = store.get(id);
            if (saved) {
                try { await provider.connect(saved); }
                catch (error) { showConnectionError(error); }
            }
        }
    }, undefined, context.subscriptions);
}

function sqlResultsHtml(webview: vscode.Webview, result: TrinoQueryResult, connection: StoredConnection): string {
    const displayedRows = result.rows.slice(0, 1_000);
    const escape = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const format = (value: unknown) => value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    const headers = result.columns.map(column => `<th>${escape(column)}</th>`).join('');
    const rows = displayedRows.map(row => `<tr>${result.columns.map((_, index) => `<td>${escape(format(row[index]))}</td>`).join('')}</tr>`).join('');
    const note = result.rows.length > displayedRows.length ? `Showing the first ${displayedRows.length.toLocaleString()} of ${result.rows.length.toLocaleString()} rows.` : `${result.rows.length.toLocaleString()} row(s) returned.`;
    const table = result.columns.length ? `<div class="results"><table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>` : '<p>Statement completed. No rows returned.</p>';
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{color:var(--vscode-foreground);font-family:var(--vscode-font-family);margin:0;padding:18px;overflow:hidden}h1{font-size:1.25em;margin:0 0 6px}.note{margin:0 0 14px;color:var(--vscode-descriptionForeground)}.results{height:calc(100vh - 108px);overflow:auto;border:1px solid var(--vscode-panel-border)}table{border-collapse:collapse;width:max-content;min-width:100%}th,td{padding:6px 10px;border-right:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border);text-align:left;vertical-align:top;white-space:pre-wrap}th{position:sticky;top:0;background:var(--vscode-editor-background);font-weight:600}td{max-width:420px}</style></head><body><h1>Trino Query Results</h1><p class="note">${escape(connection.name)} — ${note}</p>${table}</body></html>`;
}

interface ConnectionFormData {
    name: string;
    host: string;
    port: string;
    sslEnabled: boolean;
    user: string;
    catalog: string;
    schema: string;
}

interface ConnectionMessage extends ConnectionFormData {
    type: 'save';
    password: string;
    clearPassword: boolean;
    connect: boolean;
}

function isConnectionMessage(value: unknown): value is ConnectionMessage {
    return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'save';
}

/**
 * Lets the Host field accept a whole URL — pasting jdbc:trino://host:port/catalog
 * fills in the host, port, SSL, catalog, schema, and user instead of failing.
 * Values already typed into those fields win over the ones in the URL.
 */
function expandPastedUrl(message: ConnectionMessage): ConnectionMessage {
    const parsed = parseTrinoUrl(message.host);
    if (!parsed) { return message; }
    return {
        ...message,
        host: parsed.host,
        port: parsed.port ?? message.port,
        sslEnabled: parsed.sslEnabled ?? message.sslEnabled,
        user: message.user.trim() || parsed.user,
        catalog: message.catalog.trim() || parsed.catalog,
        schema: message.schema.trim() || parsed.schema
    };
}

function validateConnection(value: ConnectionMessage): string | undefined {
    if (/:\/\//.test(value.host)) { return 'Could not read that URL. Use a host name, http(s)://host:port, or jdbc:trino://host:port.'; }
    if (!value.host.trim()) { return 'Enter a host name, an IP address, or paste a JDBC/HTTP URL.'; }
    if (!/^\d+$/.test(value.port.trim()) || Number(value.port) < 1 || Number(value.port) > 65535) { return 'Port must be between 1 and 65535.'; }
    if (!value.user.trim()) { return 'Trino user is required.'; }
    return undefined;
}

/**
 * `port` and `sslEnabled` are undefined when the URL says nothing about them, so
 * callers can keep whatever the user already chose instead of guessing over it.
 */
interface ParsedTrinoUrl extends Pick<ConnectionFormData, 'host' | 'catalog' | 'schema'> {
    port?: string;
    sslEnabled?: boolean;
    user: string;
}

const JDBC_SCHEME = /^jdbc:(?:trino|presto):\/\//i;
const TLS_PORTS = new Set(['443', '8443']);

/**
 * Reads either an HTTP(S) coordinator URL or a Trino JDBC connection string.
 * JDBC URLs look like jdbc:trino://host:port/catalog/schema?SSL=true&user=alice;
 * the REST API this extension uses needs the equivalent http(s)://host:port.
 */
function parseTrinoUrl(value: string): ParsedTrinoUrl | undefined {
    const trimmed = value.trim();
    const isJdbc = JDBC_SCHEME.test(trimmed);
    if (!isJdbc && !/^https?:\/\//i.test(trimmed)) { return undefined; }
    let url: URL;
    try { url = new URL(isJdbc ? `http://${trimmed.replace(JDBC_SCHEME, '')}` : trimmed); }
    catch { return undefined; }
    if (!url.hostname) { return undefined; }

    // JDBC parameter names are conventionally capitalised (SSL), but match loosely.
    const parameter = (name: string): string | undefined => {
        for (const [key, entry] of url.searchParams) {
            if (key.toLowerCase() === name) { return entry; }
        }
        return undefined;
    };
    // An http(s) URL always states the scheme. A JDBC URL may not mention SSL at
    // all: honour SSL=… when present, otherwise infer it from a conventional TLS
    // port, and leave it undefined when the URL simply does not say.
    const ssl = parameter('ssl');
    const sslEnabled = !isJdbc ? url.protocol === 'https:'
        : ssl !== undefined ? /^true$/i.test(ssl)
        : TLS_PORTS.has(url.port) ? true
        : undefined;
    const [catalog = '', schema = ''] = url.pathname.replace(/^\//, '').split('/');
    return {
        host: url.hostname,
        port: url.port || undefined,
        sslEnabled,
        catalog: decodeURIComponent(catalog),
        schema: decodeURIComponent(schema),
        user: parameter('user') ?? ''
    };
}

function httpBaseUrl(value: string): string | undefined {
    const parsed = parseTrinoUrl(value);
    if (!parsed) { return undefined; }
    const { sslEnabled, port } = withPortDefaults(parsed);
    return `${sslEnabled ? 'https' : 'http'}://${formatHost(parsed.host)}:${port}`;
}

/** Fills in the conventional port and scheme for a URL that omitted them. */
function withPortDefaults(parsed: ParsedTrinoUrl): { port: string; sslEnabled: boolean } {
    const sslEnabled = parsed.sslEnabled ?? TLS_PORTS.has(parsed.port ?? '');
    return { sslEnabled, port: parsed.port ?? (sslEnabled ? '443' : '8080') };
}

function parseConnectionUrl(value: string): Pick<ConnectionFormData, 'host' | 'port' | 'sslEnabled'> {
    const parsed = parseTrinoUrl(value);
    return parsed
        ? { host: parsed.host, ...withPortDefaults(parsed) }
        : { host: 'localhost', port: '8080', sslEnabled: false };
}

function formatHost(host: string): string {
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function connectionFormHtml(webview: vscode.Webview, values: ConnectionFormData, isEdit: boolean, hasPassword: boolean): string {
    const nonce = String(Date.now());
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const passwordHint = hasPassword ? 'Leave blank to keep the saved password' : 'Optional';
    const forgetRow = hasPassword ? '<label class="check"><input id="clearPassword" type="checkbox"> Forget saved password</label>' : '<input id="clearPassword" type="checkbox" hidden>';
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Trino Connection</title><style>body{color:var(--vscode-foreground);font-family:var(--vscode-font-family);max-width:680px;margin:32px auto;padding:0 24px}h1{font-size:1.5em}.grid{display:grid;grid-template-columns:2fr 1fr;gap:14px}label{display:block;margin:14px 0 6px;font-weight:600}input{box-sizing:border-box;width:100%;padding:7px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(128,128,128,.55));border-radius:2px}input:focus{outline:1px solid var(--vscode-focusBorder,rgba(128,128,128,.9));outline-offset:-1px;border-color:var(--vscode-focusBorder,rgba(128,128,128,.9))}.check{display:flex;align-items:center;gap:8px;font-weight:normal}.check input{width:auto}button{margin:22px 8px 0 0;padding:8px 14px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0}button.secondary{background:var(--vscode-button-secondaryBackground)}#error{min-height:20px;color:var(--vscode-errorForeground);margin-top:12px}code{background:var(--vscode-textCodeBlock-background);padding:1px 4px}</style></head><body><h1>${isEdit ? 'Edit Trino connection' : 'New Trino connection'}</h1><p>Enter the host and port of your Trino coordinator. <em>Optional:</em> paste a full <code>http(s)://</code> or <code>jdbc:trino://</code> URL into Host to fill in the fields automatically.</p><form id="connection"><label for="name">Connection name</label><input id="name" value="${escape(values.name)}" placeholder="Development Trino"><div class="grid"><div><label for="host">Host</label><input id="host" value="${escape(values.host)}" placeholder="trino.example.com" required></div><div><label for="port">Port</label><input id="port" type="number" min="1" max="65535" value="${escape(values.port)}" required></div></div><label class="check"><input id="sslEnabled" type="checkbox" ${values.sslEnabled ? 'checked' : ''}> Enable SSL / HTTPS</label><label for="user">User</label><input id="user" value="${escape(values.user)}" required><label for="password">Password</label><input id="password" type="password" autocomplete="new-password" placeholder="${passwordHint}">${forgetRow}<label for="catalog">Default catalog (optional)</label><input id="catalog" value="${escape(values.catalog)}"><label for="schema">Default schema (optional)</label><input id="schema" value="${escape(values.schema)}"><div id="error" role="alert"></div><button type="submit" data-connect="true">Save &amp; Connect</button><button type="submit" class="secondary" data-connect="false">Save</button></form><script nonce="${nonce}">const vscode=acquireVsCodeApi();let connect=true;document.querySelectorAll('button[type=submit]').forEach(b=>b.addEventListener('click',()=>connect=b.dataset.connect==='true'));document.getElementById('connection').addEventListener('submit',e=>{e.preventDefault();const byId=id=>document.getElementById(id);vscode.postMessage({type:'save',name:byId('name').value,host:byId('host').value,port:byId('port').value,sslEnabled:byId('sslEnabled').checked,user:byId('user').value,password:byId('password').value,clearPassword:byId('clearPassword').checked,catalog:byId('catalog').value,schema:byId('schema').value,connect});});window.addEventListener('message',e=>{if(e.data.type==='error')document.getElementById('error').textContent=e.data.message;});</script></body></html>`;
}

function showConnectionError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not load Trino catalogs: ${message}`, 'Edit Connection')
        .then(selection => { if (selection) { void vscode.commands.executeCommand('trino.editConnection'); } });
}

export function deactivate(): void {}
