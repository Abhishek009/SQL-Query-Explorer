import { describe, expect, it } from 'vitest';
import { formatSqlText } from '../src/formatting';

const options = { tabSize: 2, insertSpaces: true };

describe('formatSqlText', () => {
    it('uppercases keywords and indents clauses by default', () => {
        const formatted = formatSqlText('select id, name from users where id = 1', 'postgres', options);
        expect(formatted).toBe('SELECT\n  id,\n  name\nFROM\n  users\nWHERE\n  id = 1');
    });

    it('uses each engine\'s own dialect — MySQL/MariaDB accept backtick-quoted identifiers Postgres would reject', () => {
        const mysql = formatSqlText('select `col` from `t`', 'mysql', options);
        expect(mysql).toContain('`col`');
    });

    it('falls back to generic SQL for an engine sql-formatter has no dedicated dialect for', () => {
        expect(() => formatSqlText('select 1', 'sqlite', options)).not.toThrow();
    });

    it('respects the tab size passed in for indentation', () => {
        const fourSpace = formatSqlText('select id from t', 'postgres', { tabSize: 4, insertSpaces: true });
        expect(fourSpace).toContain('\n    id');
    });
});
