import * as vscode from 'vscode';
import { StoredConnection, TrinoRequestError } from './types';
import { ConnectionStore } from './connectionStore';
import { RunningQueryRegistry } from './runningQueries';
import { QueryScope, CONNECTION_HEADER, DATABASE_HEADER } from './queryScope';
import { createClient } from './client';
import { ResultsTabs } from './resultsView';
import { resolveConnection, scopeHeader, showQueryError, showSqlResults, tabTitle } from './commands';
import { HistoryStore } from './queryHistoryStore';
import { HistoryTreeItem, HistoryTreeProvider } from './historyExplorer';
import { SavedQueryStore } from './savedQueryStore';
import { SavedQueryTreeItem } from './savedQueriesExplorer';

/** Marks an editor as bound to a saved query, so "Save Current Query" updates it in place instead of creating a duplicate. */
const SAVED_QUERY_HEADER = /^\s*--\s*Saved Query:\s*(\S+)\s*$/im;

/** One execution path for both History's "run" and Saved Queries' "run" — outside a document, so it cannot use `executeSql`'s editor-scope resolution. */
async function runAdhocQuery(
    secrets: vscode.SecretStorage,
    registry: RunningQueryRegistry,
    tabs: ResultsTabs,
    history: HistoryStore,
    connection: StoredConnection,
    database: string | undefined,
    sql: string,
    title: string
): Promise<void> {
    const surface = tabs.primary(title);
    const client = createClient(secrets, connection, registry);
    const started = Date.now();
    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Running query on ${connection.name}…`, cancellable: true },
            (_, token) => client.query(sql, token, database)
        );
        const elapsed = Date.now() - started;
        await showSqlResults(surface, result, connection, { sql, milliseconds: elapsed });
        await history.record({
            connectionId: connection.id, connectionName: connection.name, database, sql,
            executedAt: Date.now(), milliseconds: elapsed, rowCount: result.rows.length, success: true
        });
    } catch (error) {
        await showQueryError(surface, error, connection, sql);
        const message = error instanceof Error ? error.message : String(error);
        await history.record({
            connectionId: connection.id, connectionName: connection.name, database, sql,
            executedAt: Date.now(), success: false, error: message
        });
    }
}

async function openSqlInEditor(content: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content });
    await vscode.window.showTextDocument(document, { preview: false });
}

/** Choose an existing folder, the root, or type a new one — shared by every command that files a query into a folder. */
async function pickFolder(savedQueries: SavedQueryStore, defaultForNewFolder?: string): Promise<string | undefined> {
    const items: (vscode.QuickPickItem & { value?: string })[] = [
        { label: '$(root-folder) (Root)', value: '' },
        ...savedQueries.folders().map(path => ({ label: `$(folder) ${path}`, value: path })),
        { label: '$(new-folder) New folder…' }
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Choose a folder' });
    if (!picked) { return undefined; }
    if (picked.value !== undefined) { return picked.value; }
    const created = (await vscode.window.showInputBox({ prompt: 'New folder name (use "/" to nest it inside another)', value: defaultForNewFolder }))?.trim();
    if (!created) { return undefined; }
    await savedQueries.addFolder(created);
    return created;
}

function stripHeaders(text: string): string {
    return text.split('\n')
        .filter(line => !CONNECTION_HEADER.test(line) && !DATABASE_HEADER.test(line) && !SAVED_QUERY_HEADER.test(line))
        .join('\n')
        .trim();
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function historyRunEntry(
    store: ConnectionStore, secrets: vscode.SecretStorage, registry: RunningQueryRegistry, tabs: ResultsTabs, history: HistoryStore, item?: HistoryTreeItem
): Promise<void> {
    const entry = item?.entry;
    if (!entry) { return; }
    const connection = store.get(entry.connectionId);
    if (!connection) {
        const choice = await vscode.window.showWarningMessage(
            `The connection "${entry.connectionName}" no longer exists.`, 'Copy SQL', 'Open in New Editor'
        );
        if (choice === 'Copy SQL') { await vscode.env.clipboard.writeText(entry.sql); }
        else if (choice === 'Open in New Editor') { await openSqlInEditor(`-- Connection: ${entry.connectionName} (removed)\n\n${entry.sql}\n`); }
        return;
    }
    await runAdhocQuery(secrets, registry, tabs, history, connection, entry.database, entry.sql, tabTitle(entry.sql));
}

export async function historyOpenInEditor(store: ConnectionStore, item?: HistoryTreeItem): Promise<void> {
    const entry = item?.entry;
    if (!entry) { return; }
    const connection = store.get(entry.connectionId);
    const header = connection ? scopeHeader(connection, entry.database) : `-- Connection: ${entry.connectionName} (removed)\n`;
    await openSqlInEditor(`${header}\n${entry.sql}\n`);
}

export async function historyCopySql(item?: HistoryTreeItem): Promise<void> {
    if (item?.entry) { await vscode.env.clipboard.writeText(item.entry.sql); }
}

export async function historySaveAsFavorite(savedQueries: SavedQueryStore, item?: HistoryTreeItem): Promise<void> {
    const entry = item?.entry;
    if (!entry) { return; }
    const name = (await vscode.window.showInputBox({
        prompt: 'Name for this saved query', validateInput: value => value.trim() ? undefined : 'Enter a name.'
    }))?.trim();
    if (!name) { return; }
    const folder = await pickFolder(savedQueries);
    if (folder === undefined) { return; }
    await savedQueries.create(name, entry.sql, folder, entry.connectionId, entry.database);
    vscode.window.showInformationMessage(`Saved "${name}".`);
}

export async function historyRemoveEntry(history: HistoryStore, item?: HistoryTreeItem): Promise<void> {
    if (item?.entry) { await history.remove(item.entry.id); }
}

export async function historyClearConnection(history: HistoryStore, item?: HistoryTreeItem): Promise<void> {
    if (!item?.connectionId) { return; }
    const name = typeof item.label === 'string' ? item.label : item.connectionId;
    const confirmed = await vscode.window.showWarningMessage(`Clear query history for "${name}"?`, { modal: true }, 'Clear');
    if (confirmed === 'Clear') { await history.clear(item.connectionId); }
}

export async function historyClearAll(history: HistoryStore): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage('Clear all query history?', { modal: true }, 'Clear');
    if (confirmed === 'Clear') { await history.clear(); }
}

export async function historySearch(provider: HistoryTreeProvider): Promise<void> {
    const text = await vscode.window.showInputBox({ prompt: 'Filter history by SQL text', placeHolder: 'e.g. orders' });
    if (text === undefined) { return; }
    provider.setFilter(text);
    await vscode.commands.executeCommand('setContext', 'sqlExplorer.historyFiltered', provider.isFiltered);
}

export async function historyClearSearch(provider: HistoryTreeProvider): Promise<void> {
    provider.setFilter('');
    await vscode.commands.executeCommand('setContext', 'sqlExplorer.historyFiltered', false);
}

// ---------------------------------------------------------------------------
// Saved queries
// ---------------------------------------------------------------------------

export async function savedQueryRun(
    store: ConnectionStore, secrets: vscode.SecretStorage, registry: RunningQueryRegistry, tabs: ResultsTabs, history: HistoryStore,
    item?: SavedQueryTreeItem
): Promise<void> {
    const query = item?.query;
    if (!query) { return; }
    const connection = store.get(query.connectionId) ?? await resolveConnection(store);
    if (!connection) { return; }
    await runAdhocQuery(secrets, registry, tabs, history, connection, query.database, query.sql, query.name);
}

export async function savedQueryOpenInEditor(store: ConnectionStore, item?: SavedQueryTreeItem): Promise<void> {
    const query = item?.query;
    if (!query) { return; }
    const connection = store.get(query.connectionId);
    const header = connection ? scopeHeader(connection, query.database) : '';
    await openSqlInEditor(`-- Saved Query: ${query.id}\n${header}\n${query.sql}\n`);
}

export async function savedQueryInsertIntoEditor(item?: SavedQueryTreeItem): Promise<void> {
    const query = item?.query;
    const editor = vscode.window.activeTextEditor;
    if (!query) { return; }
    if (!editor) {
        vscode.window.showErrorMessage('Open an editor to insert the query into.');
        return;
    }
    await editor.edit(builder => builder.insert(editor.selection.active, query.sql));
}

export async function savedQueryRename(savedQueries: SavedQueryStore, item?: SavedQueryTreeItem): Promise<void> {
    const query = item?.query;
    if (!query) { return; }
    const name = (await vscode.window.showInputBox({ prompt: 'New name', value: query.name }))?.trim();
    if (!name || name === query.name) { return; }
    await savedQueries.update(query.id, { name });
}

export async function savedQueryMove(savedQueries: SavedQueryStore, item?: SavedQueryTreeItem): Promise<void> {
    const query = item?.query;
    if (!query) { return; }
    const folder = await pickFolder(savedQueries, query.folder);
    if (folder === undefined) { return; }
    await savedQueries.update(query.id, { folder: folder || undefined });
}

export async function savedQueryDuplicate(savedQueries: SavedQueryStore, item?: SavedQueryTreeItem): Promise<void> {
    const query = item?.query;
    if (!query) { return; }
    await savedQueries.create(`${query.name} (copy)`, query.sql, query.folder, query.connectionId, query.database);
}

export async function savedQueryDelete(savedQueries: SavedQueryStore, item?: SavedQueryTreeItem): Promise<void> {
    const query = item?.query;
    if (!query) { return; }
    const confirmed = await vscode.window.showWarningMessage(`Delete the saved query "${query.name}"?`, { modal: true }, 'Delete');
    if (confirmed === 'Delete') { await savedQueries.remove(query.id); }
}

/** Backs both the view/title "New Saved Query" button and a folder's "New Query Here" — the latter presets the folder. */
export async function savedQueryNew(savedQueries: SavedQueryStore, item?: SavedQueryTreeItem): Promise<void> {
    const name = (await vscode.window.showInputBox({
        prompt: 'Name for the new saved query', validateInput: value => value.trim() ? undefined : 'Enter a name.'
    }))?.trim();
    if (!name) { return; }
    const presetFolder = item?.kind === 'folder' ? item.path : undefined;
    const folder = presetFolder !== undefined ? presetFolder : await pickFolder(savedQueries);
    if (folder === undefined) { return; }
    const query = await savedQueries.create(name, '', folder);
    await openSqlInEditor(`-- Saved Query: ${query.id}\n\n`);
}

export async function savedQueryNewFolder(savedQueries: SavedQueryStore, item?: SavedQueryTreeItem): Promise<void> {
    const parent = item?.kind === 'folder' ? item.path : undefined;
    const name = (await vscode.window.showInputBox({
        prompt: parent ? `New subfolder under "${parent}"` : 'New folder name (use "/" to nest it)'
    }))?.trim();
    if (!name) { return; }
    await savedQueries.addFolder(parent ? `${parent}/${name}` : name);
}

export async function savedQueryFolderRename(savedQueries: SavedQueryStore, item?: SavedQueryTreeItem): Promise<void> {
    const path = item?.kind === 'folder' ? item.path : undefined;
    if (!path) { return; }
    const leaf = path.split('/').pop()!;
    const name = (await vscode.window.showInputBox({ prompt: 'New folder name', value: leaf }))?.trim();
    if (!name || name === leaf) { return; }
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined;
    await savedQueries.renameFolder(path, parent ? `${parent}/${name}` : name);
}

export async function savedQueryFolderDelete(savedQueries: SavedQueryStore, item?: SavedQueryTreeItem): Promise<void> {
    const path = item?.kind === 'folder' ? item.path : undefined;
    if (!path) { return; }
    const confirmed = await vscode.window.showWarningMessage(`Delete the folder "${path}" and everything in it?`, { modal: true }, 'Delete');
    if (confirmed === 'Delete') { await savedQueries.removeFolder(path); }
}

/**
 * Saves the active SQL editor's selection (or whole content) as a saved query.
 * An editor opened via "Open in Editor" carries a `-- Saved Query: <id>` header,
 * so saving again updates that same entry instead of piling up duplicates.
 */
export async function saveCurrentQuery(savedQueries: SavedQueryStore, scope: QueryScope): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
        vscode.window.showErrorMessage('Open a SQL query editor before saving a query.');
        return;
    }
    const text = editor.document.getText();
    const selected = editor.document.getText(editor.selection).trim();
    const sql = selected || stripHeaders(text);
    if (!sql) {
        vscode.window.showErrorMessage('There is no query text to save.');
        return;
    }
    const resolved = scope.resolve(editor.document);
    const boundId = SAVED_QUERY_HEADER.exec(text)?.[1];
    const existing = boundId ? savedQueries.get(boundId) : undefined;

    if (existing) {
        const choice = await vscode.window.showQuickPick(
            [{ label: `$(sync) Update "${existing.name}"`, action: 'update' as const }, { label: '$(add) Save as a new query…', action: 'new' as const }],
            { placeHolder: 'This editor is linked to a saved query' }
        );
        if (!choice) { return; }
        if (choice.action === 'update') {
            await savedQueries.update(existing.id, { sql, connectionId: resolved.connection?.id ?? existing.connectionId, database: resolved.database ?? existing.database });
            vscode.window.showInformationMessage(`Updated "${existing.name}".`);
            return;
        }
    }

    const name = (await vscode.window.showInputBox({
        prompt: 'Name for this saved query', validateInput: value => value.trim() ? undefined : 'Enter a name.'
    }))?.trim();
    if (!name) { return; }
    const folder = await pickFolder(savedQueries);
    if (folder === undefined) { return; }
    await savedQueries.create(name, sql, folder, resolved.connection?.id, resolved.database);
    vscode.window.showInformationMessage(`Saved "${name}".`);
}
