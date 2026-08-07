import { afterAll, describe, expect, it } from 'vitest';
import { PostgresClient } from '../../src/engines/postgres/postgresClient';
import { fakeSecrets, hasPostgresEnv, postgresConnection } from '../setup/support';

describe.skipIf(!hasPostgresEnv)('PostgresClient (live server)', () => {
    const connection = postgresConnection();
    const client = new PostgresClient(fakeSecrets() as never, connection, undefined, process.env.TEST_PG_PASSWORD);

    afterAll(() => PostgresClient.closeAll(connection.id));

    it('proves the connection and reports a server version', async () => {
        const version = await client.testConnection();
        expect(version).toMatch(/postgres/i);
    });

    it('lists databases on the server, including the configured one', async () => {
        const databases = await client.catalogs();
        expect(databases).toContain(connection.catalog);
    });

    it('lists the public schema', async () => {
        const schemas = await client.schemas(connection.catalog!);
        expect(schemas).toContain('public');
    });

    it('separates tables from views', async () => {
        const entries = await client.tableEntries(connection.catalog!, 'public');
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.some(entry => !entry.view)).toBe(true);
    });

    it('reads column names and types for a real table', async () => {
        const [table] = await client.tables(connection.catalog!, 'public');
        const columns = await client.columns(connection.catalog!, 'public', table);
        expect(columns.length).toBeGreaterThan(0);
        expect(columns[0]).toMatchObject({ name: expect.any(String), type: expect.any(String) });
    });

    it('runs a SELECT and returns rows', async () => {
        const [table] = await client.tables(connection.catalog!, 'public');
        const result = await client.query(`SELECT * FROM "public"."${table}" LIMIT 5`);
        expect(result.columns.length).toBeGreaterThan(0);
        expect(result.rows.length).toBeGreaterThan(0);
    });

    it('previews a table through previewTable/previewSql', async () => {
        const [table] = await client.tables(connection.catalog!, 'public');
        const result = await client.previewTable(connection.catalog!, 'public', table, 3);
        expect(result.rows.length).toBeLessThanOrEqual(3);
    });

    it('reports non-SELECT statements as an affected-rows summary, not an empty grid', async () => {
        const result = await client.query('CREATE TEMP TABLE _sqlx_smoke (id int)');
        expect(result.columns).toEqual(['result']);
        expect(String(result.rows[0][0])).toMatch(/CREATE/i);
    });

    it('surfaces a server error instead of throwing an opaque one', async () => {
        await expect(client.query('SELECT * FROM this_table_does_not_exist')).rejects.toThrow(/does not exist/i);
    });

    it('honours a row cap lower than the result set', async () => {
        const capped = new PostgresClient(
            fakeSecrets() as never,
            { ...connection, maxRows: 2 },
            undefined,
            process.env.TEST_PG_PASSWORD
        );
        const [table] = await client.tables(connection.catalog!, 'public');
        const result = await capped.query(`SELECT * FROM "public"."${table}"`);
        expect(result.rows.length).toBeLessThanOrEqual(2);
        await PostgresClient.closeAll(connection.id);
    });
});
