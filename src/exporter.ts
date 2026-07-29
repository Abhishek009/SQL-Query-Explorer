import * as vscode from 'vscode';
import { ResultsState } from './types';
import { visibleRows } from './sorting';

/** Writes the rows currently held in the view to a delimited file. */
export async function exportResult(state: ResultsState, format: 'csv' | 'tsv'): Promise<void> {
    const rows = visibleRows(state);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = await vscode.window.showSaveDialog({
        saveLabel: `Export ${format.toUpperCase()}`,
        defaultUri: vscode.Uri.file(`trino-results-${stamp}.${format}`),
        filters: format === 'csv' ? { 'CSV files': ['csv'] } : { 'TSV files': ['tsv'] }
    });
    if (!target) { return; }
    const text = toDelimitedText(state.result.columns, rows, format);
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    const open = await vscode.window.showInformationMessage(
        `Exported ${rows.length.toLocaleString()} row(s) to ${target.fsPath}.`, 'Open File'
    );
    if (open) { await vscode.window.showTextDocument(target); }
}

export function toDelimitedText(columns: string[], rows: unknown[][], format: 'csv' | 'tsv'): string {
    const delimiter = format === 'csv' ? ',' : '\t';
    const cell = (value: unknown): string => {
        if (value === null || value === undefined) { return ''; }
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        if (format === 'tsv') {
            // Tabs and newlines would break the row/column structure outright.
            return text.replace(/[\t\r\n]+/g, ' ');
        }
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [columns.map(cell).join(delimiter)];
    for (const row of rows) {
        lines.push(columns.map((_, index) => cell(row[index])).join(delimiter));
    }
    return `${lines.join('\r\n')}\r\n`;
}
