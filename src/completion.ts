import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { SqlClient, createClient, engineOf } from './client';
import { QueryScope } from './queryScope';

/**
 * Completes catalog, schema, table, and column names from the active connection.
 * Metadata queries are cached briefly so typing does not hammer the coordinator.
 */
export class SqlCompletionProvider implements vscode.CompletionItemProvider {
    private static readonly CACHE_MS = 5 * 60 * 1_000;
    private readonly cache = new Map<string, { at: number; names: string[] }>();

    public constructor(
        private readonly store: ConnectionStore,
        private readonly secrets: vscode.SecretStorage,
        private readonly scope: QueryScope
    ) {}

    public clear(): void { this.cache.clear(); }

    public async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<vscode.CompletionItem[]> {
        // Completion follows the same scope the statements run under.
        const { connection, database: scoped } = this.scope.resolve(document);
        if (!connection) { return []; }
        const prefix = document.getText(new vscode.Range(position.line, 0, position.line, position.character));
        const qualifier = qualifierParts(prefix);
        const client = createClient(this.secrets, connection);

        // Postgres names reach only schema.table, and the database comes from the
        // editor's scope rather than the statement, so it gets its own ladder.
        if (engineOf(connection) === 'postgres') {
            const database = scoped ?? connection.catalog;
            if (!database) { return []; }
            return this.postgresCompletions(client, connection.id, database, qualifier);
        }

        try {
            if (qualifier.length === 0) {
                const catalogs = await this.lookup(`${connection.id}:catalogs`, () => client.catalogs());
                const items = catalogs.map(name => completionItem(name, vscode.CompletionItemKind.Module, 'catalog'));
                if (connection.catalog) {
                    const schemas = await this.lookup(`${connection.id}:${connection.catalog}`, () => client.schemas(connection.catalog!));
                    items.push(...schemas.map(name => completionItem(name, vscode.CompletionItemKind.Folder, `schema in ${connection.catalog}`)));
                }
                return items;
            }
            if (qualifier.length === 1) {
                const [first] = qualifier;
                const schemas = await this.lookup(`${connection.id}:${first}`, () => client.schemas(first));
                if (schemas.length) {
                    return schemas.map(name => completionItem(name, vscode.CompletionItemKind.Folder, `schema in ${first}`));
                }
                // Not a catalog — treat it as a schema inside the connection's default catalog.
                if (connection.catalog) {
                    const tables = await this.lookup(`${connection.id}:${connection.catalog}.${first}`, () => client.tables(connection.catalog!, first));
                    return tables.map(name => completionItem(name, vscode.CompletionItemKind.Struct, `table in ${first}`));
                }
                return [];
            }
            if (qualifier.length === 2) {
                const [catalog, schema] = qualifier;
                const tables = await this.lookup(`${connection.id}:${catalog}.${schema}`, () => client.tables(catalog, schema));
                return tables.map(name => completionItem(name, vscode.CompletionItemKind.Struct, `table in ${catalog}.${schema}`));
            }
            const [catalog, schema, table] = qualifier;
            const columns = await this.lookup(
                `${connection.id}:${catalog}.${schema}.${table}:columns`,
                async () => (await client.columns(catalog, schema, table)).map(column => `${column.name}\t${column.type}`)
            );
            return columns.map(entry => {
                // Split on the first tab only: types such as "row(a bigint)" contain spaces.
                const separator = entry.indexOf('\t');
                const name = separator < 0 ? entry : entry.slice(0, separator);
                const type = separator < 0 ? '' : entry.slice(separator + 1);
                return completionItem(name, vscode.CompletionItemKind.Field, type || 'column');
            });
        } catch {
            // Metadata is best effort; a failed lookup must not break typing.
            return [];
        }
    }

    /** schema → table → column, all inside the one database the editor is scoped to. */
    private async postgresCompletions(
        client: SqlClient,
        connectionId: string,
        database: string,
        qualifier: string[]
    ): Promise<vscode.CompletionItem[]> {
        try {
            if (qualifier.length === 0) {
                const schemas = await this.lookup(`${connectionId}:${database}`, () => client.schemas(database));
                return schemas.map(name => completionItem(name, vscode.CompletionItemKind.Folder, `schema in ${database}`));
            }
            if (qualifier.length === 1) {
                const [schema] = qualifier;
                const tables = await this.lookup(`${connectionId}:${database}.${schema}`, () => client.tables(database, schema));
                return tables.map(name => completionItem(name, vscode.CompletionItemKind.Struct, `table in ${schema}`));
            }
            const [schema, table] = qualifier;
            const columns = await this.lookup(
                `${connectionId}:${database}.${schema}.${table}:columns`,
                async () => (await client.columns(database, schema, table)).map(column => `${column.name}\t${column.type}`)
            );
            return columns.map(entry => {
                const separator = entry.indexOf('\t');
                const name = separator < 0 ? entry : entry.slice(0, separator);
                const type = separator < 0 ? '' : entry.slice(separator + 1);
                return completionItem(name, vscode.CompletionItemKind.Field, type || 'column');
            });
        } catch {
            return [];
        }
    }

    private async lookup(key: string, load: () => Promise<string[]>): Promise<string[]> {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.at < SqlCompletionProvider.CACHE_MS) { return cached.names; }
        const names = await load();
        this.cache.set(key, { at: Date.now(), names });
        return names;
    }
}

/**
 * Returns the dotted qualifier immediately before the cursor, excluding the
 * partial word being typed: "from tpch.sf1.cus" yields ["tpch", "sf1"].
 */
export function qualifierParts(linePrefix: string): string[] {
    const segments: string[] = [];
    let index = linePrefix.length;
    for (;;) {
        let start: number;
        if (index > 0 && linePrefix[index - 1] === '"') {
            // Quoted identifiers may contain dots and spaces, so scan to the opening quote.
            let cursor = index - 2;
            while (cursor >= 0) {
                if (linePrefix[cursor] === '"') {
                    if (cursor > 0 && linePrefix[cursor - 1] === '"') { cursor -= 2; continue; }
                    break;
                }
                cursor--;
            }
            if (cursor < 0) { break; }
            segments.unshift(linePrefix.slice(cursor + 1, index - 1).replace(/""/g, '"'));
            start = cursor;
        } else {
            let cursor = index;
            while (cursor > 0 && /[A-Za-z0-9_$]/.test(linePrefix[cursor - 1])) { cursor--; }
            segments.unshift(linePrefix.slice(cursor, index));
            start = cursor;
        }
        if (start > 0 && linePrefix[start - 1] === '.') { index = start - 1; continue; }
        break;
    }
    // The final segment is the partial word being typed, not part of the qualifier.
    segments.pop();
    return segments.filter(segment => segment.length > 0);
}

export function completionItem(name: string, kind: vscode.CompletionItemKind, detail: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, kind);
    item.detail = detail;
    // Quote identifiers that would otherwise be invalid bare words.
    item.insertText = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
    return item;
}
