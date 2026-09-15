import * as vscode from 'vscode';
import { SavedQuery, SavedQueryStore } from './savedQueryStore';
import { ConnectionStore } from './connectionStore';

export type SavedQueryNodeKind = 'folder' | 'query' | 'empty';

export class SavedQueriesTreeProvider implements vscode.TreeDataProvider<SavedQueryTreeItem> {
    private readonly changed = new vscode.EventEmitter<SavedQueryTreeItem | undefined>();
    public readonly onDidChangeTreeData = this.changed.event;

    public constructor(private readonly queries: SavedQueryStore, private readonly connections: ConnectionStore) {
        this.queries.onDidChange(() => this.refresh());
    }

    public getTreeItem(item: SavedQueryTreeItem): vscode.TreeItem { return item; }

    public getChildren(element?: SavedQueryTreeItem): SavedQueryTreeItem[] {
        const parent = element?.kind === 'folder' ? element.path : undefined;
        const folders = this.queries.folders()
            .filter(path => parentOf(path) === parent)
            .sort((left, right) => left.localeCompare(right))
            .map(path => SavedQueryTreeItem.folder(path));
        const queries = this.queries.all()
            .filter(query => (query.folder || undefined) === parent)
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(query => SavedQueryTreeItem.query(query, this.connections.get(query.connectionId)?.name));
        const children = [...folders, ...queries];
        if (!children.length && !element) { return [SavedQueryTreeItem.empty()]; }
        return children;
    }

    public refresh(): void { this.changed.fire(undefined); }
}

export class SavedQueryTreeItem extends vscode.TreeItem {
    private constructor(label: string, public readonly kind: SavedQueryNodeKind, public readonly path?: string, public readonly query?: SavedQuery) {
        super(label, kind === 'folder' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.contextValue = `sqlExplorer.savedQuery.${kind}`;
    }

    public static empty(): SavedQueryTreeItem {
        const item = new SavedQueryTreeItem('New Saved Query…', 'empty');
        item.iconPath = new vscode.ThemeIcon('add');
        item.command = { command: 'sqlExplorer.savedQueryNew', title: 'New Saved Query' };
        item.tooltip = 'Save a query to re-run or organize into folders.';
        return item;
    }

    public static folder(path: string): SavedQueryTreeItem {
        const item = new SavedQueryTreeItem(path.split('/').pop()!, 'folder', path);
        item.iconPath = new vscode.ThemeIcon('folder');
        item.tooltip = path;
        return item;
    }

    public static query(query: SavedQuery, connectionName: string | undefined): SavedQueryTreeItem {
        const item = new SavedQueryTreeItem(query.name, 'query', undefined, query);
        item.description = connectionName ?? (query.connectionId ? 'connection removed' : undefined);
        item.iconPath = new vscode.ThemeIcon('star-full');
        item.tooltip = new vscode.MarkdownString(`**${query.name}**\n\n\`\`\`sql\n${query.sql}\n\`\`\``);
        item.command = { command: 'sqlExplorer.savedQueryRun', title: 'Run Query', arguments: [item] };
        return item;
    }
}

function parentOf(path: string): string | undefined {
    const index = path.lastIndexOf('/');
    return index < 0 ? undefined : path.slice(0, index);
}
