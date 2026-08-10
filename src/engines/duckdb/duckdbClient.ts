import * as vscode from 'vscode';
import * as path from 'path';
import { createRequire } from 'module';
import type { DuckDBConnection, DuckDBInstance, DuckDBResultReader } from '@duckdb/node-api';
import { StoredConnection, TableEntry, TrinoColumn, TrinoQueryResult, TrinoRequestError } from '../../types';
import { numberSetting, quoteIdentifier } from '../../util';
import { SqlClient } from '../../client';
import { duckdbModulePath, isDuckdbInstalled } from './duckdbRuntime';

interface DuckdbApi {
    DuckDBInstance: typeof DuckDBInstance;
}

/** Verified against the installed package's own enum — see duckdb-api.d.ts. */
const SELECT_STATEMENT = 1;

function loadDuckdbApi(): DuckdbApi {
    if (!isDuckdbInstalled()) {
        throw new Error('DuckDB is not installed yet. Edit this connection and click Install.');
    }
    // A dynamic require from a computed path, not a literal module specifier,
    // so esbuild leaves it alone rather than trying to bundle a package that
    // is never part of this project's own node_modules.
    const runtimeRequire = createRequire(path.join(duckdbModulePath(), 'package.json'));
    return runtimeRequire('@duckdb/node-api') as DuckdbApi;
}

function normalizeCell(value: unknown): unknown {
    // BigInt (from BIGINT/HUGEINT columns) cannot be JSON-serialized to the
    // results webview, so it is carried as a string like the other engines'
    // drivers already do for oversized integers.
    return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * DuckDB, embedded directly in the extension host — no server. Like SQLite,
 * one file is one catalog; unlike SQLite, DuckDB's own `duckdb_tables()` and
 * `information_schema` give real column types and literal CREATE statements.
 */
export class DuckdbClient implements SqlClient {
    private static readonly connections = new Map<string, DuckDBConnection>();

    public constructor(
        _secrets: vscode.SecretStorage,
        private readonly connection: StoredConnection
    ) {}

    public maxRows(): number {
        const perConnection = Number(this.connection.maxRows);
        if (Number.isFinite(perConnection) && perConnection > 0) { return Math.trunc(perConnection); }
        return numberSetting('query.maxRows', 10_000);
    }

    public async testConnection(): Promise<string> {
        const reader = await this.exec('SELECT version()');
        return `DuckDB ${String(reader.getRowsJS()[0]?.[0] ?? '')}`;
    }

    /** One file is one catalog, named after it — nothing else to list. */
    public async catalogs(): Promise<string[]> {
        const reader = await this.exec('SELECT current_catalog()');
        return [String(reader.getRowsJS()[0]?.[0] ?? '')];
    }

    public async schemas(): Promise<string[]> {
        const reader = await this.exec(
            `SELECT schema_name FROM information_schema.schemata
             WHERE catalog_name = current_catalog() AND schema_name NOT IN ('pg_catalog', 'information_schema')
             ORDER BY schema_name`
        );
        return reader.getRowsJS().map(row => String(row[0]));
    }

    public async tables(catalog: string, schema: string): Promise<string[]> {
        return (await this.tableEntries(catalog, schema)).map(entry => entry.name);
    }

    public async tableEntries(_catalog: string, schema: string): Promise<TableEntry[]> {
        const reader = await this.exec(
            'SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name',
            [schema]
        );
        return reader.getRowsJS().map(row => ({ name: String(row[0]), view: String(row[1]) === 'VIEW' }));
    }

    public async columns(_catalog: string, schema: string, table: string): Promise<TrinoColumn[]> {
        const reader = await this.exec(
            `SELECT column_name, data_type, is_nullable FROM information_schema.columns
             WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
            [schema, table]
        );
        return reader.getRowsJS().map(row => ({
            name: String(row[0]),
            type: String(row[1]),
            extra: String(row[2]) === 'NO' ? 'not null' : '',
            comment: ''
        }));
    }

    /** DuckDB keeps the literal CREATE statement for both tables and views. */
    public async tableDdl(_catalog: string, schema: string, table: string, view = false): Promise<string> {
        const source = view ? 'duckdb_views()' : 'duckdb_tables()';
        const nameColumn = view ? 'view_name' : 'table_name';
        const reader = await this.exec(`SELECT sql FROM ${source} WHERE schema_name = ? AND ${nameColumn} = ?`, [schema, table]);
        return String(reader.getRowsJS()[0]?.[0] ?? '');
    }

    public async query(statement: string): Promise<TrinoQueryResult> {
        const sql = statement.trim().replace(/;+$/, '');
        if (!sql) { throw new Error('Enter a SQL statement before running it.'); }
        return this.run(sql, this.maxRows());
    }

    /** DuckDB cannot reference another database file in a statement, only the schema within this one. */
    public qualify(_catalog?: string, schema?: string, table?: string): string {
        return [schema ?? 'main', table].filter(Boolean).map(part => quoteIdentifier(part!)).join('.');
    }

    public starterSql(): string {
        return "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name LIMIT 10;";
    }

    public previewSql(catalog: string, schema: string, table: string, limit: number): string {
        return `SELECT * FROM ${this.qualify(catalog, schema, table)} LIMIT ${limit}`;
    }

    public async previewTable(catalog: string, schema: string, table: string, limit: number): Promise<TrinoQueryResult> {
        return this.run(this.previewSql(catalog, schema, table, limit), limit);
    }

    /**
     * Reads in chunks until the cap is met rather than materialising the whole
     * result set, the same reason Trino pages and Postgres uses a cursor.
     */
    private async run(sql: string, limit: number): Promise<TrinoQueryResult> {
        try {
            const connection = await this.open();
            const reader: DuckDBResultReader = await connection.runAndReadUntil(sql, limit + 1);
            if (reader.statementType !== SELECT_STATEMENT) {
                const affected = reader.rowsChanged;
                const command = sql.split(/\s+/)[0].toUpperCase();
                return {
                    columns: ['result'],
                    rows: [[`${command} — ${affected} row${affected === 1 ? '' : 's'} affected`]],
                    truncated: false,
                    maxRows: limit
                };
            }
            const rawRows = reader.getRowsJS();
            const truncated = rawRows.length > limit || !reader.done;
            const rows = (truncated ? rawRows.slice(0, limit) : rawRows).map(row => row.map(normalizeCell));
            return { columns: reader.columnNames(), rows, truncated, maxRows: limit };
        } catch (error) {
            throw new TrinoRequestError(error instanceof Error ? error.message : String(error));
        }
    }

    private async exec(sql: string, values?: unknown[]): Promise<DuckDBResultReader> {
        try {
            const connection = await this.open();
            return await connection.runAndReadAll(sql, values);
        } catch (error) {
            throw new TrinoRequestError(error instanceof Error ? error.message : String(error));
        }
    }

    private async open(): Promise<DuckDBConnection> {
        const existing = DuckdbClient.connections.get(this.connection.id);
        if (existing) { return existing; }
        if (!this.connection.url) { throw new Error('Choose a DuckDB database file before connecting.'); }
        const api = loadDuckdbApi();
        const instance = await api.DuckDBInstance.create(this.connection.url);
        const connection = await instance.connect();
        DuckdbClient.connections.set(this.connection.id, connection);
        return connection;
    }

    /** Drops the open connection, for when a connection is edited or removed. */
    public static closeAll(connectionId?: string): void {
        for (const [id, connection] of [...DuckdbClient.connections]) {
            if (connectionId && id !== connectionId) { continue; }
            DuckdbClient.connections.delete(id);
            try { connection.closeSync(); } catch { /* already closed */ }
        }
    }
}

/** Creates a fresh, empty DuckDB file at `file`, for the New Database button. */
export async function createEmptyDuckdb(file: string): Promise<void> {
    const api = loadDuckdbApi();
    const instance = await api.DuckDBInstance.create(file);
    const connection = await instance.connect();
    connection.closeSync();
}
