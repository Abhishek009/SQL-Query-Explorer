import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MySqlClient } from '../../src/engines/mysql/mysqlClient';
import { fakeSecrets, hasMysqlEnv, mysqlConnection } from '../setup/support';
import type { StoredConnection } from '../../src/types';

// Uses the configured test user's own database rather than creating one —
// the account this suite runs against typically only has privileges on a
// database it was already granted (e.g. MySQL's classicmodels sample), not
// CREATE DATABASE at the server level.
describe.skipIf(!hasMysqlEnv)('MySqlClient (live server)', () => {
    const database = process.env.TEST_MYSQL_DATABASE ?? 'classicmodels';
    const table = 'sqlexplorer_smoke_actor';
    let connection: StoredConnection;
    let client: MySqlClient;

    beforeAll(async () => {
        connection = mysqlConnection({ catalog: database });
        client = new MySqlClient(fakeSecrets() as never, connection, undefined, process.env.TEST_MYSQL_PASSWORD);
        await client.query(`DROP TABLE IF EXISTS ${table}`);
        await client.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL)`);
        await client.query(`INSERT INTO ${table} (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol')`);
        await client.query(`CREATE OR REPLACE VIEW ${table}_names AS SELECT name FROM ${table}`);
    });

    afterAll(async () => {
        if (!client) { return; } // beforeAll never got far enough to set it up
        await client.query(`DROP VIEW IF EXISTS ${table}_names`);
        await client.query(`DROP TABLE IF EXISTS ${table}`);
        await MySqlClient.closeAll(connection.id);
    });

    it('proves the connection and reports a server version', async () => {
        const version = await client.testConnection();
        expect(version).toMatch(/mysql/i);
    });

    it('lists databases on the server, including the configured one', async () => {
        const databases = await client.catalogs();
        expect(databases).toContain(database);
        // System databases stay out of the way of a user's actual schemas.
        expect(databases).not.toContain('information_schema');
        expect(databases).not.toContain('mysql');
    });

    it('repeats the database name as its own schema, since MySQL has no level between them', async () => {
        const schemas = await client.schemas(database);
        expect(schemas).toEqual([database]);
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
            process.env.TEST_MYSQL_PASSWORD
        );
        const result = await capped.query(`SELECT * FROM ${table}`);
        expect(result.rows.length).toBeLessThanOrEqual(2);
        expect(result.truncated).toBe(true);
        await MySqlClient.closeAll(connection.id);
    });
});
