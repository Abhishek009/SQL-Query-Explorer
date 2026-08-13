import * as vscode from 'vscode';
import * as mysql from 'mysql2';
import { StoredConnection, TableEntry, TrinoColumn, TrinoQueryResult, TrinoRequestError } from '../../types';
import { passwordKey } from '../../connectionStore';
import { RunningQueryRegistry } from '../../runningQueries';
import { numberSetting } from '../../util';
import { SqlClient } from '../../client';
import { splitStatements } from '../../statements';

/** MySQL quotes identifiers with backticks, not the double quotes every other engine here uses. */
function quoteIdent(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
}

const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

/**
 * MySQL over mysql2. A "database" there is what Postgres calls a schema — one
 * connection can see every database on the server, unlike Postgres where each
 * one needs its own connection — but the shared catalog → schema → table shape
 * still needs three levels, so the schema level just repeats the catalog name.
 */
export class MySqlClient implements SqlClient {
    /** One pool per database: queries need to run against a specific one. */
    private static readonly pools = new Map<string, mysql.Pool>();

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
        const result = await this.run('SELECT VERSION()', 1);
        return `MySQL ${String(result.rows[0]?.[0] ?? '')}`;
    }

    public async catalogs(): Promise<string[]> {
        const result = await this.run('SHOW DATABASES', 1_000);
        return result.rows.map(row => String(row[0])).filter(name => !SYSTEM_DATABASES.has(name));
    }

    /** MySQL has no level between database and table, so the schema just names the database again. */
    public async schemas(catalog: string): Promise<string[]> {
        return [catalog];
    }

    public async tables(catalog: string, schema: string): Promise<string[]> {
        return (await this.tableEntries(catalog, schema)).map(entry => entry.name);
    }

    public async tableEntries(catalog: string, _schema: string): Promise<TableEntry[]> {
        const result = await this.run(
            'SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name',
            10_000, catalog, [catalog]
        );
        return result.rows
            .map(row => ({ name: String(row[0] ?? ''), view: String(row[1] ?? '') === 'VIEW' }))
            .filter(entry => entry.name);
    }

    public async columns(catalog: string, _schema: string, table: string): Promise<TrinoColumn[]> {
        const result = await this.run(
            `SELECT column_name, column_type, is_nullable, column_key, column_comment
             FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
            10_000, catalog, [catalog, table]
        );
        return result.rows.map(row => ({
            name: String(row[0] ?? ''),
            type: String(row[1] ?? ''),
            extra: [String(row[2] ?? '') === 'NO' ? 'not null' : '', String(row[3] ?? '') === 'PRI' ? 'primary key' : '']
                .filter(Boolean).join(', '),
            comment: String(row[4] ?? '')
        })).filter(column => column.name);
    }

    /** MySQL keeps the literal CREATE statement, like SQLite/DuckDB — nothing to reassemble. */
    public async tableDdl(catalog: string, _schema: string, table: string, view = false): Promise<string> {
        const result = await this.run(`SHOW CREATE ${view ? 'VIEW' : 'TABLE'} ${quoteIdent(catalog)}.${quoteIdent(table)}`, 1, catalog);
        // SHOW CREATE TABLE returns (name, ddl); SHOW CREATE VIEW returns (view, ddl, charset, collation).
        return String(result.rows[0]?.[1] ?? '');
    }

    public async query(statement: string, token?: vscode.CancellationToken, database?: string): Promise<TrinoQueryResult> {
        const sql = statement.trim().replace(/;+$/, '');
        if (!sql) { throw new Error('Enter a SQL statement before running it.'); }
        const parts = splitStatements(sql).map(entry => entry.text).filter(Boolean);
        if (parts.length === 0) { throw new Error('Enter a SQL statement before running it.'); }
        if (parts.length === 1) {
            return this.run(parts[0], this.maxRows(), database || this.connection.catalog, undefined, token);
        }
        // A multi-statement script (e.g. running a whole pasted .sql file): MySQL's
        // wire protocol needs multipleStatements opted in per connection to accept
        // that in one go, which is deliberately left off. Session state a script
        // relies on (`SET @x=...`, FOREIGN_KEY_CHECKS, …) also only persists on one
        // connection, so every statement runs here in turn on the same one instead
        // of the usual fresh connection per call — matching how a real SQL client
        // runs a script — and the whole thing stops at the first statement that fails.
        return this.runSequence(parts, database || this.connection.catalog, token);
    }

    private async runSequence(statements: string[], database: string | undefined, token?: vscode.CancellationToken): Promise<TrinoQueryResult> {
        const pool = await this.pool(database);
        const conn = await new Promise<mysql.PoolConnection>((resolve, reject) => {
            pool.getConnection((error, connection) => { if (error) { reject(asTrinoStyleError(error)); } else { resolve(connection); } });
        });
        try {
            let result: TrinoQueryResult | undefined;
            for (const sql of statements) {
                if (token?.isCancellationRequested) { throw new Error('Query was cancelled.'); }
                result = await this.runOnConnection(conn, sql, this.maxRows(), undefined, token);
            }
            return result!;
        } finally {
            conn.release();
        }
    }

    /** MySQL cannot reference another database's table without qualifying it, but the pool is already bound to one. */
    public qualify(catalog?: string, _schema?: string, table?: string): string {
        return [catalog, table].filter(Boolean).map(part => quoteIdent(part!)).join('.');
    }

    public starterSql(): string {
        return 'SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name LIMIT 10;';
    }

    public previewSql(catalog: string, schema: string, table: string, limit: number): string {
        return `SELECT * FROM ${this.qualify(catalog, schema, table)} LIMIT ${limit}`;
    }

    public async previewTable(catalog: string, schema: string, table: string, limit: number, token?: vscode.CancellationToken): Promise<TrinoQueryResult> {
        return this.run(this.previewSql(catalog, schema, table, limit), limit, catalog, undefined, token);
    }

    /**
     * Streams rows rather than buffering the whole result set, the same reason
     * Trino pages and Postgres uses a cursor: an unbounded SELECT must not fill
     * memory. Stops consuming — and drops the connection rather than draining
     * it — the moment the cap is hit.
     */
    private async run(
        sql: string,
        limit: number,
        database?: string,
        values?: unknown[],
        token?: vscode.CancellationToken
    ): Promise<TrinoQueryResult> {
        const pool = await this.pool(database);
        const conn = await new Promise<mysql.PoolConnection>((resolve, reject) => {
            pool.getConnection((connectError, connection) => {
                if (connectError) { reject(asTrinoStyleError(connectError)); } else { resolve(connection); }
            });
        });
        try {
            return await this.runOnConnection(conn, sql, limit, values, token);
        } finally {
            conn.release();
        }
    }

    /**
     * Runs one statement on an already-acquired connection, without releasing it —
     * callers own the connection's lifecycle, so a multi-statement script can reuse
     * the same one across several calls and keep session state like `SET @x=...`.
     */
    private async runOnConnection(
        conn: mysql.PoolConnection,
        sql: string,
        limit: number,
        values?: unknown[],
        token?: vscode.CancellationToken
    ): Promise<TrinoQueryResult> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

            const entry = this.registry?.add({
                connectionName: this.connection.name,
                sql,
                startedAt: Date.now(),
                cancel: () => { conn.destroy(); return Promise.resolve(true); }
            });
            const cancellation = token?.onCancellationRequested(() => conn.destroy());
            const cleanup = () => { cancellation?.dispose(); if (entry) { this.registry?.remove(entry.id); } };

            let columns: string[] | undefined;
            const rows: unknown[][] = [];
            let truncated = false;

            const query = conn.query({ sql, rowsAsArray: true, values });
            // mysql2 fires 'fields' for every statement, even a mutation/DDL one —
            // just with `fields` itself undefined then, not omitted.
            query.on('fields', (fields: Array<{ name: string }> | undefined) => {
                if (fields) { columns = fields.map(field => field.name); }
            });
            query.on('result', (row: unknown) => {
                if (!columns) {
                    // No real fields seen yet: an OkPacket from a mutation/DDL statement.
                    const info = row as { affectedRows?: number };
                    const affected = info.affectedRows ?? 0;
                    const command = sql.split(/\s+/)[0].toUpperCase();
                    cleanup();
                    settle(() => resolve({
                        columns: ['result'],
                        rows: [[`${command} — ${affected} row${affected === 1 ? '' : 's'} affected`]],
                        truncated: false,
                        maxRows: limit
                    }));
                    return;
                }
                if (rows.length >= limit) {
                    truncated = true;
                    conn.destroy();
                    cleanup();
                    settle(() => resolve({ columns: columns!, rows, truncated, maxRows: limit }));
                    return;
                }
                rows.push(row as unknown[]);
            });
            query.on('error', (error: Error) => {
                cleanup();
                settle(() => reject(asTrinoStyleError(error)));
            });
            query.on('end', () => {
                cleanup();
                settle(() => resolve({ columns: columns ?? [], rows, truncated, maxRows: limit }));
            });
        });
    }

    private async pool(database?: string): Promise<mysql.Pool> {
        const { host, port } = hostAndPort(this.connection.url);
        const name = database || this.connection.catalog;
        const key = `${this.connection.id}/${name ?? ''}`;
        const existing = MySqlClient.pools.get(key);
        if (existing) { return existing; }
        const pool = mysql.createPool({
            host,
            port,
            database: name,
            user: this.connection.user,
            password: this.passwordOverride ?? await this.secrets.get(passwordKey(this.connection.id)),
            ssl: this.connection.ssl ? { rejectUnauthorized: false } : undefined,
            connectTimeout: 10_000,
            connectionLimit: 4,
            supportBigNumbers: true,
            bigNumberStrings: true
        });
        pool.on('error', () => undefined);
        MySqlClient.pools.set(key, pool);
        return pool;
    }

    /** Drops pooled connections, for when a connection is edited or removed. */
    public static async closeAll(connectionId?: string): Promise<void> {
        for (const [key, pool] of [...MySqlClient.pools]) {
            if (connectionId && !key.startsWith(`${connectionId}/`)) { continue; }
            MySqlClient.pools.delete(key);
            await new Promise<void>(resolve => pool.end(() => resolve()));
        }
    }
}

export function hostAndPort(url: string): { host: string; port: number } {
    try {
        const parsed = new URL(url.includes('://') ? url : `mysql://${url}`);
        return { host: parsed.hostname || 'localhost', port: Number(parsed.port) || 3306 };
    } catch {
        return { host: url || 'localhost', port: 3306 };
    }
}

function asTrinoStyleError(error: unknown): Error {
    const failure = error as { message?: string; code?: string; sqlMessage?: string; sqlState?: string };
    const message = failure?.sqlMessage ?? failure?.message ?? String(error);
    const details = [
        failure?.code && `code: ${failure.code}`,
        failure?.sqlState && `sqlState: ${failure.sqlState}`
    ].filter(Boolean).join('\n');
    return new TrinoRequestError(message, details || undefined);
}
