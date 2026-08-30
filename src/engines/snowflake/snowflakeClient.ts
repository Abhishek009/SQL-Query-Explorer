import * as vscode from 'vscode';
import * as path from 'path';
import { createRequire } from 'module';
import { Readable } from 'stream';
import { StoredConnection, TableEntry, TrinoColumn, TrinoQueryResult, TrinoRequestError } from '../../types';
import { passwordKey } from '../../connectionStore';
import { RunningQueryRegistry } from '../../runningQueries';
import { numberSetting, quoteIdentifier, quoteLiteral } from '../../util';
import { SqlClient } from '../../client';
import { splitStatements } from '../../statements';
import { isSnowflakeInstalled, snowflakeModulePath } from './snowflakeRuntime';

/**
 * The slice of snowflake-sdk's API this file calls. Hand-written rather than
 * imported from the real package, because snowflake-sdk is never a project
 * dependency — it pulls in AWS/Azure/GCS SDKs for bulk-load features this
 * extension never uses, so installing it happens on demand at runtime,
 * downloaded into the user's machine only if they add a Snowflake connection
 * — there is nothing on disk for the compiler to read real types from.
 * Verified by hand against the installed package's own .d.ts; keep in sync if
 * snowflake-sdk changes this API.
 */
interface SnowflakeConnectionOptions {
    account: string;
    username?: string;
    password?: string;
    authenticator?: string;
    warehouse?: string;
    database?: string;
    schema?: string;
    role?: string;
    clientSessionKeepAlive?: boolean;
}
interface SnowflakeColumn {
    getName(): string;
}
interface SnowflakeStatement {
    getColumns(): SnowflakeColumn[] | undefined;
    getNumRows(): number | undefined;
    getNumUpdatedRows(): number | undefined;
    streamRows(options?: { start?: number; end?: number }): Readable;
    cancel(callback?: (error?: Error) => void): void;
}
interface SnowflakeExecuteOptions {
    sqlText: string;
    binds?: ReadonlyArray<string | number | boolean | null>;
    rowMode?: 'array';
    streamResult?: boolean;
    complete: (error: Error | undefined, statement: SnowflakeStatement) => void;
}
interface SnowflakeConnection {
    isUp(): boolean;
    connect(callback: (error: Error | undefined, connection: SnowflakeConnection) => void): void;
    execute(options: SnowflakeExecuteOptions): SnowflakeStatement;
    destroy(callback: (error: Error | undefined) => void): void;
}
interface SnowflakeApi {
    createConnection(options: SnowflakeConnectionOptions): SnowflakeConnection;
}

function loadSnowflakeApi(): SnowflakeApi {
    if (!isSnowflakeInstalled()) {
        throw new Error('Snowflake is not installed yet. Edit this connection and click Install.');
    }
    // A dynamic require from a computed path, not a literal module specifier,
    // so esbuild leaves it alone rather than trying to bundle a package that
    // is never part of this project's own node_modules.
    const runtimeRequire = createRequire(path.join(snowflakeModulePath(), 'package.json'));
    return runtimeRequire('snowflake-sdk') as SnowflakeApi;
}

const SYSTEM_DATABASES = new Set(['SNOWFLAKE']);

/**
 * Snowflake over the official snowflake-sdk. Like Trino, a database (its
 * "catalog") can be referenced directly from SQL without a separate
 * connection per one — unlike Postgres — so one connection serves every
 * database/schema the role can see, with a real schema level in between
 * (unlike MySQL/MongoDB, which fake that level by repeating the database).
 */
export class SnowflakeClient implements SqlClient {
    /** One connection per StoredConnection id, reused across databases/schemas. */
    private static readonly connections = new Map<string, SnowflakeConnection>();

    public constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly connection: StoredConnection,
        private readonly registry?: RunningQueryRegistry,
        /** Supplied while testing details that are not in Secret Storage yet. */
        private readonly passwordOverride?: string
    ) {}

    public maxRows(): number {
        const perConnection = Number(this.connection.maxRows);
        if (Number.isFinite(perConnection) && perConnection > 0) { return Math.trunc(perConnection); }
        return numberSetting('query.maxRows', 10_000);
    }

    public async testConnection(): Promise<string> {
        const result = await this.run('SELECT CURRENT_VERSION()', 1);
        return `Snowflake ${String(result.rows[0]?.[0] ?? '')}`;
    }

    public async catalogs(): Promise<string[]> {
        const result = await this.run('SHOW DATABASES', 10_000);
        const nameColumn = result.columns.findIndex(name => name.toLowerCase() === 'name');
        return result.rows
            .map(row => String(row[nameColumn >= 0 ? nameColumn : 1] ?? ''))
            .filter(name => name && !SYSTEM_DATABASES.has(name.toUpperCase()));
    }

    public async schemas(catalog: string): Promise<string[]> {
        const result = await this.run(
            `SELECT schema_name FROM ${quoteIdentifier(catalog)}.information_schema.schemata
             WHERE schema_name <> 'INFORMATION_SCHEMA' ORDER BY schema_name`,
            10_000
        );
        return result.rows.map(row => String(row[0]));
    }

    public async tables(catalog: string, schema: string): Promise<string[]> {
        return (await this.tableEntries(catalog, schema)).map(entry => entry.name);
    }

    public async tableEntries(catalog: string, schema: string): Promise<TableEntry[]> {
        const result = await this.run(
            `SELECT table_name, table_type FROM ${quoteIdentifier(catalog)}.information_schema.tables
             WHERE table_schema = ? ORDER BY table_name`,
            10_000, [schema]
        );
        return result.rows
            .map(row => ({ name: String(row[0] ?? ''), view: String(row[1] ?? '') === 'VIEW' }))
            .filter(entry => entry.name);
    }

    public async columns(catalog: string, schema: string, table: string): Promise<TrinoColumn[]> {
        const result = await this.run(
            `SELECT column_name, data_type, is_nullable, comment FROM ${quoteIdentifier(catalog)}.information_schema.columns
             WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
            10_000, [schema, table]
        );
        // Best-effort — a role without MONITOR/OWNERSHIP on the table can't SHOW its keys.
        const primaryKeys = await this.run(`SHOW PRIMARY KEYS IN TABLE ${this.qualify(catalog, schema, table)}`, 1_000)
            .then(keys => new Set(keys.rows.map(row => String(row[keys.columns.findIndex(name => name.toLowerCase() === 'column_name')] ?? '').toUpperCase())))
            .catch(() => new Set<string>());
        return result.rows.map(row => {
            const name = String(row[0] ?? '');
            return {
                name,
                type: String(row[1] ?? ''),
                extra: [String(row[2] ?? '') === 'NO' ? 'not null' : '', primaryKeys.has(name.toUpperCase()) ? 'primary key' : '']
                    .filter(Boolean).join(', '),
                comment: String(row[3] ?? '')
            };
        }).filter(column => column.name);
    }

    /** Snowflake's GET_DDL() returns the literal CREATE statement, like MySQL's SHOW CREATE TABLE. */
    public async tableDdl(catalog: string, schema: string, table: string, view = false): Promise<string> {
        const qualified = this.qualify(catalog, schema, table);
        const result = await this.run(`SELECT GET_DDL(${quoteLiteral(view ? 'VIEW' : 'TABLE')}, ${quoteLiteral(qualified)})`, 1);
        return String(result.rows[0]?.[0] ?? '');
    }

    public async query(statement: string, token?: vscode.CancellationToken, database?: string): Promise<TrinoQueryResult> {
        const sql = statement.trim().replace(/;+$/, '');
        if (!sql) { throw new Error('Enter a SQL statement before running it.'); }
        const parts = splitStatements(sql).map(entry => entry.text).filter(Boolean);
        if (parts.length === 0) { throw new Error('Enter a SQL statement before running it.'); }
        const conn = await this.client();
        // A specific database scope means bare, unqualified table names in the
        // statement should resolve there — the session otherwise keeps whatever
        // database it connected with, same as switching worksheets in Snowsight.
        if (database && database !== this.connection.catalog) {
            await this.runOnConnection(conn, `USE DATABASE ${quoteIdentifier(database)}`, 1, token);
        }
        let result: TrinoQueryResult | undefined;
        for (const part of parts) {
            if (token?.isCancellationRequested) { throw new Error('Query was cancelled.'); }
            result = await this.runOnConnection(conn, part, this.maxRows(), token);
        }
        return result!;
    }

    /** Snowflake can reference any database/schema the role can see directly from SQL, like Trino. */
    public qualify(catalog?: string, schema?: string, table?: string): string {
        return [catalog, schema, table].filter(Boolean).map(part => quoteIdentifier(part!)).join('.');
    }

    public quoteIdentifier(identifier: string): string {
        return quoteIdentifier(identifier);
    }

    public starterSql(): string {
        return 'SELECT table_schema, table_name\nFROM information_schema.tables\nWHERE table_schema <> \'INFORMATION_SCHEMA\'\nORDER BY table_schema, table_name\nLIMIT 10;';
    }

    public previewSql(catalog: string, schema: string, table: string, limit: number): string {
        return `SELECT * FROM ${this.qualify(catalog, schema, table)} LIMIT ${limit}`;
    }

    public async previewTable(catalog: string, schema: string, table: string, limit: number, token?: vscode.CancellationToken): Promise<TrinoQueryResult> {
        return this.run(this.previewSql(catalog, schema, table, limit), limit, undefined, token);
    }

    private async run(
        sql: string,
        limit: number,
        binds?: ReadonlyArray<string | number | boolean | null>,
        token?: vscode.CancellationToken
    ): Promise<TrinoQueryResult> {
        const conn = await this.client();
        return this.runOnConnection(conn, sql, limit, token, binds);
    }

    /**
     * Streams the statement's rows rather than buffering them all, the same
     * reason Trino pages and Postgres uses a cursor: an unbounded SELECT must
     * not fill memory. `streamRows({end: limit})` does the capping for us —
     * one extra row past `limit` reveals whether anything was left behind.
     */
    private async runOnConnection(
        conn: SnowflakeConnection,
        sql: string,
        limit: number,
        token?: vscode.CancellationToken,
        binds?: ReadonlyArray<string | number | boolean | null>
    ): Promise<TrinoQueryResult> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

            let statement: SnowflakeStatement | undefined;
            const entry = this.registry?.add({
                connectionName: this.connection.name,
                sql,
                startedAt: Date.now(),
                cancel: () => new Promise<boolean>(resolveCancel => {
                    statement ? statement.cancel(error => resolveCancel(!error)) : resolveCancel(false);
                })
            });
            const cleanup = () => { cancellation?.dispose(); if (entry) { this.registry?.remove(entry.id); } };
            const cancellation = token?.onCancellationRequested(() => statement?.cancel());

            statement = conn.execute({
                sqlText: sql,
                binds,
                rowMode: 'array',
                streamResult: true,
                complete: (error, stmt) => {
                    if (error) { cleanup(); settle(() => reject(asSnowflakeError(error))); return; }
                    const columns = (stmt.getColumns() ?? []).map(column => column.getName());
                    if (columns.length === 0) {
                        // No result set at all — a DDL/session command with nothing to show.
                        const affected = stmt.getNumUpdatedRows() ?? stmt.getNumRows() ?? 0;
                        const command = sql.trim().split(/\s+/)[0].toUpperCase();
                        cleanup();
                        settle(() => resolve({
                            columns: ['result'],
                            rows: [[`${command} — ${affected} row${affected === 1 ? '' : 's'} affected`]],
                            truncated: false,
                            maxRows: limit
                        }));
                        return;
                    }
                    const rows: unknown[][] = [];
                    let truncated = false;
                    const cursor = stmt.streamRows({ start: 0, end: limit });
                    cursor.on('data', (row: unknown[]) => {
                        if (rows.length >= limit) { truncated = true; return; }
                        rows.push(row);
                    });
                    cursor.on('end', () => { cleanup(); settle(() => resolve({ columns, rows, truncated, maxRows: limit })); });
                    cursor.on('error', (streamError: Error) => { cleanup(); settle(() => reject(asSnowflakeError(streamError))); });
                }
            });
        });
    }

    private async client(): Promise<SnowflakeConnection> {
        const key = this.connection.id;
        const existing = SnowflakeClient.connections.get(key);
        if (existing?.isUp()) { return existing; }

        const isExternalBrowser = this.connection.authenticator === 'externalbrowser';
        const password = isExternalBrowser
            ? undefined
            : this.passwordOverride ?? await this.secrets.get(passwordKey(this.connection.id));

        const api = loadSnowflakeApi();
        const conn = api.createConnection({
            account: this.connection.url,
            username: this.connection.user,
            password,
            authenticator: isExternalBrowser ? 'EXTERNALBROWSER' : undefined,
            warehouse: this.connection.warehouse || undefined,
            database: this.connection.catalog || undefined,
            schema: this.connection.schema || undefined,
            role: this.connection.role || undefined,
            clientSessionKeepAlive: true
        });
        await new Promise<void>((resolve, reject) => {
            conn.connect(error => { if (error) { reject(asSnowflakeError(error)); } else { resolve(); } });
        });
        SnowflakeClient.connections.set(key, conn);
        return conn;
    }

    /** Drops any open connection, for when a connection is edited or removed. */
    public static async closeAll(connectionId?: string): Promise<void> {
        for (const [key, conn] of [...SnowflakeClient.connections]) {
            if (connectionId && key !== connectionId) { continue; }
            SnowflakeClient.connections.delete(key);
            await new Promise<void>(resolve => conn.destroy(() => resolve()));
        }
    }
}

function asSnowflakeError(error: unknown): Error {
    const failure = error as { message?: string; code?: string | number; sqlState?: string };
    const message = failure?.message ?? String(error);
    const details = [
        failure?.code !== undefined && `code: ${failure.code}`,
        failure?.sqlState && `sqlState: ${failure.sqlState}`
    ].filter(Boolean).join('\n');
    return new TrinoRequestError(message, details || undefined);
}
