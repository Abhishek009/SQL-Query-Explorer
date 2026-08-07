import type { ConnectionMessage } from '../../connectionForm';
import { splitHostPort } from '../trino/trinoUrls';

const POSTGRES_SCHEME = /^postgres(?:ql)?:\/\//i;

/** A bare project ref, e.g. `abcdefghijklmnop`, with no dots or scheme. */
const PROJECT_REF = /^[a-z0-9]{16,}$/i;

/**
 * Lets the Host field on the Supabase tab accept the "Connection string" the
 * Supabase dashboard hands out (`postgresql://postgres:[PASSWORD]@db.<ref>.supabase.co:5432/postgres`)
 * as well as a bare project ref, expanding either into the individual fields.
 * Values already typed into those fields win over the ones in the string.
 */
export function expandPastedSupabaseUrl(message: ConnectionMessage): ConnectionMessage {
    if (message.engine !== 'supabase') { return message; }
    const typed = message.host.trim();

    if (POSTGRES_SCHEME.test(typed)) {
        try {
            const url = new URL(typed);
            const password = decodeURIComponent(url.password || '');
            return {
                ...message,
                host: url.hostname,
                port: url.port || message.port,
                user: message.user.trim() || decodeURIComponent(url.username || ''),
                database: message.database.trim() || url.pathname.replace(/^\//, '') || 'postgres',
                password: message.password || (password && password !== '[YOUR-PASSWORD]' ? password : message.password),
                sslEnabled: url.searchParams.get('sslmode') === 'disable' ? false : message.sslEnabled
            };
        } catch {
            // Falls through to the plain-host handling below.
        }
    }

    if (PROJECT_REF.test(typed)) {
        return { ...message, host: `db.${typed}.supabase.co` };
    }

    const { host, port } = splitHostPort(typed);
    return { ...message, host, port: port ?? message.port };
}
