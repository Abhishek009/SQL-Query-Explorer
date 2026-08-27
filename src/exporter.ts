import * as vscode from 'vscode';
import { ResultsState } from './types';
import { visibleRows } from './sorting';
import { quoteLiteral } from './util';
import { parseShellCommand } from './engines/mongodb/mongoShell';

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

/**
 * A best-effort table name for a generated INSERT/insertMany, read straight
 * off the query's own FROM clause (SQL) or the collection the Mongo shell
 * command targets — copied verbatim, quoted or not, rather than re-quoted,
 * since it is already valid syntax the statement that produced these rows was
 * built from. Reuses the real shell parser for Mongo rather than a naive
 * regex, since a db-level command like db.getCollectionNames() has no
 * collection at all — a regex alone can't tell that apart from db.people.find().
 */
export function guessTableName(sql: string, isSql: boolean): string | undefined {
    if (!isSql) {
        try { return parseShellCommand(sql).collection; } catch { return undefined; }
    }
    return /\bfrom\s+([`"[\]\w.]+)/i.exec(sql)?.[1];
}

/** A row value as a SQL literal — numbers/booleans/NULL bare, everything else quoted. */
function sqlLiteral(value: unknown): string {
    if (value === null || value === undefined) { return 'NULL'; }
    if (typeof value === 'number') { return Number.isFinite(value) ? String(value) : 'NULL'; }
    if (typeof value === 'boolean') { return value ? 'TRUE' : 'FALSE'; }
    if (value instanceof Date) { return quoteLiteral(value.toISOString()); }
    if (typeof value === 'object') { return quoteLiteral(JSON.stringify(value)); }
    return quoteLiteral(String(value));
}

/** One multi-row INSERT, with columns quoted the way the source engine requires. */
export function buildInsertStatement(table: string, columns: string[], rows: unknown[][], quoteIdentifier: (name: string) => string): string {
    const columnList = columns.map(quoteIdentifier).join(', ');
    const tuples = rows.map(row => `(${row.map(sqlLiteral).join(', ')})`).join(',\n  ');
    return `INSERT INTO ${table} (${columnList}) VALUES\n  ${tuples};`;
}

/** A row value as a Mongo shell literal — reuses ISODate(...) for a Date, same as the shell parser accepts back. */
function mongoLiteral(value: unknown): string {
    if (value === null || value === undefined) { return 'null'; }
    if (typeof value === 'number' || typeof value === 'boolean') { return String(value); }
    if (value instanceof Date) { return `ISODate("${value.toISOString()}")`; }
    if (typeof value === 'object') { return JSON.stringify(value); }
    return JSON.stringify(String(value));
}

/** One db.<collection>.insertMany([...]) call, mirroring buildInsertStatement for MongoDB. */
export function buildInsertMany(table: string, columns: string[], rows: unknown[][]): string {
    const docs = rows
        .map(row => `  { ${columns.map((name, index) => `${JSON.stringify(name)}: ${mongoLiteral(row[index])}`).join(', ')} }`)
        .join(',\n');
    return `db.${table}.insertMany([\n${docs}\n]);`;
}
