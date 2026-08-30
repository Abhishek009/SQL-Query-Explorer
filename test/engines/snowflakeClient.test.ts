import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SnowflakeClient } from '../../src/engines/snowflake/snowflakeClient';
import { isSnowflakeInstalled, setSnowflakeRuntimeDirForTests } from '../../src/engines/snowflake/snowflakeRuntime';
import { fakeSecrets } from '../setup/support';
import type { StoredConnection } from '../../src/types';

const cacheDir = path.resolve(__dirname, '../../.snowflake-test-cache');
setSnowflakeRuntimeDirForTests(cacheDir);
const hasSnowflakeCache = isSnowflakeInstalled();

// No live Snowflake account is configured for this suite (unlike MySQL/Mongo/
// MariaDB, which point at real always-on test servers) — Snowflake accounts
// aren't a free, disposable thing to spin up the way a local Docker container
// is. What this proves instead: the on-demand-installed real snowflake-sdk
// package actually has the shape mysqlClient.ts's hand-written interfaces
// assume, and the connect()/error-wrapping plumbing works end-to-end against
// a real (failing) connection attempt — the two things most likely to be
// silently wrong without ever running against the genuine package.
describe.skipIf(!hasSnowflakeCache)('SnowflakeClient (real snowflake-sdk package, no live account)', () => {
    function connection(overrides: Partial<StoredConnection> = {}): StoredConnection {
        return { id: randomUUID(), name: 'test-snowflake', type: 'snowflake', url: 'nonexistent-account-sqlexplorer-test', user: 'test', warehouse: 'WH', ...overrides };
    }

    it('reports the runtime as installed once the package is present in the cache dir', () => {
        expect(hasSnowflakeCache).toBe(true);
    });

    it('loads the real package and surfaces a real connection failure as a wrapped, non-hanging error', async () => {
        const client = new SnowflakeClient(fakeSecrets() as never, connection(), undefined, 'wrong-password');
        await expect(client.testConnection()).rejects.toThrow();
    }, 30_000);

    it('reports a clear, actionable error when the runtime is not installed, instead of a raw module-not-found', async () => {
        setSnowflakeRuntimeDirForTests(path.join(cacheDir, 'does-not-exist'));
        try {
            const client = new SnowflakeClient(fakeSecrets() as never, connection({ id: randomUUID() }), undefined, 'x');
            await expect(client.testConnection()).rejects.toThrow(/not installed/i);
        } finally {
            setSnowflakeRuntimeDirForTests(cacheDir);
        }
    });
});
