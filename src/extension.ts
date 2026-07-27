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
    /** Optional per-connection override of `trino.query.maxRows`. */
    maxRows?: number;
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
    /** True when the row cap stopped the fetch before Trino ran out of rows. */
    truncated?: boolean;
    maxRows?: number;
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
        return this.runStatement(normalizedStatement, token);
    }

    /**
     * The row cap for this connection: its own override when set, otherwise the
     * global `trino.query.maxRows`. Bounds memory regardless of the statement.
     */
    public maxRows(): number {
        const perConnection = Number(this.connection.maxRows);
        if (Number.isFinite(perConnection) && perConnection > 0) { return Math.trunc(perConnection); }
        const configured = Number(vscode.workspace.getConfiguration('trino').get('query.maxRows'));
        return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : 10_000;
    }

    private async runStatement(statement: string, token?: vscode.CancellationToken): Promise<TrinoQueryResult> {
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
        const maxRows = this.maxRows();
        let truncated = false;
        while (page.nextUri && !page.error) {
            if (rows.length >= maxRows) {
                // Stop pulling pages and tell the coordinator to abandon the query,
                // so it stops producing results nobody is going to read.
                truncated = true;
                await this.cancelQuery(page.nextUri, headers);
                break;
            }
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
        if (rows.length > maxRows) {
            rows.length = maxRows;
            truncated = true;
        }
        return { columns: (columns ?? []).map(column => column.name), rows, truncated, maxRows };
    }

    /** Best effort: a failed cancellation must not fail the query we already have. */
    private async cancelQuery(nextUri: string, headers: Record<string, string>): Promise<void> {
        try { await fetch(nextUri, { method: 'DELETE', headers }); }
        catch { /* the coordinator will time the query out on its own */ }
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

/**
 * Renders query output in the bottom panel beside Terminal and Output rather
 * than in an editor tab. The view is created lazily, so the first result has to
 * reveal it before its webview exists.
 */
interface ResultsState {
    connection: StoredConnection;
    result: TrinoQueryResult;
    limit: number;
    sql: string;
    milliseconds: number;
    executedAt: number;
    sort?: { column: number; direction: 'asc' | 'desc' };
    /** Memoised sort output, keyed so a repaint does not re-sort. */
    sortedRows?: unknown[][];
    sortedKey?: string;
    subtitle?: string;
    /** Re-runs the statement with a new LIMIT when the row cap is raised. */
    refetch?: (limit: number, token?: vscode.CancellationToken) => Promise<TrinoQueryResult>;
}

/** Rows in display order: sorted when a column is selected, then capped. */
function visibleRows(state: ResultsState): unknown[][] {
    if (!state.sort) { return state.result.rows.slice(0, state.limit); }
    // Re-sorting on every repaint (info toggle, limit change) would be wasted work.
    const key = `${state.sort.column}:${state.sort.direction}:${state.result.rows.length}`;
    if (state.sortedKey !== key || !state.sortedRows) {
        state.sortedRows = sortRows(state.result.rows, state.sort);
        state.sortedKey = key;
    }
    return state.sortedRows.slice(0, state.limit);
}

/**
 * Sorts by precomputing one key per row and ordering an index array, so each
 * value is converted once instead of once per comparison. Comparing indices
 * also avoids copying the row arrays around during the sort.
 */
function sortRows(rows: unknown[][], sort: { column: number; direction: 'asc' | 'desc' }): unknown[][] {
    const { column } = sort;
    const factor = sort.direction === 'asc' ? 1 : -1;
    const count = rows.length;
    const empty = new Uint8Array(count);
    const numbers = new Float64Array(count);
    let numeric = true;

    for (let index = 0; index < count; index++) {
        const value = rows[index][column];
        if (value === null || value === undefined || value === '') { empty[index] = 1; continue; }
        const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
        if (Number.isNaN(parsed)) { numeric = false; break; }
        numbers[index] = parsed;
    }

    const order = new Array<number>(count);
    for (let index = 0; index < count; index++) { order[index] = index; }
    // Nulls sort last in both directions so they never hide the real data.
    const emptiness = (a: number, b: number) => empty[a] && empty[b] ? 0 : empty[a] ? 1 : -1;

    if (numeric) {
        order.sort((a, b) => (empty[a] || empty[b]) ? emptiness(a, b) : (numbers[a] - numbers[b]) * factor);
    } else {
        // Plain comparison on a lowercased copy is far cheaper than a collator.
        // Emptiness is recomputed here: the numeric scan above stops early.
        const keys = new Array<string>(count);
        for (let index = 0; index < count; index++) {
            const value = rows[index][column];
            const isEmpty = value === null || value === undefined || value === '';
            empty[index] = isEmpty ? 1 : 0;
            keys[index] = isEmpty ? '' : (typeof value === 'string' ? value : String(value)).toLowerCase();
        }
        order.sort((a, b) => {
            if (empty[a] || empty[b]) { return emptiness(a, b); }
            const left = keys[a];
            const right = keys[b];
            return left < right ? -factor : left > right ? factor : 0;
        });
    }

    const sorted = new Array<unknown[]>(count);
    for (let index = 0; index < count; index++) { sorted[index] = rows[order[index]]; }
    return sorted;
}

interface ErrorState {
    connection: StoredConnection;
    sql: string;
    message: string;
    details?: string;
}

class ResultsViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'trinoResultsView';
    private view: vscode.WebviewView | undefined;
    private results: ResultsState | undefined;
    private failure: ErrorState | undefined;

    public resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.onDidReceiveMessage((message: unknown) => void this.handle(message));
        this.paint();
        view.onDidDispose(() => { this.view = undefined; });
    }

    public async showResults(state: ResultsState): Promise<void> {
        this.results = state;
        this.failure = undefined;
        await this.reveal();
        this.paint();
    }

    public async showError(state: ErrorState): Promise<void> {
        this.failure = state;
        this.results = undefined;
        await this.reveal();
        this.paint();
    }

    private async reveal(): Promise<void> {
        if (!this.view) {
            // Focusing the view forces VS Code to construct it, which resolves it above.
            await vscode.commands.executeCommand(`${ResultsViewProvider.viewId}.focus`, { preserveFocus: true });
        }
        this.view?.show(true);
    }

    private paint(): void {
        if (!this.view) { return; }
        const webview = this.view.webview;
        this.view.webview.html = this.failure
            ? queryErrorHtml(webview, this.failure)
            : this.results
                ? sqlResultsHtml(webview, this.results)
                : emptyResultsHtml(webview);
    }

    private async handle(message: unknown): Promise<void> {
        const request = message as { type?: string; value?: number; format?: string };
        if (!this.results || !request?.type) { return; }
        if (request.type === 'limit') {
            await this.applyLimit(Number(request.value));
        } else if (request.type === 'sort') {
            this.applySort(Number(request.value));
        } else if (request.type === 'download') {
            await exportResult(this.results, request.format === 'tsv' ? 'tsv' : 'csv');
        }
    }

    /** Cycles a column through ascending, descending, then unsorted. */
    private applySort(column: number): void {
        const state = this.results;
        if (!state || !Number.isInteger(column) || column < 0 || column >= state.result.columns.length) { return; }
        const current = state.sort;
        state.sort = current?.column !== column ? { column, direction: 'asc' }
            : current.direction === 'asc' ? { column, direction: 'desc' }
            : undefined;
        this.paint();
    }

    /** Raising the cap re-queries when the statement supports it; otherwise it just shows more of what was fetched. */
    private async applyLimit(requested: number): Promise<void> {
        if (!this.results || !Number.isFinite(requested)) { return; }
        const limit = clampRowLimit(requested);
        const state = this.results;
        if (state.refetch && limit > state.result.rows.length) {
            try {
                const started = Date.now();
                state.result = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Window, title: `Loading ${limit.toLocaleString()} rows…`, cancellable: true },
                    (_, token) => state.refetch!(limit, token)
                );
                state.milliseconds = Date.now() - started;
                state.executedAt = Date.now();
                state.sortedKey = undefined;
                state.sql = state.sql.replace(/LIMIT \d+$/, `LIMIT ${limit}`);
            } catch (error) {
                await this.showError({
                    connection: state.connection,
                    sql: '',
                    message: error instanceof Error ? error.message : String(error),
                    details: error instanceof TrinoRequestError ? error.details : undefined
                });
                return;
            }
        }
        state.limit = limit;
        this.paint();
    }
}

function clampRowLimit(value: number): number {
    return Math.min(Math.max(Math.trunc(value) || 1, 1), 10_000);
}

/** Writes the rows currently held in the view to a delimited file. */
async function exportResult(state: ResultsState, format: 'csv' | 'tsv'): Promise<void> {
    const rows = visibleRows(state);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = await vscode.window.showSaveDialog({
        saveLabel: `Export ${format.toUpperCase()}`,
        defaultUri: vscode.Uri.file(`trino-results-${stamp}.${format}`),
        filters: format === 'csv' ? { 'CSV files': ['csv'] } : { 'TSV files': ['tsv'] }
    });
    if (!target) { return; }
    const text = toDelimitedText(state.result.columns, rows, format);
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    const open = await vscode.window.showInformationMessage(
        `Exported ${rows.length.toLocaleString()} row(s) to ${target.fsPath}.`, 'Open File'
    );
    if (open) { await vscode.window.showTextDocument(target); }
}

function toDelimitedText(columns: string[], rows: unknown[][], format: 'csv' | 'tsv'): string {
    const delimiter = format === 'csv' ? ',' : '\t';
    const cell = (value: unknown): string => {
        if (value === null || value === undefined) { return ''; }
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        if (format === 'tsv') {
            // Tabs and newlines would break the row/column structure outright.
            return text.replace(/[\t\r\n]+/g, ' ');
        }
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [columns.map(cell).join(delimiter)];
    for (const row of rows) {
        lines.push(columns.map((_, index) => cell(row[index])).join(delimiter));
    }
    return `${lines.join('\r\n')}\r\n`;
}

/**
 * Completes catalog, schema, table, and column names from the active connection.
 * Metadata queries are cached briefly so typing does not hammer the coordinator.
 */
class SqlCompletionProvider implements vscode.CompletionItemProvider {
    private static readonly CACHE_MS = 5 * 60 * 1_000;
    private readonly cache = new Map<string, { at: number; names: string[] }>();

    public constructor(private readonly store: ConnectionStore, private readonly secrets: vscode.SecretStorage) {}

    public clear(): void { this.cache.clear(); }

    public async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<vscode.CompletionItem[]> {
        const connection = this.store.get(this.store.activeId);
        if (!connection) { return []; }
        const prefix = document.getText(new vscode.Range(position.line, 0, position.line, position.character));
        const qualifier = qualifierParts(prefix);
        const client = new TrinoClient(this.secrets, connection);

        try {
            if (qualifier.length === 0) {
                const catalogs = await this.lookup(`${connection.id}:catalogs`, () => client.catalogs());
                const items = catalogs.map(name => completionItem(name, vscode.CompletionItemKind.Module, 'catalog'));
                if (connection.catalog) {
                    const schemas = await this.lookup(`${connection.id}:${connection.catalog}`, () => client.schemas(connection.catalog!));
                    items.push(...schemas.map(name => completionItem(name, vscode.CompletionItemKind.Folder, `schema in ${connection.catalog}`)));
                }
                return items;
            }
            if (qualifier.length === 1) {
                const [first] = qualifier;
                const schemas = await this.lookup(`${connection.id}:${first}`, () => client.schemas(first));
                if (schemas.length) {
                    return schemas.map(name => completionItem(name, vscode.CompletionItemKind.Folder, `schema in ${first}`));
                }
                // Not a catalog — treat it as a schema inside the connection's default catalog.
                if (connection.catalog) {
                    const tables = await this.lookup(`${connection.id}:${connection.catalog}.${first}`, () => client.tables(connection.catalog!, first));
                    return tables.map(name => completionItem(name, vscode.CompletionItemKind.Struct, `table in ${first}`));
                }
                return [];
            }
            if (qualifier.length === 2) {
                const [catalog, schema] = qualifier;
                const tables = await this.lookup(`${connection.id}:${catalog}.${schema}`, () => client.tables(catalog, schema));
                return tables.map(name => completionItem(name, vscode.CompletionItemKind.Struct, `table in ${catalog}.${schema}`));
            }
            const [catalog, schema, table] = qualifier;
            const columns = await this.lookup(
                `${connection.id}:${catalog}.${schema}.${table}:columns`,
                async () => (await client.columns(catalog, schema, table)).map(column => `${column.name}\t${column.type}`)
            );
            return columns.map(entry => {
                // Split on the first tab only: types such as "row(a bigint)" contain spaces.
                const separator = entry.indexOf('\t');
                const name = separator < 0 ? entry : entry.slice(0, separator);
                const type = separator < 0 ? '' : entry.slice(separator + 1);
                return completionItem(name, vscode.CompletionItemKind.Field, type || 'column');
            });
        } catch {
            // Metadata is best effort; a failed lookup must not break typing.
            return [];
        }
    }

    private async lookup(key: string, load: () => Promise<string[]>): Promise<string[]> {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.at < SqlCompletionProvider.CACHE_MS) { return cached.names; }
        const names = await load();
        this.cache.set(key, { at: Date.now(), names });
        return names;
    }
}

/**
 * Returns the dotted qualifier immediately before the cursor, excluding the
 * partial word being typed: "from tpch.sf1.cus" yields ["tpch", "sf1"].
 */
function qualifierParts(linePrefix: string): string[] {
    const segments: string[] = [];
    let index = linePrefix.length;
    for (;;) {
        let start: number;
        if (index > 0 && linePrefix[index - 1] === '"') {
            // Quoted identifiers may contain dots and spaces, so scan to the opening quote.
            let cursor = index - 2;
            while (cursor >= 0) {
                if (linePrefix[cursor] === '"') {
                    if (cursor > 0 && linePrefix[cursor - 1] === '"') { cursor -= 2; continue; }
                    break;
                }
                cursor--;
            }
            if (cursor < 0) { break; }
            segments.unshift(linePrefix.slice(cursor + 1, index - 1).replace(/""/g, '"'));
            start = cursor;
        } else {
            let cursor = index;
            while (cursor > 0 && /[A-Za-z0-9_$]/.test(linePrefix[cursor - 1])) { cursor--; }
            segments.unshift(linePrefix.slice(cursor, index));
            start = cursor;
        }
        if (start > 0 && linePrefix[start - 1] === '.') { index = start - 1; continue; }
        break;
    }
    // The final segment is the partial word being typed, not part of the qualifier.
    segments.pop();
    return segments.filter(segment => segment.length > 0);
}

function completionItem(name: string, kind: vscode.CompletionItemKind, detail: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, kind);
    item.detail = detail;
    // Quote identifiers that would otherwise be invalid bare words.
    item.insertText = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
    return item;
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
    const results = new ResultsViewProvider();
    const completions = new SqlCompletionProvider(store, context.secrets);
    void store.migrateLegacyConnection();

    context.subscriptions.push(
        status,
        vscode.languages.registerCompletionItemProvider({ language: 'sql' }, completions, '.'),
        store.onDidChange(() => completions.clear()),
        vscode.window.registerTreeDataProvider('trinoCatalogs', provider),
        vscode.window.registerWebviewViewProvider(ResultsViewProvider.viewId, results, {
            webviewOptions: { retainContextWhenHidden: true }
        }),
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
        completions.clear();
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
        await previewTable(store, context.secrets, results, item, true);
    });
    register('trino.tableClicked', async (item?: ExplorerItem) => {
        await previewTable(store, context.secrets, results, item);
    });
    register('trino.openQuery', async () => { await openSqlQueryEditor(store); });
    register('trino.runActiveSql', async () => { await runActiveSql(store, context.secrets, status, results); });
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
async function previewTable(store: ConnectionStore, secrets: vscode.SecretStorage, results: ResultsViewProvider, item?: ExplorerItem, force = false): Promise<void> {
    const connection = store.get(item?.connectionId);
    if (!connection || !item?.catalog || !item.schema || !item.table) { return; }
    if (!force && !isDoubleClick(`${connection.id}/${item.catalog}/${item.schema}/${item.table}`)) { return; }
    const qualified = `${quoteIdentifier(item.catalog)}.${quoteIdentifier(item.schema)}.${quoteIdentifier(item.table)}`;
    const limit = previewRowLimit();
    const client = new TrinoClient(secrets, connection);
    const fetchRows = (rowLimit: number, token?: vscode.CancellationToken) =>
        client.query(`SELECT * FROM ${qualified} LIMIT ${rowLimit}`, token);
    const started = Date.now();
    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Loading ${item.table}…`, cancellable: true },
            (_, token) => fetchRows(limit, token)
        );
        await showSqlResults(
            results,
            result,
            connection,
            { sql: `SELECT * FROM ${qualified} LIMIT ${limit}`, milliseconds: Date.now() - started },
            fetchRows
        );
    } catch (error) {
        await showQueryError(results, error, connection, `SELECT * FROM ${qualified} LIMIT ${limit}`);
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

async function runActiveSql(store: ConnectionStore, secrets: vscode.SecretStorage, status: QueryStatusProvider, results: ResultsViewProvider): Promise<void> {
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
        const elapsed = Date.now() - started;
        status.record(editor.document.uri, { line, milliseconds: elapsed, rows: result.rows.length });
        await showSqlResults(results, result, connection, { sql, milliseconds: elapsed });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status.record(editor.document.uri, { line, milliseconds: Date.now() - started, rows: 0, error: summarize(message) });
        await showQueryError(results, error, connection, sql);
    }
}

function firstStatementLine(document: vscode.TextDocument): number {
    for (let line = 0; line < document.lineCount; line++) {
        const text = document.lineAt(line).text.trim();
        if (text && !text.startsWith('--')) { return line; }
    }
    return 0;
}

async function showSqlResults(
    results: ResultsViewProvider,
    result: TrinoQueryResult,
    connection: StoredConnection,
    query: { sql: string; milliseconds: number },
    refetch?: ResultsState['refetch']
): Promise<void> {
    await results.showResults({
        connection,
        result,
        limit: previewRowLimit(),
        sql: query.sql,
        milliseconds: query.milliseconds,
        executedAt: Date.now(),
        refetch
    });
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
        schema: existing?.schema ?? '',
        maxRows: existing?.maxRows ? String(existing.maxRows) : ''
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
            schema: request.schema.trim() || undefined,
            maxRows: parseMaxRows(request.maxRows)
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
async function showQueryError(results: ResultsViewProvider, error: unknown, connection: StoredConnection, sql: string): Promise<void> {
    await results.showError({
        connection,
        sql,
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof TrinoRequestError ? error.details : undefined
    });
}

function emptyResultsHtml(webview: vscode.Webview): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';"></head><body style="color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family);padding:14px">Run a query to see results here.</body></html>`;
}

function queryErrorHtml(webview: vscode.Webview, state: ErrorState): string {
    const { connection, sql, message, details } = state;
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const detailBlock = details && details.trim() && details.trim() !== message.trim()
        ? `<h2>Server response</h2><pre class="details">${escape(details)}</pre>`
        : '';
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{color:var(--vscode-foreground);font-family:var(--vscode-font-family);margin:0;padding:10px 14px;height:100%;box-sizing:border-box;overflow:auto}h1{font-size:1.05em;margin:0 0 4px;color:var(--vscode-errorForeground)}h2{font-size:.95em;margin:20px 0 6px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.04em}.note{margin:0 0 14px;color:var(--vscode-descriptionForeground)}pre{font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,13px);white-space:pre-wrap;word-break:break-word;padding:12px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));border-radius:3px;background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.1));margin:0}pre.message{border-left:3px solid var(--vscode-errorForeground)}</style></head><body><h1>Query failed</h1><p class="note">${escape(connection.name)} — ${escape(connection.url)}</p><pre class="message">${escape(message)}</pre>${detailBlock}${sql ? `<h2>Statement</h2><pre>${escape(sql)}</pre>` : ''}</body></html>`;
}

function sqlResultsHtml(webview: vscode.Webview, state: ResultsState): string {
    const { result, connection, limit } = state;
    const displayedRows = visibleRows(state);
    const nonce = String(Date.now());
    const escape = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const format = (value: unknown) => value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    const isNumeric = (value: unknown) => typeof value === 'number'
        || (typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value.trim()));
    const cell = (value: unknown) => {
        const text = format(value);
        const classes = value === null || value === undefined ? 'nul' : isNumeric(value) ? 'num' : '';
        const title = text.length > 60 ? ` title="${escape(text)}"` : '';
        return `<td class="${classes}"${title}>${escape(text)}</td>`;
    };
    const arrow = (index: number) => state.sort?.column === index ? (state.sort.direction === 'asc' ? ' ▲' : ' ▼') : '';
    const headers = `<th class="rownum"></th>${result.columns
        .map((column, index) => `<th class="sortable${state.sort?.column === index ? ' sorted' : ''}" data-col="${index}" title="Sort by ${escape(column)}">${escape(column)}<span class="arrow">${arrow(index)}</span></th>`)
        .join('')}`;
    const rows = displayedRows
        .map((row, index) => `<tr><th class="rownum">${index + 1}</th>${result.columns.map((_, column) => cell(row[column])).join('')}</tr>`)
        .join('');
    const fetched = result.rows.length;
    const note = state.subtitle ?? (fetched > displayedRows.length
        ? `${displayedRows.length.toLocaleString()} of ${fetched.toLocaleString()} rows`
        : `${fetched.toLocaleString()} row(s)`);
    const table = result.columns.length
        ? `<div class="results"><table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p>Statement completed. No rows returned.</p>';
    const info = [
        ['Connection', `${connection.name} (${connection.url})`],
        ['User', connection.user],
        ['Executed', new Date(state.executedAt).toLocaleString()],
        ['Duration', formatDuration(state.milliseconds)],
        ['Rows fetched', `${fetched.toLocaleString()}${result.truncated ? ` (capped at ${(result.maxRows ?? fetched).toLocaleString()})` : ''}`],
        ['Rows shown', `${displayedRows.length.toLocaleString()} (limit ${limit.toLocaleString()})`],
        ['Columns', String(result.columns.length)],
        ['Sorted by', state.sort ? `${result.columns[state.sort.column]} ${state.sort.direction === 'asc' ? 'ascending' : 'descending'}` : 'none']
    ].map(([label, value]) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join('');
    const infoPanel = `<div id="info" class="info" hidden><dl>${info}</dl>${state.sql ? `<div class="sqlwrap"><div class="sqllabel">Statement</div><pre>${escape(state.sql)}</pre></div>` : ''}</div>`;
    const capBanner = result.truncated
        ? `<div class="banner">Stopped at the ${(result.maxRows ?? fetched).toLocaleString()} row cap — the query had more rows. Raise <code>trino.query.maxRows</code>, or set a per-connection limit, to fetch more.</div>`
        : '';
    const toolbar = `<div class="bar"><span class="note"><b>${escape(connection.name)}</b> — ${note} · ${formatDuration(state.milliseconds)}</span><span class="spacer"></span><label for="limit">Limit</label><input id="limit" type="number" min="1" max="10000" step="50" value="${limit}" title="Maximum rows to display"><button id="info-toggle" class="ghost" title="Show query details">Info</button><button id="csv" title="Export displayed rows as CSV">CSV</button><button id="tsv" title="Export displayed rows as TSV">TSV</button></div>${capBanner}${infoPanel}`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>html,body{height:100%}body{display:flex;flex-direction:column;color:var(--vscode-foreground);font-family:var(--vscode-font-family);margin:0;padding:8px 12px;box-sizing:border-box;overflow:hidden}.bar{flex:0 0 auto;display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}.spacer{flex:1 1 auto}.note{color:var(--vscode-descriptionForeground);font-size:.9em}label{font-size:.9em;color:var(--vscode-descriptionForeground)}input{width:74px;padding:3px 6px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(128,128,128,.55));border-radius:2px}button{padding:3px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:2px;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}
button.ghost{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border,rgba(128,128,128,.45))}
button.ghost:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.18))}
.banner{flex:0 0 auto;margin:0 0 8px;padding:6px 10px;border-radius:3px;font-size:.9em;color:var(--vscode-inputValidation-warningForeground,var(--vscode-foreground));background:var(--vscode-inputValidation-warningBackground,rgba(190,145,23,.18));border:1px solid var(--vscode-inputValidation-warningBorder,rgba(190,145,23,.6))}
.banner code{background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.18));padding:0 4px;border-radius:2px}
.info{flex:0 0 auto;margin:0 0 8px;padding:10px 12px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));border-radius:4px;background:var(--vscode-textBlockQuote-background,rgba(128,128,128,.07));max-height:38%;overflow:auto}
.info dl{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;margin:0;font-size:.9em}
.info dt{color:var(--vscode-descriptionForeground);white-space:nowrap}
.info dd{margin:0}
.sqlwrap{margin-top:10px}
.sqllabel{color:var(--vscode-descriptionForeground);font-size:.85em;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
.info pre{margin:0;padding:8px 10px;white-space:pre-wrap;word-break:break-word;font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,12px);background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.12));border-radius:3px}
th.sortable{cursor:pointer}
th.sortable:hover{background-color:var(--vscode-list-hoverBackground,rgba(128,128,128,.2))}
th.sorted{color:var(--vscode-textLink-foreground,inherit)}
.arrow{font-size:.85em;opacity:.9}.results{flex:1 1 auto;min-height:0;overflow:auto;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));border-radius:4px}
table{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%;font-size:var(--vscode-editor-font-size,13px)}
thead th{position:sticky;top:0;z-index:2;background-color:var(--vscode-panel-background,var(--vscode-editor-background,#1f1f1f));background-clip:padding-box;box-shadow:0 1px 0 var(--vscode-panel-border,rgba(128,128,128,.4));border-right:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));font-weight:600;text-align:left;white-space:nowrap;padding:7px 14px 7px 12px;letter-spacing:.01em}
tbody td{padding:5px 12px;vertical-align:top;max-width:460px;overflow:hidden;text-overflow:ellipsis;white-space:pre-wrap;word-break:break-word;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.16));border-right:1px solid var(--vscode-panel-border,rgba(128,128,128,.24))}
tbody tr td:last-child,thead th:last-child{border-right:0}
tbody tr:nth-child(even){background:var(--vscode-tree-tableOddRowsBackground,rgba(128,128,128,.055))}
tbody tr:hover{background:var(--vscode-list-hoverBackground,rgba(128,128,128,.13))}
tbody tr:last-child td,tbody tr:last-child th{border-bottom:0}
.rownum{position:sticky;left:0;z-index:1;width:1%;white-space:nowrap;background-color:var(--vscode-panel-background,var(--vscode-editor-background,#1f1f1f));background-clip:padding-box;color:var(--vscode-editorLineNumber-foreground,rgba(128,128,128,.8));font-weight:400;text-align:right;padding:5px 8px;user-select:none;box-shadow:1px 0 0 var(--vscode-panel-border,rgba(128,128,128,.3));font-variant-numeric:tabular-nums}
thead .rownum{z-index:3}
.grip{position:absolute;top:0;right:0;width:7px;height:100%;cursor:col-resize;user-select:none}
.grip:hover,.grip.active{background:var(--vscode-focusBorder,rgba(128,128,128,.7))}
td.num{text-align:right;font-family:var(--vscode-editor-font-family,monospace);font-variant-numeric:tabular-nums}
td.nul{color:var(--vscode-descriptionForeground);font-style:italic;opacity:.75}</style></head><body>${toolbar}${table}<script nonce="${nonce}">const vscode=acquireVsCodeApi();const box=document.getElementById('limit');const send=()=>{const v=Number(box.value);if(Number.isFinite(v)&&v>0)vscode.postMessage({type:'limit',value:v});};box.addEventListener('change',send);box.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();send();}});document.getElementById('csv').addEventListener('click',()=>vscode.postMessage({type:'download',format:'csv'}));document.getElementById('tsv').addEventListener('click',()=>vscode.postMessage({type:'download',format:'tsv'}));
const info=document.getElementById('info');document.getElementById('info-toggle').addEventListener('click',()=>{info.hidden=!info.hidden;});
document.querySelectorAll('thead th.sortable').forEach(th=>{th.addEventListener('click',e=>{if(e.target.classList.contains('grip'))return;vscode.postMessage({type:'sort',value:Number(th.dataset.col)});});});
document.querySelectorAll('thead th:not(.rownum)').forEach(th=>{const grip=document.createElement('span');grip.className='grip';th.appendChild(grip);grip.addEventListener('mousedown',e=>{e.preventDefault();e.stopPropagation();const startX=e.clientX;const startWidth=th.offsetWidth;grip.classList.add('active');document.body.style.cursor='col-resize';const move=ev=>{const width=Math.max(48,startWidth+ev.clientX-startX);th.style.width=width+'px';th.style.minWidth=width+'px';th.style.maxWidth=width+'px';};const stop=()=>{grip.classList.remove('active');document.body.style.cursor='';document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',stop);};document.addEventListener('mousemove',move);document.addEventListener('mouseup',stop);});grip.addEventListener('dblclick',e=>{e.preventDefault();th.style.width='';th.style.minWidth='';th.style.maxWidth='';});});</script></body></html>`;
}

interface ConnectionFormData {
    name: string;
    host: string;
    port: string;
    sslEnabled: boolean;
    user: string;
    catalog: string;
    schema: string;
    maxRows: string;
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

/** Blank means "use the global cap", so an empty field stores nothing. */
function parseMaxRows(value: string): number | undefined {
    const parsed = Number(value.trim());
    return value.trim() && Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
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
    const forgetRow = hasPassword
        ? '<label class="switch small"><input id="clearPassword" type="checkbox"><span class="track"></span><span class="switch-label">Forget the saved password</span></label>'
        : '<input id="clearPassword" type="checkbox" hidden>';
    const advancedOpen = values.catalog || values.schema || values.maxRows ? ' open' : '';

    const styles = `
:root{--gap:18px;--radius:6px}
*{box-sizing:border-box}
body{color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px;margin:0;padding:28px 20px 96px}
.page{max-width:640px;margin:0 auto}
.head{display:flex;align-items:flex-start;gap:14px;margin-bottom:22px}
.badge{flex:0 0 auto;width:38px;height:38px;border-radius:10px;display:grid;place-items:center;font-size:17px;font-weight:700;color:#fff;background:linear-gradient(135deg,#2f7ce0,#1f4fa8);box-shadow:0 2px 8px rgba(0,0,0,.25)}
h1{font-size:1.32em;margin:0 0 4px;font-weight:600;letter-spacing:-.01em}
.sub{margin:0;color:var(--vscode-descriptionForeground);line-height:1.5}
.card{border:1px solid var(--vscode-panel-border,rgba(128,128,128,.32));border-radius:var(--radius);background:var(--vscode-editorWidget-background,rgba(128,128,128,.05));padding:16px 18px 20px;margin-bottom:14px}
.card-title{display:flex;align-items:center;gap:8px;font-size:.78em;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--vscode-descriptionForeground);margin:0 0 14px}
.card-title::after{content:"";flex:1 1 auto;height:1px;background:var(--vscode-panel-border,rgba(128,128,128,.25))}
.field{margin-bottom:var(--gap)}
.field:last-child{margin-bottom:0}
label.lbl{display:block;margin:0 0 6px;font-weight:600}
.req{color:var(--vscode-charts-red,#e5534b);margin-left:2px}
input[type=text],input[type=password],input[type=number],input:not([type]){width:100%;padding:7px 10px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(128,128,128,.5));border-radius:4px;font-family:inherit;font-size:13px;transition:border-color .12s,box-shadow .12s}
input::placeholder{color:var(--vscode-input-placeholderForeground,rgba(128,128,128,.75))}
input:hover{border-color:var(--vscode-inputOption-hoverBackground,rgba(128,128,128,.7))}
input:focus{outline:none;border-color:var(--vscode-focusBorder,#2f7ce0);box-shadow:0 0 0 2px color-mix(in srgb,var(--vscode-focusBorder,#2f7ce0) 30%,transparent)}
.hint{margin:6px 0 0;font-size:.9em;color:var(--vscode-descriptionForeground);line-height:1.45}
.row{display:grid;grid-template-columns:minmax(0,1fr) 130px;gap:12px}
.switch{display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none;margin:0}
.switch input{position:absolute;opacity:0;width:0;height:0}
.track{position:relative;flex:0 0 auto;width:34px;height:19px;border-radius:19px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(128,128,128,.6));transition:background .15s,border-color .15s}
.track::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--vscode-descriptionForeground);transition:transform .15s,background .15s}
.switch input:checked+.track{background:var(--vscode-button-background,#2f7ce0);border-color:var(--vscode-button-background,#2f7ce0)}
.switch input:checked+.track::after{transform:translateX(15px);background:var(--vscode-button-foreground,#fff)}
.switch input:focus-visible+.track{box-shadow:0 0 0 2px color-mix(in srgb,var(--vscode-focusBorder,#2f7ce0) 45%,transparent)}
.switch-label{font-weight:600}
.switch.small .switch-label{font-weight:400;color:var(--vscode-descriptionForeground)}
.switch.small{margin-top:10px}
details{border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.22));margin-top:2px;padding-top:12px}
summary{cursor:pointer;font-weight:600;list-style:none;display:flex;align-items:center;gap:7px;color:var(--vscode-foreground)}
summary::-webkit-details-marker{display:none}
summary::before{content:"\\25B8";display:inline-block;transition:transform .15s;color:var(--vscode-descriptionForeground)}
details[open] summary::before{transform:rotate(90deg)}
.details-body{margin-top:16px}
code{background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.16));padding:1px 5px;border-radius:3px;font-family:var(--vscode-editor-font-family,monospace);font-size:.92em}
.alert{display:none;align-items:flex-start;gap:8px;margin-bottom:14px;padding:9px 12px;border-radius:4px;color:var(--vscode-inputValidation-errorForeground,var(--vscode-foreground));background:var(--vscode-inputValidation-errorBackground,rgba(190,60,60,.16));border:1px solid var(--vscode-inputValidation-errorBorder,rgba(190,60,60,.7))}
.alert.show{display:flex}
.alert::before{content:"\\26A0";flex:0 0 auto}
.actions{position:fixed;left:0;right:0;bottom:0;display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;background:var(--vscode-editor-background,#1f1f1f);border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.3))}
.actions-inner{width:100%;max-width:640px;margin:0 auto;display:flex;justify-content:flex-end;gap:10px}
button{padding:7px 18px;border:0;border-radius:4px;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button:hover{background:var(--vscode-button-hoverBackground)}
button.secondary{color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));background:var(--vscode-button-secondaryBackground,transparent);border:1px solid var(--vscode-panel-border,rgba(128,128,128,.45))}
button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground,rgba(128,128,128,.16))}
button:focus-visible{outline:2px solid var(--vscode-focusBorder,#2f7ce0);outline-offset:2px}
@media(max-width:520px){.row{grid-template-columns:1fr}}`;

    const body = `
<div class="page">
  <div class="head">
    <div class="badge">T</div>
    <div>
      <h1>${isEdit ? 'Edit connection' : 'New Trino connection'}</h1>
      <p class="sub">Point the explorer at a Trino coordinator. You can paste a full <code>http(s)://</code> or <code>jdbc:trino://</code> URL into Host and the rest fills itself in.</p>
    </div>
  </div>
  <div id="error" class="alert" role="alert"></div>
  <form id="connection">
    <section class="card">
      <h2 class="card-title">Coordinator</h2>
      <div class="field">
        <label class="lbl" for="name">Connection name</label>
        <input id="name" value="${escape(values.name)}" placeholder="Development Trino">
        <p class="hint">Shown in the Connections view.</p>
      </div>
      <div class="field row">
        <div>
          <label class="lbl" for="host">Host<span class="req">*</span></label>
          <input id="host" value="${escape(values.host)}" placeholder="trino.example.com" required>
        </div>
        <div>
          <label class="lbl" for="port">Port<span class="req">*</span></label>
          <input id="port" type="number" min="1" max="65535" value="${escape(values.port)}" required>
        </div>
      </div>
      <label class="switch">
        <input id="sslEnabled" type="checkbox" ${values.sslEnabled ? 'checked' : ''}>
        <span class="track"></span>
        <span class="switch-label">Enable SSL / HTTPS</span>
      </label>
      <p class="hint">Required when the coordinator serves TLS. Ports 443 and 8443 enable this automatically.</p>
    </section>

    <section class="card">
      <h2 class="card-title">Authentication</h2>
      <div class="field">
        <label class="lbl" for="user">User<span class="req">*</span></label>
        <input id="user" value="${escape(values.user)}" required placeholder="your.username">
        <p class="hint">Sent as the <code>X-Trino-User</code> header.</p>
      </div>
      <div class="field">
        <label class="lbl" for="password">Password</label>
        <input id="password" type="password" autocomplete="new-password" placeholder="${passwordHint}">
        <p class="hint">Stored in VS Code Secret Storage, never in settings.json.</p>
        ${forgetRow}
      </div>
    </section>

    <section class="card">
      <details${advancedOpen}>
        <summary>Session defaults and limits</summary>
        <div class="details-body">
          <div class="field row">
            <div>
              <label class="lbl" for="catalog">Default catalog</label>
              <input id="catalog" value="${escape(values.catalog)}" placeholder="hive">
            </div>
            <div>
              <label class="lbl" for="schema">Default schema</label>
              <input id="schema" value="${escape(values.schema)}" placeholder="default">
            </div>
          </div>
          <div class="field">
            <label class="lbl" for="maxRows">Maximum rows to fetch</label>
            <input id="maxRows" type="number" min="1" max="1000000" value="${escape(values.maxRows)}" placeholder="Leave blank to use the global setting">
            <p class="hint">Caps how many rows are pulled from a single statement. Blank uses <code>trino.query.maxRows</code>.</p>
          </div>
        </div>
      </details>
    </section>
  </form>
</div>
<div class="actions">
  <div class="actions-inner">
    <button type="submit" form="connection" class="secondary" data-connect="false">Save</button>
    <button type="submit" form="connection" data-connect="true">Save &amp; Connect</button>
  </div>
</div>`;

    const script = `const vscode=acquireVsCodeApi();let connect=true;
document.querySelectorAll('button[type=submit]').forEach(b=>b.addEventListener('click',()=>{connect=b.dataset.connect==='true';}));
document.getElementById('connection').addEventListener('submit',e=>{e.preventDefault();const byId=id=>document.getElementById(id);
vscode.postMessage({type:'save',name:byId('name').value,host:byId('host').value,port:byId('port').value,sslEnabled:byId('sslEnabled').checked,user:byId('user').value,password:byId('password').value,clearPassword:byId('clearPassword').checked,catalog:byId('catalog').value,schema:byId('schema').value,maxRows:byId('maxRows').value,connect});});
window.addEventListener('message',e=>{if(e.data.type==='error'){const box=document.getElementById('error');box.textContent=e.data.message;box.classList.add('show');box.scrollIntoView({block:'nearest'});}});
document.getElementById('host').focus();`;

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Trino Connection</title><style>${styles}</style></head><body>${body}<script nonce="${nonce}">${script}</script></body></html>`;
}

function showConnectionError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not load Trino catalogs: ${message}`, 'Edit Connection')
        .then(selection => { if (selection) { void vscode.commands.executeCommand('trino.editConnection'); } });
}

export function deactivate(): void {}
