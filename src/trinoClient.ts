import * as vscode from 'vscode';
import { StoredConnection, TrinoColumn, TrinoQueryResult, TrinoRequestError } from './types';
import { passwordKey } from './connectionStore';
import { firstColumn, quoteIdentifier, summarize } from './util';
import { httpBaseUrl } from './urls';
import { RunningQueryRegistry } from './runningQueries';

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
        const live: { nextUri?: string } = {};
        const entry = this.registry?.add({
            connectionName: this.connection.name,
            sql: statement,
            startedAt: Date.now(),
            cancel: async () => {
                abort.abort();
                if (live.nextUri) { await this.cancelQuery(live.nextUri, headers); }
            }
        });

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
            if (entry) { this.registry?.remove(entry.id); }
        }
    }

    /** Best effort: a failed cancellation must not fail the query we already have. */
    private async cancelQuery(nextUri: string, headers: Record<string, string>): Promise<void> {
        try { await fetch(nextUri, { method: 'DELETE', headers }); }
        catch { /* the coordinator will time the query out on its own */ }
    }

    private async request(url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: vscode.CancellationToken; abort?: AbortController }): Promise<Response> {
        const controller = init.abort ?? new AbortController();
        const cancellation = init.signal?.onCancellationRequested(() => controller.abort());
        try {
            return await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: controller.signal });
        } catch (error) {
            if (controller.signal.aborted) { throw new Error('Trino query was cancelled.'); }
            throw error;
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
