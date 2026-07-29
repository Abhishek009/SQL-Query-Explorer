import * as vscode from 'vscode';
import { StoredConnection, TrinoColumn } from './types';
import { ConnectionStore } from './connectionStore';
import { TrinoClient } from './trinoClient';
import { quoteIdentifier, showConnectionError } from './util';

export type ExplorerNodeKind = 'connection' | 'catalog' | 'schema' | 'table' | 'column' | 'empty';

export class TrinoExplorerProvider implements vscode.TreeDataProvider<ExplorerItem> {
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
