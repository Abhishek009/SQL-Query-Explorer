/**
 * `port` and `sslEnabled` are undefined when the URL says nothing about them, so
 * callers can keep whatever the user already chose instead of guessing over it.
 */
export interface ParsedTrinoUrl {
    host: string;
    catalog: string;
    schema: string;
    port?: string;
    sslEnabled?: boolean;
    user: string;
}

export const JDBC_SCHEME = /^jdbc:(?:trino|presto):\/\//i;

export const TLS_PORTS = new Set(['443', '8443']);

/**
 * Reads either an HTTP(S) coordinator URL or a Trino JDBC connection string.
 * JDBC URLs look like jdbc:trino://host:port/catalog/schema?SSL=true&user=alice;
 * the REST API this extension uses needs the equivalent http(s)://host:port.
 */
export function parseTrinoUrl(value: string): ParsedTrinoUrl | undefined {
    const trimmed = value.trim();
    const isJdbc = JDBC_SCHEME.test(trimmed);
    if (!isJdbc && !/^https?:\/\//i.test(trimmed)) { return undefined; }
    let url: URL;
    try { url = new URL(isJdbc ? `http://${trimmed.replace(JDBC_SCHEME, '')}` : trimmed); }
    catch { return undefined; }
    if (!url.hostname) { return undefined; }

    // JDBC parameter names are conventionally capitalised (SSL), but match loosely.
    const parameter = (name: string): string | undefined => {
        for (const [key, entry] of url.searchParams) {
            if (key.toLowerCase() === name) { return entry; }
        }
        return undefined;
    };
    // An http(s) URL always states the scheme. A JDBC URL may not mention SSL at
    // all: honour SSL=… when present, otherwise infer it from a conventional TLS
    // port, and leave it undefined when the URL simply does not say.
    const ssl = parameter('ssl');
    const sslEnabled = !isJdbc ? url.protocol === 'https:'
        : ssl !== undefined ? /^true$/i.test(ssl)
        : TLS_PORTS.has(url.port) ? true
        : undefined;
    const [catalog = '', schema = ''] = url.pathname.replace(/^\//, '').split('/');
    return {
        host: url.hostname,
        port: url.port || undefined,
        sslEnabled,
        catalog: decodeURIComponent(catalog),
        schema: decodeURIComponent(schema),
        user: parameter('user') ?? ''
    };
}

export function httpBaseUrl(value: string): string | undefined {
    const parsed = parseTrinoUrl(value);
    if (!parsed) { return undefined; }
    const { sslEnabled, port } = withPortDefaults(parsed);
    return `${sslEnabled ? 'https' : 'http'}://${formatHost(parsed.host)}:${port}`;
}

/** Fills in the conventional port and scheme for a URL that omitted them. */
export function withPortDefaults(parsed: ParsedTrinoUrl): { port: string; sslEnabled: boolean } {
    const sslEnabled = parsed.sslEnabled ?? TLS_PORTS.has(parsed.port ?? '');
    return { sslEnabled, port: parsed.port ?? (sslEnabled ? '443' : '8080') };
}

export function parseConnectionUrl(value: string): { host: string; port: string; sslEnabled: boolean } {
    const parsed = parseTrinoUrl(value);
    return parsed
        ? { host: parsed.host, ...withPortDefaults(parsed) }
        : { host: 'localhost', port: '8080', sslEnabled: false };
}

export function formatHost(host: string): string {
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
