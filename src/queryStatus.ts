import * as vscode from 'vscode';
import { formatDuration } from './util';

export interface QueryOutcome {
    line: number;
    milliseconds: number;
    rows: number;
    error?: string;
}

/**
 * Reports the last run's timing above the statement it belongs to. A CodeLens is
 * the only supported way to draw a line of text above editor content.
 */
export class QueryStatusProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this.changed.event;
    private readonly outcomes = new Map<string, QueryOutcome>();
    private readonly successGutter: vscode.TextEditorDecorationType;
    private readonly errorGutter: vscode.TextEditorDecorationType;

    public constructor(context: vscode.ExtensionContext) {
        const gutter = (file: string, overviewColor: string) => vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.file(context.asAbsolutePath(`resources/${file}`)),
            gutterIconSize: 'contain',
            overviewRulerColor: overviewColor,
            overviewRulerLane: vscode.OverviewRulerLane.Left
        });
        this.successGutter = gutter('query-success.svg', '#2ea043');
        this.errorGutter = gutter('query-error.svg', '#f14c4c');
    }

    public record(uri: vscode.Uri, outcome: QueryOutcome): void {
        this.outcomes.set(uri.toString(), outcome);
        this.changed.fire();
        this.decorate();
        // Opening the results panel can leave the editor inactive, which defers the
        // redraw; a second notification once that settles keeps the lens immediate.
        setTimeout(() => { this.changed.fire(); this.decorate(); }, 0);
    }

    public forget(uri: vscode.Uri): void {
        if (this.outcomes.delete(uri.toString())) { this.changed.fire(); this.decorate(); }
    }

    /** Puts the tick or cross in the gutter of every editor showing the statement. */
    public decorate(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            const outcome = this.outcomes.get(editor.document.uri.toString());
            const ranges = outcome
                ? [new vscode.Range(this.anchor(outcome, editor.document), 0, this.anchor(outcome, editor.document), 0)]
                : [];
            editor.setDecorations(this.successGutter, outcome && !outcome.error ? ranges : []);
            editor.setDecorations(this.errorGutter, outcome?.error ? ranges : []);
        }
    }

    public dispose(): void {
        this.successGutter.dispose();
        this.errorGutter.dispose();
    }

    private anchor(outcome: QueryOutcome, document: vscode.TextDocument): number {
        return Math.min(outcome.line, Math.max(document.lineCount - 1, 0));
    }

    public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const outcome = this.outcomes.get(document.uri.toString());
        if (!outcome) { return []; }
        const line = this.anchor(outcome, document);
        const elapsed = formatDuration(outcome.milliseconds);
        const title = outcome.error
            ? `$(error) Failed in ${elapsed} — ${outcome.error}`
            : `$(check) ${elapsed} · ${outcome.rows.toLocaleString()} row(s)`;
        return [new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title, command: '' })];
    }
}
