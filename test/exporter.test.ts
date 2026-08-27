import { describe, expect, it } from 'vitest';
import { buildInsertMany, buildInsertStatement, guessTableName, toDelimitedText } from '../src/exporter';

describe('guessTableName', () => {
    it('reads a bare table name off a plain SELECT', () => {
        expect(guessTableName('SELECT * FROM customers', true)).toBe('customers');
    });

    it('reads a quoted, dotted table reference verbatim, without re-quoting it', () => {
        expect(guessTableName('SELECT * FROM `catalog`.`table` LIMIT 50', true)).toBe('`catalog`.`table`');
        expect(guessTableName('SELECT * FROM "schema"."table" LIMIT 50', true)).toBe('"schema"."table"');
    });

    it('takes the first table in a join as its best-effort guess', () => {
        expect(guessTableName('SELECT a.x FROM orders o JOIN customers c ON o.id = c.id', true)).toBe('orders');
    });

    it('matches case-insensitively', () => {
        expect(guessTableName('select * from Widgets', true)).toBe('Widgets');
    });

    it('returns undefined when there is no FROM clause to read', () => {
        expect(guessTableName('SHOW TABLES', true)).toBeUndefined();
    });

    it('reads the collection name out of a Mongo shell command', () => {
        expect(guessTableName('db.people.find({}).limit(50)', false)).toBe('people');
    });

    it('returns undefined for a Mongo db-level command with no collection', () => {
        expect(guessTableName('db.getCollectionNames()', false)).toBeUndefined();
    });
});

describe('buildInsertStatement', () => {
    const quote = (name: string) => `\`${name}\``;

    it('quotes columns with the given identifier quoter and builds one multi-row INSERT', () => {
        const sql = buildInsertStatement('`t`', ['id', 'name'], [[1, 'Alice'], [2, 'Bob']], quote);
        expect(sql).toBe('INSERT INTO `t` (`id`, `name`) VALUES\n  (1, \'Alice\'),\n  (2, \'Bob\');');
    });

    it('renders NULL, numbers, and booleans unquoted', () => {
        const sql = buildInsertStatement('t', ['a', 'b', 'c'], [[null, 42, true]], quote);
        expect(sql).toContain('(NULL, 42, TRUE)');
    });

    it('escapes an embedded single quote by doubling it', () => {
        const sql = buildInsertStatement('t', ['name'], [["O'Brien"]], quote);
        expect(sql).toContain("'O''Brien'");
    });

    it('formats a Date as a quoted ISO string', () => {
        const date = new Date('2024-01-01T00:00:00.000Z');
        const sql = buildInsertStatement('t', ['created'], [[date]], quote);
        expect(sql).toContain("'2024-01-01T00:00:00.000Z'");
    });

    it('JSON-stringifies and quotes a plain object or array value', () => {
        const sql = buildInsertStatement('t', ['meta'], [[{ a: 1 }]], quote);
        expect(sql).toContain('\'{"a":1}\'');
    });

    it('treats a non-finite number as NULL rather than emitting invalid SQL', () => {
        const sql = buildInsertStatement('t', ['n'], [[NaN]], quote);
        expect(sql).toContain('(NULL)');
    });
});

describe('buildInsertMany', () => {
    it('builds a db.<collection>.insertMany([...]) call with JS-literal documents', () => {
        const js = buildInsertMany('people', ['name', 'age'], [['Alice', 30], ['Bob', 25]]);
        expect(js).toBe('db.people.insertMany([\n  { "name": "Alice", "age": 30 },\n  { "name": "Bob", "age": 25 }\n]);');
    });

    it('renders null, numbers, and booleans as JS literals', () => {
        const js = buildInsertMany('t', ['a', 'b', 'c'], [[null, 1, false]]);
        expect(js).toContain('{ "a": null, "b": 1, "c": false }');
    });

    it('formats a Date as ISODate(...)', () => {
        const date = new Date('2024-01-01T00:00:00.000Z');
        const js = buildInsertMany('t', ['created'], [[date]]);
        expect(js).toContain('ISODate("2024-01-01T00:00:00.000Z")');
    });

    it('JSON-stringifies a nested object or array value as-is', () => {
        const js = buildInsertMany('t', ['tags'], [[['x', 'y']]]);
        expect(js).toContain('"tags": ["x","y"]');
    });
});

describe('toDelimitedText (existing CSV/TSV export, unaffected by the new builders)', () => {
    it('still exports plain CSV correctly', () => {
        expect(toDelimitedText(['id', 'name'], [[1, 'Alice']], 'csv')).toBe('id,name\r\n1,Alice\r\n');
    });
});
