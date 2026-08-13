export interface SqlStatement {
    /** Statement text without the trailing semicolon. */
    text: string;
    /** Zero-based line the statement starts on, for anchoring a CodeLens. */
    line: number;
}

/**
 * Splits a script into statements on top-level semicolons. Quotes and comments
 * are tracked so a semicolon inside 'a;b', "a;b", -- a;b, or /* a;b *␘/ does not
 * split the statement.
 */
export function splitStatements(sql: string): SqlStatement[] {
    const statements: SqlStatement[] = [];
    let start = 0;
    let line = 0;
    let startLine = 0;
    let quote: "'" | '"' | undefined;
    let comment: 'line' | 'block' | undefined;
    let seenContent = false;
    // Counts a run of consecutive backslashes right before the current
    // position, while inside a quote — an odd count means the next quote
    // character is escaped (MySQL-style `\'`), not a closing quote.
    let backslashes = 0;

    const push = (end: number) => {
        const text = sql.slice(start, end);
        if (text.trim()) { statements.push({ text: text.trim(), line: startLine }); }
        start = end + 1;
        seenContent = false;
    };

    for (let index = 0; index < sql.length; index++) {
        const character = sql[index];
        const next = sql[index + 1];

        if (character === '\n') {
            line++;
            if (comment === 'line') { comment = undefined; }
            continue;
        }
        if (comment === 'line') { continue; }
        if (comment === 'block') {
            if (character === '*' && next === '/') { comment = undefined; index++; }
            continue;
        }
        if (quote) {
            if (character === '\\') { backslashes++; continue; }
            if (character === quote) {
                const escaped = backslashes % 2 === 1;
                backslashes = 0;
                if (escaped) { continue; }
                // Doubling is the other way SQL string and identifier quotes escape themselves.
                if (next === quote) { index++; } else { quote = undefined; }
                continue;
            }
            backslashes = 0;
            continue;
        }
        if (character === '-' && next === '-') { comment = 'line'; index++; continue; }
        if (character === '/' && next === '*') { comment = 'block'; index++; continue; }
        if (character === "'" || character === '"') { quote = character; backslashes = 0; markStart(); continue; }
        if (character === ';') { push(index); continue; }
        if (!/\s/.test(character)) { markStart(); }
    }
    push(sql.length);
    return statements;

    /** The first non-comment, non-space character fixes the reported line. */
    function markStart(): void {
        if (!seenContent) { startLine = line; seenContent = true; }
    }
}
