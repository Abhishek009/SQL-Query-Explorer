import * as vscode from 'vscode';
import { StoredConnection, TableEntry, TrinoColumn, TrinoQueryResult, TrinoRequestError } from './types';
import { passwordKey } from './connectionStore';
import { describeFetchFailure, firstColumn, quoteIdentifier, quoteLiteral, summarize } from './util';
import { httpBaseUrl } from './urls';
import { RunningQueryRegistry } from './runningQueries';

/** How long to wait for the query URI before abandoning a cancel attempt. */
const CANCEL_URI_WAIT_MS = 3_000;

export interface TrinoPage {
    id?: string;
    nextUri?: string;
    columns?: Array<{ name: string }>;
    data?: unknown[][];
    error?: { message: string; errorName?: string };
}

export class TrinoClient {
    public constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly connection: StoredConnection,
        /** Set for user-initiated statements so they appear in the status bar. */
        private readonly registry?: RunningQueryRegistry
    ) {}

    public async catalogs(token?: vscode.CancellationToken): Promise<string[]> {
        return firstColumn(await this.query('SHOW CATALOGS', token));
    }

    public async schemas(catalog: string): Promise<string[]> {
        return firstColumn(await this.query(`SHOW SCHEMAS FROM ${quoteIdentifier(catalog)}`));
    }

    public async tables(catalog: string, schema: string): Promise<string[]> {
        return firstColumn(await this.query(`SHOW TABLES FROM ${quoteIdentifier(catalog)}.${quoteIdentifier(schema)}`));
    }

    /** SHOW COLUMNS returns one row per column: name, type, extra, comment. */
    public async columns(catalog: string, schema: string, table: string): Promise<TrinoColumn[]> {
        const qualified = `${quoteIdentifier(catalog)}.${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
        const result = await this.query(`SHOW COLUMNS FROM ${qualified}`);
        return result.rows.map(row => ({
            name: String(row[0] ?? ''),
            type: String(row[1] ?? ''),
            extra: String(row[2] ?? ''),
            comment: String(row[3] ?? '')
        })).filter(column => column.name);
    }

    /**
     * Tables and views in a schema, separated by type. SHOW TABLES lists both
     * without distinguishing them, so information_schema is used when available
     * and SHOW TABLES is the fallback for connectors that refuse it.
     */
    public async tableEntries(catalog: string, schema: string): Promise<TableEntry[]> {
        try {
            const result = await this.query(
                `SELECT table_name, table_type FROM ${quoteIdentifier(catalog)}.information_schema.tables ` +
                `WHERE table_schema = ${quoteLiteral(schema)} ORDER BY table_name`
            );
            const entries = result.rows
                .map(row => ({ name: String(row[0] ?? ''), view: /VIEW/i.test(String(row[1] ?? '')) }))
                .filter(entry => entry.name);
            if (entries.length) { return entries; }
        } catch { /* fall through to SHOW TABLES */ }
        return (await this.tables(catalog, schema)).map(name => ({ name, view: false }));
    }

    /**
     * Table counts for every schema in a catalog, in a single query. Counting per
     * schema would mean one round trip per node, which is far too slow to expand.
     * Rows match what SHOW TABLES lists, so views are included in the count.
     */
    public async tableCountsBySchema(catalog: string, token?: vscode.CancellationToken): Promise<Map<string, number>> {
        const result = await this.query(
            `SELECT table_schema, COUNT(*) FROM ${quoteIdentifier(catalog)}.information_schema.tables GROUP BY table_schema`,
            token
        );
        const counts = new Map<string, number>();
        for (const row of result.rows) {
            const schema = String(row[0] ?? '');
            const count = Number(row[1]);
            if (schema && Number.isFinite(count)) { counts.set(schema, count); }
        }
        return counts;
    }

    /** SHOW CREATE returns the DDL as a single cell; views need their own form. */
    public async tableDdl(catalog: string, schema: string, table: string, view = false, token?: vscode.CancellationToken): Promise<string> {
        const qualified = `${quoteIdentifier(catalog)}.${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
        const result = await this.query(`SHOW CREATE ${view ? 'VIEW' : 'TABLE'} ${qualified}`, token);
        return result.rows.map(row => String(row[0] ?? '')).join('\n').trim();
    }

    public async query(statement: string, token?: vscode.CancellationToken): Promise<TrinoQueryResult> {
        const normalizedStatement = statement.trim().replace(/;+$/, '');
        if (!normalizedStatement) { throw new Error('Enter a SQL statement before running it.'); }
        return this.runStatement(normalizedStatement, token);
    }

    /**
     * The row cap for this connection: its own override when set, otherwise the
     * global `trino.query.maxRows`. Bounds memory regardless of the statement.
     */
    public maxRows(): number {
        const perConnection = Number(this.connection.maxRows);
        if (Number.isFinite(perConnection) && perConnection > 0) { return Math.trunc(perConnection); }
        const configured = Number(vscode.workspace.getConfiguration('trino').get('query.maxRows'));
        return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : 10_000;
    }

    private async runStatement(statement: string, token?: vscode.CancellationToken): Promise<TrinoQueryResult> {
        const { url: rawUrl, user, catalog, schema } = this.connection;
        if (!rawUrl || !user) { throw new Error('Configure the Trino URL and user before connecting.'); }
        const baseUrl = httpBaseUrl(rawUrl);
        if (!baseUrl) {
            throw new Error(`Could not read the Trino URL "${rawUrl}". Use http(s)://host:port or jdbc:trino://host:port.`);
        }

        const password = await this.secrets.get(passwordKey(this.connection.id));
        const headers: Record<string, string> = {
            'X-Trino-User': user,
            'Content-Type': 'text/plain'
        };
        if (catalog) { headers['X-Trino-Catalog'] = catalog; }
        if (schema) { headers['X-Trino-Schema'] = schema; }
        if (password) {
            headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
        }

        // One controller for the whole statement: cancelling has to stop the page
        // currently in flight as well as the ones that would follow it.
        const abort = new AbortController();
        const live: { nextUri?: string; cancelled: boolean; finished: boolean } = { cancelled: false, finished: false };
        const cancel = async (): Promise<boolean> => {
            live.cancelled = true;
            // Killing the query needs its URI, which only arrives with the first
            // page. Aborting immediately would orphan a query Trino is already
            // running, so wait briefly for the URI before giving up on it.
            const deadline = Date.now() + CANCEL_URI_WAIT_MS;
            while (!live.nextUri && !live.finished && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            const target = live.nextUri;
            abort.abort();
            return target ? this.cancelQuery(target, headers) : live.finished;
        };
        const entry = this.registry?.add({
            connectionName: this.connection.name,
            sql: statement,
            startedAt: Date.now(),
            cancel
        });
        // The progress notification's Cancel button trips this token; route it
        // through the same path so Trino is told to stop, not just the socket.
        const cancellation = token?.onCancellationRequested(() => { void cancel(); });

        try {
            let response = await this.request(`${baseUrl}/v1/statement`, {
                method: 'POST', headers, body: statement, signal: token, abort
            });
            let page = await this.readPage(response);
            live.nextUri = page.nextUri;
            if (entry) { this.registry?.setQueryId(entry.id, page.id); }
            const rows = [...(page.data ?? [])];
            let columns = page.columns;
            const maxRows = this.maxRows();
            let truncated = false;
            while (page.nextUri && !page.error) {
                if (rows.length >= maxRows) {
                    // Stop pulling pages and tell the coordinator to abandon the query,
                    // so it stops producing results nobody is going to read.
                    truncated = true;
                    await this.cancelQuery(page.nextUri, headers);
                    break;
                }
                if (live.cancelled) { throw new Error('Trino query was cancelled.'); }
                response = await this.request(page.nextUri, { method: 'GET', headers, signal: token, abort });
                page = await this.readPage(response);
                live.nextUri = page.nextUri;
                rows.push(...(page.data ?? []));
                columns ??= page.columns;
            }
            if (page.error) {
                throw new TrinoRequestError(
                    page.error.message || page.error.errorName || 'Trino returned an error.',
                    JSON.stringify(page.error, null, 2)
                );
            }
            if (rows.length > maxRows) {
                rows.length = maxRows;
                truncated = true;
            }
            return { columns: (columns ?? []).map(column => column.name), rows, truncated, maxRows };
        } finally {
            live.finished = true;
            cancellation?.dispose();
            if (entry) { this.registry?.remove(entry.id); }
        }
    }

    /**
     * Asks the coordinator to abandon the query. Returns whether it accepted:
     * a failure here means the query may still be running on the cluster.
     */
    private async cancelQuery(nextUri: string, headers: Record<string, string>): Promise<boolean> {
        try {
            const response = await fetch(nextUri, { method: 'DELETE', headers });
            return response.ok || response.status === 404; // 404 = already gone
        } catch {
            return false;
        }
    }

    private async request(url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: vscode.CancellationToken; abort?: AbortController }): Promise<Response> {
        const controller = init.abort ?? new AbortController();
        const cancellation = init.signal?.onCancellationRequested(() => controller.abort());
        try {
            return await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: controller.signal });
        } catch (error) {
            if (controller.signal.aborted) { throw new Error('Trino query was cancelled.'); }
            throw describeFetchFailure(error, url);
        } finally {
            cancellation?.dispose();
        }
    }

    private async readPage(response: Response): Promise<TrinoPage> {
        if (!response.ok) {
            const details = await response.text();
            if (/plain HTTP request was sent to HTTPS port/i.test(details)) {
                throw new TrinoRequestError('The coordinator expects HTTPS on this port. Turn on "Enable SSL / HTTPS" in the connection window, or add ?SSL=true to the JDBC URL.', details);
            }
            throw new TrinoRequestError(`Trino request failed (${response.status}): ${summarize(details) || response.statusText}`, details);
        }
        return response.json() as Promise<TrinoPage>;
    }
}
