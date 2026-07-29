import * as vscode from 'vscode';
import { formatDuration } from './util';

export interface RunningQuery {
    id: number;
    connectionName: string;
    sql: string;
    startedAt: number;
    /** Trino's query id, known once the coordinator has accepted the statement. */
    queryId?: string;
    /** Resolves true when the coordinator confirmed it stopped the query. */
    cancel: () => Promise<boolean>;
}

/** Tracks statements that are still in flight so they can be shown and killed. */
export class RunningQueryRegistry {
    private readonly changed = new vscode.EventEmitter<void>();
    public readonly onDidChange = this.changed.event;
    private readonly queries = new Map<number, RunningQuery>();
    private nextId = 1;

    public add(query: Omit<RunningQuery, 'id'>): RunningQuery {
        const entry: RunningQuery = { ...query, id: this.nextId++ };
        this.queries.set(entry.id, entry);
        this.changed.fire();
        return entry;
    }

    public remove(id: number): void {
        if (this.queries.delete(id)) { this.changed.fire(); }
    }

    /** The coordinator's query id arrives with the first page, after registration. */
    public setQueryId(id: number, queryId: string | undefined): void {
        const entry = this.queries.get(id);
        if (entry && queryId && entry.queryId !== queryId) {
            entry.queryId = queryId;
            this.changed.fire();
        }
    }

    public all(): RunningQuery[] {
        return [...this.queries.values()];
    }

    public dispose(): void { this.changed.dispose(); }
}

/** Shows a spinning status bar entry while queries run; clicking it offers to cancel. */
export class RunningQueryStatus implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private timer: NodeJS.Timeout | undefined;
    private readonly subscription: vscode.Disposable;

    public constructor(private readonly registry: RunningQueryRegistry) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
        this.item.command = 'trino.cancelQuery';
        this.subscription = registry.onDidChange(() => this.render());
        this.render();
    }

    private render(): void {
        const running = this.registry.all();
        if (!running.length) {
            this.item.hide();
            if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
            return;
        }
        // Tick so the elapsed time keeps counting up while the query runs.
        if (!this.timer) { this.timer = setInterval(() => this.render(), 1_000); }

        const oldest = running.reduce((a, b) => a.startedAt <= b.startedAt ? a : b);
        const elapsed = formatDuration(Date.now() - oldest.startedAt);
        this.item.text = running.length === 1
            ? `$(sync~spin) Trino ${elapsed}`
            : `$(sync~spin) Trino ${running.length} queries ${elapsed}`;
        this.item.tooltip = new vscode.MarkdownString(
            [`**Running ${running.length === 1 ? 'query' : 'queries'}** — click to cancel\n`,
             ...running.map(query => {
                 const age = formatDuration(Date.now() - query.startedAt);
                 return `- \`${query.connectionName}\` · ${age}${query.queryId ? ` · ${query.queryId}` : ''}\n\n  ${firstLine(query.sql)}`;
             })].join('\n')
        );
        this.item.show();
    }

    public dispose(): void {
        if (this.timer) { clearInterval(this.timer); }
        this.subscription.dispose();
        this.item.dispose();
    }
}

export function firstLine(sql: string): string {
    const line = sql.split('\n').map(part => part.trim()).find(part => part && !part.startsWith('--')) ?? sql.trim();
    return line.length > 70 ? `${line.slice(0, 70)}…` : line;
}

/** Asks which query to stop when several are in flight, then cancels it. */
export async function cancelRunningQuery(registry: RunningQueryRegistry): Promise<void> {
    const running = registry.all();
    if (!running.length) {
        vscode.window.showInformationMessage('No Trino queries are running.');
        return;
    }
    const chosen = running.length === 1 ? running[0] : await pickQuery(running);
    if (!chosen) { return; }
    const stopped = await chosen.cancel();
    if (stopped) {
        vscode.window.showInformationMessage(`Cancelled the query on "${chosen.connectionName}".`);
    } else {
        // Be honest: we stopped reading, but the cluster may still be working.
        vscode.window.showWarningMessage(
            `Stopped waiting for the query on "${chosen.connectionName}", but the coordinator did not confirm it was cancelled` +
            `${chosen.queryId ? ` (query ${chosen.queryId})` : ''}. It may still be running on the cluster.`
        );
    }
}

async function pickQuery(running: RunningQuery[]): Promise<RunningQuery | undefined> {
    const picked = await vscode.window.showQuickPick(
        running.map(query => ({
            label: `$(stop-circle) ${firstLine(query.sql)}`,
            description: `${query.connectionName} · ${formatDuration(Date.now() - query.startedAt)}`,
            detail: query.queryId,
            id: query.id
        })),
        { placeHolder: 'Select the query to cancel' }
    );
    return running.find(query => query.id === picked?.id);
}
