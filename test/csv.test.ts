import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/csv';

describe('parseCsv', () => {
    it('splits a simple comma-separated file', () => {
        expect(parseCsv('id,name\n1,Alice\n2,Bob\n')).toEqual([
            ['id', 'name'], ['1', 'Alice'], ['2', 'Bob']
        ]);
    });

    it('handles a quoted field containing a comma', () => {
        expect(parseCsv('id,name\n1,"Doe, Jane"\n')).toEqual([
            ['id', 'name'], ['1', 'Doe, Jane']
        ]);
    });

    it('unescapes doubled quotes inside a quoted field', () => {
        expect(parseCsv('id,quote\n1,"She said ""hi"""\n')).toEqual([
            ['id', 'quote'], ['1', 'She said "hi"']
        ]);
    });

    it('handles an embedded newline inside a quoted field', () => {
        expect(parseCsv('id,note\n1,"line one\nline two"\n')).toEqual([
            ['id', 'note'], ['1', 'line one\nline two']
        ]);
    });

    it('handles CRLF line endings', () => {
        expect(parseCsv('id,name\r\n1,Alice\r\n')).toEqual([
            ['id', 'name'], ['1', 'Alice']
        ]);
    });

    it('handles a file with no trailing newline', () => {
        expect(parseCsv('id,name\n1,Alice')).toEqual([
            ['id', 'name'], ['1', 'Alice']
        ]);
    });

    it('handles empty fields', () => {
        expect(parseCsv('a,b,c\n1,,3\n')).toEqual([
            ['a', 'b', 'c'], ['1', '', '3']
        ]);
    });
});
