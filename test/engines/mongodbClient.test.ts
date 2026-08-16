import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongodbClient } from '../../src/engines/mongodb/mongodbClient';
import { fakeSecrets, hasMongoEnv, mongodbConnection } from '../setup/support';
import type { StoredConnection } from '../../src/types';

describe.skipIf(!hasMongoEnv)('MongodbClient (live server)', () => {
    const database = process.env.TEST_MONGO_DATABASE ?? 'sqlexplorer_test';
    const collection = 'sqlexplorer_smoke_people';
    let connection: StoredConnection;
    let client: MongodbClient;

    beforeAll(async () => {
        connection = mongodbConnection({ catalog: database });
        client = new MongodbClient(fakeSecrets() as never, connection, undefined, process.env.TEST_MONGO_PASSWORD);
        await client.query(`db.${collection}.drop()`).catch(() => undefined);
        await client.query(`db.${collection}.insertMany([{name:"Alice",age:30},{name:"Bob",age:25},{name:"Carol",age:35}])`);
    });

    afterAll(async () => {
        if (!client) { return; }
        await client.query(`db.${collection}.drop()`).catch(() => undefined);
        await MongodbClient.closeAll(connection.id);
    });

    it('proves the connection and reports a server version', async () => {
        const version = await client.testConnection();
        expect(version).toMatch(/mongodb/i);
    });

    it('lists the configured database', async () => {
        expect(await client.catalogs()).toEqual([database]);
    });

    it('repeats the database name as its own schema, since MongoDB has no level between them', async () => {
        expect(await client.schemas(database)).toEqual([database]);
    });

    it('lists collections, including the one seeded above', async () => {
        const entries = await client.tableEntries(database, database);
        expect(entries).toContainEqual({ name: collection, view: false });
    });

    it('infers columns from sampled documents', async () => {
        const columns = await client.columns(database, database, collection);
        expect(columns).toContainEqual(expect.objectContaining({ name: '_id', type: 'ObjectId' }));
        expect(columns).toContainEqual(expect.objectContaining({ name: 'name', type: 'string' }));
        expect(columns).toContainEqual(expect.objectContaining({ name: 'age', type: 'number' }));
    });

    it('returns the inferred shape and an example document as "DDL"', async () => {
        const ddl = await client.tableDdl(database, database, collection);
        expect(ddl).toMatch(/no fixed schema/i);
        expect(ddl).toMatch(/Example document/i);
    });

    it('runs a find() and returns rows', async () => {
        const result = await client.query(`db.${collection}.find({}, {name:1, age:1}).sort({name:1})`);
        expect(result.columns).toContain('name');
        expect(result.rows.map(row => row[result.columns.indexOf('name')])).toEqual(['Alice', 'Bob', 'Carol']);
    });

    it('previews a collection through previewTable/previewSql', async () => {
        const result = await client.previewTable(database, database, collection, 2);
        expect(result.rows.length).toBe(2);
    });

    it('reports a mutation as an affected-count summary, not an empty grid', async () => {
        const result = await client.query(`db.${collection}.updateOne({name:"Alice"}, {$set:{age:31}})`);
        expect(result.columns).toEqual(['result']);
        expect(String(result.rows[0][0])).toMatch(/updateOne — matched 1, modified 1/i);
    });

    it('runs an aggregate() pipeline', async () => {
        const result = await client.query(`db.${collection}.aggregate([{$match:{age:{$gt:26}}},{$count:"n"}])`);
        expect(result.rows[0][result.columns.indexOf('n')]).toBe(2);
    });

    it('runs multiple semicolon-separated commands, returning the last result', async () => {
        const result = await client.query(`db.${collection}.countDocuments({}); db.${collection}.find({name:"Bob"})`);
        expect(result.columns).toContain('name');
    });

    it('surfaces a server error instead of throwing an opaque one', async () => {
        await expect(client.query('db.foo.bar()')).rejects.toThrow(/[Uu]nsupported/);
    });

    it('honours a row cap lower than the result set', async () => {
        const capped = new MongodbClient(
            fakeSecrets() as never,
            { ...connection, maxRows: 2 },
            undefined,
            process.env.TEST_MONGO_PASSWORD
        );
        const result = await capped.query(`db.${collection}.find()`);
        expect(result.rows.length).toBeLessThanOrEqual(2);
        expect(result.truncated).toBe(true);
        await MongodbClient.closeAll(connection.id);
    });
});
