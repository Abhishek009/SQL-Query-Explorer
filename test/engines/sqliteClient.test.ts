import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import RawDatabase from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteClient } from '../../src/engines/sqlite/sqliteClient';
import { fakeSecrets } from '../setup/support';
import type { StoredConnection } from '../../src/types';

// SQLite needs no external server — the fixture is a real file created fresh
// for this run, so these tests always run rather than skipping like the
// live-server suites for Postgres/Trino.
describe('SqliteClient (local file)', () => {
    const file = path.join(os.tmpdir(), `sqlexplorer-test-${randomUUID()}.db`);
    let connection: StoredConnection;
    let client: SqliteClient;

    beforeAll(() => {
        const seed = new RawDatabase(file);
        seed.exec(`
            CREATE TABLE actor (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
            CREATE VIEW actor_names AS SELECT name FROM actor;
        `);
        const insert = seed.prepare('INSERT INTO actor (name) VALUES (?)');
        for (let i = 0; i < 10; i++) { insert.run(`Actor ${i}`); }
        seed.close();

        connection = { id: randomUUID(), name: 'test-sqlite', type: 'sqlite', url: file, user: '' };
        client = new SqliteClient(fakeSecrets() as never, connection);
    });

    afterAll(() => {
        SqliteClient.closeAll(connection.id);
        fs.rmSync(file, { force: true });
        fs.rmSync(`${file}-wal`, { force: true });
        fs.rmSync(`${file}-shm`, { force: true });
    });

    it('proves the connection and reports a server version', async () => {
        const version = await client.testConnection();
        expect(version).toMatch(/sqlite/i);
    });

    it('treats the file itself as the one catalog', async () => {
        const catalogs = await client.catalogs();
        expect(catalogs).toEqual([path.basename(file)]);
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
        expect(columns).toContainEqual(expect.objectContaining({ name: 'id', extra: expect.stringContaining('primary key') }));
        expect(columns).toContainEqual(expect.objectContaining({ name: 'name', extra: expect.stringContaining('not null') }));
    });

    it('returns the literal CREATE statement as DDL', async () => {
        const ddl = await client.tableDdl('', 'main', 'actor');
        expect(ddl).toMatch(/CREATE TABLE actor/i);
    });

    it('runs a SELECT and returns rows', async () => {
        const result = await client.query('SELECT * FROM actor ORDER BY id');
        expect(result.columns).toEqual(['id', 'name']);
        expect(result.rows.length).toBe(10);
    });

    it('previews a table through previewTable/previewSql', async () => {
        const result = await client.previewTable('', 'main', 'actor', 3);
        expect(result.rows.length).toBe(3);
    });

    it('reports non-SELECT statements as an affected-rows summary, not an empty grid', async () => {
        const result = await client.query("UPDATE actor SET name = 'x' WHERE id = 1");
        expect(result.columns).toEqual(['result']);
        expect(String(result.rows[0][0])).toMatch(/UPDATE — 1 row/i);
    });

    it('surfaces a server error instead of throwing an opaque one', async () => {
        await expect(client.query('SELECT * FROM this_table_does_not_exist')).rejects.toThrow(/no such table/i);
    });

    it('honours a row cap lower than the result set', async () => {
        const capped = new SqliteClient(fakeSecrets() as never, { ...connection, maxRows: 2 });
        const result = await capped.query('SELECT * FROM actor');
        expect(result.rows.length).toBe(2);
        expect(result.truncated).toBe(true);
    });
});
