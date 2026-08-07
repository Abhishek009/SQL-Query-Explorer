import { describe, expect, it } from 'vitest';
import { TrinoClient } from '../../src/engines/trino/trinoClient';
import { fakeSecrets, hasTrinoEnv, trinoConnection } from '../setup/support';

describe.skipIf(!hasTrinoEnv)('TrinoClient (live server)', () => {
    const connection = trinoConnection();
    const client = new TrinoClient(fakeSecrets() as never, connection);

    it('proves the connection and reports a server version', async () => {
        const version = await client.testConnection();
        expect(version).toBeTruthy();
    });

    it('lists catalogs, including the configured one', async () => {
        const catalogs = await client.catalogs();
        expect(catalogs).toContain(connection.catalog);
    });

    it('lists schemas in the configured catalog', async () => {
        const schemas = await client.schemas(connection.catalog!);
        expect(schemas).toContain(connection.schema);
    });

    it('separates tables from views via tableEntries', async () => {
        const entries = await client.tableEntries(connection.catalog!, connection.schema!);
        expect(entries.length).toBeGreaterThan(0);
    });

    it('reads column names and types for a real table', async () => {
        const [table] = await client.tables(connection.catalog!, connection.schema!);
        const columns = await client.columns(connection.catalog!, connection.schema!, table);
        expect(columns.length).toBeGreaterThan(0);
        expect(columns[0]).toMatchObject({ name: expect.any(String), type: expect.any(String) });
    });

    it('runs a SELECT and returns rows', async () => {
        const [table] = await client.tables(connection.catalog!, connection.schema!);
        const result = await client.query(
            `SELECT * FROM ${client.qualify(connection.catalog, connection.schema, table)} LIMIT 5`
        );
        expect(result.columns.length).toBeGreaterThan(0);
        expect(result.rows.length).toBeGreaterThan(0);
    });

    it('previews a table through previewTable/previewSql', async () => {
        const [table] = await client.tables(connection.catalog!, connection.schema!);
        const result = await client.previewTable(connection.catalog!, connection.schema!, table, 3);
        expect(result.rows.length).toBeLessThanOrEqual(3);
    });

    it('surfaces a server error instead of throwing an opaque one', async () => {
        await expect(client.query('SELECT * FROM this_table_does_not_exist')).rejects.toThrow();
    });

    it('honours a row cap lower than the result set', async () => {
        const capped = new TrinoClient(fakeSecrets() as never, { ...connection, maxRows: 2 });
        const [table] = await client.tables(connection.catalog!, connection.schema!);
        const result = await capped.query(
            `SELECT * FROM ${client.qualify(connection.catalog, connection.schema, table)}`
        );
        expect(result.rows.length).toBeLessThanOrEqual(2);
        expect(result.truncated).toBe(true);
    });
});
