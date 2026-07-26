import * as vscode from 'vscode';

const PASSWORD_KEY = 'trino.connection.password';

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

class TrinoClient {
    public constructor(private readonly secrets: vscode.SecretStorage) {}

    public async catalogs(token?: vscode.CancellationToken): Promise<string[]> {
        const result = await this.query('SHOW CATALOGS', token);
        return firstColumn(result);
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
        const config = vscode.workspace.getConfiguration('trino.connection');
        const rawUrl = String(config.get('url') ?? '').trim();
        const user = String(config.get('user') ?? '').trim();
        if (!rawUrl || !user) {
            throw new Error('Configure the Trino URL and user before connecting.');
        }

        const baseUrl = httpBaseUrl(rawUrl);
        if (!baseUrl) {
            throw new Error(`Could not read the Trino URL "${rawUrl}". Use http(s)://host:port or jdbc:trino://host:port.`);
        }
        const password = await this.secrets.get(PASSWORD_KEY);
        const headers: Record<string, string> = {
            'X-Trino-User': user,
            'Content-Type': 'text/plain'
        };
        const catalog = String(config.get('catalog') ?? '').trim();
        const schema = String(config.get('schema') ?? '').trim();
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
                throw new Error('The coordinator expects HTTPS on this port. Turn on "Enable SSL / HTTPS" in Configure Connection, or add ?SSL=true to the JDBC URL.');
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

type ExplorerNodeKind = 'connection' | 'catalog' | 'schema' | 'table' | 'connect';

class CatalogProvider implements vscode.TreeDataProvider<ExplorerItem> {
    private readonly changed = new vscode.EventEmitter<ExplorerItem | undefined>();
    public readonly onDidChangeTreeData = this.changed.event;
    private catalogs: string[] | undefined;

    public constructor(private readonly client: TrinoClient) {}

    public getTreeItem(item: ExplorerItem): vscode.TreeItem { return item; }

    public async getChildren(element?: ExplorerItem): Promise<ExplorerItem[]> {
        if (!element) {
            if (!this.catalogs) {
                return [new ExplorerItem('Connect to Trino', 'connect', undefined, undefined, 'Connect to a configured coordinator to load catalogs.', 'trino.connect')];
            }
            return [new ExplorerItem(this.connectionName(), 'connection')];
        }
        if (element.kind === 'connection') {
            return (this.catalogs ?? []).map(catalog => new ExplorerItem(catalog, 'catalog', catalog));
        }
        if (element.kind === 'catalog' && element.catalog) {
            const schemas = await this.client.schemas(element.catalog);
            return schemas.map(schema => new ExplorerItem(schema, 'schema', element.catalog, schema));
        }
        if (element.kind === 'schema' && element.catalog && element.schema) {
            const tables = await this.client.tables(element.catalog, element.schema);
            return tables.map(table => new ExplorerItem(table, 'table', element.catalog, element.schema));
        }
        return [];
    }

    public async refresh(): Promise<void> {
        this.catalogs = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'Loading Trino catalogs…' },
            (_, token) => this.client.catalogs(token)
        );
        this.changed.fire(undefined);
    }

    public clear(): void { this.catalogs = undefined; this.changed.fire(undefined); }

    private connectionName(): string {
        const config = vscode.workspace.getConfiguration('trino.connection');
        const name = String(config.get('name') ?? '').trim();
        return name || `Trino (${String(config.get('url') ?? 'connection')})`;
    }
}

class ExplorerItem extends vscode.TreeItem {
    public constructor(
        name: string,
        public readonly kind: ExplorerNodeKind,
        public readonly catalog?: string,
        public readonly schema?: string,
        tooltip?: string,
        command?: string
    ) {
        super(name, kind === 'connection' ? vscode.TreeItemCollapsibleState.Expanded : ['catalog', 'schema'].includes(kind) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.contextValue = `trino${kind[0].toUpperCase()}${kind.slice(1)}`;
        this.iconPath = new vscode.ThemeIcon(kind === 'connection' ? 'plug' : kind === 'catalog' ? 'database' : kind === 'schema' ? 'folder-library' : kind === 'table' ? 'table' : 'plug');
        this.tooltip = tooltip ?? (kind === 'table' ? `Trino table: ${name}` : `Trino ${kind}: ${name}`);
        if (command) {
            this.command = { command, title: name };
            this.iconPath = new vscode.ThemeIcon('plug');
        }
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const client = new TrinoClient(context.secrets);
    const provider = new CatalogProvider(client);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('trinoCatalogs', provider));

    context.subscriptions.push(vscode.commands.registerCommand('trino.configureConnection', async () => {
        await showConnectionWindow(context, provider);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('trino.openQuery', async () => {
        await openSqlQueryEditor();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('trino.runActiveSql', async () => {
        await runActiveSql(client);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('trino.connect', async () => {
        try { await provider.refresh(); }
        catch (error) { showConnectionError(error); }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('trino.refreshCatalogs', async () => {
        try { await provider.refresh(); }
        catch (error) { showConnectionError(error); }
    }));
}

async function openSqlQueryEditor(): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT *\nFROM system.runtime.nodes\nLIMIT 10;' });
    await vscode.window.showTextDocument(document, { preview: false });
}

async function runActiveSql(client: TrinoClient): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
        vscode.window.showErrorMessage('Open a Trino SQL query editor before running a query.');
        return;
    }
    const selectedSql = editor.document.getText(editor.selection).trim();
    const sql = selectedSql || editor.document.getText();
    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'Executing Trino query…', cancellable: true },
            (_, token) => client.query(sql, token)
        );
        showSqlResults(result);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Trino query failed: ${message}`);
    }
}

function showSqlResults(result: TrinoQueryResult): void {
    const panel = vscode.window.createWebviewPanel('trinoQueryResults', 'Trino Query Results', vscode.ViewColumn.Beside, { enableScripts: false });
    panel.webview.html = sqlResultsHtml(panel.webview, result);
}

async function showConnectionWindow(context: vscode.ExtensionContext, provider: CatalogProvider): Promise<void> {
    const config = vscode.workspace.getConfiguration('trino.connection');
    const current = parseConnectionUrl(String(config.get('url') ?? 'http://localhost:8080'));
    const panel = vscode.window.createWebviewPanel('trinoConnection', 'Trino Connection', vscode.ViewColumn.One, {
        enableScripts: true
    });
    panel.webview.html = connectionFormHtml(panel.webview, {
        name: String(config.get('name') ?? ''),
        host: current.host,
        port: current.port,
        sslEnabled: current.sslEnabled,
        user: String(config.get('user') ?? ''),
        catalog: String(config.get('catalog') ?? ''),
        schema: String(config.get('schema') ?? '')
    });

    panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!isConnectionMessage(message)) { return; }
        const request = expandPastedUrl(message);
        const validation = validateConnection(request);
        if (validation) {
            void panel.webview.postMessage({ type: 'error', message: validation });
            return;
        }
        const connection = vscode.workspace.getConfiguration('trino.connection');
        const host = formatHost(request.host.trim());
        const url = `${request.sslEnabled ? 'https' : 'http'}://${host}:${request.port.trim()}`;
        await connection.update('name', request.name.trim(), vscode.ConfigurationTarget.Global);
        await connection.update('url', url, vscode.ConfigurationTarget.Global);
        await connection.update('user', request.user.trim(), vscode.ConfigurationTarget.Global);
        await connection.update('catalog', request.catalog.trim(), vscode.ConfigurationTarget.Global);
        await connection.update('schema', request.schema.trim(), vscode.ConfigurationTarget.Global);
        if (request.clearPassword) { await context.secrets.delete(PASSWORD_KEY); }
        else if (request.password) { await context.secrets.store(PASSWORD_KEY, request.password); }
        provider.clear();
        panel.dispose();
        vscode.window.showInformationMessage(`Trino connection saved: ${url}`);
        if (request.connect) {
            try { await provider.refresh(); }
            catch (error) { showConnectionError(error); }
        }
    }, undefined, context.subscriptions);
}

function sqlResultsHtml(webview: vscode.Webview, result: TrinoQueryResult): string {
    const displayedRows = result.rows.slice(0, 1_000);
    const escape = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const format = (value: unknown) => value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    const headers = result.columns.map(column => `<th>${escape(column)}</th>`).join('');
    const rows = displayedRows.map(row => `<tr>${result.columns.map((_, index) => `<td>${escape(format(row[index]))}</td>`).join('')}</tr>`).join('');
    const note = result.rows.length > displayedRows.length ? `Showing the first ${displayedRows.length.toLocaleString()} of ${result.rows.length.toLocaleString()} rows.` : `${result.rows.length.toLocaleString()} row(s) returned.`;
    const table = result.columns.length ? `<div class="results"><table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>` : '<p>Statement completed. No rows returned.</p>';
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{color:var(--vscode-foreground);font-family:var(--vscode-font-family);margin:0;padding:18px;overflow:hidden}h1{font-size:1.25em;margin:0 0 6px}.note{margin:0 0 14px;color:var(--vscode-descriptionForeground)}.results{height:calc(100vh - 108px);overflow:auto;border:1px solid var(--vscode-panel-border)}table{border-collapse:collapse;width:max-content;min-width:100%}th,td{padding:6px 10px;border-right:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border);text-align:left;vertical-align:top;white-space:pre-wrap}th{position:sticky;top:0;background:var(--vscode-editor-background);font-weight:600}td{max-width:420px}</style></head><body><h1>Trino Query Results</h1><p class="note">${note}</p>${table}</body></html>`;
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

function connectionFormHtml(webview: vscode.Webview, values: ConnectionFormData): string {
    const nonce = String(Date.now());
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Trino Connection</title><style>body{color:var(--vscode-foreground);font-family:var(--vscode-font-family);max-width:680px;margin:32px auto;padding:0 24px}h1{font-size:1.5em}.grid{display:grid;grid-template-columns:2fr 1fr;gap:14px}label{display:block;margin:14px 0 6px;font-weight:600}input{box-sizing:border-box;width:100%;padding:7px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}.check{display:flex;align-items:center;gap:8px;font-weight:normal}.check input{width:auto}button{margin:22px 8px 0 0;padding:8px 14px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0}button.secondary{background:var(--vscode-button-secondaryBackground)}#error{min-height:20px;color:var(--vscode-errorForeground);margin-top:12px}</style></head><body><h1>Connect to Trino</h1><p>Enter the details for your Trino coordinator, or paste a full URL into Host &mdash; <code>http(s)://host:port</code> or <code>jdbc:trino://host:port/catalog/schema?SSL=true</code> &mdash; and the remaining fields are filled in for you.</p><form id="connection"><label for="name">Connection name</label><input id="name" value="${escape(values.name)}" placeholder="Development Trino"><div class="grid"><div><label for="host">Host</label><input id="host" value="${escape(values.host)}" placeholder="trino.example.com" required></div><div><label for="port">Port</label><input id="port" type="number" min="1" max="65535" value="${escape(values.port)}" required></div></div><label class="check"><input id="sslEnabled" type="checkbox" ${values.sslEnabled ? 'checked' : ''}> Enable SSL / HTTPS</label><label for="user">User</label><input id="user" value="${escape(values.user)}" required><label for="password">Password</label><input id="password" type="password" autocomplete="new-password" placeholder="Leave blank to keep the saved password"><label class="check"><input id="clearPassword" type="checkbox"> Remove saved password</label><label for="catalog">Default catalog (optional)</label><input id="catalog" value="${escape(values.catalog)}"><label for="schema">Default schema (optional)</label><input id="schema" value="${escape(values.schema)}"><div id="error" role="alert"></div><button type="submit" data-connect="true">Save &amp; Connect</button><button type="submit" class="secondary" data-connect="false">Save</button></form><script nonce="${nonce}">const vscode=acquireVsCodeApi();let connect=true;document.querySelectorAll('button[type=submit]').forEach(b=>b.addEventListener('click',()=>connect=b.dataset.connect==='true'));document.getElementById('connection').addEventListener('submit',e=>{e.preventDefault();const byId=id=>document.getElementById(id);vscode.postMessage({type:'save',name:byId('name').value,host:byId('host').value,port:byId('port').value,sslEnabled:byId('sslEnabled').checked,user:byId('user').value,password:byId('password').value,clearPassword:byId('clearPassword').checked,catalog:byId('catalog').value,schema:byId('schema').value,connect});});window.addEventListener('message',e=>{if(e.data.type==='error')document.getElementById('error').textContent=e.data.message;});</script></body></html>`;
}

function showConnectionError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not load Trino catalogs: ${message}`, 'Configure Connection')
        .then(selection => { if (selection) { void vscode.commands.executeCommand('trino.configureConnection'); } });
}

export function deactivate(): void {}
