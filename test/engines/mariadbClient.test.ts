import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MySqlClient } from '../../src/engines/mysql/mysqlClient';
import { fakeSecrets, hasMariadbEnv, mariadbConnection } from '../setup/support';
import type { StoredConnection } from '../../src/types';

// MariaDB is served by the same MySqlClient MySQL uses — same wire protocol,
// same mysql2 driver — so this suite mirrors mysqlClient.test.ts, just proving
// the shared client behaves correctly against a real MariaDB server too.
describe.skipIf(!hasMariadbEnv)('MySqlClient against MariaDB (live server)', () => {
    const database = process.env.TEST_MARIADB_DATABASE ?? 'my_database';
    const table = 'sqlexplorer_smoke_actor';
    let connection: StoredConnection;
    let client: MySqlClient;

    beforeAll(async () => {
        connection = mariadbConnection({ catalog: database });
        client = new MySqlClient(fakeSecrets() as never, connection, undefined, process.env.TEST_MARIADB_PASSWORD);
        await client.query(`DROP TABLE IF EXISTS ${table}`);
        await client.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL)`);
        await client.query(`INSERT INTO ${table} (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol')`);
        await client.query(`CREATE OR REPLACE VIEW ${table}_names AS SELECT name FROM ${table}`);
    });

    afterAll(async () => {
        if (!client) { return; }
        await client.query(`DROP VIEW IF EXISTS ${table}_names`);
        await client.query(`DROP TABLE IF EXISTS ${table}`);
        await MySqlClient.closeAll(connection.id);
    });

    it('proves the connection and reports a server version labelled MariaDB, not MySQL', async () => {
        const version = await client.testConnection();
        expect(version).toMatch(/^MariaDB /);
    });

    it('lists databases on the server, including the configured one', async () => {
        const databases = await client.catalogs();
        expect(databases).toContain(database);
        expect(databases).not.toContain('information_schema');
        expect(databases).not.toContain('mysql');
    });

    it('repeats the database name as its own schema', async () => {
        expect(await client.schemas(database)).toEqual([database]);
    });

    it('separates tables from views', async () => {
        const entries = await client.tableEntries(database, database);
        expect(entries).toContainEqual({ name: table, view: false });
        expect(entries).toContainEqual({ name: `${table}_names`, view: true });
    });

    it('reads column names and types for a real table', async () => {
        const columns = await client.columns(database, database, table);
        expect(columns).toContainEqual(expect.objectContaining({ name: 'id', extra: expect.stringContaining('primary key') }));
        expect(columns).toContainEqual(expect.objectContaining({ name: 'name', extra: expect.stringContaining('not null') }));
    });

    it('returns the literal CREATE statement as DDL', async () => {
        const ddl = await client.tableDdl(database, database, table);
        expect(ddl).toMatch(new RegExp(`CREATE TABLE \`${table}\``, 'i'));
    });

    it('runs a SELECT and returns rows', async () => {
        const result = await client.query(`SELECT * FROM ${table} ORDER BY id`);
        expect(result.columns).toEqual(['id', 'name']);
        expect(result.rows).toEqual([[1, 'Alice'], [2, 'Bob'], [3, 'Carol']]);
    });

    it('previews a table through previewTable/previewSql', async () => {
        const result = await client.previewTable(database, database, table, 2);
        expect(result.rows.length).toBe(2);
    });

    it('reports non-SELECT statements as an affected-rows summary, not an empty grid', async () => {
        const result = await client.query(`UPDATE ${table} SET name = 'x' WHERE id = 1`);
        expect(result.columns).toEqual(['result']);
        expect(String(result.rows[0][0])).toMatch(/UPDATE — 1 row/i);
    });

    it('surfaces a server error instead of throwing an opaque one', async () => {
        await expect(client.query('SELECT * FROM this_table_does_not_exist')).rejects.toThrow(/exist/i);
    });

    it('honours a row cap lower than the result set', async () => {
        const capped = new MySqlClient(
            fakeSecrets() as never,
            { ...connection, maxRows: 2 },
            undefined,
            process.env.TEST_MARIADB_PASSWORD
        );
        const result = await capped.query(`SELECT * FROM ${table}`);
        expect(result.rows.length).toBeLessThanOrEqual(2);
        expect(result.truncated).toBe(true);
        await MySqlClient.closeAll(connection.id);
    });

    // Regression test: CSV import built its column list with the ANSI
    // double-quote helper for every engine, which MariaDB (like MySQL) rejects
    // outright — reported as "You have an error in your SQL syntax ... near
    // '"col1", "col2", ...'". client.quoteIdentifier() is what importData.ts
    // now calls instead.
    it('accepts an INSERT column list built with quoteIdentifier(), and rejects the double-quoted form that used to be sent', async () => {
        const columnList = ['id', 'name'].map(name => client.quoteIdentifier(name)).join(', ');
        expect(columnList).toBe('`id`, `name`');
        await expect(client.query(`INSERT INTO ${table} (${columnList}) VALUES (99, 'Zoe')`)).resolves.toBeTruthy();

        const doubleQuoted = ['id', 'name'].map(name => `"${name}"`).join(', ');
        await expect(client.query(`INSERT INTO ${table} (${doubleQuoted}) VALUES (100, 'Yara')`))
            .rejects.toThrow(/syntax/i);
    });
});
