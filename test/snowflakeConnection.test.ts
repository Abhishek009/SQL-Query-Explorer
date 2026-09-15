import { describe, expect, it } from 'vitest';
import { validateConnection } from '../src/connectionForm';
import { connectionFromForm } from '../src/commands';
import { asSnowflakeError, normalizeAccountIdentifier } from '../src/engines/snowflake/snowflakeClient';
import type { ConnectionMessage } from '../src/connectionForm';

function message(overrides: Partial<ConnectionMessage> = {}): ConnectionMessage {
    return {
        type: 'save', engine: 'snowflake', name: '', host: '', port: '', sslEnabled: false, sslVerify: true,
        user: '', catalog: '', schema: '', database: '', file: '', maxRows: '',
        warehouse: '', role: '', authMethod: 'password',
        password: '', savePassword: true, connect: false,
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

// Regression coverage for a real bug report: pasting the full Snowsight URL
// into Account identifier (a very natural thing to do — it's exactly what
// shows in the browser bar) was passed straight through to the driver's
// `account` option, which broke SSO outright with Snowflake's generic,
// unhelpful "error related to the SAML Identity Provider account parameter" —
// the identity-provider lookup is keyed off that exact string.
describe('normalizeAccountIdentifier', () => {
    it('leaves a bare account identifier untouched', () => {
        expect(normalizeAccountIdentifier('xy12345.us-east-1')).toBe('xy12345.us-east-1');
        expect(normalizeAccountIdentifier('myorg-myaccount')).toBe('myorg-myaccount');
    });

    it('strips a pasted https:// Snowsight URL down to the bare identifier', () => {
        expect(normalizeAccountIdentifier('https://xy12345.us-east-1.snowflakecomputing.com')).toBe('xy12345.us-east-1');
    });

    it('strips a trailing slash or path along with the scheme', () => {
        expect(normalizeAccountIdentifier('https://xy12345.us-east-1.snowflakecomputing.com/console')).toBe('xy12345.us-east-1');
        expect(normalizeAccountIdentifier('https://xy12345.us-east-1.snowflakecomputing.com/')).toBe('xy12345.us-east-1');
    });

    it('strips the .snowflakecomputing.com suffix even without a scheme', () => {
        expect(normalizeAccountIdentifier('xy12345.us-east-1.snowflakecomputing.com')).toBe('xy12345.us-east-1');
    });

    it('trims surrounding whitespace', () => {
        expect(normalizeAccountIdentifier('  xy12345.us-east-1  ')).toBe('xy12345.us-east-1');
    });
});

describe('connectionFromForm (Snowflake)', () => {
    it('stores the account identifier as the url, with no host/port assembly', () => {
        const connection = connectionFromForm(message({ host: 'xy12345.us-east-1', warehouse: 'WH', user: 'alice' }), 'id-1');
        expect(connection.url).toBe('xy12345.us-east-1');
        expect(connection.type).toBe('snowflake');
    });

    it('normalizes a pasted full Snowsight URL down to the bare account identifier', () => {
        const connection = connectionFromForm(message({
            host: 'https://xy12345.us-east-1.snowflakecomputing.com/', warehouse: 'WH', user: 'alice'
        }), 'id-1');
        expect(connection.url).toBe('xy12345.us-east-1');
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

// Regression coverage for a real bug report: EXTERNALBROWSER failing against
// an account with no SSO/SAML integration configured (common on trial/personal
// accounts) surfaces only as Snowflake's generic "Contact Snowflake support"
// text, which names no actual cause.
describe('asSnowflakeError', () => {
    it('translates the SAML-not-configured error into actionable guidance, keeping the raw text as detail', () => {
        const raw = 'Authentication failed. Error code: 390190, message: There was an error related to the SAML Identity Provider account parameter. Contact Snowflake support.';
        const error = asSnowflakeError({ message: raw, code: 390190 });
        expect(error.message).toMatch(/does not appear to have SSO configured/i);
        expect(error.message).toMatch(/Username & Password/i);
        expect((error as { details?: string }).details).toContain(raw);
    });

    it('leaves an unrelated error message untouched', () => {
        const error = asSnowflakeError({ message: 'Incorrect username or password was specified.', code: 390100 });
        expect(error.message).toBe('Incorrect username or password was specified.');
    });
});
