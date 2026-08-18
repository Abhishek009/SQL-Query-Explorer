import * as vscode from 'vscode';
import { AbstractCursor, Collection, Db, Document, MongoClient, ObjectId } from 'mongodb';
import { StoredConnection, TableEntry, TrinoColumn, TrinoQueryResult, TrinoRequestError } from '../../types';
import { passwordKey } from '../../connectionStore';
import { RunningQueryRegistry } from '../../runningQueries';
import { numberSetting } from '../../util';
import { SqlClient } from '../../client';
import { splitStatements } from '../../statements';
import { evalShellArgs, parseShellCommand } from './mongoShell';

const SYSTEM_DATABASES = new Set(['admin', 'local', 'config']);
/** How many documents inform the inferred "columns" for a collection. */
const SAMPLE_SIZE = 20;

/**
 * MongoDB via the official driver, with the editor speaking Mongo shell syntax
 * (`db.collection.find({...})`) instead of SQL. One client per connection —
 * unlike Postgres, a single MongoClient can see every database it's authorised
 * for, so there's no per-database pool the way MySQL and Postgres need.
 */
export class MongodbClient implements SqlClient {
    private static readonly clients = new Map<string, MongoClient>();

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
        const client = await this.client();
        const info = await client.db().admin().command({ buildInfo: 1 });
        return `MongoDB ${String(info.version ?? '')}`;
    }

    /**
     * A restricted user (common on shared Atlas tiers) may lack permission to
     * list every database on the server, so a connection scoped to one database
     * skips that call entirely rather than failing to open the tree at all.
     */
    public async catalogs(): Promise<string[]> {
        if (this.connection.catalog) { return [this.connection.catalog]; }
        const client = await this.client();
        try {
            const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
            return databases.map(entry => entry.name).filter(name => !SYSTEM_DATABASES.has(name)).sort();
        } catch (error) {
            throw asMongoError(error);
        }
    }

    /** MongoDB has no level between database and collection, so the schema just names the database again. */
    public async schemas(catalog: string): Promise<string[]> {
        return [catalog];
    }

    public async tables(catalog: string, schema: string): Promise<string[]> {
        return (await this.tableEntries(catalog, schema)).map(entry => entry.name);
    }

    public async tableEntries(catalog: string, _schema: string): Promise<TableEntry[]> {
        const client = await this.client();
        try {
            const collections = await client.db(catalog).listCollections({}, { nameOnly: false }).toArray();
            return collections
                .filter(entry => entry.name && !entry.name.startsWith('system.'))
                .map(entry => ({ name: entry.name, view: entry.type === 'view' }))
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch (error) {
            throw asMongoError(error);
        }
    }

    /** No fixed schema to read, so the "columns" are inferred from a handful of sampled documents. */
    public async columns(catalog: string, _schema: string, table: string): Promise<TrinoColumn[]> {
        const client = await this.client();
        try {
            const docs = await client.db(catalog).collection(table).find({}).limit(SAMPLE_SIZE).toArray();
            const types = new Map<string, Set<string>>();
            const order: string[] = [];
            const note = (name: string, type: string) => {
                if (!types.has(name)) { types.set(name, new Set()); order.push(name); }
                types.get(name)!.add(type);
            };
            note('_id', 'ObjectId');
            for (const doc of docs) {
                for (const [key, value] of Object.entries(doc)) { note(key, bsonTypeName(value)); }
            }
            return order.map(name => ({ name, type: [...types.get(name)!].sort().join(' | '), extra: '', comment: '' }));
        } catch (error) {
            throw asMongoError(error);
        }
    }

    /** MongoDB has no CREATE TABLE, so "DDL" is the inferred field shape plus an example document. */
    public async tableDdl(catalog: string, _schema: string, table: string): Promise<string> {
        const client = await this.client();
        try {
            const db = client.db(catalog);
            const [info] = await db.listCollections({ name: table }, { nameOnly: false }).toArray();
            const [sample] = await db.collection(table).find({}).limit(1).toArray();
            const shape = await this.columns(catalog, _schema, table);
            const lines = [
                `// ${catalog}.${table} — MongoDB collections have no fixed schema.`,
                `// Field shape inferred from up to ${SAMPLE_SIZE} sampled documents:`,
                '{',
                ...shape.map(column => `  ${column.name}: ${column.type}`),
                '}'
            ];
            const validator = (info?.options as { validator?: unknown } | undefined)?.validator;
            if (validator) { lines.push('', '// Schema validator:', JSON.stringify(validator, jsonReplacer, 2)); }
            if (sample) { lines.push('', '// Example document:', JSON.stringify(sample, jsonReplacer, 2)); }
            return lines.join('\n');
        } catch (error) {
            throw asMongoError(error);
        }
    }

    public async query(statement: string, token?: vscode.CancellationToken, database?: string): Promise<TrinoQueryResult> {
        const text = statement.trim().replace(/;+$/, '');
        if (!text) { throw new Error('Enter a MongoDB command before running it.'); }
        const parts = splitStatements(text).map(entry => entry.text).filter(Boolean);
        if (parts.length === 0) { throw new Error('Enter a MongoDB command before running it.'); }
        const db = database || this.connection.catalog;
        if (!db) { throw new Error('Choose a database before running a command — pick one in the tree, or set a default database on the connection.'); }
        let result: TrinoQueryResult | undefined;
        for (const part of parts) {
            if (token?.isCancellationRequested) { throw new Error('Query was cancelled.'); }
            result = await this.runStatement(part, db, token);
        }
        return result!;
    }

    /** A collection reference is meaningful only inside a shell command, so this is just the bare name. */
    public qualify(_catalog?: string, _schema?: string, table?: string): string {
        return table ?? '';
    }

    /** Field names go into a JS object literal, not quoted SQL, so there's nothing to quote. */
    public quoteIdentifier(identifier: string): string {
        return identifier;
    }

    public starterSql(): string {
        return 'db.getCollectionNames()';
    }

    public previewSql(_catalog: string, _schema: string, table: string, limit: number): string {
        return `db.${table}.find().limit(${limit})`;
    }

    public async previewTable(catalog: string, schema: string, table: string, limit: number, token?: vscode.CancellationToken): Promise<TrinoQueryResult> {
        return this.query(this.previewSql(catalog, schema, table, limit), token, catalog);
    }

    private async runStatement(statement: string, database: string, token?: vscode.CancellationToken): Promise<TrinoQueryResult> {
        const controller = new AbortController();
        const entry = this.registry?.add({
            connectionName: this.connection.name,
            sql: statement,
            startedAt: Date.now(),
            cancel: () => { controller.abort(); return Promise.resolve(true); }
        });
        const cancellation = token?.onCancellationRequested(() => controller.abort());
        try {
            return await this.runOne(statement, database, controller.signal);
        } catch (error) {
            throw asMongoError(error);
        } finally {
            cancellation?.dispose();
            if (entry) { this.registry?.remove(entry.id); }
        }
    }

    private async runOne(statement: string, database: string, signal: AbortSignal): Promise<TrinoQueryResult> {
        const client = await this.client();
        const db = client.db(database);
        const parsed = parseShellCommand(statement);
        const limit = this.maxRows();

        if (!parsed.collection) {
            return this.runDbLevel(db, parsed.calls, limit, signal);
        }
        const [primary, ...chain] = parsed.calls;
        if (!primary) { throw new Error(`Expected a method call after "db.${parsed.collection}".`); }
        const collection = db.collection(parsed.collection);
        const args = evalShellArgs(primary.args ?? '');

        switch (primary.name) {
            case 'find':
                return this.runFind(collection, args, chain, limit, signal);
            case 'findOne': {
                const doc = await collection.findOne(args[0] as Document ?? {}, { projection: args[1] as Document, signal });
                return docsToResult(doc ? [doc] : [], limit, false);
            }
            case 'aggregate': {
                const [pipeline] = args;
                if (!Array.isArray(pipeline)) { throw new Error('aggregate() expects an array of pipeline stages.'); }
                return this.drainCursor(collection.aggregate(pipeline as Document[], { signal }), limit);
            }
            case 'countDocuments':
            case 'count': {
                const count = await collection.countDocuments(args[0] as Document ?? {}, { signal });
                return summary(primary.name, `${count} document${count === 1 ? '' : 's'}`, limit);
            }
            case 'distinct': {
                const [field, filter] = args;
                const values = await collection.distinct(String(field), (filter as Document) ?? {});
                return { columns: [String(field)], rows: values.map(value => [formatCell(value)]), truncated: false, maxRows: limit };
            }
            case 'insertOne': {
                const result = await collection.insertOne(args[0] as Document);
                return summary('insertOne', `1 document inserted, _id: ${String(result.insertedId)}`, limit);
            }
            case 'insertMany': {
                const docs = args[0];
                if (!Array.isArray(docs)) { throw new Error('insertMany() expects an array of documents.'); }
                const result = await collection.insertMany(docs as Document[]);
                return summary('insertMany', `${result.insertedCount} document${result.insertedCount === 1 ? '' : 's'} inserted`, limit);
            }
            case 'updateOne':
            case 'updateMany': {
                const [filter, update, options] = args;
                const result = primary.name === 'updateOne'
                    ? await collection.updateOne((filter as Document) ?? {}, (update as Document) ?? {}, options as Document)
                    : await collection.updateMany((filter as Document) ?? {}, (update as Document) ?? {}, options as Document);
                return summary(primary.name, `matched ${result.matchedCount}, modified ${result.modifiedCount}`, limit);
            }
            case 'replaceOne': {
                const [filter, replacement] = args;
                const result = await collection.replaceOne((filter as Document) ?? {}, (replacement as Document) ?? {});
                return summary('replaceOne', `matched ${result.matchedCount}, modified ${result.modifiedCount}`, limit);
            }
            case 'deleteOne':
            case 'deleteMany': {
                const result = primary.name === 'deleteOne'
                    ? await collection.deleteOne(args[0] as Document ?? {})
                    : await collection.deleteMany(args[0] as Document ?? {});
                return summary(primary.name, `${result.deletedCount} document${result.deletedCount === 1 ? '' : 's'} deleted`, limit);
            }
            case 'drop': {
                await collection.drop();
                return summary('drop', 'collection dropped', limit);
            }
            default:
                throw new Error(
                    `Unsupported method "${primary.name}()". Supported: find, findOne, aggregate, countDocuments, distinct, ` +
                    'insertOne, insertMany, updateOne, updateMany, replaceOne, deleteOne, deleteMany, drop.'
                );
        }
    }

    private async runFind(
        collection: Collection,
        args: unknown[],
        chain: { name: string; args?: string }[],
        limit: number,
        signal: AbortSignal
    ): Promise<TrinoQueryResult> {
        const [filter, projection] = args;
        let cursor = collection.find((filter as Document) ?? {}, { projection: projection as Document, signal });
        for (const step of chain) {
            const stepArgs = evalShellArgs(step.args ?? '');
            switch (step.name) {
                case 'sort': cursor = cursor.sort(stepArgs[0] as Document ?? {}); break;
                case 'limit': cursor = cursor.limit(Number(stepArgs[0])); break;
                case 'skip': cursor = cursor.skip(Number(stepArgs[0])); break;
                case 'project': cursor = cursor.project(stepArgs[0] as Document ?? {}); break;
                default: throw new Error(`Unsupported chained method ".${step.name}()" after find(). Supported: sort, limit, skip, project.`);
            }
        }
        return this.drainCursor(cursor, limit);
    }

    private async runDbLevel(db: Db, calls: { name: string; args?: string }[], limit: number, signal: AbortSignal): Promise<TrinoQueryResult> {
        const [primary] = calls;
        if (!primary) { throw new Error('Expected a command after "db.".'); }
        switch (primary.name) {
            case 'getCollectionNames': {
                const names = (await db.listCollections({}, { nameOnly: true, signal }).toArray()).map(entry => entry.name).sort();
                return { columns: ['name'], rows: names.map(name => [name]), truncated: false, maxRows: limit };
            }
            case 'runCommand': {
                const [command] = evalShellArgs(primary.args ?? '');
                const result = await db.command((command as Document) ?? {}, { signal });
                return { columns: ['result'], rows: [[JSON.stringify(result, jsonReplacer)]], truncated: false, maxRows: limit };
            }
            case 'stats': {
                const result = await db.command({ dbStats: 1 }, { signal });
                return { columns: ['result'], rows: [[JSON.stringify(result, jsonReplacer)]], truncated: false, maxRows: limit };
            }
            default:
                throw new Error(`Unsupported command "db.${primary.name}()". Supported: getCollectionNames, stats, runCommand.`);
        }
    }

    /**
     * Streams the cursor rather than buffering the whole result, the same
     * reason Trino pages and Postgres uses a server-side cursor: an unbounded
     * find()/aggregate() must not fill memory. Closes the cursor early — rather
     * than draining it — the moment the cap is hit.
     */
    private async drainCursor(cursor: AbstractCursor, limit: number): Promise<TrinoQueryResult> {
        const docs: Document[] = [];
        let truncated = false;
        try {
            for await (const doc of cursor) {
                if (docs.length >= limit) { truncated = true; break; }
                docs.push(doc);
            }
        } finally {
            await cursor.close().catch(() => undefined);
        }
        return docsToResult(docs, limit, truncated);
    }

    private async client(): Promise<MongoClient> {
        const key = this.connection.id;
        const existing = MongodbClient.clients.get(key);
        if (existing) { return existing; }
        const password = this.passwordOverride ?? await this.secrets.get(passwordKey(this.connection.id));
        const client = new MongoClient(this.connection.url, {
            auth: this.connection.user ? { username: this.connection.user, password: password || '' } : undefined,
            // `undefined`, not `false`, when the SSL toggle is off — an explicit
            // `tls: false` would force TLS off even for a mongodb+srv:// URL,
            // where the driver's own default is TLS on and every real server
            // (Atlas included) requires it; leaving it undefined lets that default
            // apply instead of overriding it, while the toggle can still force TLS
            // on for a plain mongodb:// host that needs it.
            tls: this.connection.ssl || undefined,
            serverSelectionTimeoutMS: 10_000,
            connectTimeoutMS: 10_000
        });
        client.on('error', () => undefined);
        try {
            await client.connect();
        } catch (error) {
            await client.close().catch(() => undefined);
            throw asMongoError(error);
        }
        MongodbClient.clients.set(key, client);
        return client;
    }

    /** Drops any open client, for when a connection is edited or removed. */
    public static async closeAll(connectionId?: string): Promise<void> {
        for (const [key, client] of [...MongodbClient.clients]) {
            if (connectionId && key !== connectionId) { continue; }
            MongodbClient.clients.delete(key);
            await client.close().catch(() => undefined);
        }
    }
}

function docsToResult(docs: Document[], limit: number, truncated: boolean): TrinoQueryResult {
    if (docs.length === 0) { return { columns: [], rows: [], truncated, maxRows: limit }; }
    const columns: string[] = [];
    const seen = new Set<string>();
    const addField = (name: string) => { if (!seen.has(name)) { seen.add(name); columns.push(name); } };
    addField('_id');
    for (const doc of docs) { for (const key of Object.keys(doc)) { addField(key); } }
    return { columns, rows: docs.map(doc => columns.map(column => formatCell(doc[column]))), truncated, maxRows: limit };
}

function summary(command: string, detail: string, limit: number): TrinoQueryResult {
    return { columns: ['result'], rows: [[`${command} — ${detail}`]], truncated: false, maxRows: limit };
}

/** A document/array cell is stringified so the results grid shows valid JSON text rather than "[object Object]". */
function formatCell(value: unknown): unknown {
    if (value === undefined) { return null; }
    if (value instanceof ObjectId) { return value.toHexString(); }
    if (value instanceof Date) { return value.toISOString(); }
    if (Array.isArray(value) || (value !== null && typeof value === 'object')) { return JSON.stringify(value, jsonReplacer); }
    return value as string | number | boolean | null;
}

function bsonTypeName(value: unknown): string {
    if (value === null) { return 'null'; }
    if (value instanceof ObjectId) { return 'ObjectId'; }
    if (value instanceof Date) { return 'Date'; }
    if (Array.isArray(value)) { return 'array'; }
    if (typeof value === 'object') { return 'object'; }
    return typeof value;
}

function jsonReplacer(_key: string, value: unknown): unknown {
    return value instanceof ObjectId ? value.toHexString() : value;
}

/** A bare hostname the form built into `mongodb://host:port`, versus a pasted connection string kept verbatim. */
export function mongoHostAndPort(url: string): { host: string; port: string } {
    const simple = /^mongodb:\/\/([^:@/?,]+):(\d+)\/?$/i.exec(url);
    if (simple) { return { host: simple[1], port: simple[2] }; }
    return { host: url, port: '' };
}

function asMongoError(error: unknown): Error {
    if (error instanceof TrinoRequestError) { return error; }
    const failure = error as { message?: string; code?: number | string; codeName?: string };
    const message = failure?.message ?? String(error);
    const details = [
        failure?.code !== undefined && `code: ${failure.code}`,
        failure?.codeName && `codeName: ${failure.codeName}`
    ].filter(Boolean).join('\n');
    return new TrinoRequestError(message, details || undefined);
}
