import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { TrinoExplorerProvider, ExplorerDragController, ExplorerItem } from './explorer';
import { ResultsViewProvider } from './resultsView';
import { QueryStatusProvider } from './queryStatus';
import { SqlCompletionProvider } from './completion';
import { openScopedQuery, openSqlQueryEditor, pickConnection, previewTable, resolveConnection, runActiveSql, showConnectionWindow, showTableDdl } from './commands';
import { showConnectionError } from './util';
import { RunningQueryRegistry, RunningQueryStatus, cancelRunningQuery } from './runningQueries';

export function activate(context: vscode.ExtensionContext): void {
    const store = new ConnectionStore(context);
    const provider = new TrinoExplorerProvider(store, context.secrets);
    const status = new QueryStatusProvider(context);
    const results = new ResultsViewProvider();
    const completions = new SqlCompletionProvider(store, context.secrets);
    const running = new RunningQueryRegistry();
    void store.migrateLegacyConnection();

    context.subscriptions.push(
        status,
        running,
        new RunningQueryStatus(running),
        vscode.languages.registerCompletionItemProvider({ language: 'sql' }, completions, '.'),
        store.onDidChange(() => completions.clear()),
        vscode.window.createTreeView('trinoCatalogs', {
            treeDataProvider: provider,
            dragAndDropController: new ExplorerDragController(),
            canSelectMany: true,
            showCollapseAll: true
        }),
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
    register('trino.refreshNode', async (item?: ExplorerItem) => {
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
        provider.refreshItem(item);
    });
    register('trino.configureConnection', async () => {
        const connection = store.get(store.activeId);
        await showConnectionWindow(context, store, provider, connection);
    });
    register('trino.previewTable', async (item?: ExplorerItem) => {
        await previewTable(store, context.secrets, results, running, item, true);
    });
    register('trino.tableClicked', async (item?: ExplorerItem) => {
        await previewTable(store, context.secrets, results, running, item);
    });
    register('trino.newQueryHere', async (item?: ExplorerItem) => {
        await openScopedQuery(store, item);
    });
    register('trino.showTableDdl', async (item?: ExplorerItem) => {
        await showTableDdl(store, context.secrets, results, running, item);
    });
    register('trino.openQuery', async () => { await openSqlQueryEditor(store); });
    register('trino.runActiveSql', async () => { await runActiveSql(store, context.secrets, status, results, running); });
    register('trino.cancelQuery', async () => { await cancelRunningQuery(running); });
}

export function deactivate(): void {}
