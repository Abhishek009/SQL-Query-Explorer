import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TrinoClient } from '../src/engines/trino/trinoClient';
import { PostgresClient } from '../src/engines/postgres/postgresClient';
import { SqliteClient } from '../src/engines/sqlite/sqliteClient';
import { DuckdbClient } from '../src/engines/duckdb/duckdbClient';
import { MySqlClient } from '../src/engines/mysql/mysqlClient';
import { MongodbClient } from '../src/engines/mongodb/mongodbClient';
import { SnowflakeClient } from '../src/engines/snowflake/snowflakeClient';
import { fakeSecrets } from './setup/support';
import type { StoredConnection } from '../src/types';
import type { SqlClient } from '../src/client';

function connection(type: StoredConnection['type']): StoredConnection {
    return { id: randomUUID(), name: 'test', type, url: 'unused', user: 'test' };
}

// A pure string transform — none of these constructors open a real connection,
// so this needs no live server, unlike the engines' other integration tests.
describe('quoteIdentifier', () => {
    it('MySQL and MariaDB use backticks, since that is what their SQL syntax requires', () => {
        expect(new MySqlClient(fakeSecrets() as never, connection('mysql')).quoteIdentifier('col name')).toBe('`col name`');
        expect(new MySqlClient(fakeSecrets() as never, connection('mariadb')).quoteIdentifier('col name')).toBe('`col name`');
    });

    it('escapes an embedded backtick by doubling it', () => {
        expect(new MySqlClient(fakeSecrets() as never, connection('mysql')).quoteIdentifier('a`b')).toBe('`a``b`');
    });

    it('every other SQL engine uses ANSI double quotes', () => {
        const clients: SqlClient[] = [
            new TrinoClient(fakeSecrets() as never, connection('trino')),
            new PostgresClient(fakeSecrets() as never, connection('postgres')),
            new SqliteClient(fakeSecrets() as never, connection('sqlite')),
            new DuckdbClient(fakeSecrets() as never, connection('duckdb')),
            new SnowflakeClient(fakeSecrets() as never, connection('snowflake'))
        ];
        for (const client of clients) {
            expect(client.quoteIdentifier('col name')).toBe('"col name"');
        }
    });

    it('MongoDB has no SQL identifiers to quote, so the name passes through unchanged', () => {
        expect(new MongodbClient(fakeSecrets() as never, connection('mongodb')).quoteIdentifier('field name')).toBe('field name');
    });
});

// Regression test for the bug this suite would have caught: importData.ts used
// to import `quoteIdentifier` from util.ts directly (always double-quoted)
// instead of calling client.quoteIdentifier(), so a CSV import into MySQL or
// MariaDB sent `"col"` — a syntax error on both, since they require backticks.
describe('SqlClient.quoteIdentifier vs the plain util helper', () => {
    it('MySQL/MariaDB disagree with the ANSI double-quote helper import used to hardcode', async () => {
        const { quoteIdentifier: ansiQuote } = await import('../src/util');
        const mysql = new MySqlClient(fakeSecrets() as never, connection('mysql'));
        expect(mysql.quoteIdentifier('name')).not.toBe(ansiQuote('name'));
    });
});
