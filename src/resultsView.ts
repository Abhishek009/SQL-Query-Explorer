import * as vscode from 'vscode';
import { ErrorState, ResultsState, TrinoRequestError } from './types';
import { emptyResultsHtml, queryErrorHtml, sqlResultsHtml } from './resultsHtml';
import { exportResult } from './exporter';
import { clampRowLimit } from './util';

export class ResultsViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'trinoResultsView';
    private view: vscode.WebviewView | undefined;
    private results: ResultsState | undefined;
    private failure: ErrorState | undefined;

    public resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.onDidReceiveMessage((message: unknown) => void this.handle(message));
        this.paint();
        view.onDidDispose(() => { this.view = undefined; });
    }

    public async showResults(state: ResultsState): Promise<void> {
        this.results = state;
        this.failure = undefined;
        await this.reveal();
        this.paint();
    }

    public async showError(state: ErrorState): Promise<void> {
        this.failure = state;
        this.results = undefined;
        await this.reveal();
        this.paint();
    }

    private async reveal(): Promise<void> {
        if (!this.view) {
            // Focusing the view forces VS Code to construct it, which resolves it above.
            await vscode.commands.executeCommand(`${ResultsViewProvider.viewId}.focus`, { preserveFocus: true });
        }
        this.view?.show(true);
    }

    private paint(): void {
        if (!this.view) { return; }
        const webview = this.view.webview;
        this.view.webview.html = this.failure
            ? queryErrorHtml(webview, this.failure)
            : this.results
                ? sqlResultsHtml(webview, this.results)
                : emptyResultsHtml(webview);
    }

    private async handle(message: unknown): Promise<void> {
        const request = message as { type?: string; value?: number; format?: string };
        if (!this.results || !request?.type) { return; }
        if (request.type === 'limit') {
            await this.applyLimit(Number(request.value));
        } else if (request.type === 'sort') {
            this.applySort(Number(request.value));
        } else if (request.type === 'download') {
            await exportResult(this.results, request.format === 'tsv' ? 'tsv' : 'csv');
        }
    }

    /** Cycles a column through ascending, descending, then unsorted. */
    private applySort(column: number): void {
        const state = this.results;
        if (!state || !Number.isInteger(column) || column < 0 || column >= state.result.columns.length) { return; }
        const current = state.sort;
        state.sort = current?.column !== column ? { column, direction: 'asc' }
            : current.direction === 'asc' ? { column, direction: 'desc' }
            : undefined;
        this.paint();
    }

    /** Raising the cap re-queries when the statement supports it; otherwise it just shows more of what was fetched. */
    private async applyLimit(requested: number): Promise<void> {
        if (!this.results || !Number.isFinite(requested)) { return; }
        const limit = clampRowLimit(requested);
        const state = this.results;
        if (state.refetch && limit > state.result.rows.length) {
            try {
                const started = Date.now();
                state.result = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Window, title: `Loading ${limit.toLocaleString()} rows…`, cancellable: true },
                    (_, token) => state.refetch!(limit, token)
                );
                state.milliseconds = Date.now() - started;
                state.executedAt = Date.now();
                state.sortedKey = undefined;
                state.sql = state.sql.replace(/LIMIT \d+$/, `LIMIT ${limit}`);
            } catch (error) {
                await this.showError({
                    connection: state.connection,
                    sql: '',
                    message: error instanceof Error ? error.message : String(error),
                    details: error instanceof TrinoRequestError ? error.details : undefined
                });
                return;
            }
        }
        state.limit = limit;
        this.paint();
    }
}
