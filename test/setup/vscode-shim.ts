/**
 * Stands in for the `vscode` module so PostgresClient/TrinoClient — which only
 * ever use `vscode` for types, cancellation tokens, and reading settings — can
 * run in a plain Node test process instead of the VS Code extension host.
 * Settings reads always fall through to the caller's fallback, since there is
 * no workbench configuration here.
 */
export const workspace = {
    getConfiguration() {
        return { get: () => undefined, inspect: () => undefined };
    }
};

export class CancellationTokenSource {
    private readonly listeners: Array<() => void> = [];
    public token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => {
            this.listeners.push(listener);
            return { dispose: () => undefined };
        }
    };
    public cancel(): void {
        this.token.isCancellationRequested = true;
        this.listeners.forEach(listener => listener());
    }
    public dispose(): void { /* no-op */ }
}

/**
 * Just enough of the tree-view API for explorer.ts to load — commands.ts
 * imports it, and pulling in commands.ts is the only way to unit-test its own
 * pure functions (connectionFromForm, validateConnection) outside the
 * extension host. Never asked to actually render or manage a tree, so nothing
 * here needs to behave like a real TreeItem beyond holding the properties
 * ExplorerItem sets on it.
 */
export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }

export class TreeItem {
    public collapsibleState?: TreeItemCollapsibleState;
    public contextValue?: string;
    public tooltip?: unknown;
    public description?: string;
    public iconPath?: unknown;
    public command?: unknown;
    public constructor(public label?: string, collapsibleState?: TreeItemCollapsibleState) {
        this.collapsibleState = collapsibleState;
    }
}

export class ThemeIcon {
    public constructor(public readonly id: string) {}
}

export class MarkdownString {
    public constructor(public value = '') {}
}

export class EventEmitter<T> {
    private readonly listeners: Array<(value: T) => void> = [];
    public event = (listener: (value: T) => void): { dispose: () => void } => {
        this.listeners.push(listener);
        return { dispose: () => undefined };
    };
    public fire(value: T): void { this.listeners.forEach(listener => listener(value)); }
    public dispose(): void { /* no-op */ }
}

export class Uri {
    private constructor(public readonly fsPath: string) {}
    public static file(fsPath: string): Uri { return new Uri(fsPath); }
    public static joinPath(base: Uri, ...segments: string[]): Uri { return new Uri([base.fsPath, ...segments].join('/')); }
}
