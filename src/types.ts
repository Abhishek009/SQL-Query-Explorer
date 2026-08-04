import * as vscode from 'vscode';

export interface StoredConnection {
    id: string;
    name: string;
    url: string;
    user: string;
    catalog?: string;
    schema?: string;
    /** Optional per-connection override of `trino.query.maxRows`. */
    maxRows?: number;
}

export interface TrinoQueryResult {
    columns: string[];
    rows: unknown[][];
    /** True when the row cap stopped the fetch before Trino ran out of rows. */
    truncated?: boolean;
    maxRows?: number;
}

/** Carries the untruncated server response alongside the short display message. */
export class TrinoRequestError extends Error {
    public constructor(message: string, public readonly details?: string) {
        super(message);
        this.name = 'TrinoRequestError';
    }
}

export interface TableEntry {
    name: string;
    view: boolean;
}

export interface TrinoColumn {
    name: string;
    type: string;
    extra: string;
    comment: string;
}

/**
 * Renders query output in the bottom panel beside Terminal and Output rather
 * than in an editor tab. The view is created lazily, so the first result has to
 * reveal it before its webview exists.
 */
export interface ResultsState {
    connection: StoredConnection;
    result: TrinoQueryResult;
    limit: number;
    sql: string;
    milliseconds: number;
    executedAt: number;
    sort?: { column: number; direction: 'asc' | 'desc' };
    /** Memoised sort output, keyed so a repaint does not re-sort. */
    sortedRows?: unknown[][];
    sortedKey?: string;
    subtitle?: string;
    /** Re-runs the statement with a new LIMIT when the row cap is raised. */
    refetch?: (limit: number, token?: vscode.CancellationToken) => Promise<TrinoQueryResult>;
}

export interface ErrorState {
    connection: StoredConnection;
    sql: string;
    message: string;
    details?: string;
}
