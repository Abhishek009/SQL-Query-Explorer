import * as vscode from 'vscode';
import { TrinoQueryResult } from './types';

export function firstColumn(result: TrinoQueryResult): string[] {
    return result.rows
        .map((row) => String(row[0] ?? ''))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
}

/** Proxies answer with HTML error pages; show their text instead of the markup. */
export function summarize(body: string): string {
    const text = /<html/i.test(body)
        ? (/<title>([^<]+)<\/title>/i.exec(body)?.[1] ?? body.replace(/<[^>]*>/g, ' '))
        : body;
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
}

export function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

export function clampRowLimit(value: number): number {
    return Math.min(Math.max(Math.trunc(value) || 1, 1), 10_000);
}

export function formatDuration(milliseconds: number): string {
    if (milliseconds < 1_000) { return `${Math.round(milliseconds)}ms`; }
    if (milliseconds < 60_000) { return `${(milliseconds / 1_000).toFixed(2)}s`; }
    const minutes = Math.floor(milliseconds / 60_000);
    return `${minutes}m ${Math.round((milliseconds % 60_000) / 1_000)}s`;
}

export function previewRowLimit(): number {
    const configured = vscode.workspace.getConfiguration('trino').get<number>('preview.rowLimit') ?? 100;
    return Math.min(Math.max(Math.trunc(configured) || 100, 1), 10_000);
}

export function showConnectionError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not load Trino catalogs: ${message}`, 'Edit Connection')
        .then(selection => { if (selection) { void vscode.commands.executeCommand('trino.editConnection'); } });
}
