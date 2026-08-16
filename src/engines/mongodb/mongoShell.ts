import * as vm from 'vm';
import { ObjectId } from 'mongodb';

export interface ShellCall {
    name: string;
    /** Raw, unparsed text between the call's parentheses; undefined if this segment is a bare property access, not a call. */
    args?: string;
}

export interface ParsedShellCommand {
    /** Absent for a db-level command like `db.getCollectionNames()`. */
    collection?: string;
    calls: ShellCall[];
}

/**
 * Finds the index just past the bracket that matches the opener at `start`,
 * skipping over quoted strings (with backslash escapes) so a `)` or `}` inside
 * a literal never closes the wrong thing.
 */
function skipBalanced(text: string, start: number): number {
    const opens = '([{';
    const closes = ')]}';
    const stack: string[] = [text[start]];
    let quote: string | undefined;
    for (let i = start + 1; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\') { i++; continue; }
            if (ch === quote) { quote = undefined; }
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
        if (opens.includes(ch)) { stack.push(ch); continue; }
        if (closes.includes(ch)) {
            const opener = opens[closes.indexOf(ch)];
            if (stack.pop() !== opener) { throw new Error('Unbalanced brackets in the command.'); }
            if (stack.length === 0) { return i + 1; }
        }
    }
    throw new Error('Unbalanced brackets in the command — a closing bracket is missing.');
}

/** Parses a `.name` or `.name(args)` chain, e.g. the text after `db` in `db.users.find({}).limit(5)`. */
function parseChain(text: string): ShellCall[] {
    const calls: ShellCall[] = [];
    let i = 0;
    while (i < text.length) {
        if (text[i] !== '.') { throw new Error(`Expected "." at "${text.slice(i, i + 20)}".`); }
        i++;
        const nameStart = i;
        while (i < text.length && /[A-Za-z0-9_$]/.test(text[i])) { i++; }
        const name = text.slice(nameStart, i);
        if (!name) { throw new Error('Expected a collection or method name after ".".'); }
        let args: string | undefined;
        if (text[i] === '(') {
            const end = skipBalanced(text, i);
            args = text.slice(i + 1, end - 1);
            i = end;
        }
        calls.push({ name, args });
    }
    return calls;
}

/**
 * Parses MongoDB shell syntax: `db.<collection>.<method>(args)[.<chain>(args)...]`
 * or a db-level command like `db.getCollectionNames()` / `db.runCommand({...})`.
 */
export function parseShellCommand(statement: string): ParsedShellCommand {
    const trimmed = statement.trim();
    if (!/^db\b/.test(trimmed)) {
        throw new Error('MongoDB commands start with db.<collection>.<method>(...), e.g. db.users.find({}).');
    }
    const calls = parseChain(trimmed.slice(2));
    if (calls.length === 0) { throw new Error('Expected a collection or command after "db.".'); }

    const [first, ...rest] = calls;
    if (first.name === 'getCollection' && first.args !== undefined) {
        const [name] = evalShellArgs(first.args);
        return { collection: String(name), calls: rest };
    }
    // A call right after "db." (not a bare property) is a db-level command.
    if (first.args !== undefined) { return { calls }; }
    return { collection: first.name, calls: rest };
}

/**
 * Evaluates a shell call's argument text into real values, understanding the
 * handful of Mongo-shell-only constructors (ObjectId, ISODate, ...) that plain
 * JSON does not. Runs inside a `vm` context rather than `Function`/`eval` —
 * `Function` closures still see Node's real globals (`process`, `Buffer`,
 * `setTimeout`, ...), so a pasted or mistyped query could reach `process.exit()`
 * and take the extension host down with it. `vm.createContext` gives the code
 * its own global object containing only the helpers listed below, with a time
 * limit against an accidental infinite loop in pasted text.
 */
export function evalShellArgs(argsText: string): unknown[] {
    if (!argsText.trim()) { return []; }
    const sandbox = vm.createContext({
        ObjectId: (id?: string) => (id ? new ObjectId(id) : new ObjectId()),
        ISODate: (value?: string) => (value ? new Date(value) : new Date()),
        Date,
        NumberLong: (value: string | number) => Number(value),
        NumberInt: (value: string | number) => Number(value),
        NumberDecimal: (value: string | number) => Number(value),
        Timestamp: (t: number, i: number) => ({ t, i }),
        BinData: (_subtype: number, base64: string) => Buffer.from(base64, 'base64')
    });
    try {
        return vm.runInContext(`[${argsText}]`, sandbox, { timeout: 2_000 }) as unknown[];
    } catch (error) {
        throw new Error(`Could not parse arguments "${argsText}": ${error instanceof Error ? error.message : String(error)}`);
    }
}
