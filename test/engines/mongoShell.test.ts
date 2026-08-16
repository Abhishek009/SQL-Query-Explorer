import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { evalShellArgs, parseShellCommand } from '../../src/engines/mongodb/mongoShell';

describe('parseShellCommand', () => {
    it('parses a bare find with no arguments', () => {
        expect(parseShellCommand('db.users.find()')).toEqual({
            collection: 'users',
            calls: [{ name: 'find', args: '' }]
        });
    });

    it('parses a find with a chained sort/limit', () => {
        expect(parseShellCommand("db.users.find({age:{$gt:21}}).sort({name:1}).limit(10)")).toEqual({
            collection: 'users',
            calls: [
                { name: 'find', args: '{age:{$gt:21}}' },
                { name: 'sort', args: '{name:1}' },
                { name: 'limit', args: '10' }
            ]
        });
    });

    it('does not split on a semicolon or parenthesis inside a quoted string argument', () => {
        const parsed = parseShellCommand(`db.users.find({name:"a;b(c)"})`);
        expect(parsed.calls[0].args).toBe('{name:"a;b(c)"}');
    });

    it('parses a db-level command with no collection', () => {
        expect(parseShellCommand('db.getCollectionNames()')).toEqual({
            calls: [{ name: 'getCollectionNames', args: '' }]
        });
    });

    it('parses db.getCollection("name") for a collection name that is not a valid identifier', () => {
        const parsed = parseShellCommand('db.getCollection("weird-name").find()');
        expect(parsed.collection).toBe('weird-name');
        expect(parsed.calls).toEqual([{ name: 'find', args: '' }]);
    });

    it('rejects text that does not start with db.', () => {
        expect(() => parseShellCommand('SELECT * FROM users')).toThrow(/db\./);
    });

    it('rejects unbalanced brackets', () => {
        expect(() => parseShellCommand('db.users.find({a:1)')).toThrow(/[Bb]racket/);
    });
});

describe('evalShellArgs', () => {
    it('returns an empty array for no arguments', () => {
        expect(evalShellArgs('')).toEqual([]);
    });

    it('evaluates a plain JSON-shaped filter', () => {
        expect(evalShellArgs('{"age":21}')).toEqual([{ age: 21 }]);
    });

    it('evaluates unquoted keys and single-quoted strings, shell-style', () => {
        expect(evalShellArgs("{name:'Alice',active:true}")).toEqual([{ name: 'Alice', active: true }]);
    });

    it('evaluates ObjectId(...) into a real ObjectId', () => {
        const id = '507f1f77bcf86cd799439011';
        const [result] = evalShellArgs(`{_id:ObjectId("${id}")}`) as [{ _id: ObjectId }];
        expect(result._id).toBeInstanceOf(ObjectId);
        expect(result._id.toHexString()).toBe(id);
    });

    it('evaluates ISODate(...) into a real Date', () => {
        const [result] = evalShellArgs('{createdAt:ISODate("2024-01-01T00:00:00.000Z")}') as [{ createdAt: Date }];
        expect(result.createdAt).toBeInstanceOf(Date);
        expect(result.createdAt.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    });

    it('evaluates multiple arguments, e.g. for updateOne(filter, update)', () => {
        expect(evalShellArgs('{_id:1},{$set:{name:"Bob"}}')).toEqual([{ _id: 1 }, { $set: { name: 'Bob' } }]);
    });

    it('cannot reach Node globals like process from inside the sandbox', () => {
        // Runs in a vm context with its own global object, containing only the
        // ObjectId/ISODate/... helpers — not the real process/Buffer/require.
        expect(() => evalShellArgs('process.exit(1)')).toThrow(/process is not defined/);
    });

    it('times out rather than hanging on an infinite loop', () => {
        expect(() => evalShellArgs('(function(){while(true){}})()')).toThrow();
    });
});
