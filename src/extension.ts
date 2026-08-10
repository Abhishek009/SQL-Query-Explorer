import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { TrinoExplorerProvider, ExplorerDragController, ExplorerItem } from './explorer';
import { ResultsTabs } from './resultsView';
import { QueryStatusProvider } from './queryStatus';
import { SqlCompletionProvider } from './completion';
import { openScopedQuery, openSqlQueryEditor, pickConnection, previewTable, resolveConnection, runActiveSql, runStatement, selectQueryConnection, selectQueryDatabase, showConnectionWindow, showTableDdl } from './commands';
import { showConnectionError } from './util';
import { RunningQueryRegistry, RunningQueryStatus, cancelRunningQuery } from './runningQueries';
import { QueryScope } from './queryScope';
import { closeAllClients } from './client';
import { importDataFromFile } from './importData';
import { initDuckdbRuntime } from './engines/duckdb/duckdbRuntime';

export function activate(context: vscode.ExtensionContext): void {
    initDuckdbRuntime(context);
    const store = new ConnectionStore(context);
    const provider = new TrinoExplorerProvider(store, context.secrets, context.extensionUri);
    const scope = new QueryScope(store);
    const status = new QueryStatusProvider(context, scope);
    const tabs = new ResultsTabs();
    const completions = new SqlCompletionProvider(store, context.secrets, scope);
    const running = new RunningQueryRegistry();
    void store.migrateLegacyConnection();

    context.subscriptions.push(
        status,
        running,
        new RunningQueryStatus(running),
        vscode.languages.registerCompletionItemProvider({ language: 'sql' }, completions, '.'),
        store.onDidChange(() => completions.clear()),
        vscode.window.createTreeView('sqlExplorerConnections', {
            treeDataProvider: provider,
            dragAndDropController: new ExplorerDragController(store),
            canSelectMany: true,
            showCollapseAll: true
        }),
        tabs,
        vscode.languages.registerCodeLensProvider({ language: 'sql' }, status),
        vscode.workspace.onDidCloseTextDocument(document => { status.forget(document.uri); scope.forget(document.uri); }),
        scope.onDidChange(() => { status.refresh(); completions.clear(); }),
        // Reapply after a split, tab switch, or reopen; decorations are per editor.
        vscode.window.onDidChangeVisibleTextEditors(() => status.decorate()),
        store.onDidChange(() => provider.refresh()),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('sqlExplorer.connections')) { provider.refresh(); }
        })
    );

    const register = (command: string, handler: (...args: never[]) => unknown) => {
        context.subscriptions.push(vscode.commands.registerCommand(command, handler));
    };

    register('sqlExplorer.addConnection', async () => {
        await showConnectionWindow(context, store, provider, undefined);
    });
    register('sqlExplorer.editConnection', async (item?: ExplorerItem) => {
        const connection = store.get(item?.connectionId) ?? await pickConnection(store, 'Select a connection to edit');
        if (connection) { await showConnectionWindow(context, store, provider, connection); }
    });
    register('sqlExplorer.removeConnection', async (item?: ExplorerItem) => {
        const connection = store.get(item?.connectionId) ?? await pickConnection(store, 'Select a connection to remove');
        if (!connection) { return; }
        const confirmed = await vscode.window.showWarningMessage(
            `Remove the connection "${connection.name}"?`, { modal: true }, 'Remove'
        );
        if (confirmed !== 'Remove') { return; }
        await store.remove(connection.id);
        await closeAllClients(connection.id);
        provider.forget(connection.id);
        vscode.window.showInformationMessage(`Removed connection "${connection.name}".`);
    });
    register('sqlExplorer.setActiveConnection', async (item?: ExplorerItem) => {
        const connection = store.get(item?.connectionId) ?? await pickConnection(store, 'Select the connection to use for queries');
        if (connection) {
            await store.setActive(connection.id);
            vscode.window.showInformationMessage(`Queries now run against "${connection.name}".`);
        }
    });
    register('sqlExplorer.connect', async (item?: ExplorerItem) => {
        const connection = store.get(item?.connectionId) ?? await resolveConnection(store);
        if (!connection) { return; }
        try { await provider.connect(connection); }
        catch (error) { showConnectionError(error); }
    });
    register('sqlExplorer.refreshCatalogs', async (item?: ExplorerItem) => {
        provider.forget(item?.connectionId);
        completions.clear();
        const connection = store.get(item?.connectionId);
        if (!connection) { return; }
        try { await provider.connect(connection); }
        catch (error) { showConnectionError(error); }
    });
    register('sqlExplorer.refreshNode', async (item?: ExplorerItem) => {
        if (!item) { return; }
        if (item.kind === 'connection' && item.connectionId) {
            provider.forget(item.connectionId);
            completions.clear();
            const connection = store.get(item.connectionId);
            if (!connection) { return; }
            try { await provider.connect(connection); }
            catch (error) { showConnectionError(error); }
            return;
        }
        // Cached metadata would otherwise keep serving the pre-refresh names.
        completions.clear();
        await provider.refreshItem(item);
    });
    register('sqlExplorer.configureConnection', async () => {
        const connection = store.get(store.activeId);
        await showConnectionWindow(context, store, provider, connection);
    });
    register('sqlExplorer.previewTable', async (item?: ExplorerItem) => {
        await previewTable(store, context.secrets, tabs, running, item, true);
    });
    register('sqlExplorer.tableClicked', async (item?: ExplorerItem) => {
        await previewTable(store, context.secrets, tabs, running, item);
    });
    register('sqlExplorer.newQueryHere', async (item?: ExplorerItem) => {
        await openScopedQuery(store, item);
    });
    register('sqlExplorer.showTableDdl', async (item?: ExplorerItem) => {
        await showTableDdl(store, context.secrets, tabs, running, item);
    });
    register('sqlExplorer.importData', async (item?: ExplorerItem) => {
        await importDataFromFile(store, context.secrets, provider, running, item);
    });
    register('sqlExplorer.openQuery', async () => { await openSqlQueryEditor(store, context.secrets); });
    register('sqlExplorer.runActiveSql', async () => { await runActiveSql(store, context.secrets, status, tabs, running, scope); });
    register('sqlExplorer.runStatement', async (args?: { uri?: string; sql?: string; line?: number }) => {
        await runStatement(store, context.secrets, status, tabs, running, args, false, scope);
    });
    register('sqlExplorer.runStatementNewTab', async (args?: { uri?: string; sql?: string; line?: number }) => {
        await runStatement(store, context.secrets, status, tabs, running, args, true, scope);
    });
    register('sqlExplorer.selectQueryConnection', async (uri?: string) => { await selectQueryConnection(store, scope, uri); });
    register('sqlExplorer.selectQueryDatabase', async (uri?: string) => { await selectQueryDatabase(store, context.secrets, scope, uri); });
    register('sqlExplorer.cancelQuery', async () => { await cancelRunningQuery(running); });
}

export function deactivate(): void {}
