import * as vscode from 'vscode';
import { HistoryEntry, HistoryStore } from './queryHistoryStore';
import { ConnectionStore } from './connectionStore';

export type HistoryNodeKind = 'group' | 'entry' | 'empty';

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryTreeItem> {
    private readonly changed = new vscode.EventEmitter<HistoryTreeItem | undefined>();
    public readonly onDidChangeTreeData = this.changed.event;
    private filter = '';

    public constructor(private readonly history: HistoryStore, private readonly connections: ConnectionStore) {
        this.history.onDidChange(() => this.refresh());
    }

    public getTreeItem(item: HistoryTreeItem): vscode.TreeItem { return item; }

    public getChildren(element?: HistoryTreeItem): HistoryTreeItem[] {
        const entries = this.matchingEntries();
        if (!element) {
            if (!entries.length) { return [HistoryTreeItem.empty(this.filter ? 'No matching history' : 'No queries run yet')]; }
            const order: string[] = [];
            const byConnection = new Map<string, HistoryEntry[]>();
            for (const entry of entries) {
                if (!byConnection.has(entry.connectionId)) { order.push(entry.connectionId); byConnection.set(entry.connectionId, []); }
                byConnection.get(entry.connectionId)!.push(entry);
            }
            return order.map(connectionId => {
                const group = byConnection.get(connectionId)!;
                const name = this.connections.get(connectionId)?.name ?? group[0].connectionName;
                const removed = !this.connections.get(connectionId);
                return HistoryTreeItem.group(connectionId, name, removed, group.length);
            });
        }
        if (element.kind === 'group') {
            return entries.filter(entry => entry.connectionId === element.connectionId).map(entry => HistoryTreeItem.entry(entry));
        }
        return [];
    }

    public setFilter(text: string): void {
        this.filter = text.trim().toLowerCase();
        this.refresh();
    }

    public get isFiltered(): boolean { return Boolean(this.filter); }

    public refresh(): void { this.changed.fire(undefined); }

    private matchingEntries(): HistoryEntry[] {
        const all = this.history.all();
        if (!this.filter) { return all; }
        return all.filter(entry =>
            entry.sql.toLowerCase().includes(this.filter) || entry.connectionName.toLowerCase().includes(this.filter));
    }
}

export class HistoryTreeItem extends vscode.TreeItem {
    private constructor(label: string, public readonly kind: HistoryNodeKind, public readonly connectionId?: string, public readonly entry?: HistoryEntry) {
        super(label, kind === 'group' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        this.contextValue = `sqlExplorer.history.${kind}`;
    }

    public static empty(message: string): HistoryTreeItem {
        const item = new HistoryTreeItem(message, 'empty');
        item.iconPath = new vscode.ThemeIcon('history');
        item.tooltip = 'Every statement run from a SQL editor shows up here, newest first.';
        return item;
    }

    public static group(connectionId: string, name: string, removed: boolean, count: number): HistoryTreeItem {
        const item = new HistoryTreeItem(name, 'group', connectionId);
        item.description = removed ? `connection removed · ${count.toLocaleString()}` : count.toLocaleString();
        item.iconPath = new vscode.ThemeIcon(removed ? 'warning' : 'vm');
        item.contextValue = 'sqlExplorer.history.group';
        return item;
    }

    public static entry(entry: HistoryEntry): HistoryTreeItem {
        const item = new HistoryTreeItem(oneLine(entry.sql), 'entry', entry.connectionId, entry);
        item.description = [relativeTime(entry.executedAt), entry.success ? summary(entry) : 'failed'].filter(Boolean).join(' · ');
        item.iconPath = new vscode.ThemeIcon(entry.success ? 'history' : 'error', entry.success ? undefined : new vscode.ThemeColor('errorForeground'));
        item.tooltip = tooltip(entry);
        item.command = { command: 'sqlExplorer.historyRunEntry', title: 'Run Query', arguments: [item] };
        return item;
    }
}

function summary(entry: HistoryEntry): string {
    if (entry.rowCount === undefined || entry.milliseconds === undefined) { return ''; }
    return `${entry.rowCount.toLocaleString()} row${entry.rowCount === 1 ? '' : 's'}`;
}

function oneLine(sql: string): string {
    const flat = sql.replace(/\s+/g, ' ').trim();
    return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function tooltip(entry: HistoryEntry): vscode.MarkdownString {
    const when = new Date(entry.executedAt).toLocaleString();
    const status = entry.success
        ? `${entry.rowCount?.toLocaleString() ?? '?'} row(s) in ${entry.milliseconds ?? '?'}ms`
        : `Failed: ${entry.error ?? 'unknown error'}`;
    const database = entry.database ? `\n\nDatabase: \`${entry.database}\`` : '';
    return new vscode.MarkdownString(`\`\`\`sql\n${entry.sql}\n\`\`\`\n\n${when} · ${status}${database}`);
}

function relativeTime(at: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) { return 'just now'; }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) { return `${minutes}m ago`; }
    const hours = Math.round(minutes / 60);
    if (hours < 24) { return `${hours}h ago`; }
    const days = Math.round(hours / 24);
    if (days < 7) { return `${days}d ago`; }
    return new Date(at).toLocaleDateString();
}
