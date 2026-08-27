import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { sqlResultsHtml } from '../src/resultsHtml';
import type { ResultsState } from '../src/types';

function buildState(): ResultsState {
    return {
        connection: { id: '1', name: 'test', url: 'http://x', user: 'u' },
        result: { columns: ['id', 'name'], rows: [[1, 'Alice'], [2, 'Bob'], [3, null]], truncated: false, maxRows: 10_000 },
        limit: 100,
        sql: 'SELECT * FROM t',
        milliseconds: 12,
        executedAt: Date.now()
    };
}

/**
 * Renders the actual webview HTML/script into a real DOM and runs it, the way
 * VS Code's webview host would — a syntax check alone wouldn't catch a wrong
 * selector or event-handling bug in the click-to-copy/filter logic below.
 */
function renderInJsdom(state: ResultsState) {
    const webview = { cspSource: 'vscode-resource:' } as unknown as Parameters<typeof sqlResultsHtml>[0];
    const html = sqlResultsHtml(webview, state);
    let copied: string | undefined;
    const posted: unknown[] = [];
    const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        beforeParse(contentWindow) {
            const win = contentWindow as unknown as {
                acquireVsCodeApi: () => { postMessage: (message: unknown) => void };
                navigator: { clipboard: { writeText: (text: string) => Promise<void> } };
            };
            win.acquireVsCodeApi = () => ({ postMessage: message => { posted.push(message); } });
            win.navigator.clipboard = { writeText: text => { copied = text; return Promise.resolve(); } };
        }
    });
    return { window: dom.window, getCopied: () => copied, posted };
}

describe('results grid: click-to-copy', () => {
    it('copies a single cell on click and highlights it', () => {
        const { window, getCopied } = renderInJsdom(buildState());
        const cell = window.document.querySelector('td[data-r="0"][data-c="1"]') as unknown as HTMLElement; // "Alice"
        cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        expect(getCopied()).toBe('Alice');
        expect(cell.classList.contains('selected')).toBe(true);
        expect(cell.classList.contains('copied')).toBe(true);
    });

    it('copies a rectangular range as TSV on shift+click, from the previously clicked anchor', () => {
        const { window, getCopied } = renderInJsdom(buildState());
        const first = window.document.querySelector('td[data-r="0"][data-c="0"]') as unknown as HTMLElement; // 1
        const second = window.document.querySelector('td[data-r="1"][data-c="1"]') as unknown as HTMLElement; // Bob
        first.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        second.dispatchEvent(new window.MouseEvent('click', { bubbles: true, shiftKey: true }));
        expect(getCopied()).toBe('1\tAlice\n2\tBob');
    });

    it('renders a NULL cell as the literal text "NULL", and copies that literal text', () => {
        const { window, getCopied } = renderInJsdom(buildState());
        const cell = window.document.querySelector('td[data-r="2"][data-c="1"]') as unknown as HTMLElement; // null
        expect(cell.textContent).toBe('NULL');
        cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        expect(getCopied()).toBe('NULL');
    });

    it('a fresh plain click clears the previous selection rather than extending it', () => {
        const { window } = renderInJsdom(buildState());
        const first = window.document.querySelector('td[data-r="0"][data-c="0"]') as unknown as HTMLElement;
        const second = window.document.querySelector('td[data-r="1"][data-c="0"]') as unknown as HTMLElement;
        first.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        second.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); // no shiftKey
        expect(first.classList.contains('selected')).toBe(false);
        expect(second.classList.contains('selected')).toBe(true);
    });
});

describe('results grid: quick filter', () => {
    it('hides non-matching rows, updates the row count, and un-hides when cleared', () => {
        const { window } = renderInJsdom(buildState());
        const filterBox = window.document.getElementById('filter') as unknown as HTMLInputElement;
        filterBox.value = 'bob';
        filterBox.dispatchEvent(new window.Event('input', { bubbles: true }));

        const rows = window.document.querySelectorAll('tbody tr');
        expect((rows[0] as HTMLElement).style.display).toBe('none'); // Alice
        expect((rows[1] as HTMLElement).style.display).toBe(''); // Bob
        expect((rows[2] as HTMLElement).style.display).toBe('none'); // null row

        const rowcount = window.document.getElementById('rowcount')!;
        expect(rowcount.textContent).toBe('1 of 3 rows match');

        filterBox.value = '';
        filterBox.dispatchEvent(new window.Event('input', { bubbles: true }));
        expect((rows[0] as HTMLElement).style.display).toBe('');
        expect(rowcount.textContent).toBe('3 row(s)');
    });

    it('matches case-insensitively across any column', () => {
        const { window } = renderInJsdom(buildState());
        const filterBox = window.document.getElementById('filter') as unknown as HTMLInputElement;
        filterBox.value = 'ALICE';
        filterBox.dispatchEvent(new window.Event('input', { bubbles: true }));
        const rows = window.document.querySelectorAll('tbody tr');
        expect((rows[0] as HTMLElement).style.display).toBe('');
        expect((rows[1] as HTMLElement).style.display).toBe('none');
    });
});

describe('results grid: column visibility', () => {
    it('adds a hide rule for a column when its checkbox is unchecked', () => {
        const { window } = renderInJsdom(buildState());
        const checkbox = window.document.querySelector('#columns-panel input[data-col="1"]') as unknown as HTMLInputElement;
        checkbox.checked = false;
        checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
        const injected = [...window.document.querySelectorAll('style')].map(el => el.textContent).join('');
        expect(injected).toContain('th[data-col="1"]');
        expect(injected).toContain('td[data-c="1"]');
    });

    it('removes the hide rule again once re-checked', () => {
        const { window } = renderInJsdom(buildState());
        const checkbox = window.document.querySelector('#columns-panel input[data-col="1"]') as unknown as HTMLInputElement;
        checkbox.checked = false;
        checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
        checkbox.checked = true;
        checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
        const injected = [...window.document.querySelectorAll('style')].map(el => el.textContent).join('');
        expect(injected).not.toContain('data-col="1"');
    });

    it('lists one checkbox per column, all checked by default', () => {
        const { window } = renderInJsdom(buildState());
        const checkboxes = window.document.querySelectorAll('#columns-panel input[type="checkbox"]');
        expect(checkboxes.length).toBe(2); // id, name
        checkboxes.forEach(cb => expect((cb as unknown as HTMLInputElement).checked).toBe(true));
    });
});

describe('results grid: expand a cell', () => {
    it('shows the column name, row number, and raw value on double-click', () => {
        const { window } = renderInJsdom(buildState());
        const cell = window.document.querySelector('td[data-r="0"][data-c="1"]') as unknown as HTMLElement; // Alice
        cell.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
        expect((window.document.getElementById('expand-panel') as unknown as HTMLElement).hidden).toBe(false);
        expect(window.document.getElementById('expand-title')!.textContent).toBe('name · row 1');
        expect(window.document.getElementById('expand-body')!.textContent).toBe('Alice');
    });

    it('pretty-prints a JSON object cell instead of showing the compact form', () => {
        const state = buildState();
        state.result.columns = [...state.result.columns, 'meta'];
        state.result.rows = state.result.rows.map(row => [...row, { a: 1, b: [1, 2] }]);
        const { window } = renderInJsdom(state);
        const cell = window.document.querySelector('td[data-r="0"][data-c="2"]') as unknown as HTMLElement;
        cell.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
        expect(window.document.getElementById('expand-body')!.textContent).toBe(JSON.stringify({ a: 1, b: [1, 2] }, null, 2));
    });

    it('closes on Escape and via the close button', () => {
        const { window } = renderInJsdom(buildState());
        const cell = window.document.querySelector('td[data-r="0"][data-c="1"]') as unknown as HTMLElement;
        cell.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
        window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect((window.document.getElementById('expand-panel') as unknown as HTMLElement).hidden).toBe(true);

        cell.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
        (window.document.getElementById('expand-close') as unknown as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        expect((window.document.getElementById('expand-panel') as unknown as HTMLElement).hidden).toBe(true);
    });
});

describe('results grid: row selection and Copy as INSERT', () => {
    it('selects a row on click and enables the button', () => {
        const { window } = renderInJsdom(buildState());
        const rownum = window.document.querySelector('tbody tr[data-row="0"] th.rownum') as unknown as HTMLElement;
        rownum.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        expect((window.document.querySelector('tbody tr[data-row="0"]') as unknown as HTMLElement).classList.contains('row-selected')).toBe(true);
        expect((window.document.getElementById('copy-insert') as unknown as HTMLButtonElement).disabled).toBe(false);
    });

    it('the button starts disabled with nothing selected', () => {
        const { window } = renderInJsdom(buildState());
        expect((window.document.getElementById('copy-insert') as unknown as HTMLButtonElement).disabled).toBe(true);
    });

    it('extends the selection with shift+click and posts sorted row indices', () => {
        const { window, posted } = renderInJsdom(buildState());
        const row0 = window.document.querySelector('tbody tr[data-row="0"] th.rownum') as unknown as HTMLElement;
        const row2 = window.document.querySelector('tbody tr[data-row="2"] th.rownum') as unknown as HTMLElement;
        row0.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        row2.dispatchEvent(new window.MouseEvent('click', { bubbles: true, shiftKey: true }));
        (window.document.getElementById('copy-insert') as unknown as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        expect(posted).toEqual([{ type: 'copyInsert', rows: [0, 1, 2] }]);
    });

    it('ctrl/cmd+click toggles one row without clearing the rest', () => {
        const { window, posted } = renderInJsdom(buildState());
        const row0 = window.document.querySelector('tbody tr[data-row="0"] th.rownum') as unknown as HTMLElement;
        const row2 = window.document.querySelector('tbody tr[data-row="2"] th.rownum') as unknown as HTMLElement;
        row0.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        row2.dispatchEvent(new window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
        (window.document.getElementById('copy-insert') as unknown as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        expect(posted).toEqual([{ type: 'copyInsert', rows: [0, 2] }]);
    });

    it('labels the button for the connection\'s dialect', () => {
        const sqlState = buildState();
        expect(renderInJsdom(sqlState).window.document.getElementById('copy-insert')!.textContent).toBe('Copy as INSERT');

        const mongoState = buildState();
        mongoState.connection = { ...mongoState.connection, type: 'mongodb' };
        expect(renderInJsdom(mongoState).window.document.getElementById('copy-insert')!.textContent).toBe('Copy as insertMany()');
    });
});
