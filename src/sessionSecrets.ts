/**
 * Passwords the user chose not to persist to Secret Storage, kept only for
 * the life of this window so "Save password" can be unchecked without
 * forcing a retype on every query. Never written to disk; gone on reload.
 */
const sessionPasswords = new Map<string, string>();

export function rememberForSession(connectionId: string, password: string): void {
    sessionPasswords.set(connectionId, password);
}

export function sessionPassword(connectionId: string): string | undefined {
    return sessionPasswords.get(connectionId);
}

export function forgetSession(connectionId: string): void {
    sessionPasswords.delete(connectionId);
}
