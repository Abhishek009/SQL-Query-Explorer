/**
 * Parses RFC 4180 CSV text (the same dialect `exporter.ts` writes): comma
 * delimited, `"` quoting, `""` for a literal quote inside a quoted field,
 * and either CRLF or LF line endings.
 */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    let i = 0;

    const endField = () => { row.push(field); field = ''; };
    const endRow = () => { endField(); rows.push(row); row = []; };

    while (i < text.length) {
        const char = text[i];
        if (inQuotes) {
            if (char === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i++; continue;
            }
            field += char; i++; continue;
        }
        if (char === '"') { inQuotes = true; i++; continue; }
        if (char === ',') { endField(); i++; continue; }
        if (char === '\r') { i++; continue; }
        if (char === '\n') { endRow(); i++; continue; }
        field += char; i++;
    }
    // A trailing newline leaves nothing pending; anything else is the last row.
    if (field !== '' || row.length) { endRow(); }
    return rows;
}
