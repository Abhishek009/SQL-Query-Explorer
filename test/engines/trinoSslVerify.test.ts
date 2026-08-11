import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TrinoClient } from '../../src/engines/trino/trinoClient';
import { fakeSecrets } from '../setup/support';
import type { StoredConnection } from '../../src/types';

const keyFile = `/tmp/sqlexplorer-tlsverify-${randomUUID()}-key.pem`;
const certFile = `/tmp/sqlexplorer-tlsverify-${randomUUID()}-cert.pem`;

function hasOpenssl(): boolean {
    try { execSync('openssl version', { stdio: 'ignore' }); return true; }
    catch { return false; }
}

/**
 * Reproduces the real scenario reported against a corporate Trino coordinator:
 * a certificate issued for a different hostname (a load balancer sharing one
 * cert across services). Verifies the "Verify server certificate" toggle
 * (StoredConnection.sslVerify) actually controls whether that connection is
 * accepted or rejected, through TrinoClient itself — not just raw fetch.
 */
describe.skipIf(!hasOpenssl())('TrinoClient sslVerify (mismatched certificate)', () => {
    let server: https.Server;
    let port: number;

    beforeAll(async () => {
        execSync(
            `openssl req -x509 -newkey rsa:2048 -keyout ${keyFile} -out ${certFile} ` +
            '-days 1 -nodes -subj "/CN=wrong-hostname.example.com" -addext "subjectAltName=DNS:wrong-hostname.example.com"',
            { stdio: 'ignore' }
        );
        server = https.createServer(
            { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) },
            (_req, res) => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ id: 'q1', columns: [{ name: '_col0' }], data: [['Trino 999-mock']] }));
            }
        );
        await new Promise<void>(resolve => server.listen(0, resolve));
        port = (server.address() as { port: number }).port;
    });

    afterAll(() => {
        server.close();
        fs.rmSync(keyFile, { force: true });
        fs.rmSync(certFile, { force: true });
    });

    const connection = (sslVerify: boolean): StoredConnection => ({
        id: randomUUID(), name: 'tls-test', type: 'trino', url: `https://localhost:${port}`, user: 'test', sslVerify
    });

    it('rejects a mismatched certificate by default (sslVerify unset)', async () => {
        const client = new TrinoClient(fakeSecrets() as never, { ...connection(true), sslVerify: undefined });
        await expect(client.testConnection()).rejects.toThrow();
    });

    it('rejects a mismatched certificate when sslVerify is explicitly true', async () => {
        const client = new TrinoClient(fakeSecrets() as never, connection(true));
        await expect(client.testConnection()).rejects.toThrow();
    });

    it('connects anyway when sslVerify is turned off', async () => {
        const client = new TrinoClient(fakeSecrets() as never, connection(false));
        const version = await client.testConnection();
        expect(version).toBe('Trino 999-mock');
    });
});
