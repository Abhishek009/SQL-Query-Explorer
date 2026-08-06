import * as vscode from 'vscode';
import { Pool, PoolClient } from 'pg';
import { StoredConnection, TableEntry, TrinoColumn, TrinoQueryResult, TrinoRequestError } from '../../types';
import { passwordKey } from '../../connectionStore';
import { RunningQueryRegistry } from '../../runningQueries';
import { numberSetting, quoteIdentifier } from '../../util';
import { SqlClient } from '../../client';

/** Statements a cursor can wrap, which is how the row cap is enforced. */
const CURSOR_SAFE = /^\s*(?:with|select|table|values)\b/i;

/**
 * Postgres over the wire protocol. The tree's catalog level maps to databases
 * on the server, so a connection can browse siblings of the one it opened.
 */
export class PostgresClient implements SqlClient {
    /** One pool per database: Postgres binds a connection to a single database. */
    private static readonly pools = new Map<string, Pool>();

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
        const result = await this.run('SELECT version()', 1);
        const version = String(result.rows[0]?.[0] ?? '');
        return version.split(',')[0] || 'Connected';
    }

    public async catalogs(): Promise<string[]> {
        const result = await this.run(
            'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname', 1_000
        );
        return result.rows.map(row => String(row[0]));
    }

    public async schemas(catalog: string): Promise<string[]> {
        const result = await this.run(
            `SELECT nspname FROM pg_namespace
             WHERE nspname NOT LIKE 'pg\\_%' ORDER BY nspname`, 1_000, catalog
        );
        return result.rows.map(row => String(row[0]));
    }

    public async tables(catalog: string, schema: string): Promise<string[]> {
        return (await this.tableEntries(catalog, schema)).map(entry => entry.name);
    }

    public async tableEntries(catalog: string, schema: string): Promise<TableEntry[]> {
        const result = await this.run(
            `SELECT table_name, table_type FROM information_schema.tables
             WHERE table_schema = $1 ORDER BY table_name`, 10_000, catalog, [schema]
        );
        return result.rows
            .map(row => ({ name: String(row[0] ?? ''), view: /VIEW/i.test(String(row[1] ?? '')) }))
            .filter(entry => entry.name);
    }

    public async columns(catalog: string, schema: string, table: string): Promise<TrinoColumn[]> {
        const result = await this.run(
            `SELECT column_name, format_type(a.atttypid, a.atttypmod), is_nullable, col_description(a.attrelid, a.attnum)
             FROM information_schema.columns c
             JOIN pg_attribute a ON a.attrelid = to_regclass(quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))
                                AND a.attname = c.column_name
             WHERE c.table_schema = $1 AND c.table_name = $2
             ORDER BY c.ordinal_position`, 10_000, catalog, [schema, table]
        );
        return result.rows.map(row => ({
            name: String(row[0] ?? ''),
            type: String(row[1] ?? ''),
            extra: String(row[2] ?? '') === 'NO' ? 'not null' : '',
            comment: String(row[3] ?? '')
        })).filter(column => column.name);
    }

    /** Postgres has no SHOW CREATE TABLE, so the DDL is assembled from the catalog. */
    public async tableDdl(catalog: string, schema: string, table: string, view = false): Promise<string> {
        if (view) {
            const definition = await this.run(
                'SELECT pg_get_viewdef(to_regclass($1), true)', 1, catalog,
                [`${quoteIdentifier(schema)}.${quoteIdentifier(table)}`]
            );
            const body = String(definition.rows[0]?.[0] ?? '').trim();
            return body ? `CREATE OR REPLACE VIEW ${quoteIdentifier(schema)}.${quoteIdentifier(table)} AS\n${body}` : '';
        }
        const columns = await this.columns(catalog, schema, table);
        if (!columns.length) { return ''; }
        const keys = await this.run(
            `SELECT a.attname FROM pg_index i
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
             WHERE i.indrelid = to_regclass($1) AND i.indisprimary`, 100, catalog,
            [`${quoteIdentifier(schema)}.${quoteIdentifier(table)}`]
        );
        const lines = columns.map(column =>
            `    ${quoteIdentifier(column.name)} ${column.type}${column.extra === 'not null' ? ' NOT NULL' : ''}`);
        const primary = keys.rows.map(row => quoteIdentifier(String(row[0])));
        if (primary.length) { lines.push(`    PRIMARY KEY (${primary.join(', ')})`); }
        return `CREATE TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)} (\n${lines.join(',\n')}\n);`;
    }

    public async query(statement: string, token?: vscode.CancellationToken, database?: string): Promise<TrinoQueryResult> {
        const sql = statement.trim().replace(/;+$/, '');
        if (!sql) { throw new Error('Enter a SQL statement before running it.'); }
        return this.run(sql, this.maxRows(), database || this.connection.catalog, undefined, token);
    }

    /**
     * Postgres cannot reference another database in a statement, so the catalog
     * level is dropped from the name and carried as the database to connect to.
     */
    public qualify(catalog?: string, schema?: string, table?: string): string {
        return [schema, table].filter(Boolean).map(part => quoteIdentifier(part!)).join('.');
    }

    public starterSql(): string {
        return 'SELECT table_schema, table_name\nFROM information_schema.tables\nWHERE table_schema NOT IN (\'pg_catalog\', \'information_schema\')\nORDER BY table_schema, table_name\nLIMIT 10;';
    }

    public previewSql(catalog: string, schema: string, table: string, limit: number): string {
        return `SELECT * FROM ${this.qualify(catalog, schema, table)} LIMIT ${limit}`;
    }

    public async previewTable(catalog: string, schema: string, table: string, limit: number, token?: vscode.CancellationToken): Promise<TrinoQueryResult> {
        return this.run(this.previewSql(catalog, schema, table, limit), limit, catalog, undefined, token);
    }

    /**
     * Runs a statement with the row cap applied. Bounded reads use a cursor so
     * the server never streams more than the cap, which matters for the same
     * reason as Trino's paging limit: an unbounded SELECT must not fill memory.
     */
    private async run(
        sql: string,
        limit: number,
        database?: string,
        values?: unknown[],
        token?: vscode.CancellationToken
    ): Promise<TrinoQueryResult> {
        const pool = await this.pool(database);
        const client = await pool.connect();
        const entry = token !== undefined || this.registry
            ? this.registry?.add({
                connectionName: this.connection.name,
                sql,
                startedAt: Date.now(),
                cancel: () => this.cancelBackend(client, database)
            })
            : undefined;
        const cancellation = token?.onCancellationRequested(() => { void this.cancelBackend(client, database); });
        try {
            if (!CURSOR_SAFE.test(sql)) {
                const direct = await client.query({ text: sql, values, rowMode: 'array' });
                return this.toResult(direct, limit);
            }

            await client.query('BEGIN');
            try {
                await client.query({ text: `DECLARE _sqlx NO SCROLL CURSOR FOR ${sql}`, values });
                // One extra row reveals whether anything was left behind.
                const page = await client.query({ text: `FETCH FORWARD ${limit + 1} FROM _sqlx`, rowMode: 'array' });
                return this.toResult(page, limit);
            } finally {
                await client.query('ROLLBACK').catch(() => undefined);
            }
        } catch (error) {
            throw asTrinoStyleError(error);
        } finally {
            cancellation?.dispose();
            if (entry) { this.registry?.remove(entry.id); }
            client.release();
        }
    }

    private toResult(
        result: { fields?: Array<{ name: string }>; rows?: unknown[][]; command?: string; rowCount?: number | null },
        limit: number
    ): TrinoQueryResult {
        const rows = result.rows ?? [];
        // INSERT/UPDATE/DELETE/DDL return no columns, which would draw an empty
        // grid and read as "nothing happened". Report what the server did instead.
        if (!result.fields?.length) {
            const affected = result.rowCount ?? 0;
            const command = result.command ?? 'OK';
            return {
                columns: ['result'],
                rows: [[`${command} — ${affected} row${affected === 1 ? '' : 's'} affected`]],
                truncated: false,
                maxRows: limit
            };
        }
        const truncated = rows.length > limit;
        return {
            columns: result.fields.map(field => field.name),
            rows: truncated ? rows.slice(0, limit) : rows,
            truncated,
            maxRows: limit
        };
    }

    /** Cancelling needs a second connection: the first one is busy running the query. */
    private async cancelBackend(client: PoolClient, database?: string): Promise<boolean> {
        try {
            const pid = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
            const pool = await this.pool(database);
            const other = await pool.connect();
            try {
                await other.query('SELECT pg_cancel_backend($1)', [pid.rows[0].pid]);
                return true;
            } finally {
                other.release();
            }
        } catch {
            return false;
        }
    }

    private async pool(database?: string): Promise<Pool> {
        const { host, port } = hostAndPort(this.connection.url);
        const name = database || this.connection.catalog || 'postgres';
        const key = `${this.connection.id}/${name}`;
        const existing = PostgresClient.pools.get(key);
        if (existing) { return existing; }
        const pool = new Pool({
            host,
            port,
            database: name,
            user: this.connection.user,
            password: this.passwordOverride ?? await this.secrets.get(passwordKey(this.connection.id)),
            ssl: this.connection.ssl ? { rejectUnauthorized: false } : undefined,
            connectionTimeoutMillis: 10_000,
            max: 4
        });
        // A pool that errors while idle must not take the extension down with it.
        pool.on('error', () => undefined);
        PostgresClient.pools.set(key, pool);
        return pool;
    }

    /** Drops pooled sockets, for when a connection is edited or removed. */
    public static async closeAll(connectionId?: string): Promise<void> {
        for (const [key, pool] of [...PostgresClient.pools]) {
            if (connectionId && !key.startsWith(`${connectionId}/`)) { continue; }
            PostgresClient.pools.delete(key);
            await pool.end().catch(() => undefined);
        }
    }
}

export function hostAndPort(url: string): { host: string; port: number } {
    try {
        const parsed = new URL(url.includes('://') ? url : `postgresql://${url}`);
        return { host: parsed.hostname || 'localhost', port: Number(parsed.port) || 5432 };
    } catch {
        return { host: url || 'localhost', port: 5432 };
    }
}

/** Keeps error shape uniform so the results panel can show detail for any engine. */
function asTrinoStyleError(error: unknown): Error {
    const failure = error as { message?: string; code?: string; detail?: string; hint?: string; position?: string };
    const message = failure?.message ?? String(error);
    const details = [
        failure?.code && `code: ${failure.code}`,
        failure?.detail && `detail: ${failure.detail}`,
        failure?.hint && `hint: ${failure.hint}`,
        failure?.position && `position: ${failure.position}`
    ].filter(Boolean).join('\n');
    return new TrinoRequestError(message, details || undefined);
}
