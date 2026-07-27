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

/** Carries the untruncated server response alongside the short display message. */
class TrinoRequestError extends Error {
    public constructor(message: string, public readonly details?: string) {
        super(message);
        this.name = 'TrinoRequestError';
    }
}

interface TrinoColumn {
    name: string;
    type: string;
    extra: string;
    comment: string;
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

    /** SHOW COLUMNS returns one row per column: name, type, extra, comment. */
    public async columns(catalog: string, schema: string, table: string): Promise<TrinoColumn[]> {
        const qualified = `${quoteIdentifier(catalog)}.${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
        const result = await this.query(`SHOW COLUMNS FROM ${qualified}`);
        return result.rows.map(row => ({
            name: String(row[0] ?? ''),
            type: String(row[1] ?? ''),
            extra: String(row[2] ?? ''),
            comment: String(row[3] ?? '')
        })).filter(column => column.name);
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
            throw new TrinoRequestError(
                page.error.message || page.error.errorName || 'Trino returned an error.',
                JSON.stringify(page.error, null, 2)
            );
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
                throw new TrinoRequestError('The coordinator expects HTTPS on this port. Turn on "Enable SSL / HTTPS" in the connection window, or add ?SSL=true to the JDBC URL.', details);
            }
            throw new TrinoRequestError(`Trino request failed (${response.status}): ${summarize(details) || response.statusText}`, details);
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

interface QueryOutcome {
    line: number;
    milliseconds: number;
    rows: number;
    error?: string;
}

/**
 * Reports the last run's timing above the statement it belongs to. A CodeLens is
 * the only supported way to draw a line of text above editor content.
 */
class QueryStatusProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this.changed.event;
    private readonly outcomes = new Map<string, QueryOutcome>();
    private readonly successGutter: vscode.TextEditorDecorationType;
    private readonly errorGutter: vscode.TextEditorDecorationType;

    public constructor(context: vscode.ExtensionContext) {
        const gutter = (file: string, overviewColor: string) => vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.file(context.asAbsolutePath(`resources/${file}`)),
            gutterIconSize: 'contain',
            overviewRulerColor: overviewColor,
            overviewRulerLane: vscode.OverviewRulerLane.Left
        });
        this.successGutter = gutter('query-success.svg', '#2ea043');
        this.errorGutter = gutter('query-error.svg', '#f14c4c');
    }

    public record(uri: vscode.Uri, outcome: QueryOutcome): void {
        this.outcomes.set(uri.toString(), outcome);
        this.changed.fire();
        this.decorate();
        // Opening the results panel can leave the editor inactive, which defers the
        // redraw; a second notification once that settles keeps the lens immediate.
        setTimeout(() => { this.changed.fire(); this.decorate(); }, 0);
    }

    public forget(uri: vscode.Uri): void {
        if (this.outcomes.delete(uri.toString())) { this.changed.fire(); this.decorate(); }
    }

    /** Puts the tick or cross in the gutter of every editor showing the statement. */
    public decorate(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            const outcome = this.outcomes.get(editor.document.uri.toString());
            const ranges = outcome
                ? [new vscode.Range(this.anchor(outcome, editor.document), 0, this.anchor(outcome, editor.document), 0)]
                : [];
            editor.setDecorations(this.successGutter, outcome && !outcome.error ? ranges : []);
            editor.setDecorations(this.errorGutter, outcome?.error ? ranges : []);
        }
    }

    public dispose(): void {
        this.successGutter.dispose();
        this.errorGutter.dispose();
    }

    private anchor(outcome: QueryOutcome, document: vscode.TextDocument): number {
        return Math.min(outcome.line, Math.max(document.lineCount - 1, 0));
    }

    public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const outcome = this.outcomes.get(document.uri.toString());
        if (!outcome) { return []; }
        const line = this.anchor(outcome, document);
        const elapsed = formatDuration(outcome.milliseconds);
        const title = outcome.error
            ? `$(error) Failed in ${elapsed} — ${outcome.error}`
            : `$(check) ${elapsed} · ${outcome.rows.toLocaleString()} row(s)`;
        return [new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title, command: '' })];
    }
}

function formatDuration(milliseconds: number): string {
    if (milliseconds < 1_000) { return `${Math.round(milliseconds)}ms`; }
    if (milliseconds < 60_000) { return `${(milliseconds / 1_000).toFixed(2)}s`; }
    const minutes = Math.floor(milliseconds / 60_000);
    return `${minutes}m ${Math.round((milliseconds % 60_000) / 1_000)}s`;
}

type ExplorerNodeKind = 'connection' | 'catalog' | 'schema' | 'table' | 'column' | 'empty';

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
            if (element.kind === 'table' && element.catalog && element.schema && element.table) {
                const columns = await client.columns(element.catalog, element.schema, element.table);
                return columns.map(column => ExplorerItem.column(connection.id, element.catalog!, element.schema!, element.table!, column));
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
        public readonly schema?: string,
        public readonly table?: string
    ) {
        super(label, kind === 'column' || kind === 'empty'
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
        const item = new ExplorerItem(table, 'table', connectionId, catalog, schema, table);
        item.description = 'TABLE';
        item.iconPath = new vscode.ThemeIcon('list-flat');
        item.tooltip = `${catalog}.${schema}.${table}`;
        // Fires on every click; the handler previews only on a double click.
        item.command = { command: 'trino.tableClicked', title: 'Preview Table Data', arguments: [item] };
        return item;
    }

    public static column(connectionId: string, catalog: string, schema: string, table: string, column: TrinoColumn): ExplorerItem {
        const item = new ExplorerItem(column.name, 'column', connectionId, catalog, schema, table);
        item.description = column.type;
        item.iconPath = new vscode.ThemeIcon('symbol-field');
        const details = [`\`${column.type}\``, column.extra, column.comment].filter(Boolean).join(' · ');
        item.tooltip = new vscode.MarkdownString(`**${column.name}**\n\n${details}\n\n${catalog}.${schema}.${table}`);
        return item;
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const store = new ConnectionStore(context);
    const provider = new TrinoExplorerProvider(store, context.secrets);
    const status = new QueryStatusProvider(context);
    void store.migrateLegacyConnection();

    context.subscriptions.push(
        status,
        vscode.window.registerTreeDataProvider('trinoCatalogs', provider),
        vscode.languages.registerCodeLensProvider({ language: 'sql' }, status),
        vscode.workspace.onDidCloseTextDocument(document => status.forget(document.uri)),
        // Reapply after a split, tab switch, or reopen; decorations are per editor.
        vscode.window.onDidChangeVisibleTextEditors(() => status.decorate()),
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
    register('trino.previewTable', async (item?: ExplorerItem) => {
        await previewTable(store, context.secrets, item, true);
    });
    register('trino.tableClicked', async (item?: ExplorerItem) => {
        await previewTable(store, context.secrets, item);
    });
    register('trino.openQuery', async () => { await openSqlQueryEditor(store); });
    register('trino.runActiveSql', async () => { await runActiveSql(store, context.secrets, status); });
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

const DOUBLE_CLICK_MS = 500;
let lastClick: { key: string; at: number } | undefined;

/**
 * The tree API has no double-click event and fires TreeItem.command on every
 * click, so treat two clicks on the same table within DOUBLE_CLICK_MS as one.
 */
function isDoubleClick(key: string): boolean {
    const now = Date.now();
    const repeated = lastClick?.key === key && now - lastClick.at <= DOUBLE_CLICK_MS;
    lastClick = repeated ? undefined : { key, at: now };
    return repeated;
}

/** Runs a bounded SELECT for the clicked table and shows it in the results grid. */
async function previewTable(store: ConnectionStore, secrets: vscode.SecretStorage, item?: ExplorerItem, force = false): Promise<void> {
    const connection = store.get(item?.connectionId);
    if (!connection || !item?.catalog || !item.schema || !item.table) { return; }
    if (!force && !isDoubleClick(`${connection.id}/${item.catalog}/${item.schema}/${item.table}`)) { return; }
    const qualified = `${quoteIdentifier(item.catalog)}.${quoteIdentifier(item.schema)}.${quoteIdentifier(item.table)}`;
    const limit = previewRowLimit();
    const sql = `SELECT * FROM ${qualified} LIMIT ${limit}`;
    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Loading ${item.table}…`, cancellable: true },
            (_, token) => new TrinoClient(secrets, connection).query(sql, token)
        );
        const shown = `${result.rows.length.toLocaleString()} row(s) from ${item.catalog}.${item.schema}.${item.table}`;
        showSqlResults(result, connection, `${item.table} — ${connection.name}`, `${shown} (limit ${limit.toLocaleString()}).`);
    } catch (error) {
        showQueryError(error, connection, sql, `${item.table} — failed`);
    }
}

function previewRowLimit(): number {
    const configured = vscode.workspace.getConfiguration('trino').get<number>('preview.rowLimit') ?? 100;
    return Math.min(Math.max(Math.trunc(configured) || 100, 1), 10_000);
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

async function runActiveSql(store: ConnectionStore, secrets: vscode.SecretStorage, status: QueryStatusProvider): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
        vscode.window.showErrorMessage('Open a Trino SQL query editor before running a query.');
        return;
    }
    const connection = await resolveConnection(store);
    if (!connection) { return; }
    const selectedSql = editor.document.getText(editor.selection).trim();
    const sql = selectedSql || editor.document.getText();
    // Anchor the timing above the statement that ran: the selection, or the
    // first non-empty line when the whole editor is executed.
    const line = selectedSql ? editor.selection.start.line : firstStatementLine(editor.document);
    const started = Date.now();
    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Executing on ${connection.name}…`, cancellable: true },
            (_, token) => new TrinoClient(secrets, connection).query(sql, token)
        );
        status.record(editor.document.uri, { line, milliseconds: Date.now() - started, rows: result.rows.length });
        showSqlResults(result, connection);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status.record(editor.document.uri, { line, milliseconds: Date.now() - started, rows: 0, error: summarize(message) });
        showQueryError(error, connection, sql);
    }
}

function firstStatementLine(document: vscode.TextDocument): number {
    for (let line = 0; line < document.lineCount; line++) {
        const text = document.lineAt(line).text.trim();
        if (text && !text.startsWith('--')) { return line; }
    }
    return 0;
}

function showSqlResults(result: TrinoQueryResult, connection: StoredConnection, title?: string, subtitle?: string): void {
    const panel = vscode.window.createWebviewPanel(
        'trinoQueryResults',
        title ?? `Trino Results — ${connection.name}`,
        // Keep the caret in the SQL editor so its timing CodeLens redraws at once.
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: false }
    );
    panel.webview.html = sqlResultsHtml(panel.webview, result, connection, subtitle);
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

/** Failures land in the same panel as results, with the full server response. */
function showQueryError(error: unknown, connection: StoredConnection, sql: string, title?: string): void {
    const panel = vscode.window.createWebviewPanel(
        'trinoQueryResults',
        title ?? `Trino Error — ${connection.name}`,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: false }
    );
    const message = error instanceof Error ? error.message : String(error);
    const details = error instanceof TrinoRequestError ? error.details : undefined;
    panel.webview.html = queryErrorHtml(panel.webview, connection, sql, message, details);
}

function queryErrorHtml(webview: vscode.Webview, connection: StoredConnection, sql: string, message: string, details?: string): string {
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const detailBlock = details && details.trim() && details.trim() !== message.trim()
        ? `<h2>Server response</h2><pre class="details">${escape(details)}</pre>`
        : '';
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{color:var(--vscode-foreground);font-family:var(--vscode-font-family);margin:0;padding:18px}h1{font-size:1.25em;margin:0 0 6px;color:var(--vscode-errorForeground)}h2{font-size:.95em;margin:20px 0 6px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.04em}.note{margin:0 0 14px;color:var(--vscode-descriptionForeground)}pre{font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,13px);white-space:pre-wrap;word-break:break-word;padding:12px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));border-radius:3px;background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.1));margin:0}pre.message{border-left:3px solid var(--vscode-errorForeground)}</style></head><body><h1>Query failed</h1><p class="note">${escape(connection.name)} — ${escape(connection.url)}</p><pre class="message">${escape(message)}</pre>${detailBlock}<h2>Statement</h2><pre>${escape(sql)}</pre></body></html>`;
}

function sqlResultsHtml(webview: vscode.Webview, result: TrinoQueryResult, connection: StoredConnection, subtitle?: string): string {
    const displayedRows = result.rows.slice(0, 1_000);
    const escape = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const format = (value: unknown) => value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    const headers = result.columns.map(column => `<th>${escape(column)}</th>`).join('');
    const rows = displayedRows.map(row => `<tr>${result.columns.map((_, index) => `<td>${escape(format(row[index]))}</td>`).join('')}</tr>`).join('');
    const note = subtitle ?? (result.rows.length > displayedRows.length
        ? `Showing the first ${displayedRows.length.toLocaleString()} of ${result.rows.length.toLocaleString()} rows.`
        : `${result.rows.length.toLocaleString()} row(s) returned.`);
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
