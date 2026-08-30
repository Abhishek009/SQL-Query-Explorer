import { describe, expect, it } from 'vitest';
import { validateConnection } from '../src/connectionForm';
import { connectionFromForm } from '../src/commands';
import type { ConnectionMessage } from '../src/connectionForm';

function message(overrides: Partial<ConnectionMessage> = {}): ConnectionMessage {
    return {
        type: 'save', engine: 'snowflake', name: '', host: '', port: '', sslEnabled: false, sslVerify: true,
        user: '', catalog: '', schema: '', database: '', file: '', maxRows: '',
        warehouse: '', role: '', authMethod: 'password',
        password: '', clearPassword: false, connect: false,
        ...overrides
    };
}

describe('validateConnection (Snowflake)', () => {
    it('requires an account identifier', () => {
        expect(validateConnection(message())).toMatch(/account identifier/i);
    });

    it('requires a warehouse, since Snowflake has no default to fall back to', () => {
        expect(validateConnection(message({ host: 'xy12345', user: 'alice' }))).toMatch(/warehouse/i);
    });

    it('requires a username for password authentication', () => {
        expect(validateConnection(message({ host: 'xy12345', warehouse: 'WH' }))).toMatch(/user name/i);
    });

    it('accepts a complete password-auth connection', () => {
        expect(validateConnection(message({ host: 'xy12345', warehouse: 'WH', user: 'alice' }))).toBeUndefined();
    });

    it('does not require a username for external-browser authentication', () => {
        expect(validateConnection(message({ host: 'xy12345', warehouse: 'WH', authMethod: 'externalbrowser' }))).toBeUndefined();
    });

    it('never falls through to the generic host/port check that would reject a bare account identifier', () => {
        // A bare account identifier like "xy12345.us-east-1" isn't a URL and has
        // no port — the generic wire-protocol validation would wrongly reject it.
        expect(validateConnection(message({ host: 'xy12345.us-east-1', warehouse: 'WH', user: 'alice' }))).toBeUndefined();
    });
});

describe('connectionFromForm (Snowflake)', () => {
    it('stores the account identifier as the url, with no host/port assembly', () => {
        const connection = connectionFromForm(message({ host: 'xy12345.us-east-1', warehouse: 'WH', user: 'alice' }), 'id-1');
        expect(connection.url).toBe('xy12345.us-east-1');
        expect(connection.type).toBe('snowflake');
    });

    it('carries warehouse, role, and catalog/schema through to the stored connection', () => {
        const connection = connectionFromForm(message({
            host: 'xy12345', warehouse: 'COMPUTE_WH', role: 'ANALYST', user: 'alice',
            catalog: 'ANALYTICS', schema: 'PUBLIC'
        }), 'id-1');
        expect(connection.warehouse).toBe('COMPUTE_WH');
        expect(connection.role).toBe('ANALYST');
        expect(connection.catalog).toBe('ANALYTICS');
        expect(connection.schema).toBe('PUBLIC');
    });

    it('leaves catalog undefined (browse every database) when the field is blank', () => {
        const connection = connectionFromForm(message({ host: 'xy12345', warehouse: 'WH', user: 'alice' }), 'id-1');
        expect(connection.catalog).toBeUndefined();
    });

    it('sets authenticator to externalbrowser and drops the username requirement downstream', () => {
        const connection = connectionFromForm(message({
            host: 'xy12345', warehouse: 'WH', authMethod: 'externalbrowser'
        }), 'id-1');
        expect(connection.authenticator).toBe('externalbrowser');
    });

    it('leaves authenticator undefined for plain password auth, matching the "absent means password" convention', () => {
        const connection = connectionFromForm(message({ host: 'xy12345', warehouse: 'WH', user: 'alice' }), 'id-1');
        expect(connection.authenticator).toBeUndefined();
    });

    it('defaults the connection name when none is given', () => {
        const connection = connectionFromForm(message({ host: 'xy12345', warehouse: 'WH', user: 'alice' }), 'id-1');
        expect(connection.name).toBe('Snowflake Connection');
    });
});
