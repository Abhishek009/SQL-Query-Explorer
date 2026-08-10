import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckdbClient, createEmptyDuckdb } from '../../src/engines/duckdb/duckdbClient';
import { setDuckdbRuntimeDirForTests, isDuckdbInstalled } from '../../src/engines/duckdb/duckdbRuntime';
import { fakeSecrets } from '../setup/support';
import type { StoredConnection } from '../../src/types';

// Skips itself (rather than failing) when the ~100MB native module has not
// been fetched into the local test cache — see .gitignore/.duckdb-test-cache
// for how to opt in. No download happens as a side effect of `npm test`.
const cacheDir = path.resolve(__dirname, '../../.duckdb-test-cache');
setDuckdbRuntimeDirForTests(cacheDir);
const hasDuckdbCache = isDuckdbInstalled();

describe.skipIf(!hasDuckdbCache)('DuckdbClient (local file)', () => {
    const file = path.join(os.tmpdir(), `sqlexplorer-test-${randomUUID()}.duckdb`);
    let connection: StoredConnection;
    let client: DuckdbClient;

    beforeAll(async () => {
        await createEmptyDuckdb(file);
        connection = { id: randomUUID(), name: 'test-duckdb', type: 'duckdb', url: file, user: '' };
        client = new DuckdbClient(fakeSecrets() as never, connection);
        await client.query(`
            CREATE TABLE actor (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, balance DECIMAL(10,2));
            CREATE VIEW actor_names AS SELECT name FROM actor;
        `);
        for (let i = 0; i < 10; i++) {
            await client.query(`INSERT INTO actor VALUES (${i}, 'Actor ${i}', ${i}.5)`);
        }
    });

    afterAll(() => {
        DuckdbClient.closeAll(connection.id);
        fs.rmSync(file, { force: true });
    });

    it('proves the connection and reports a server version', async () => {
        const version = await client.testConnection();
        expect(version).toMatch(/duckdb/i);
    });

    it('treats the file itself as the one catalog', async () => {
        const catalogs = await client.catalogs();
        expect(catalogs).toEqual([path.basename(file, path.extname(file))]);
    });

    it('lists the main schema', async () => {
        const schemas = await client.schemas();
        expect(schemas).toContain('main');
    });

    it('separates tables from views', async () => {
        const entries = await client.tableEntries('', 'main');
        expect(entries).toContainEqual({ name: 'actor', view: false });
        expect(entries).toContainEqual({ name: 'actor_names', view: true });
    });

    it('reads column names and types for a real table', async () => {
        const columns = await client.columns('', 'main', 'actor');
        expect(columns).toContainEqual(expect.objectContaining({ name: 'id', extra: 'not null' }));
        expect(columns).toContainEqual(expect.objectContaining({ name: 'balance', type: expect.stringContaining('DECIMAL') }));
    });

    it('returns the literal CREATE statement as DDL', async () => {
        const ddl = await client.tableDdl('', 'main', 'actor');
        expect(ddl).toMatch(/CREATE TABLE actor/i);
    });

    it('runs a SELECT and returns rows', async () => {
        const result = await client.query('SELECT * FROM actor ORDER BY id');
        expect(result.columns).toEqual(['id', 'name', 'balance']);
        expect(result.rows.length).toBe(10);
        expect(result.rows[0]).toEqual([0, 'Actor 0', 0.5]);
    });

    it('previews a table through previewTable/previewSql', async () => {
        const result = await client.previewTable('', 'main', 'actor', 3);
        expect(result.rows.length).toBe(3);
    });

    it('reports non-SELECT statements as an affected-rows summary, not an empty grid', async () => {
        const result = await client.query("UPDATE actor SET name = 'x' WHERE id = 0");
        expect(result.columns).toEqual(['result']);
        expect(String(result.rows[0][0])).toMatch(/UPDATE — 1 row/i);
    });

    it('surfaces a server error instead of throwing an opaque one', async () => {
        await expect(client.query('SELECT * FROM this_table_does_not_exist')).rejects.toThrow(/does not exist/i);
    });

    it('honours a row cap lower than the result set', async () => {
        const capped = new DuckdbClient(fakeSecrets() as never, { ...connection, maxRows: 2 });
        const result = await capped.query('SELECT * FROM actor');
        expect(result.rows.length).toBe(2);
        expect(result.truncated).toBe(true);
    });
});
