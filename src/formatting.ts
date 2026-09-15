import * as vscode from 'vscode';
import { format, SqlLanguage } from 'sql-formatter';
import { ConnectionStore } from './connectionStore';
import { QueryScope } from './queryScope';
import { EngineId, engineOf, speaksSql } from './client';

/** Engines sql-formatter has a dedicated dialect for; everything else (Trino included) falls back to its generic 'sql'. */
const DIALECT: Partial<Record<EngineId, SqlLanguage>> = {
    postgres: 'postgresql',
    supabase: 'postgresql',
    mysql: 'mysql',
    mariadb: 'mariadb',
    sqlite: 'sqlite',
    duckdb: 'duckdb',
    snowflake: 'snowflake',
    trino: 'trino'
};

function keywordCase(): 'preserve' | 'upper' | 'lower' {
    const value = vscode.workspace.getConfiguration('sqlExplorer').get<string>('format.keywordCase');
    return value === 'lower' || value === 'preserve' ? value : 'upper';
}

/** Exported for reuse by both the manual command and the formatting provider, so "Format Query" and "Format Document"/format-on-save never drift apart. */
export function formatSqlText(text: string, engine: EngineId, editorOptions: { tabSize: number; insertSpaces: boolean }): string {
    return format(text, {
        language: DIALECT[engine] ?? 'sql',
        tabWidth: editorOptions.tabSize,
        useTabs: !editorOptions.insertSpaces,
        keywordCase: keywordCase()
    });
}

function engineFor(document: vscode.TextDocument, store: ConnectionStore, scope: QueryScope): EngineId | undefined {
    const connection = scope.resolve(document).connection ?? store.get(store.activeId);
    return connection ? engineOf(connection) : undefined;
}

/** Backs "Format Document" (Shift+Alt+F) and `editor.formatOnSave`, once VS Code picks this as the SQL formatter. */
export class SqlFormattingProvider implements vscode.DocumentFormattingEditProvider {
    public constructor(private readonly store: ConnectionStore, private readonly scope: QueryScope) {}

    public provideDocumentFormattingEdits(document: vscode.TextDocument, options: vscode.FormattingOptions): vscode.TextEdit[] {
        const engine = engineFor(document, this.store, this.scope);
        // MongoDB queries are JS-shaped, not SQL — nothing here understands how to format them, so leave them untouched.
        if (engine && !speaksSql(engine)) { return []; }
        const text = document.getText();
        if (!text.trim()) { return []; }
        try {
            const formatted = formatSqlText(text, engine ?? 'trino', options);
            if (formatted === text) { return []; }
            const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
            return [vscode.TextEdit.replace(fullRange, formatted)];
        } catch {
            // Formatting a statement mid-edit (unbalanced parens, a dangling keyword) is
            // normal while typing — fail quietly rather than blocking Format Document/save.
            return [];
        }
    }
}

/** The "SQL: Format Query" command — formats the selection if there is one, otherwise the whole editor. */
export async function formatActiveQuery(store: ConnectionStore, scope: QueryScope): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
        vscode.window.showErrorMessage('Open a SQL query editor before formatting.');
        return;
    }
    const document = editor.document;
    const engine = engineFor(document, store, scope);
    if (engine && !speaksSql(engine)) {
        vscode.window.showErrorMessage('MongoDB queries are not SQL and cannot be formatted.');
        return;
    }
    const range = editor.selection.isEmpty
        ? new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length))
        : editor.selection;
    const text = document.getText(range);
    if (!text.trim()) { return; }
    try {
        const formatted = formatSqlText(text, engine ?? 'trino', { tabSize: Number(editor.options.tabSize) || 4, insertSpaces: editor.options.insertSpaces !== false });
        if (formatted === text) { return; }
        await editor.edit(builder => builder.replace(range, formatted));
    } catch (error) {
        vscode.window.showErrorMessage(`Could not format: ${error instanceof Error ? error.message : String(error)}`);
    }
}
