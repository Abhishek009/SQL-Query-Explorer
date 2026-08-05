import * as vscode from 'vscode';
import { ErrorState, ResultsState, TrinoRequestError } from './types';
import { emptyResultsHtml, queryErrorHtml, sqlResultsHtml } from './resultsHtml';
import { exportResult } from './exporter';
import { clampRowLimit } from './util';

/**
 * Everything a results grid does — sorting, the row limit, export — independent
 * of whether it is drawn in the bottom panel or in an editor tab. Subclasses
 * only supply the webview and how to bring it into view.
 */
export abstract class ResultsSurface {
    protected results: ResultsState | undefined;
    protected failure: ErrorState | undefined;

    protected abstract webview(): vscode.Webview | undefined;
    protected abstract reveal(): Promise<void>;

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

    protected paint(): void {
        const webview = this.webview();
        if (!webview) { return; }
        webview.html = this.failure
            ? queryErrorHtml(webview, this.failure)
            : this.results
                ? sqlResultsHtml(webview, this.results)
                : emptyResultsHtml(webview);
    }

    protected async handle(message: unknown): Promise<void> {
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
                    { location: vscode.ProgressLocation.Notification, title: `Loading ${limit.toLocaleString()} rows…`, cancellable: true },
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

/**
 * The column a new results tab should open in. Splitting the window again when
 * a second group already exists (a chat panel, another editor) is rarely what
 * anyone wants, so reuse that group and become another tab in it.
 */
function adjacentGroupColumn(): vscode.ViewColumn {
    const groups = vscode.window.tabGroups?.all ?? [];
    // Anchor on the query editor rather than the focused group: results must not
    // land on top of the SQL file, even when the chat panel has focus.
    const queryColumn = vscode.window.activeTextEditor?.viewColumn
        ?? vscode.window.tabGroups?.activeTabGroup?.viewColumn;
    const other = groups.find(group => group.viewColumn !== undefined && group.viewColumn !== queryColumn);
    return other?.viewColumn ?? vscode.ViewColumn.Beside;
}

/** A results grid in its own editor tab. */
export class ResultsTabPanel extends ResultsSurface {
    private panel: vscode.WebviewPanel | undefined;
    private title = 'Trino Results';
    private column: vscode.ViewColumn | undefined;

    protected webview(): vscode.Webview | undefined { return this.panel?.webview; }

    /** Where the tab lives now, so sibling results can join the same group. */
    public get viewColumn(): vscode.ViewColumn | undefined { return this.panel?.viewColumn; }

    public preferColumn(column: vscode.ViewColumn | undefined): void { this.column = column; }

    /** Names the tab after the query, so several results stay tellable apart. */
    public retitle(title: string): void {
        this.title = title;
        if (this.panel) { this.panel.title = title; }
    }

    protected async reveal(): Promise<void> {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'trinoResults',
                this.title,
                // Keep the caret in the editor so its timing CodeLens redraws at once.
                { viewColumn: this.column ?? adjacentGroupColumn(), preserveFocus: true },
                { enableScripts: true, retainContextWhenHidden: true }
            );
            this.panel.webview.onDidReceiveMessage((message: unknown) => void this.handle(message));
            this.panel.onDidDispose(() => { this.panel = undefined; });
        } else {
            this.panel.reveal(undefined, true);
        }
    }

    public dispose(): void { this.panel?.dispose(); }
}

/**
 * Owns the results tabs. Ordinary runs reuse one tab so results do not pile up;
 * "Side" mints a separate tab that later runs will not overwrite.
 */
export class ResultsTabs implements vscode.Disposable {
    private shared: ResultsTabPanel | undefined;
    private readonly extras: ResultsTabPanel[] = [];

    /** The reusable tab, recreated if the user closed it. */
    public primary(title: string): ResultsTabPanel {
        if (!this.shared) { this.shared = new ResultsTabPanel(); }
        this.shared.retitle(title);
        this.shared.preferColumn(this.resultsColumn());
        return this.shared;
    }

    public additional(title: string): ResultsTabPanel {
        const panel = new ResultsTabPanel();
        panel.retitle(title);
        // Open beside the results already on screen, not in a fresh split.
        panel.preferColumn(this.resultsColumn());
        this.extras.push(panel);
        return panel;
    }

    /** The group results already occupy, wherever the user moved it to. */
    private resultsColumn(): vscode.ViewColumn | undefined {
        return this.shared?.viewColumn ?? this.extras.map(panel => panel.viewColumn).find(Boolean);
    }

    public dispose(): void {
        this.shared?.dispose();
        for (const panel of this.extras) { panel.dispose(); }
    }
}
