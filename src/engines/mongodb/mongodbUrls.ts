import type { ConnectionMessage } from '../../connectionForm';

const MONGO_SCHEME = /^mongodb(\+srv)?:\/\//i;
/** mongodb://[user[:pass]@]host1[:port1][,host2[:port2]...][/database][?options] */
const MONGO_URL = /^(mongodb(?:\+srv)?):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^/?]+)(\/[^?]*)?(\?.*)?$/i;

/** True for text the Host field should treat as a full connection string rather than a bare host name. */
export function isMongoConnectionString(text: string): boolean {
    return MONGO_SCHEME.test(text.trim());
}

/**
 * Lets the Host field accept a full `mongodb://` or `mongodb+srv://` connection
 * string — as Atlas' "Connect" dialog hands out — pulling the user, password,
 * and default database into their own fields. The host(s), port, and any query
 * parameters (replicaSet, authSource, ...) stay together as one string in Host,
 * since those don't decompose into this form's other fields the way a single
 * host/port pair does; Port is left blank and ignored for a pasted string.
 * A replica set's extra hosts beyond the first are kept, since they live inside
 * that same string rather than being parsed out.
 */
export function expandPastedMongoUrl(message: ConnectionMessage): ConnectionMessage {
    if (message.engine !== 'mongodb') { return message; }
    const typed = message.host.trim();
    const match = MONGO_URL.exec(typed);
    if (!match) { return message; }
    const [, scheme, user, pass, hosts, dbPath, query] = match;
    const database = (dbPath ?? '').replace(/^\//, '');
    return {
        ...message,
        host: `${scheme}://${hosts}${query ?? ''}`,
        port: '',
        user: message.user.trim() || (user ? decodeURIComponent(user) : message.user),
        password: message.password || (pass ? decodeURIComponent(pass) : message.password),
        database: message.database.trim() || database,
        // mongodb+srv:// requires TLS in practice (Atlas included), and it's the
        // driver's own default for that scheme — check the box to match what
        // will actually happen. A plain mongodb:// paste leaves the toggle alone,
        // since a self-hosted replica set may or may not need TLS.
        sslEnabled: scheme.toLowerCase() === 'mongodb+srv' ? true : message.sslEnabled
    };
}
