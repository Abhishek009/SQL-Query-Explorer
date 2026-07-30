import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ResultsState, StoredConnection, TrinoQueryResult, TrinoRequestError } from './types';
import { ConnectionStore, passwordKey } from './connectionStore';
import { TrinoClient } from './trinoClient';
import { ExplorerItem, TrinoExplorerProvider } from './explorer';
import { ResultsViewProvider } from './resultsView';
import { QueryStatusProvider } from './queryStatus';
import { RunningQueryRegistry } from './runningQueries';
import { ConnectionMessage, connectionFormHtml, expandPastedUrl, isConnectionMessage, parseMaxRows, validateConnection } from './connectionForm';
import { formatHost, parseConnectionUrl } from './urls';
import { previewRowLimit, quoteIdentifier, showConnectionError, summarize } from './util';

export async function pickConnection(store: ConnectionStore, placeHolder: string): Promise<StoredConnection | undefined> {
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
export async function resolveConnection(store: ConnectionStore): Promise<StoredConnection | undefined> {
    const active = store.get(store.activeId);
    if (active) { return active; }
    const connection = await pickConnection(store, 'Select a Trino connection');
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
export async function previewTable(store: ConnectionStore, secrets: vscode.SecretStorage, results: ResultsViewProvider, registry: RunningQueryRegistry, item?: ExplorerItem, force = false): Promise<void> {
    const connection = store.get(item?.connectionId);
    if (!connection || !item?.catalog || !item.schema || !item.table) { return; }
    if (!force && !isDoubleClick(`${connection.id}/${item.catalog}/${item.schema}/${item.table}`)) { return; }
    const qualified = `${quoteIdentifier(item.catalog)}.${quoteIdentifier(item.schema)}.${quoteIdentifier(item.table)}`;
    const limit = previewRowLimit();
    const client = new TrinoClient(secrets, connection, registry);
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
    results: ResultsViewProvider,
    registry: RunningQueryRegistry,
    item?: ExplorerItem
): Promise<void> {
    const connection = store.get(item?.connectionId);
    if (!connection || !item?.catalog || !item.schema || !item.table) { return; }
    const qualified = `${quoteIdentifier(item.catalog)}.${quoteIdentifier(item.schema)}.${quoteIdentifier(item.table)}`;
    try {
        const ddl = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Fetching DDL for ${item.table}…`, cancellable: true },
            (_, token) => new TrinoClient(secrets, connection, registry).tableDdl(item.catalog!, item.schema!, item.table!, token)
        );
        if (!ddl) {
            vscode.window.showWarningMessage(`Trino returned no DDL for ${item.catalog}.${item.schema}.${item.table}.`);
            return;
        }
        const document = await vscode.workspace.openTextDocument({
            language: 'sql',
            content: `-- ${item.catalog}.${item.schema}.${item.table}\n-- ${connection.name} · ${new Date().toLocaleString()}\n\n${ddl}\n`
        });
        await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
        await showQueryError(results, error, connection, `SHOW CREATE TABLE ${qualified}`);
    }
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

export async function runActiveSql(store: ConnectionStore, secrets: vscode.SecretStorage, status: QueryStatusProvider, results: ResultsViewProvider, registry: RunningQueryRegistry): Promise<void> {
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
            { location: vscode.ProgressLocation.Notification, title: `Running query on ${connection.name}…`, cancellable: true },
            (_, token) => new TrinoClient(secrets, connection, registry).query(sql, token)
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

export function firstStatementLine(document: vscode.TextDocument): number {
    for (let line = 0; line < document.lineCount; line++) {
        const text = document.lineAt(line).text.trim();
        if (text && !text.startsWith('--')) { return line; }
    }
    return 0;
}

export async function showSqlResults(
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

export async function showConnectionWindow(
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
export async function showQueryError(results: ResultsViewProvider, error: unknown, connection: StoredConnection, sql: string): Promise<void> {
    await results.showError({
        connection,
        sql,
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof TrinoRequestError ? error.details : undefined
    });
}
