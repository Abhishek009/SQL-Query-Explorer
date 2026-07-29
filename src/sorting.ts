import { ResultsState } from './types';

/** Rows in display order: sorted when a column is selected, then capped. */
export function visibleRows(state: ResultsState): unknown[][] {
    if (!state.sort) { return state.result.rows.slice(0, state.limit); }
    // Re-sorting on every repaint (info toggle, limit change) would be wasted work.
    const key = `${state.sort.column}:${state.sort.direction}:${state.result.rows.length}`;
    if (state.sortedKey !== key || !state.sortedRows) {
        state.sortedRows = sortRows(state.result.rows, state.sort);
        state.sortedKey = key;
    }
    return state.sortedRows.slice(0, state.limit);
}

/**
 * Sorts by precomputing one key per row and ordering an index array, so each
 * value is converted once instead of once per comparison. Comparing indices
 * also avoids copying the row arrays around during the sort.
 */
export function sortRows(rows: unknown[][], sort: { column: number; direction: 'asc' | 'desc' }): unknown[][] {
    const { column } = sort;
    const factor = sort.direction === 'asc' ? 1 : -1;
    const count = rows.length;
    const empty = new Uint8Array(count);
    const numbers = new Float64Array(count);
    let numeric = true;

    for (let index = 0; index < count; index++) {
        const value = rows[index][column];
        if (value === null || value === undefined || value === '') { empty[index] = 1; continue; }
        const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
        if (Number.isNaN(parsed)) { numeric = false; break; }
        numbers[index] = parsed;
    }

    const order = new Array<number>(count);
    for (let index = 0; index < count; index++) { order[index] = index; }
    // Nulls sort last in both directions so they never hide the real data.
    const emptiness = (a: number, b: number) => empty[a] && empty[b] ? 0 : empty[a] ? 1 : -1;

    if (numeric) {
        order.sort((a, b) => (empty[a] || empty[b]) ? emptiness(a, b) : (numbers[a] - numbers[b]) * factor);
    } else {
        // Plain comparison on a lowercased copy is far cheaper than a collator.
        // Emptiness is recomputed here: the numeric scan above stops early.
        const keys = new Array<string>(count);
        for (let index = 0; index < count; index++) {
            const value = rows[index][column];
            const isEmpty = value === null || value === undefined || value === '';
            empty[index] = isEmpty ? 1 : 0;
            keys[index] = isEmpty ? '' : (typeof value === 'string' ? value : String(value)).toLowerCase();
        }
        order.sort((a, b) => {
            if (empty[a] || empty[b]) { return emptiness(a, b); }
            const left = keys[a];
            const right = keys[b];
            return left < right ? -factor : left > right ? factor : 0;
        });
    }

    const sorted = new Array<unknown[]>(count);
    for (let index = 0; index < count; index++) { sorted[index] = rows[order[index]]; }
    return sorted;
}
