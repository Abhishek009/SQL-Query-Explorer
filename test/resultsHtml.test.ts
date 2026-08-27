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
