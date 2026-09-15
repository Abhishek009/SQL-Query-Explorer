import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

export interface SavedQuery {
    id: string;
    name: string;
    sql: string;
    /** Slash-separated folder path ("Reports/Weekly"); absent/empty means the root. */
    folder?: string;
    /** Optional — the connection this was written for. Falls back to the active connection when run if it no longer exists. */
    connectionId?: string;
    /** The catalog/database it ran against, if the engine addresses one. */
    database?: string;
    createdAt: number;
    updatedAt: number;
}

/**
 * Named queries organized into folders, kept in the `sqlExplorer.savedQueries`
 * setting — same pattern as ConnectionStore, since this is a small,
 * deliberately-curated list a user may want to hand-edit or carry over via
 * Settings Sync, unlike the high-volume, auto-generated query history.
 */
export class SavedQueryStore {
    private readonly changed = new vscode.EventEmitter<void>();
    public readonly onDidChange = this.changed.event;

    public all(): SavedQuery[] {
        return vscode.workspace.getConfiguration('sqlExplorer').get<SavedQuery[]>('savedQueries') ?? [];
    }

    public get(id: string | undefined): SavedQuery | undefined {
        return id ? this.all().find(query => query.id === id) : undefined;
    }

    /** Every distinct folder path that exists, including empty ones created with no query in them yet. */
    public folders(): string[] {
        const paths = new Set<string>();
        for (const query of this.all()) {
            for (const path of ancestry(query.folder)) { paths.add(path); }
        }
        for (const path of this.emptyFolders()) { paths.add(path); }
        return [...paths].sort((left, right) => left.localeCompare(right));
    }

    public async create(name: string, sql: string, folder?: string, connectionId?: string, database?: string): Promise<SavedQuery> {
        const now = Date.now();
        const query: SavedQuery = { id: randomUUID(), name, sql, folder: folder || undefined, connectionId, database, createdAt: now, updatedAt: now };
        await this.write([...this.all(), query]);
        return query;
    }

    public async update(id: string, changes: Partial<Pick<SavedQuery, 'name' | 'sql' | 'folder' | 'connectionId' | 'database'>>): Promise<void> {
        const queries = this.all();
        const index = queries.findIndex(query => query.id === id);
        if (index < 0) { return; }
        queries[index] = { ...queries[index], ...changes, updatedAt: Date.now() };
        await this.write(queries);
    }

    public async remove(id: string): Promise<void> {
        await this.write(this.all().filter(query => query.id !== id));
    }

    public async addFolder(path: string): Promise<void> {
        if (this.folders().includes(path)) { return; }
        await this.context().update('savedQueryFolders', [...this.emptyFolders(), path], vscode.ConfigurationTarget.Global);
    }

    /** Renaming/deleting a folder cascades to every query and subfolder nested under it. */
    public async renameFolder(from: string, to: string): Promise<void> {
        const queries = this.all().map(query => query.folder && withinFolder(query.folder, from)
            ? { ...query, folder: to + query.folder.slice(from.length) }
            : query);
        const empty = this.emptyFolders()
            .filter(path => path !== from)
            .map(path => withinFolder(path, from) ? to + path.slice(from.length) : path);
        await this.write(queries);
        await this.context().update('savedQueryFolders', [...empty, to], vscode.ConfigurationTarget.Global);
    }

    public async removeFolder(path: string): Promise<void> {
        const queries = this.all().filter(query => !query.folder || !withinFolder(query.folder, path));
        const empty = this.emptyFolders().filter(existing => existing !== path && !withinFolder(existing, path));
        await this.write(queries);
        await this.context().update('savedQueryFolders', empty, vscode.ConfigurationTarget.Global);
    }

    /** Folders with no query directly or transitively in them yet — tracked separately so "New Folder" has somewhere to persist. */
    private emptyFolders(): string[] {
        return vscode.workspace.getConfiguration('sqlExplorer').get<string[]>('savedQueryFolders') ?? [];
    }

    private context(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('sqlExplorer');
    }

    private async write(queries: SavedQuery[]): Promise<void> {
        await this.context().update('savedQueries', queries, vscode.ConfigurationTarget.Global);
        this.changed.fire();
    }
}

/** A folder path and every ancestor above it: "A/B/C" → ["A", "A/B", "A/B/C"]. */
function ancestry(folder: string | undefined): string[] {
    if (!folder) { return []; }
    const segments = folder.split('/');
    return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

function withinFolder(folder: string, ancestor: string): boolean {
    return folder === ancestor || folder.startsWith(`${ancestor}/`);
}
