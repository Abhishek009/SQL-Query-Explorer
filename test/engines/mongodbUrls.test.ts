import { describe, expect, it } from 'vitest';
import { expandPastedMongoUrl, isMongoConnectionString } from '../../src/engines/mongodb/mongodbUrls';
import { mongoHostAndPort } from '../../src/engines/mongodb/mongodbClient';
import type { ConnectionMessage } from '../../src/connectionForm';

function message(overrides: Partial<ConnectionMessage> = {}): ConnectionMessage {
    return {
        type: 'save', engine: 'mongodb', name: '', host: '', port: '', sslEnabled: false, sslVerify: true,
        user: '', catalog: '', schema: '', database: '', file: '', maxRows: '',
        password: '', clearPassword: false, connect: false,
        ...overrides
    };
}

describe('isMongoConnectionString', () => {
    it('recognises mongodb:// and mongodb+srv://', () => {
        expect(isMongoConnectionString('mongodb://localhost:27017')).toBe(true);
        expect(isMongoConnectionString('mongodb+srv://cluster0.example.mongodb.net')).toBe(true);
    });

    it('rejects a bare host name', () => {
        expect(isMongoConnectionString('localhost')).toBe(false);
    });
});

describe('expandPastedMongoUrl', () => {
    it('leaves non-mongodb engines untouched', () => {
        const original = message({ engine: 'mysql' as ConnectionMessage['engine'], host: 'mongodb://x' });
        expect(expandPastedMongoUrl(original)).toBe(original);
    });

    it('leaves a bare host name in the Host field untouched', () => {
        const original = message({ host: 'localhost' });
        expect(expandPastedMongoUrl(original)).toEqual(original);
    });

    it('pulls user, password, and database out of a standard connection string', () => {
        const result = expandPastedMongoUrl(message({ host: 'mongodb://alice:s3cret@db.example.com:27017/shop' }));
        expect(result.host).toBe('mongodb://db.example.com:27017');
        expect(result.port).toBe('');
        expect(result.user).toBe('alice');
        expect(result.password).toBe('s3cret');
        expect(result.database).toBe('shop');
    });

    it('keeps an SRV string intact, including query parameters, with no port', () => {
        const result = expandPastedMongoUrl(message({
            host: 'mongodb+srv://cluster0.example.mongodb.net/shop?retryWrites=true&w=majority'
        }));
        expect(result.host).toBe('mongodb+srv://cluster0.example.mongodb.net?retryWrites=true&w=majority');
        expect(result.port).toBe('');
        expect(result.database).toBe('shop');
    });

    it('does not overwrite fields the user already typed into the form', () => {
        const result = expandPastedMongoUrl(message({
            host: 'mongodb://alice:s3cret@db.example.com:27017/shop',
            user: 'bob',
            database: 'inventory'
        }));
        expect(result.user).toBe('bob');
        expect(result.database).toBe('inventory');
    });

    it('URL-decodes a percent-encoded password', () => {
        const result = expandPastedMongoUrl(message({ host: 'mongodb://alice:p%40ss@db.example.com:27017' }));
        expect(result.password).toBe('p@ss');
    });

    it('checks SSL for a pasted mongodb+srv:// string, since that scheme requires TLS in practice', () => {
        const result = expandPastedMongoUrl(message({
            host: 'mongodb+srv://cluster0.example.mongodb.net', sslEnabled: false
        }));
        expect(result.sslEnabled).toBe(true);
    });

    it('leaves SSL alone for a plain mongodb:// string, since a self-hosted replica set may not need it', () => {
        const result = expandPastedMongoUrl(message({
            host: 'mongodb://db.example.com:27017', sslEnabled: false
        }));
        expect(result.sslEnabled).toBe(false);
    });
});

describe('mongoHostAndPort', () => {
    it('splits a plain mongodb://host:port URL', () => {
        expect(mongoHostAndPort('mongodb://db.example.com:27017')).toEqual({ host: 'db.example.com', port: '27017' });
    });

    it('shows an SRV or multi-host string back whole, with an empty port', () => {
        expect(mongoHostAndPort('mongodb+srv://cluster0.example.mongodb.net')).toEqual({
            host: 'mongodb+srv://cluster0.example.mongodb.net',
            port: ''
        });
    });
});
