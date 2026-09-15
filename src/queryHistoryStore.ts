import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { numberSetting } from './util';

export interface HistoryEntry {
    id: string;
    connectionId: string;
    /** Snapshot of the connection's name at the time this ran, so history stays readable after a rename or removal. */
    connectionName: string;
    database?: string;
    sql: string;
    executedAt: number;
    milliseconds?: number;
    rowCount?: number;
    success: boolean;
    error?: string;
}

const STORAGE_KEY = 'sqlExplorer.queryHistory';

/**
 * Every statement run from a SQL editor, newest first. Kept in globalState
 * rather than a setting — unlike connections or saved queries, this is
 * high-volume and auto-generated, not something to hand-edit or sync as
 * settings.json.
 */
export class HistoryStore {
    private readonly changed = new vscode.EventEmitter<void>();
    public readonly onDidChange = this.changed.event;

    public constructor(private readonly context: vscode.ExtensionContext) {}

    public all(): HistoryEntry[] {
        return this.context.globalState.get<HistoryEntry[]>(STORAGE_KEY) ?? [];
    }

    public async record(entry: Omit<HistoryEntry, 'id'>): Promise<void> {
        if (!entry.sql.trim()) { return; }
        const limit = Math.max(1, Math.trunc(numberSetting('history.limit', 500)));
        const withoutOverflow = trimPerConnection([{ ...entry, id: randomUUID() }, ...this.all()], limit);
        await this.write(withoutOverflow);
    }

    public async remove(id: string): Promise<void> {
        await this.write(this.all().filter(item => item.id !== id));
    }

    public async clear(connectionId?: string): Promise<void> {
        await this.write(connectionId ? this.all().filter(item => item.connectionId !== connectionId) : []);
    }

    private async write(entries: HistoryEntry[]): Promise<void> {
        await this.context.globalState.update(STORAGE_KEY, entries);
        this.changed.fire();
    }
}

/** Caps each connection's own run separately, so a heavily-used connection cannot crowd out a rarely-used one's history. */
function trimPerConnection(entries: HistoryEntry[], limit: number): HistoryEntry[] {
    const seen = new Map<string, number>();
    return entries.filter(entry => {
        const count = seen.get(entry.connectionId) ?? 0;
        if (count >= limit) { return false; }
        seen.set(entry.connectionId, count + 1);
        return true;
    });
}
