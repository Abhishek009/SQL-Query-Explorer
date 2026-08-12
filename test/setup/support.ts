import { randomUUID } from 'node:crypto';
import type { StoredConnection } from '../../src/types';

/** A SecretStorage backed by an in-memory map, standing in for Secret Storage. */
export function fakeSecrets(passwords: Record<string, string> = {}) {
    const store = new Map(Object.entries(passwords));
    return {
        get: async (key: string) => store.get(key),
        store: async (key: string, value: string) => { store.set(key, value); },
        delete: async (key: string) => { store.delete(key); },
        onDidChange: () => ({ dispose: () => undefined })
    };
}

export function trinoConnection(overrides: Partial<StoredConnection> = {}): StoredConnection {
    return {
        id: randomUUID(),
        name: 'test-trino',
        type: 'trino',
        url: `http://${process.env.TEST_TRINO_HOST}:${process.env.TEST_TRINO_PORT}`,
        user: process.env.TEST_TRINO_USER ?? 'test',
        catalog: process.env.TEST_TRINO_CATALOG,
        schema: process.env.TEST_TRINO_SCHEMA,
        ...overrides
    };
}

export function postgresConnection(overrides: Partial<StoredConnection> = {}): StoredConnection {
    return {
        id: randomUUID(),
        name: 'test-postgres',
        type: 'postgres',
        url: `postgresql://${process.env.TEST_PG_HOST}:${process.env.TEST_PG_PORT}`,
        user: process.env.TEST_PG_USER ?? 'postgres',
        catalog: process.env.TEST_PG_DATABASE ?? 'postgres',
        ssl: false,
        ...overrides
    };
}

export function mysqlConnection(overrides: Partial<StoredConnection> = {}): StoredConnection {
    return {
        id: randomUUID(),
        name: 'test-mysql',
        type: 'mysql',
        url: `mysql://${process.env.TEST_MYSQL_HOST}:${process.env.TEST_MYSQL_PORT}`,
        user: process.env.TEST_MYSQL_USER ?? 'root',
        catalog: process.env.TEST_MYSQL_DATABASE,
        ssl: false,
        ...overrides
    };
}

export const hasTrinoEnv = Boolean(process.env.TEST_TRINO_HOST && process.env.TEST_TRINO_PORT);
export const hasPostgresEnv = Boolean(process.env.TEST_PG_HOST && process.env.TEST_PG_PORT);
export const hasMysqlEnv = Boolean(process.env.TEST_MYSQL_HOST && process.env.TEST_MYSQL_PORT);
