import * as vscode from 'vscode';
import { StoredConnection } from './types';
import { ConnectionStore } from './connectionStore';
import { addressesByDatabase, engineOf, ENGINE_LABELS } from './client';

/** Kept for editors written before the picker existed, and for hand-edited files. */
export const CONNECTION_HEADER = /^\s*--\s*Connection:\s*(.+?)\s*$/im;
export const DATABASE_HEADER = /^\s*--\s*Database:\s*(.+?)\s*$/im;

export interface ResolvedScope {
    connection?: StoredConnection;
    /** The catalog (Trino) or database (Postgres) statements run against. */
    database?: string;
}

/**
 * Which connection and database a SQL editor runs against. A file needs no
 * header to run: the active connection is the default, a header overrides it
 * when present, and an explicit pick from the lens overrides both.
 */
export class QueryScope {
    private readonly picked = new Map<string, { connectionId?: string; database?: string }>();
    private readonly changed = new vscode.EventEmitter<void>();
    public readonly onDidChange = this.changed.event;

    public constructor(private readonly store: ConnectionStore) {}

    public resolve(document: vscode.TextDocument): ResolvedScope {
        const chosen = this.picked.get(document.uri.toString());
        const text = document.getText();
        const connection =
            this.store.get(chosen?.connectionId)
            ?? this.byName(CONNECTION_HEADER.exec(text)?.[1])
            ?? this.store.get(this.store.activeId);
        if (!connection) { return {}; }
        const database =
            chosen?.database
            ?? DATABASE_HEADER.exec(text)?.[1]
            ?? connection.catalog;
        return { connection, database };
    }

    public setConnection(document: vscode.TextDocument, connectionId: string): void {
        const key = document.uri.toString();
        // The database belongs to the old connection, so it cannot carry over.
        this.picked.set(key, { connectionId });
        this.changed.fire();
    }

    public setDatabase(document: vscode.TextDocument, database: string): void {
        const key = document.uri.toString();
        const current = this.picked.get(key) ?? {};
        this.picked.set(key, { ...current, connectionId: current.connectionId ?? this.resolve(document).connection?.id, database });
        this.changed.fire();
    }

    public forget(uri: vscode.Uri): void {
        if (this.picked.delete(uri.toString())) { this.changed.fire(); }
    }

    /** The label the lens shows for a database, or undefined when the engine has no such level. */
    public databaseLabel(scope: ResolvedScope): string | undefined {
        if (!scope.connection) { return undefined; }
        const engine = engineOf(scope.connection);
        return scope.database || (addressesByDatabase(engine) ? ENGINE_LABELS[engine] : 'no catalog');
    }

    private byName(name: string | undefined): StoredConnection | undefined {
        return name ? this.store.all().find(connection => connection.name === name.trim()) : undefined;
    }
}
