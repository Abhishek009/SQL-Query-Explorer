import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { ErrorState, ResultsState, StoredConnection, TrinoQueryResult, TrinoRequestError } from './types';
import { ConnectionStore, passwordKey } from './connectionStore';
import { SqlClient, createClient } from './client';
import { ExplorerItem, TrinoExplorerProvider, qualifiedName } from './explorer';
import { ResultsSurface, ResultsTabs } from './resultsView';
import { QueryStatusProvider } from './queryStatus';
import { QueryScope } from './queryScope';
import { RunningQueryRegistry } from './runningQueries';
import { ConnectionMessage, connectionFormHtml, isBrowseFileMessage, isCheckRuntimeMessage, isConnectionMessage, isCreateFileMessage, isInstallRuntimeMessage, parseMaxRows, validateConnection } from './connectionForm';
import { createEmptyDatabase } from './engines/sqlite/sqliteClient';
import { isSqliteInstalled, installSqlite } from './engines/sqlite/sqliteRuntime';
import { createEmptyDuckdb } from './engines/duckdb/duckdbClient';
import { installDuckdb, isDuckdbInstalled } from './engines/duckdb/duckdbRuntime';
import { addressesByDatabase, closeAllClients, engineOf, ENGINE_LABELS } from './client';
import { expandPastedUrl, parseConnectionUrl } from './engines/trino/trinoUrls';
import { hostAndPort } from './engines/postgres/postgresClient';
import { expandPastedSupabaseUrl } from './engines/supabase/supabaseUrls';
import { formatHost, previewRowLimit, quoteIdentifier, showConnectionError, summarize } from './util';

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
    const limit = previewRowLimit();
    const client = createClient(secrets, connection, registry);
    const { catalog, schema, table } = item;
    const fetchRows = (rowLimit: number, token?: vscode.CancellationToken) =>
        client.previewTable(catalog, schema, table, rowLimit, token);
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
            { sql: client.previewSql(catalog, schema, table, limit), milliseconds: Date.now() - started },
            fetchRows
        );
    } catch (error) {
        await showQueryError(results, error, connection, client.previewSql(catalog, schema, table, limit));
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

/** Drops a table after confirmation, then refreshes its parent group so it disappears from the tree. */
export async function dropTable(
    store: ConnectionStore,
    secrets: vscode.SecretStorage,
    provider: TrinoExplorerProvider,
    tabs: ResultsTabs,
    registry: RunningQueryRegistry,
    item?: ExplorerItem
): Promise<void> {
    const connection = store.get(item?.connectionId);
    if (!connection || !item?.catalog || !item.schema || !item.table || item.contextValue !== 'sqlExplorer.table') { return; }
    const { catalog, schema, table } = item;
    const tableLabel = `${schema}.${table}`;
    const confirmed = await vscode.window.showWarningMessage(
        `Drop the table "${tableLabel}"? This cannot be undone.`, { modal: true }, 'Drop Table'
    );
    if (confirmed !== 'Drop Table') { return; }

    const client = createClient(secrets, connection, registry);
    const qualified = client.qualify(catalog, schema, table);
    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Dropping ${tableLabel}…` },
            () => client.query(`DROP TABLE ${qualified}`, undefined, catalog)
        );
        await provider.refreshItem(ExplorerItem.group(connection.id, catalog, schema, 'tables', 0));
        vscode.window.showInformationMessage(`Dropped table "${tableLabel}".`);
    } catch (error) {
        const results = tabs.primary(tableLabel);
        await showQueryError(results, error, connection, `DROP TABLE ${qualified}`);
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

    const engine = engineOf(connection);
    const scope = qualifiedName(item, engine);
    const body = item.kind === 'table'
        ? `SELECT *\nFROM ${scope}\nLIMIT ${previewRowLimit()};\n`
        // Ends on the dot so completion offers the next level straight away.
        : scope ? `SELECT *\nFROM ${scope}.` : '';
    const document = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: `${scopeHeader(connection, item.catalog)}\n${body}`
    });
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const end = document.lineAt(document.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
}

export async function openSqlQueryEditor(store: ConnectionStore, secrets: vscode.SecretStorage): Promise<void> {
    const connection = await resolveConnection(store);
    if (!connection) { return; }
    const starter = createClient(secrets, connection).starterSql();
    const document = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: `${scopeHeader(connection, connection.catalog)}\n${starter}`
    });
    await vscode.window.showTextDocument(document, { preview: false });
}

/**
 * Records the scope in the file itself. Nothing depends on it — the lens shows
 * and changes the scope, and an unmarked file runs on the active connection —
 * but it keeps a saved script readable and portable.
 */
function scopeHeader(connection: StoredConnection, catalog: string | undefined): string {
    const lines = [`-- Connection: ${connection.name}`];
    if (addressesByDatabase(engineOf(connection)) && catalog) { lines.push(`-- Database: ${catalog}`); }
    return `${lines.join('\n')}\n`;
}

/** Lets the user point the current editor at a different connection. */
export async function selectQueryConnection(store: ConnectionStore, scope: QueryScope, uri?: string): Promise<void> {
    const document = documentFor(uri);
    if (!document) { return; }
    const connection = await pickConnection(store, 'Run this script against…');
    if (!connection) { return; }
    scope.setConnection(document, connection.id);
}

/** Lets the user switch the catalog (Trino) or database (Postgres) for the current editor. */
export async function selectQueryDatabase(
    store: ConnectionStore,
    secrets: vscode.SecretStorage,
    scope: QueryScope,
    uri?: string
): Promise<void> {
    const document = documentFor(uri);
    if (!document) { return; }
    const { connection, database } = scope.resolve(document);
    if (!connection) {
        vscode.window.showErrorMessage('Choose a connection before choosing a database.');
        return;
    }
    const label = addressesByDatabase(engineOf(connection)) ? 'database' : 'catalog';
    try {
        const names = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Loading ${label}s…` },
            (_, token) => createClient(secrets, connection).catalogs(token)
        );
        if (!names.length) {
            vscode.window.showWarningMessage(`${connection.name} reported no ${label}s.`);
            return;
        }
        const picked = await vscode.window.showQuickPick(
            names.map(name => ({ label: name, description: name === database ? 'current' : undefined })),
            { placeHolder: `Select the ${label} to run against` }
        );
        if (picked) { scope.setDatabase(document, picked.label); }
    } catch (error) {
        showConnectionError(error);
    }
}

function documentFor(uri?: string): vscode.TextDocument | undefined {
    if (uri) {
        const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri);
        if (open) { return open; }
    }
    return vscode.window.activeTextEditor?.document;
}

export async function runActiveSql(store: ConnectionStore, secrets: vscode.SecretStorage, status: QueryStatusProvider, tabs: ResultsTabs, registry: RunningQueryRegistry, scope: QueryScope): Promise<void> {
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
    await executeSql({
        store, secrets, status, registry, scope, surface: tabs.primary(tabTitle(sql)),
        sql, line, uri: editor.document.uri, document: editor.document
    });
}

export interface ExecuteRequest {
    store: ConnectionStore;
    secrets: vscode.SecretStorage;
    status: QueryStatusProvider;
    registry: RunningQueryRegistry;
    scope: QueryScope;
    /** Where the grid is drawn: the shared panel, or a dedicated tab. */
    surface: ResultsSurface;
    sql: string;
    line: number;
    uri: vscode.Uri;
    /** The editor the statement came from, which carries the connection and database. */
    document?: vscode.TextDocument;
}

/** One execution path for every entry point, so timing and errors stay uniform. */
export async function executeSql(request: ExecuteRequest): Promise<void> {
    const { store, secrets, status, registry, scope, surface, sql, line, uri, document } = request;
    // The editor's own scope wins; falling back to the active connection means a
    // plain .sql file with no header still runs.
    const resolved = document ? scope.resolve(document) : {};
    const connection = resolved.connection ?? await resolveConnection(store);
    if (!connection) { return; }
    const database = resolved.connection ? resolved.database : connection.catalog;
    const started = Date.now();
    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Running query on ${connection.name}…`, cancellable: true },
            (_, token) => createClient(secrets, connection, registry).query(sql, token, database)
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
    newTab = false,
    scope?: QueryScope
): Promise<void> {
    if (!args?.sql || !args.uri || !scope) { return; }
    const title = tabTitle(args.sql);
    const surface = newTab ? tabs.additional(title) : tabs.primary(title);
    // The lens carries only the one statement, so the scope lives on the document.
    const document = vscode.workspace.textDocuments.find(open => open.uri.toString() === args.uri);
    await executeSql({
        store, secrets, status, registry, scope, surface,
        sql: args.sql, line: args.line ?? 0, uri: vscode.Uri.parse(args.uri), document
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
    const defaultName = {
        trino: 'Trino Connection', postgres: 'PostgreSQL Connection', supabase: 'Supabase Connection',
        sqlite: 'SQLite Database', duckdb: 'DuckDB Database', mysql: 'MySQL Connection'
    }[request.engine];
    if (request.engine === 'sqlite' || request.engine === 'duckdb') {
        const file = request.file.trim();
        return {
            id,
            name: request.name.trim() || defaultName,
            type: request.engine,
            // A local file has no host/port/user — the path itself is the connection.
            url: file,
            user: '',
            // Nothing else identifies "the database" for a single-file engine, but the
            // lens and scope headers still want a name to show for it.
            catalog: path.basename(file) || undefined,
            maxRows: parseMaxRows(request.maxRows)
        };
    }
    const host = formatHost(request.host.trim());
    const port = request.port.trim();
    const isMysql = request.engine === 'mysql';
    const wireProtocol = addressesByDatabase(request.engine);
    return {
        id,
        name: request.name.trim() || defaultName,
        type: request.engine,
        // Postgres/Supabase keep their database in `catalog`, which is also the tree's top level.
        url: wireProtocol ? `${isMysql ? 'mysql' : 'postgresql'}://${host}:${port}` : `${request.sslEnabled ? 'https' : 'http'}://${host}:${port}`,
        user: request.user.trim(),
        // MySQL can browse every database on the server without picking one first,
        // unlike Postgres where a connection is always open against exactly one —
        // so an empty field means "all of them" instead of falling back to a default.
        catalog: wireProtocol
            ? (isMysql ? (request.database.trim() || undefined) : (request.database.trim() || 'postgres'))
            : (request.catalog.trim() || undefined),
        schema: wireProtocol ? undefined : (request.schema.trim() || undefined),
        ssl: wireProtocol ? request.sslEnabled : undefined,
        // Trino only: whether HTTPS requests verify the server's certificate.
        sslVerify: wireProtocol ? undefined : request.sslVerify,
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
        // A test must not leave a pooled socket or open file handle behind for an unsaved connection.
        await closeAllClients(candidate.id);
    }
}

export async function showConnectionWindow(
    context: vscode.ExtensionContext,
    store: ConnectionStore,
    provider: TrinoExplorerProvider,
    existing: StoredConnection | undefined
): Promise<void> {
    const engine = engineOf(existing ?? { type: 'trino' } as StoredConnection);
    const isLocalFile = engine === 'sqlite' || engine === 'duckdb';
    const wireProtocol = !isLocalFile && addressesByDatabase(engine);
    // A new connection starts blank so the placeholder hints show and clear on
    // focus, rather than pre-filling fields the user would have to type over.
    const current = existing && !isLocalFile
        ? wireProtocol
            ? { ...hostAndPort(existing.url), sslEnabled: Boolean(existing.ssl) }
            : parseConnectionUrl(existing.url)
        : { host: '', port: '', sslEnabled: false };
    const panel = vscode.window.createWebviewPanel(
        'trinoConnection',
        existing ? `Edit ${existing.name}` : 'New Connection',
        vscode.ViewColumn.One,
        // Keeps typed-but-unsaved fields intact when the user switches tabs and back.
        { enableScripts: true, retainContextWhenHidden: true }
    );
    const hasPassword = existing ? Boolean(await context.secrets.get(passwordKey(existing.id))) : false;
    panel.webview.html = connectionFormHtml(panel.webview, {
        name: existing?.name ?? '',
        engine,
        host: current.host,
        port: current.port ? String(current.port) : '',
        sslEnabled: current.sslEnabled,
        sslVerify: existing?.sslVerify ?? true,
        user: existing?.user ?? '',
        catalog: wireProtocol ? '' : (existing?.catalog ?? ''),
        schema: existing?.schema ?? '',
        database: wireProtocol ? (existing?.catalog ?? '') : '',
        file: isLocalFile ? (existing?.url ?? '') : '',
        maxRows: existing?.maxRows ? String(existing.maxRows) : ''
    }, Boolean(existing), hasPassword);

    panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (isBrowseFileMessage(message)) {
            const label = message.engine === 'sqlite' ? 'SQLite' : 'DuckDB';
            const extensions = message.engine === 'sqlite' ? ['db', 'sqlite', 'sqlite3', 'db3'] : ['duckdb', 'db'];
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: false,
                title: `Choose a ${label} database file`,
                filters: { [`${label} database`]: extensions, 'All files': ['*'] }
            });
            if (picked?.[0]) { void panel.webview.postMessage({ type: 'fileChosen', engine: message.engine, path: picked[0].fsPath }); }
            return;
        }
        if (isCreateFileMessage(message)) {
            const label = message.engine === 'sqlite' ? 'SQLite' : 'DuckDB';
            const extensions = message.engine === 'sqlite' ? ['db', 'sqlite', 'sqlite3', 'db3'] : ['duckdb', 'db'];
            const defaultName = message.engine === 'sqlite' ? 'database.db' : 'database.duckdb';
            const target = await vscode.window.showSaveDialog({
                title: `Create a new ${label} database`,
                saveLabel: 'Create Database',
                filters: { [`${label} database`]: extensions },
                defaultUri: vscode.Uri.file(defaultName)
            });
            if (!target) { return; }
            try {
                if (message.engine === 'sqlite') { createEmptyDatabase(target.fsPath); }
                else { await createEmptyDuckdb(target.fsPath); }
                void panel.webview.postMessage({ type: 'fileChosen', engine: message.engine, path: target.fsPath });
            } catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                void panel.webview.postMessage({ type: 'error', message: `Could not create the database: ${text}` });
            }
            return;
        }
        if (isCheckRuntimeMessage(message)) {
            const installed = message.engine === 'sqlite' ? isSqliteInstalled() : isDuckdbInstalled();
            void panel.webview.postMessage({ type: 'runtimeStatus', engine: message.engine, installed });
            return;
        }
        if (isInstallRuntimeMessage(message)) {
            const label = message.engine === 'sqlite' ? 'SQLite' : 'DuckDB';
            const install = message.engine === 'sqlite' ? installSqlite : installDuckdb;
            try {
                await install(line => {
                    void panel.webview.postMessage({ type: 'runtimeInstallProgress', engine: message.engine, message: line.trim().split('\n').pop() || 'Installing…' });
                });
                void panel.webview.postMessage({ type: 'runtimeInstallDone', engine: message.engine, ok: true, message: `${label} is installed and ready.` });
            } catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                void panel.webview.postMessage({ type: 'runtimeInstallDone', engine: message.engine, ok: false, message: `Install failed: ${summarize(text)}` });
            }
            return;
        }
        if (!isConnectionMessage(message)) { return; }
        const request = message.engine === 'supabase' ? expandPastedSupabaseUrl(message) : expandPastedUrl(message);
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

        // Editing connection details must not leave a stale pool or file handle around.
        await closeAllClients(id);
        provider.forget(id);
        panel.dispose();
        vscode.window.showInformationMessage(`${ENGINE_LABELS[engineOf(candidate)]} connection saved: ${url}`);
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
