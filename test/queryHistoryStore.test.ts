import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { HistoryStore } from '../src/queryHistoryStore';

/** globalState backed by an in-memory map, the same shape as fakeSecrets() uses for Secret Storage. */
function fakeContext(): vscode.ExtensionContext {
    const store = new Map<string, unknown>();
    return {
        globalState: {
            get: (key: string) => store.get(key),
            update: async (key: string, value: unknown) => { store.set(key, value); }
        }
    } as unknown as vscode.ExtensionContext;
}

function entry(overrides: Partial<Parameters<HistoryStore['record']>[0]> = {}) {
    return {
        connectionId: 'c1', connectionName: 'Connection 1', sql: 'SELECT 1', executedAt: Date.now(), success: true,
        ...overrides
    };
}

describe('HistoryStore', () => {
    it('keeps the newest run first', async () => {
        const history = new HistoryStore(fakeContext());
        await history.record(entry({ sql: 'SELECT 1' }));
        await history.record(entry({ sql: 'SELECT 2' }));
        expect(history.all().map(item => item.sql)).toEqual(['SELECT 2', 'SELECT 1']);
    });

    it('ignores a blank statement — nothing useful to re-run or search for', async () => {
        const history = new HistoryStore(fakeContext());
        await history.record(entry({ sql: '   ' }));
        expect(history.all()).toHaveLength(0);
    });

    it('caps each connection separately, so a busy connection cannot crowd out a quiet one', async () => {
        const history = new HistoryStore(fakeContext());
        // The default cap (sqlExplorer.history.limit) is 500 when unset, as here.
        for (let i = 0; i < 501; i++) { await history.record(entry({ connectionId: 'busy', sql: `SELECT ${i}` })); }
        await history.record(entry({ connectionId: 'quiet', sql: 'SELECT 1' }));

        const all = history.all();
        expect(all.filter(item => item.connectionId === 'busy')).toHaveLength(500);
        expect(all.filter(item => item.connectionId === 'quiet')).toHaveLength(1);
        // Trimming drops the oldest, so the most recently run statements survive.
        expect(all.find(item => item.sql === 'SELECT 500')).toBeDefined();
        expect(all.find(item => item.sql === 'SELECT 0')).toBeUndefined();
    });

    it('remove() deletes one entry without touching the rest', async () => {
        const history = new HistoryStore(fakeContext());
        await history.record(entry({ sql: 'SELECT 1' }));
        await history.record(entry({ sql: 'SELECT 2' }));
        const [toRemove] = history.all();
        await history.remove(toRemove.id);
        expect(history.all().map(item => item.sql)).toEqual(['SELECT 1']);
    });

    it('clear(connectionId) only clears that connection', async () => {
        const history = new HistoryStore(fakeContext());
        await history.record(entry({ connectionId: 'a', sql: 'SELECT a' }));
        await history.record(entry({ connectionId: 'b', sql: 'SELECT b' }));
        await history.clear('a');
        expect(history.all().map(item => item.connectionId)).toEqual(['b']);
    });

    it('clear() with no connection wipes everything', async () => {
        const history = new HistoryStore(fakeContext());
        await history.record(entry({ connectionId: 'a' }));
        await history.record(entry({ connectionId: 'b' }));
        await history.clear();
        expect(history.all()).toHaveLength(0);
    });
});
