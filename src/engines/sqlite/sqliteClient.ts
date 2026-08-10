import * as vscode from 'vscode';
import * as path from 'path';
import { createRequire } from 'module';
import { StoredConnection, TableEntry, TrinoColumn, TrinoQueryResult, TrinoRequestError } from '../../types';
import { numberSetting, quoteIdentifier } from '../../util';
import { SqlClient } from '../../client';
import { isSqliteInstalled, sqliteModulePath } from './sqliteRuntime';

/**
 * The slice of better-sqlite3's API this file calls. Hand-written rather than
 * `@types/better-sqlite3` because the real package is never a project
 * dependency — installing it (a native module) happens on demand at runtime,
 * downloaded into the user's machine only if they add a SQLite connection —
 * so there is nothing on disk for the compiler to read real types from.
 * Verified by hand against the installed package's own .d.ts; keep in sync if
 * better-sqlite3 changes this API.
 */
interface SqliteRunResult {
    changes: number;
}
interface SqliteStatement {
    readonly reader: boolean;
    pluck(toggleState?: boolean): SqliteStatement;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): SqliteRunResult;
    iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
}
interface SqliteDatabase {
    prepare(sql: string): SqliteStatement;
    pragma(sql: string): unknown;
    close(): void;
}
type SqliteDatabaseCtor = new (path: string, options?: { fileMustExist?: boolean }) => SqliteDatabase;

function loadSqliteApi(): SqliteDatabaseCtor {
    if (!isSqliteInstalled()) {
        throw new Error('SQLite is not installed yet. Edit this connection and click Install.');
    }
    // A dynamic require from a computed path, not a literal module specifier,
    // so esbuild leaves it alone rather than trying to bundle a package that
    // is never part of this project's own node_modules.
    const runtimeRequire = createRequire(path.join(sqliteModulePath(), 'package.json'));
    return runtimeRequire('better-sqlite3') as SqliteDatabaseCtor;
}

/**
 * SQLite, opened directly from a local file. There is no server and no
 * separate "database" to pick — the file the connection points at is the only
 * one there ever is — so the tree's catalog level is just that file's name,
 * and the schema level is whichever of SQLite's own schemas (normally just
 * `main`) the file exposes.
 */
export class SqliteClient implements SqlClient {
    /** One handle per connection id: better-sqlite3 is synchronous and safe to reuse. */
    private static readonly handles = new Map<string, SqliteDatabase>();

    public constructor(
        _secrets: vscode.SecretStorage,
        private readonly connection: StoredConnection,
        _registry?: unknown,
        _passwordOverride?: string
    ) {}

    public maxRows(): number {
        const perConnection = Number(this.connection.maxRows);
        if (Number.isFinite(perConnection) && perConnection > 0) { return Math.trunc(perConnection); }
        return numberSetting('query.maxRows', 10_000);
    }

    public async testConnection(): Promise<string> {
        const db = this.open();
        const version = db.prepare('SELECT sqlite_version()').pluck().get() as string;
        return `SQLite ${version}`;
    }

    /** One file is one database; the "catalog" is just its own name for the tree. */
    public async catalogs(): Promise<string[]> {
        return [path.basename(this.connection.url)];
    }

    public async schemas(): Promise<string[]> {
        const db = this.open();
        const attached = db.prepare('PRAGMA database_list').all() as Array<{ name: string }>;
        return attached.map(row => row.name);
    }

    public async tables(_catalog: string, schema: string): Promise<string[]> {
        return (await this.tableEntries(_catalog, schema)).map(entry => entry.name);
    }

    public async tableEntries(_catalog: string, schema: string): Promise<TableEntry[]> {
        const db = this.open();
        const rows = db.prepare(
            `SELECT name, type FROM ${quoteIdentifier(schema)}.sqlite_master
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
             ORDER BY name`
        ).all() as Array<{ name: string; type: string }>;
        return rows.map(row => ({ name: row.name, view: row.type === 'view' }));
    }

    public async columns(_catalog: string, schema: string, table: string): Promise<TrinoColumn[]> {
        const db = this.open();
        const rows = db.prepare(`PRAGMA ${quoteIdentifier(schema)}.table_info(${quoteIdentifier(table)})`).all() as Array<{
            name: string; type: string; notnull: number; pk: number;
        }>;
        return rows.map(row => ({
            name: row.name,
            type: row.type || 'TEXT',
            extra: [row.notnull ? 'not null' : '', row.pk ? 'primary key' : ''].filter(Boolean).join(', '),
            comment: ''
        }));
    }

    /** SQLite keeps the literal CREATE statement it was given, so there is nothing to assemble. */
    public async tableDdl(_catalog: string, schema: string, table: string): Promise<string> {
        const db = this.open();
        const sql = db.prepare(
            `SELECT sql FROM ${quoteIdentifier(schema)}.sqlite_master WHERE name = ?`
        ).pluck().get(table) as string | undefined;
        return sql ?? '';
    }

    public async query(statement: string): Promise<TrinoQueryResult> {
        const sql = statement.trim().replace(/;+$/, '');
        if (!sql) { throw new Error('Enter a SQL statement before running it.'); }
        return this.run(sql);
    }

    /** SQLite cannot reference another database file in a statement, only the schema within this one. */
    public qualify(_catalog?: string, schema?: string, table?: string): string {
        return [schema ?? 'main', table].filter(Boolean).map(part => quoteIdentifier(part!)).join('.');
    }

    public starterSql(): string {
        return "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name LIMIT 10;";
    }

    public previewSql(catalog: string, schema: string, table: string, limit: number): string {
        return `SELECT * FROM ${this.qualify(catalog, schema, table)} LIMIT ${limit}`;
    }

    public async previewTable(catalog: string, schema: string, table: string, limit: number): Promise<TrinoQueryResult> {
        return this.run(this.previewSql(catalog, schema, table, limit));
    }

    private run(sql: string): TrinoQueryResult {
        const db = this.open();
        try {
            const limit = this.maxRows();
            const statement = db.prepare(sql);
            if (!statement.reader) {
                const info = statement.run();
                return {
                    columns: ['result'],
                    rows: [[`${sql.trim().split(/\s+/)[0].toUpperCase()} — ${info.changes} row${info.changes === 1 ? '' : 's'} affected`]],
                    truncated: false,
                    maxRows: limit
                };
            }
            const rows: unknown[][] = [];
            let columns: string[] | undefined;
            for (const row of statement.iterate()) {
                columns ??= Object.keys(row);
                if (rows.length >= limit) { return { columns, rows, truncated: true, maxRows: limit }; }
                rows.push(Object.values(row));
            }
            return { columns: columns ?? [], rows, truncated: false, maxRows: limit };
        } catch (error) {
            throw new TrinoRequestError(error instanceof Error ? error.message : String(error));
        }
    }

    private open(): SqliteDatabase {
        const existing = SqliteClient.handles.get(this.connection.id);
        if (existing) { return existing; }
        if (!this.connection.url) { throw new Error('Choose a SQLite database file before connecting.'); }
        const Database = loadSqliteApi();
        const db = new Database(this.connection.url, { fileMustExist: true });
        db.pragma('journal_mode = WAL');
        SqliteClient.handles.set(this.connection.id, db);
        return db;
    }

    /** Closes the file handle, for when a connection is edited or removed. */
    public static closeAll(connectionId?: string): void {
        for (const [id, db] of [...SqliteClient.handles]) {
            if (connectionId && id !== connectionId) { continue; }
            SqliteClient.handles.delete(id);
            try { db.close(); } catch { /* already closed */ }
        }
    }
}

/** Creates a fresh, empty SQLite file at `file`, for the New Database button. */
export function createEmptyDatabase(file: string): void {
    const Database = loadSqliteApi();
    new Database(file).close();
}
