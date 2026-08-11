import * as vscode from 'vscode';
import { TrinoQueryResult, TrinoRequestError } from './types';

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

/** Brackets a host so it survives concatenation into a `host:port` URL, e.g. an IPv6 literal. */
export function formatHost(host: string): string {
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

export function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

/** Single-quoted SQL string literal, for values rather than identifiers. */
export function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
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
    const configured = numberSetting('preview.rowLimit', 100);
    return Math.min(Math.max(Math.trunc(configured) || 100, 1), 10_000);
}

/**
 * Reads a setting from the current namespace, falling back to the value a user
 * had explicitly set under the old `trino.*` name. `get` cannot be used for the
 * fallback because it returns the schema default rather than nothing.
 */
export function numberSetting(key: string, fallback: number): number {
    return explicitSetting<number>('sqlExplorer', key)
        ?? explicitSetting<number>('trino', key)
        ?? fallback;
}

function explicitSetting<T>(section: string, key: string): T | undefined {
    const info = vscode.workspace.getConfiguration(section).inspect<T>(key);
    return info?.workspaceFolderValue ?? info?.workspaceValue ?? info?.globalValue;
}

/**
 * Node reports every network failure as a bare "fetch failed" and hides the real
 * reason in `error.cause`. Unwrap it so the message says what to actually fix.
 */
export function describeFetchFailure(error: unknown, url: string): Error {
    const cause = (error as { cause?: { code?: string; message?: string } } | undefined)?.cause;
    const code = cause?.code ?? '';
    const target = hostOf(url);
    const explanations: Record<string, string> = {
        ENOTFOUND: `the host name "${target}" could not be resolved. Check the spelling, or whether you need to be on the VPN.`,
        EAI_AGAIN: `the host name "${target}" could not be resolved right now. Check your DNS or VPN.`,
        ECONNREFUSED: `nothing is listening on ${target}. Check the port, and that the coordinator is running.`,
        EHOSTUNREACH: `no route to ${target}. On macOS, allow VS Code under System Settings → Privacy & Security → Local Network, then restart it. Otherwise check the firewall or VPN.`,
        ENETUNREACH: `the network is unreachable from here. Check your connection, firewall, or VPN.`,
        ECONNRESET: `the connection to ${target} was reset. A proxy or firewall may be interfering.`,
        ETIMEDOUT: `the connection to ${target} timed out. A firewall or proxy may be dropping it.`,
        UND_ERR_CONNECT_TIMEOUT: `the connection to ${target} timed out. A firewall or proxy may be dropping it.`,
        EPROTO: `the TLS handshake with ${target} failed. Try turning "Enable SSL / HTTPS" off, or on.`,
        ERR_SSL_WRONG_VERSION_NUMBER: `${target} is not speaking TLS on this port. Turn "Enable SSL / HTTPS" off.`,
        DEPTH_ZERO_SELF_SIGNED_CERT: `${target} uses a self-signed certificate that Node does not trust. Point NODE_EXTRA_CA_CERTS at your CA bundle.`,
        SELF_SIGNED_CERT_IN_CHAIN: `${target} presents a certificate chain Node does not trust, which is common behind a corporate proxy. Point NODE_EXTRA_CA_CERTS at your CA bundle.`,
        UNABLE_TO_VERIFY_LEAF_SIGNATURE: `the certificate from ${target} could not be verified. Point NODE_EXTRA_CA_CERTS at your CA bundle.`,
        CERT_HAS_EXPIRED: `the certificate for ${target} has expired.`,
        ERR_TLS_CERT_ALTNAME_INVALID: `${target}'s certificate does not cover that hostname — likely a load balancer/proxy presenting the wrong certificate. If you know this server and its certificate mismatch, turn off "Verify server certificate" in Advanced; otherwise this is a server-side TLS misconfiguration.`
    };
    const explanation = explanations[code] ?? `${cause?.message ?? (error instanceof Error ? error.message : String(error))}.`;
    const detail = [code, cause?.message].filter(Boolean).join(': ');
    return new TrinoRequestError(`Could not reach ${target} — ${explanation}`, detail || undefined);
}

function hostOf(url: string): string {
    try { return new URL(url).host; } catch { return url; }
}

export function showConnectionError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not load catalogs: ${message}`, 'Edit Connection')
        .then(selection => { if (selection) { void vscode.commands.executeCommand('sqlExplorer.editConnection'); } });
}
