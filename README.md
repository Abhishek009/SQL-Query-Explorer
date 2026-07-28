# Trino Explorer

A VS Code extension that connects to one or more [Trino](https://trino.io) coordinators, lets you browse catalogs, schemas, tables, and columns from the Activity Bar, and run SQL against them without leaving the editor.

## Features

### Connections
- **Manage several coordinators at once** — dev, staging, and production sit side by side in the **Connections** view. Add one with the **+** button, then edit, remove, or refresh each from its context menu.
- One connection is **active** for queries at a time; right-click → **Use Connection for Queries** to switch.
- **Paste a JDBC connection string or a full URL into the Host field** and the rest of the form fills itself in — see [Connection URL formats](#connection-url-formats).
- Passwords are stored in **VS Code Secret Storage**, never in `settings.json`.
- All metadata and query traffic goes through Trino's `/v1/statement` endpoint.

#### Connection URL formats

The Host field accepts a plain host name, an HTTP(S) URL, or a Trino JDBC connection string. JDBC URLs are translated to the equivalent REST endpoint:

| You enter | Resolves to |
| --- | --- |
| `trino.example.com` | `http://trino.example.com:8080` |
| `https://trino.example.com:8443` | `https://trino.example.com:8443` |
| `jdbc:trino://trino.example.com:8443/hive/default?SSL=true` | `https://trino.example.com:8443`, catalog `hive`, schema `default` |
| `jdbc:trino://localhost:8080/tpch` | `http://localhost:8080`, catalog `tpch` |

Details:
- `SSL=true` selects HTTPS, as do ports `443` and `8443`. Parameter names are matched case-insensitively.
- A `/catalog/schema` path and a `user=` parameter populate those fields; anything already typed into the form takes precedence, and anything the URL omits keeps the value you chose.
- `jdbc:presto://` is accepted for older deployments.
- A password in the URL is **ignored by design**, so it never lands in `settings.json` in clear text — enter it in the form instead, where it goes to Secret Storage.
- JDBC-only parameters such as `SSLVerification`, `KerberosRemoteServiceName`, and `extraCredentials` are parsed but not yet applied.

### Explorer
- Lazy hierarchy of **connection → catalog → schema → table → column**, fetched only when you expand a node.
- **Columns show their data type** beside the name, with comments and the fully-qualified name on hover.
- **Double-click a table** to preview its rows, or use the inline preview icon / context menu for a single click.

### SQL editor and execution
- **Trino: New SQL Query** opens a native VS Code SQL editor, so normal editing, syntax highlighting, and GitHub Copilot all work.
- **Trino: Run SQL Query** from the editor title bar or `Cmd+Enter` / `Ctrl+Enter`. If text is selected only the selection runs; otherwise the whole editor runs.
- **Autocomplete from live metadata** — typing `tpch.` suggests schemas, `tpch.sf1.` suggests tables, and `tpch.sf1.customer.` suggests columns with their types. Results are cached briefly and refresh with the connection.
- **Execution feedback in the editor**: a timing line above the statement (`✓ 619ms · 1,500 row(s)`) plus a green tick or red cross in the gutter.
- Long-running statements show a cancellable progress indicator and abort the underlying request when cancelled.

### Results panel
Results open in a **Trino Results** tab beside Terminal and Output, not in an editor tab.

- **Sortable columns** — click a header to cycle ascending → descending → unsorted. Numbers sort numerically, text case-insensitively, and NULLs always sort last.
- **Resizable columns** — drag a header edge; double-click it to reset.
- **Row limit box** — defaults to 100. For table previews, raising it re-queries Trino for more rows.
- **Export to CSV or TSV**, honouring the current sort and limit. CSV uses RFC 4180 quoting; TSV collapses tabs and newlines.
- **Info** shows the connection, user, timestamp, duration, row counts, column count, sort order, and the statement that ran.
- Readable grid: sticky header, row numbers, zebra striping, right-aligned numerics, and distinct NULL styling.
- **Errors appear in the same panel** with the full server response — Trino's error JSON including `errorName` and `errorLocation` — not a truncated notification.

### Row cap
Queries without a `LIMIT` could otherwise pull an entire table into memory. The extension stops fetching at `trino.query.maxRows` (default 10,000), **cancels the query on the coordinator**, and shows a banner so truncation is never silent. Any connection can override the cap in its own settings.

### Commands

| Command | Description |
| --- | --- |
| `Trino: Add Connection` | Create a new coordinator connection. |
| `Trino: Edit Connection` | Change an existing connection's details. |
| `Trino: Remove Connection` | Delete a connection and its saved password. |
| `Trino: Use Connection for Queries` | Make a connection the active one for SQL. |
| `Trino: Connect` | Connect and load catalogs. |
| `Trino: New SQL Query` | Open a new SQL editor. |
| `Trino: Run SQL Query` | Execute the selection, or the whole editor if nothing is selected. |
| `Trino: Preview Table Data` | Run a bounded `SELECT` against the selected table. |
| `Trino: Refresh Catalogs` | Reload the tree and clear cached metadata. |

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `trino.connections` | `[]` | Saved connections. Managed by the Connections view; passwords are kept in Secret Storage, not here. |
| `trino.query.maxRows` | `10000` | Hard cap on rows fetched for any statement. A connection can override it. |
| `trino.preview.rowLimit` | `100` | Rows shown in the results grid, and fetched for a table preview. |

The older `trino.connection.*` settings are deprecated. Existing values are migrated into `trino.connections` automatically on first run.

## Getting started

1. Install the extension, or run it from source:
   ```bash
   npm install
   npm run compile
   ```
   Then open the project in VS Code and press `F5` to launch the Extension Development Host.
2. Select the Trino icon in the Activity Bar, then **+** (or **Add Connection**).
3. Enter the host, port, SSL/HTTPS choice, and user, plus an optional password. You can also paste a full `jdbc:trino://…` or `http(s)://…` URL into **Host** and let the other fields populate themselves.
4. Select **Save & Connect**.
5. Expand a catalog to browse schemas, tables, and columns. Double-click a table to preview its data.
6. Run **Trino: New SQL Query**, write a statement, and execute it with `Cmd+Enter` / `Ctrl+Enter`.

## Roadmap

- **Query history and saved queries** — persist previously run statements, re-run them, and bookmark favourites.
- **`SHOW CREATE TABLE`** — generate DDL from the explorer.
- **Enterprise authentication** — OAuth2, JWT, and Kerberos beyond the current user and password.
- **Natural ordering for text sorts** — restore `item9` before `item10` for text columns without the performance cost.

Suggestions and issues are welcome at the [project repository](https://github.com/Abhishek009/trino-plugin).

## Notes

The SQL console executes directly against the configured coordinator. Use appropriate `LIMIT` clauses and follow your organization's data-access policies.

## License

[MIT](LICENSE)
