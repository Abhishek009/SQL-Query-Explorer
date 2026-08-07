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
