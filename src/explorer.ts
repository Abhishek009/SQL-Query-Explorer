import * as vscode from 'vscode';
import { StoredConnection, TableEntry, TrinoColumn } from './types';
import { ConnectionStore } from './connectionStore';
import { TrinoClient } from './trinoClient';
import { quoteIdentifier, showConnectionError } from './util';

export type ExplorerNodeKind = 'connection' | 'catalog' | 'schema' | 'group' | 'table' | 'column' | 'empty';

export class TrinoExplorerProvider implements vscode.TreeDataProvider<ExplorerItem> {
    private readonly changed = new vscode.EventEmitter<ExplorerItem | undefined>();
    public readonly onDidChangeTreeData = this.changed.event;
    private readonly catalogsByConnection = new Map<string, string[]>();
    /** Table and view listings per "connectionId/catalog/schema". */
    private readonly entriesBySchema = new Map<string, TableEntry[]>();

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
                const entries = await this.tableEntries(client, connection.id, element.catalog, element.schema);
                return [
                    ExplorerItem.group(connection.id, element.catalog, element.schema, 'tables', entries.filter(entry => !entry.view).length),
                    ExplorerItem.group(connection.id, element.catalog, element.schema, 'views', entries.filter(entry => entry.view).length)
                ];
            }
            if (element.kind === 'group' && element.catalog && element.schema && element.group) {
                const wantViews = element.group === 'views';
                const entries = await this.tableEntries(client, connection.id, element.catalog, element.schema);
                return entries
                    .filter(entry => entry.view === wantViews)
                    .map(entry => ExplorerItem.table(connection.id, element.catalog!, element.schema!, entry.name, entry.view));
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

    /**
     * Cached because both group nodes and their children need the same listing;
     * without it, expanding a schema and then its Tables folder queries twice.
     */
    private async tableEntries(client: TrinoClient, connectionId: string, catalog: string, schema: string): Promise<TableEntry[]> {
        const key = `${connectionId}/${catalog}/${schema}`;
        const cached = this.entriesBySchema.get(key);
        if (cached) { return cached; }
        const entries = await client.tableEntries(catalog, schema);
        this.entriesBySchema.set(key, entries);
        return entries;
    }

    /** Loads and caches a connection's catalogs, marking it connected in the tree. */
    public async connect(connection: StoredConnection): Promise<void> {
        const client = new TrinoClient(this.secrets, connection);
        await this.loadCatalogs(client, connection);
        await this.store.setActive(connection.id);
    }

    public forget(id?: string): void {
        if (id) {
            this.catalogsByConnection.delete(id);
            this.forgetCached(`${id}/`);
        } else {
            this.catalogsByConnection.clear();
            this.entriesBySchema.clear();
        }
        this.refresh();
    }

    public refresh(): void { this.changed.fire(undefined); }

    /**
     * Redraws one branch. Schemas, tables, and columns are fetched on expand and
     * never cached here, so firing for the node is enough to re-query it. The
     * table listing is cached, so drop it for the branch being refreshed.
     */
    public refreshItem(item: ExplorerItem): void {
        if (item.connectionId) {
            const path = [item.connectionId, item.catalog, item.schema].filter(Boolean).join('/');
            this.forgetCached(item.catalog ? path : `${item.connectionId}/`);
        }
        this.changed.fire(item);
    }

    private forgetCached(prefix: string): void {
        for (const key of [...this.entriesBySchema.keys()]) {
            if (key.startsWith(prefix)) { this.entriesBySchema.delete(key); }
        }
    }

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

/**
 * Lets tree nodes be dragged into a SQL editor. Setting `text/plain` on the
 * transfer is what makes the editor accept the drop and insert the name.
 */
export class ExplorerDragController implements vscode.TreeDragAndDropController<ExplorerItem> {
    public readonly dragMimeTypes = ['text/plain'];
    public readonly dropMimeTypes: string[] = [];

    public handleDrag(source: readonly ExplorerItem[], data: vscode.DataTransfer): void {
        const text = source.map(qualifiedName).filter(Boolean).join(', ');
        if (text) { data.set('text/plain', new vscode.DataTransferItem(text)); }
    }

    public handleDrop(): void { /* the tree accepts no drops */ }
}

/** The SQL name a node stands for, quoting only identifiers that need it. */
export function qualifiedName(item: ExplorerItem): string {
    const part = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : quoteIdentifier(name);
    switch (item.kind) {
        case 'catalog':
            return item.catalog ? part(item.catalog) : '';
        case 'schema':
            return item.catalog && item.schema ? `${part(item.catalog)}.${part(item.schema)}` : '';
        case 'table':
            return item.catalog && item.schema && item.table
                ? `${part(item.catalog)}.${part(item.schema)}.${part(item.table)}`
                : '';
        case 'column':
            // A bare column name is what you want inside a SELECT list.
            return part(String(item.label ?? ''));
        default:
            return '';
    }
}

export class ExplorerItem extends vscode.TreeItem {
    private constructor(
        label: string,
        public readonly kind: ExplorerNodeKind,
        public readonly connectionId?: string,
        public readonly catalog?: string,
        public readonly schema?: string,
        public readonly table?: string,
        /** Which folder a 'group' node stands for. */
        public readonly group?: 'tables' | 'views'
    ) {
        super(label, kind === 'column' || kind === 'empty'
            ? vscode.TreeItemCollapsibleState.None
            : vscode.TreeItemCollapsibleState.Collapsed);
        this.contextValue = `sqlExplorer.${kind}`;
    }

    public static empty(): ExplorerItem {
        const item = new ExplorerItem('Add a Trino connection', 'empty');
        item.iconPath = new vscode.ThemeIcon('add');
        item.command = { command: 'sqlExplorer.addConnection', title: 'Add Trino Connection' };
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
        item.contextValue = active ? 'sqlExplorer.connection.active' : 'sqlExplorer.connection';
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
        item.iconPath = new vscode.ThemeIcon('folder-library');
        item.tooltip = new vscode.MarkdownString(`**${schema}**\n\n${catalog}.${schema}`);
        return item;
    }

    public static group(connectionId: string, catalog: string, schema: string, group: 'tables' | 'views', count: number): ExplorerItem {
        const label = group === 'tables' ? 'Tables' : 'Views';
        const item = new ExplorerItem(`${label} (${count.toLocaleString()})`, 'group', connectionId, catalog, schema, undefined, group);
        item.iconPath = new vscode.ThemeIcon(group === 'tables' ? 'symbol-structure' : 'eye');
        item.tooltip = `${count.toLocaleString()} ${label.toLowerCase()} in ${catalog}.${schema}`;
        item.contextValue = `sqlExplorer.group.${group}`;
        // Nothing to expand into, so do not offer an arrow that reveals nothing.
        item.collapsibleState = count === 0
            ? vscode.TreeItemCollapsibleState.None
            : vscode.TreeItemCollapsibleState.Collapsed;
        return item;
    }

    public static table(connectionId: string, catalog: string, schema: string, table: string, view = false): ExplorerItem {
        const item = new ExplorerItem(table, 'table', connectionId, catalog, schema, table);
        // The parent folder already says which it is, so the label stays clean.
        item.iconPath = new vscode.ThemeIcon(view ? 'eye' : 'list-flat');
        item.contextValue = view ? 'sqlExplorer.view' : 'sqlExplorer.table';
        item.tooltip = `${catalog}.${schema}.${table}`;
        // Fires on every click; the handler previews only on a double click.
        item.command = { command: 'sqlExplorer.tableClicked', title: 'Preview Table Data', arguments: [item] };
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
