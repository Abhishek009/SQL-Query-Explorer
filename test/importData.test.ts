import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cellLiteral } from '../src/importData';
import { parseCsv } from '../src/csv';
import { quoteIdentifier } from '../src/util';
import { SqliteClient, createEmptyDatabase } from '../src/engines/sqlite/sqliteClient';
import { isSqliteInstalled, setSqliteRuntimeDirForTests } from '../src/engines/sqlite/sqliteRuntime';
import { fakeSecrets } from './setup/support';
import type { StoredConnection } from '../src/types';

const cacheDir = path.resolve(__dirname, '../.sqlite-test-cache');
setSqliteRuntimeDirForTests(cacheDir);
const hasSqliteCache = isSqliteInstalled();

describe('cellLiteral', () => {
    it('passes a valid number through unquoted for a numeric column', () => {
        expect(cellLiteral('42', 'INTEGER')).toBe('42');
        expect(cellLiteral('3.14', 'REAL')).toBe('3.14');
    });

    it('falls back to NULL for unparseable numeric input', () => {
        expect(cellLiteral('not-a-number', 'INTEGER')).toBe('NULL');
    });

    it('treats an empty cell as NULL regardless of column type', () => {
        expect(cellLiteral('', 'TEXT')).toBe('NULL');
        expect(cellLiteral('', 'INTEGER')).toBe('NULL');
    });

    it('quotes and escapes text for a non-numeric column', () => {
        expect(cellLiteral("O'Brien", 'TEXT')).toBe("'O''Brien'");
    });
});

describe.skipIf(!hasSqliteCache)('import pipeline (real SQLite file)', () => {
    const file = path.join(os.tmpdir(), `sqlexplorer-import-${randomUUID()}.db`);
    let client: SqliteClient;
    let connection: StoredConnection;

    beforeAll(async () => {
        createEmptyDatabase(file);
        connection = { id: randomUUID(), name: 'test-import', type: 'sqlite', url: file, user: '' };
        client = new SqliteClient(fakeSecrets() as never, connection);
        await client.query('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, balance REAL)');
    });

    afterAll(() => {
        SqliteClient.closeAll(connection.id);
        fs.rmSync(file, { force: true });
    });

    it('builds and runs the same batched INSERT importData.ts generates, from a real CSV', async () => {
        const csv = 'id,full_name,balance,notes\n1,"Doe, Jane",100.5,\n2,O\'Brien,not-a-number,skip me\n';
        const [headers, ...dataRows] = parseCsv(csv);
        expect(headers).toEqual(['id', 'full_name', 'balance', 'notes']);

        const columns = await client.columns('', 'main', 'customers');
        // Mirrors the mapping a user would pick in the webview: id<-id, name<-full_name,
        // balance<-balance; "notes" is deliberately left unmapped (no matching column).
        const mapping: Record<string, number> = { id: 0, name: 1, balance: 2 };
        const mapped = columns
            .map(column => ({ column, sourceIndex: mapping[column.name] ?? -1 }))
            .filter(entry => entry.sourceIndex >= 0);

        const qualified = client.qualify('', 'main', 'customers');
        const columnList = mapped.map(entry => quoteIdentifier(entry.column.name)).join(', ');
        const values = dataRows.map(row =>
            `(${mapped.map(entry => cellLiteral(row[entry.sourceIndex], entry.column.type)).join(', ')})`
        ).join(', ');
        const sql = `INSERT INTO ${qualified} (${columnList}) VALUES ${values}`;

        await client.query(sql);

        const result = await client.query('SELECT id, name, balance FROM customers ORDER BY id');
        expect(result.rows).toEqual([
            [1, 'Doe, Jane', 100.5],
            [2, "O'Brien", null] // balance was unparseable -> NULL, not a crash or wrong type
        ]);
    });
});
