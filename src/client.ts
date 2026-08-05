import * as vscode from 'vscode';
import { StoredConnection, TableEntry, TrinoColumn, TrinoQueryResult } from './types';
import { RunningQueryRegistry } from './runningQueries';
import { TrinoClient } from './trinoClient';
import { PostgresClient } from './postgresClient';

/**
 * What the explorer, completion, and query commands need from an engine. Every
 * engine maps its own hierarchy onto catalog → schema → table so one tree and
 * one set of commands serve all of them.
 */
export interface SqlClient {
    catalogs(token?: vscode.CancellationToken): Promise<string[]>;
    schemas(catalog: string): Promise<string[]>;
    tables(catalog: string, schema: string): Promise<string[]>;
    tableEntries(catalog: string, schema: string): Promise<TableEntry[]>;
    columns(catalog: string, schema: string, table: string): Promise<TrinoColumn[]>;
    tableDdl(catalog: string, schema: string, table: string, view?: boolean, token?: vscode.CancellationToken): Promise<string>;
    query(statement: string, token?: vscode.CancellationToken): Promise<TrinoQueryResult>;
    maxRows(): number;
    /** Proves the connection works, returning something identifying to show back. */
    testConnection(token?: vscode.CancellationToken): Promise<string>;
}

export type EngineId = 'trino' | 'postgres';

/** Connections without a type predate Postgres support, so they are Trino. */
export function engineOf(connection: StoredConnection): EngineId {
    return connection.type === 'postgres' ? 'postgres' : 'trino';
}

export const ENGINE_LABELS: Record<EngineId, string> = {
    trino: 'Trino',
    postgres: 'PostgreSQL'
};

export function createClient(
    secrets: vscode.SecretStorage,
    connection: StoredConnection,
    registry?: RunningQueryRegistry,
    /** Used when testing details that have not been saved to Secret Storage yet. */
    password?: string
): SqlClient {
    return engineOf(connection) === 'postgres'
        ? new PostgresClient(secrets, connection, registry, password)
        : new TrinoClient(secrets, connection, registry, password);
}
