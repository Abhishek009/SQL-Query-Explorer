import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SavedQueryStore reads/writes `vscode.workspace.getConfiguration('sqlExplorer')`
 * directly (like ConnectionStore), rather than taking an injectable config
 * object — so unlike `fakeSecrets()`, exercising it needs the `vscode` module
 * itself replaced with a small in-memory one, not just a fake passed in.
 */
// Vitest hoists `vi.mock` above ordinary statements, so the map it closes
// over has to come from `vi.hoisted` — a plain `const` here would be read
// before its own initializer runs.
const mockConfigStore = vi.hoisted(() => new Map<string, unknown>());

vi.mock('vscode', () => {
    class EventEmitter<T> {
        private readonly listeners: Array<(value: T) => void> = [];
        public event = (listener: (value: T) => void) => { this.listeners.push(listener); return { dispose: () => undefined }; };
        public fire(value: T): void { this.listeners.forEach(listener => listener(value)); }
    }
    return {
        EventEmitter,
        ConfigurationTarget: { Global: 1 },
        workspace: {
            getConfiguration: (section: string) => ({
                get: (key: string) => mockConfigStore.get(`${section}.${key}`),
                update: async (key: string, value: unknown) => { mockConfigStore.set(`${section}.${key}`, value); }
            })
        }
    };
});

const { SavedQueryStore } = await import('../src/savedQueryStore');

beforeEach(() => { mockConfigStore.clear(); });

describe('SavedQueryStore folders', () => {
    it('lists every ancestor of a nested folder, not just the leaf', async () => {
        const store = new SavedQueryStore();
        await store.create('Q1', 'SELECT 1', 'Reports/Weekly');
        expect(store.folders()).toEqual(['Reports', 'Reports/Weekly']);
    });

    it('renaming a folder moves every query and subfolder nested under it', async () => {
        const store = new SavedQueryStore();
        const q1 = await store.create('Q1', 'SELECT 1', 'Reports/Weekly');
        const q2 = await store.create('Q2', 'SELECT 2', 'Reports/Weekly/Detail');
        await store.addFolder('Reports/Weekly/Empty');

        await store.renameFolder('Reports/Weekly', 'Archive/Weekly');

        expect(store.get(q1.id)?.folder).toBe('Archive/Weekly');
        expect(store.get(q2.id)?.folder).toBe('Archive/Weekly/Detail');
        expect(store.folders()).toEqual(expect.arrayContaining(['Archive', 'Archive/Weekly', 'Archive/Weekly/Detail', 'Archive/Weekly/Empty']));
        expect(store.folders()).not.toEqual(expect.arrayContaining(['Reports', 'Reports/Weekly']));
    });

    // Regression guard: a naive `folder.startsWith(ancestor)` check (instead of
    // requiring the "/" boundary) would wrongly sweep "ReportsArchive" into a
    // rename/delete of "Reports".
    it('does not touch a sibling folder that merely shares a name prefix', async () => {
        const store = new SavedQueryStore();
        const inFolder = await store.create('In', 'SELECT 1', 'Reports');
        const inLookalike = await store.create('Similar', 'SELECT 2', 'ReportsArchive');

        await store.renameFolder('Reports', 'Old');

        expect(store.get(inFolder.id)?.folder).toBe('Old');
        expect(store.get(inLookalike.id)?.folder).toBe('ReportsArchive');
    });

    it('deleting a folder removes every query nested under it, leaving siblings alone', async () => {
        const store = new SavedQueryStore();
        const doomed = await store.create('Doomed', 'SELECT 1', 'Trash/Sub');
        const safe = await store.create('Safe', 'SELECT 2', 'Keep');

        await store.removeFolder('Trash');

        expect(store.get(doomed.id)).toBeUndefined();
        expect(store.get(safe.id)?.name).toBe('Safe');
        expect(store.folders()).not.toEqual(expect.arrayContaining(['Trash', 'Trash/Sub']));
    });

    it('update() bumps updatedAt without disturbing createdAt', async () => {
        const store = new SavedQueryStore();
        const query = await store.create('Q1', 'SELECT 1');
        await new Promise(resolve => setTimeout(resolve, 2));
        await store.update(query.id, { sql: 'SELECT 2' });
        const updated = store.get(query.id);
        expect(updated?.sql).toBe('SELECT 2');
        expect(updated?.createdAt).toBe(query.createdAt);
        expect(updated!.updatedAt).toBeGreaterThan(query.updatedAt);
    });
});
