import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ErrorState, ResultsState, StoredConnection, TrinoQueryResult, TrinoRequestError } from './types';
import { ConnectionStore, passwordKey } from './connectionStore';
import { SqlClient, createClient } from './client';
import { ExplorerItem, TrinoExplorerProvider, qualifiedName } from './explorer';
import { ResultsSurface, ResultsTabs } from './resultsView';
import { QueryStatusProvider } from './queryStatus';
import { RunningQueryRegistry } from './runningQueries';
import { ConnectionMessage, connectionFormHtml, expandPastedUrl, isConnectionMessage, parseMaxRows, validateConnection } from './connectionForm';
import { formatHost, parseConnectionUrl } from './urls';
import { engineOf, ENGINE_LABELS } from './client';
import { PostgresClient, hostAndPort } from './postgresClient';
import { previewRowLimit, quoteIdentifier, showConnectionError, summarize } from './util';

export async function pickConnection(store: ConnectionStore, placeHolder: string): Promise<StoredConnection | undefined> {
    const connections = store.all();
    if (!connections.length) {
        vscode.window.showErrorMessage('Add a connection first.', 'Add Connection')
            .then(selection => { if (selection) { void vscode.commands.executeCommand('sqlExplorer.addConnection'); } });
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
export async function resolveConnection(store: ConnectionStore): Promise<StoredConnection | undefined> {
    const active = store.get(store.activeId);
    if (active) { return active; }
    const connection = await pickConnection(store, 'Select a connection');
    if (connection) { await store.setActive(connection.id); }
    return connection;
}

export const DOUBLE_CLICK_MS = 500;

export let lastClick: { key: string; at: number } | undefined;

/**
 * The tree API has no double-click event and fires TreeItem.command on every
 * click, so treat two clicks on the same table within DOUBLE_CLICK_MS as one.
 */
export function isDoubleClick(key: string): boolean {
    const now = Date.now();
    const repeated = lastClick?.key === key && now - lastClick.at <= DOUBLE_CLICK_MS;
    lastClick = repeated ? undefined : { key, at: now };
    return repeated;
}

/** Runs a bounded SELECT for the clicked table and shows it in the results grid. */
export async function previewTable(store: ConnectionStore, secrets: vscode.SecretStorage, tabs: ResultsTabs, registry: RunningQueryRegistry, item?: ExplorerItem, force = false): Promise<void> {
    const connection = store.get(item?.connectionId);
    if (!connection || !item?.catalog || !item.schema || !item.table) { return; }
    const results = tabs.primary(`${item.schema}.${item.table}`);
    if (!force && !isDoubleClick(`${connection.id}/${item.catalog}/${item.schema}/${item.table}`)) { return; }
    const qualified = `${quoteIdentifier(item.catalog)}.${quoteIdentifier(item.schema)}.${quoteIdentifier(item.table)}`;
    const limit = previewRowLimit();
    const client = createClient(secrets, connection, registry);
    const fetchRows = (rowLimit: number, token?: vscode.CancellationToken) =>
        client.query(`SELECT * FROM ${qualified} LIMIT ${rowLimit}`, token);
    const started = Date.now();
    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Loading ${item.table}…`, cancellable: true },
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

/** Opens SHOW CREATE TABLE output in a SQL editor so it can be read and copied. */
export async function showTableDdl(
    store: ConnectionStore,
    secrets: vscode.SecretStorage,
    tabs: ResultsTabs,
    registry: RunningQueryRegistry,
    item?: ExplorerItem
): Promise<void> {
    const connection = store.get(item?.connectionId);
    if (!connection || !item?.catalog || !item.schema || !item.table) { return; }
    const results = tabs.primary(`${item.schema}.${item.table}`);
    const qualified = `${quoteIdentifier(item.catalog)}.${quoteIdentifier(item.schema)}.${quoteIdentifier(item.table)}`;
    const isView = item.contextValue === 'sqlExplorer.view';
    try {
        const ddl = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Fetching DDL for ${item.table}…`, cancellable: true },
            (_, token) => createClient(secrets, connection, registry).tableDdl(item.catalog!, item.schema!, item.table!, isView, token)
        );
        if (!ddl) {
            vscode.window.showWarningMessage(`No DDL returned for ${item.catalog}.${item.schema}.${item.table}.`);
            return;
        }
        const document = await vscode.workspace.openTextDocument({
            language: 'sql',
            content: `-- ${item.catalog}.${item.schema}.${item.table}\n-- ${connection.name} · ${new Date().toLocaleString()}\n\n${ddl}\n`
        });
        await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
        await showQueryError(results, error, connection, `SHOW CREATE ${isView ? 'VIEW' : 'TABLE'} ${qualified}`);
    }
}

/**
 * Opens a SQL editor already scoped to the node it was launched from, and makes
 * that node's connection active so Cmd+Enter runs against the right coordinator.
 */
export async function openScopedQuery(store: ConnectionStore, item?: ExplorerItem): Promise<void> {
    const connection = store.get(item?.connectionId);
    if (!connection || !item) { return; }
    await store.setActive(connection.id);

    const scope = qualifiedName(item);
    const body = item.kind === 'table'
        ? `SELECT *\nFROM ${scope}\nLIMIT ${previewRowLimit()};\n`
        // Ends on the dot so completion offers the next level straight away.
        : scope ? `SELECT *\nFROM ${scope}.` : '';
    const document = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: `-- Connection: ${connection.name}\n\n${body}`
    });
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const end = document.lineAt(document.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
}

export async function openSqlQueryEditor(store: ConnectionStore): Promise<void> {
    const connection = await resolveConnection(store);
    if (!connection) { return; }
    const document = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: `-- Connection: ${connection.name}\nSELECT *\nFROM system.runtime.nodes\nLIMIT 10;`
    });
    await vscode.window.showTextDocument(document, { preview: false });
}

export async function runActiveSql(store: ConnectionStore, secrets: vscode.SecretStorage, status: QueryStatusProvider, tabs: ResultsTabs, registry: RunningQueryRegistry): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
        vscode.window.showErrorMessage('Open a SQL query editor before running a query.');
        return;
    }
    const selectedSql = editor.document.getText(editor.selection).trim();
    const sql = selectedSql || editor.document.getText();
    // Anchor the timing above the statement that ran: the selection, or the
    // first non-empty line when the whole editor is executed.
    const line = selectedSql ? editor.selection.start.line : firstStatementLine(editor.document);
    await executeSql({ store, secrets, status, registry, surface: tabs.primary(tabTitle(sql)), sql, line, uri: editor.document.uri });
}

export interface ExecuteRequest {
    store: ConnectionStore;
    secrets: vscode.SecretStorage;
    status: QueryStatusProvider;
    registry: RunningQueryRegistry;
    /** Where the grid is drawn: the shared panel, or a dedicated tab. */
    surface: ResultsSurface;
    sql: string;
    line: number;
    uri: vscode.Uri;
}

/** One execution path for every entry point, so timing and errors stay uniform. */
export async function executeSql(request: ExecuteRequest): Promise<void> {
    const { store, secrets, status, registry, surface, sql, line, uri } = request;
    const connection = await resolveConnection(store);
    if (!connection) { return; }
    const started = Date.now();
    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Running query on ${connection.name}…`, cancellable: true },
            (_, token) => createClient(secrets, connection, registry).query(sql, token)
        );
        const elapsed = Date.now() - started;
        status.record(uri, { line, milliseconds: elapsed, rows: result.rows.length });
        await surface.showResults({
            connection,
            result,
            limit: previewRowLimit(),
            sql,
            milliseconds: elapsed,
            executedAt: Date.now()
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status.record(uri, { line, milliseconds: Date.now() - started, rows: 0, error: summarize(message) });
        await surface.showError({
            connection,
            sql,
            message,
            details: error instanceof TrinoRequestError ? error.details : undefined
        });
    }
}

/** Runs one statement from a CodeLens, optionally into its own results tab. */
export async function runStatement(
    store: ConnectionStore,
    secrets: vscode.SecretStorage,
    status: QueryStatusProvider,
    tabs: ResultsTabs,
    registry: RunningQueryRegistry,
    args?: { uri?: string; sql?: string; line?: number },
    newTab = false
): Promise<void> {
    if (!args?.sql || !args.uri) { return; }
    const title = tabTitle(args.sql);
    const surface = newTab ? tabs.additional(title) : tabs.primary(title);
    await executeSql({
        store, secrets, status, registry, surface,
        sql: args.sql, line: args.line ?? 0, uri: vscode.Uri.parse(args.uri)
    });
}

/** A short, recognisable tab name taken from the statement itself. */
export function tabTitle(sql: string): string {
    // A qualified name whose parts may be quoted, so "order details" survives.
    const part = '(?:"(?:[^"]|"")*"|[A-Za-z0-9_$]+)';
    const from = new RegExp(`\\bfrom\\s+(${part}(?:\\.${part})*)`, 'i').exec(sql)?.[1];
    const parts = from?.match(new RegExp(part, 'g'))
        ?.map(name => name.replace(/^"|"$/g, '').replace(/""/g, '"')) ?? [];
    // The last two levels identify the table without the noise of the catalog.
    return parts.length ? parts.slice(-2).join('.') : 'Results';
}

export function firstStatementLine(document: vscode.TextDocument): number {
    for (let line = 0; line < document.lineCount; line++) {
        const text = document.lineAt(line).text.trim();
        if (text && !text.startsWith('--')) { return line; }
    }
    return 0;
}

export async function showSqlResults(
    results: ResultsSurface,
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

/** Turns the form fields into a connection, in the shape each engine expects. */
export function connectionFromForm(request: ConnectionMessage, id: string): StoredConnection {
    const host = formatHost(request.host.trim());
    const port = request.port.trim();
    const postgres = request.engine === 'postgres';
    return {
        id,
        name: request.name.trim() || (postgres ? 'PostgreSQL Connection' : 'Trino Connection'),
        type: request.engine,
        // Postgres keeps its database in `catalog`, which is also the tree's top level.
        url: postgres ? `postgresql://${host}:${port}` : `${request.sslEnabled ? 'https' : 'http'}://${host}:${port}`,
        user: request.user.trim(),
        catalog: postgres ? (request.database.trim() || 'postgres') : (request.catalog.trim() || undefined),
        schema: postgres ? undefined : (request.schema.trim() || undefined),
        ssl: postgres ? request.sslEnabled : undefined,
        maxRows: parseMaxRows(request.maxRows)
    };
}

/**
 * Runs a real query against the entered details without saving anything. The
 * typed password is passed straight through, since it is not in storage yet.
 */
async function reportConnectionTest(
    panel: vscode.WebviewPanel,
    secrets: vscode.SecretStorage,
    candidate: StoredConnection,
    password: string
): Promise<void> {
    const label = ENGINE_LABELS[engineOf(candidate)];
    try {
        const banner = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Testing ${candidate.name}…`, cancellable: true },
            (_, token) => createClient(secrets, candidate, undefined, password || undefined).testConnection(token)
        );
        void panel.webview.postMessage({
            type: 'testResult', ok: true,
            message: `Connected to ${label} at ${candidate.url}\n${banner}`
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void panel.webview.postMessage({ type: 'testResult', ok: false, message: summarize(message) });
    } finally {
        // A test must not leave a pooled socket behind for an unsaved connection.
        await PostgresClient.closeAll(candidate.id);
    }
}

export async function showConnectionWindow(
    context: vscode.ExtensionContext,
    store: ConnectionStore,
    provider: TrinoExplorerProvider,
    existing: StoredConnection | undefined
): Promise<void> {
    const engine = engineOf(existing ?? { type: 'trino' } as StoredConnection);
    const current = engine === 'postgres'
        ? { ...hostAndPort(existing?.url ?? 'postgresql://localhost:5432'), sslEnabled: Boolean(existing?.ssl) }
        : parseConnectionUrl(existing?.url ?? 'http://localhost:8080');
    const panel = vscode.window.createWebviewPanel(
        'trinoConnection',
        existing ? `Edit ${existing.name}` : 'New Trino Connection',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );
    const hasPassword = existing ? Boolean(await context.secrets.get(passwordKey(existing.id))) : false;
    panel.webview.html = connectionFormHtml(panel.webview, {
        name: existing?.name ?? 'New Connection',
        engine,
        host: current.host,
        port: String(current.port),
        sslEnabled: current.sslEnabled,
        user: existing?.user ?? '',
        catalog: engine === 'postgres' ? '' : (existing?.catalog ?? ''),
        schema: existing?.schema ?? '',
        database: engine === 'postgres' ? (existing?.catalog ?? '') : '',
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
        const candidate = connectionFromForm(request, id);
        const url = candidate.url;

        if (request.type === 'test') {
            await reportConnectionTest(panel, context.secrets, candidate, request.password);
            return;
        }

        await store.save(candidate);
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
export async function showQueryError(results: ResultsSurface, error: unknown, connection: StoredConnection, sql: string): Promise<void> {
    await results.showError({
        connection,
        sql,
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof TrinoRequestError ? error.details : undefined
    });
}
