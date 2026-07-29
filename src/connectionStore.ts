import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { StoredConnection } from './types';

export const LEGACY_PASSWORD_KEY = 'trino.connection.password';

export const ACTIVE_CONNECTION_KEY = 'trino.activeConnection';

export function passwordKey(id: string): string { return `trino.connection.password.${id}`; }

/**
 * Saved connections live in the `trino.connections` setting; each password is
 * kept in Secret Storage under a key derived from the connection id.
 */
export class ConnectionStore {
    private readonly changed = new vscode.EventEmitter<void>();
    public readonly onDidChange = this.changed.event;

    public constructor(private readonly context: vscode.ExtensionContext) {}

    public all(): StoredConnection[] {
        const stored = vscode.workspace.getConfiguration('trino').get<StoredConnection[]>('connections') ?? [];
        return stored.filter(connection => connection && connection.id && connection.url);
    }

    public get(id: string | undefined): StoredConnection | undefined {
        return id ? this.all().find(connection => connection.id === id) : undefined;
    }

    public get activeId(): string | undefined {
        return this.context.globalState.get<string>(ACTIVE_CONNECTION_KEY);
    }

    public async setActive(id: string | undefined): Promise<void> {
        await this.context.globalState.update(ACTIVE_CONNECTION_KEY, id);
        this.changed.fire();
    }

    public async save(connection: StoredConnection): Promise<void> {
        const connections = this.all();
        const index = connections.findIndex(existing => existing.id === connection.id);
        if (index >= 0) { connections[index] = connection; } else { connections.push(connection); }
        await this.write(connections);
    }

    public async remove(id: string): Promise<void> {
        await this.write(this.all().filter(connection => connection.id !== id));
        await this.context.secrets.delete(passwordKey(id));
        if (this.activeId === id) { await this.setActive(undefined); }
    }

    /** Moves a pre-multi-connection `trino.connection.*` setup into the list. */
    public async migrateLegacyConnection(): Promise<void> {
        if (this.all().length) { return; }
        const legacy = vscode.workspace.getConfiguration('trino.connection');
        const url = String(legacy.get('url') ?? '').trim();
        const user = String(legacy.get('user') ?? '').trim();
        if (!url || !user) { return; }
        const id = randomUUID();
        await this.save({
            id,
            name: String(legacy.get('name') ?? '').trim() || 'Trino Connection',
            url,
            user,
            catalog: String(legacy.get('catalog') ?? '').trim() || undefined,
            schema: String(legacy.get('schema') ?? '').trim() || undefined
        });
        const password = await this.context.secrets.get(LEGACY_PASSWORD_KEY);
        if (password) {
            await this.context.secrets.store(passwordKey(id), password);
            await this.context.secrets.delete(LEGACY_PASSWORD_KEY);
        }
        await this.setActive(id);
    }

    private async write(connections: StoredConnection[]): Promise<void> {
        await vscode.workspace.getConfiguration('trino').update('connections', connections, vscode.ConfigurationTarget.Global);
        this.changed.fire();
    }
}
