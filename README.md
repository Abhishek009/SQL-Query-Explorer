# SQL Explorer

A VS Code extension for browsing database schemas and running SQL without leaving the editor.

It currently speaks [Trino](https://trino.io); the connection, results, and editor features are engine-agnostic, so further engines are being added.

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
| `localhost:8080` | `http://localhost:8080` (plain HTTP, e.g. a local Docker coordinator) |
| `https://trino.example.com:8443` | `https://trino.example.com:8443` |
| `jdbc:trino://trino.example.com:8443/hive/default?SSL=true` | `https://trino.example.com:8443`, catalog `hive`, schema `default` |
| `jdbc:trino://localhost:8080/tpch` | `http://localhost:8080`, catalog `tpch` |

Details:
- `SSL=true` selects HTTPS, as do ports `443` and `8443`. Parameter names are matched case-insensitively.
- A `/catalog/schema` path and a `user=` parameter populate those fields; anything already typed into the form takes precedence, and anything the URL omits keeps the value you chose.
- A `host:port` typed without a scheme fills in the port too, so `localhost:8080` works. Bare IPv6 literals such as `::1` are left intact.
- Plain HTTP is fully supported and is the default; leave **Enable SSL / HTTPS** off for a local or Docker coordinator.
- `jdbc:presto://` is accepted for older deployments.
- A password in the URL is **ignored by design**, so it never lands in `settings.json` in clear text — enter it in the form instead, where it goes to Secret Storage.
- JDBC-only parameters such as `SSLVerification`, `KerberosRemoteServiceName`, and `extraCredentials` are parsed but not yet applied.

### Explorer
- Lazy hierarchy of **connection → catalog → schema → Tables/Views → table → column**, fetched only when you expand a node.
- **Tables and views are grouped into folders** with counts, for example `Tables (10)` and `Views (3)`.
- **Columns show their data type** beside the name, with comments and the fully-qualified name on hover.
- **Double-click a table** to preview its rows, or use the inline preview icon / context menu for a single click.
- **New Query Here** — hover a catalog, schema, table, or view and click the new-file icon to open a SQL editor already scoped to it, with that connection made active.
- **Right-click a table or view → Show Table DDL** to open its `SHOW CREATE TABLE` / `SHOW CREATE VIEW` output in a SQL editor.

### SQL editor and execution
- **SQL: New SQL Query** opens a native VS Code SQL editor, so normal editing, syntax highlighting, and GitHub Copilot all work.
- **Run / New Tab actions above every statement** — `Run` reuses a single results tab, so repeated runs replace it in place; `New Tab` opens a separate tab that later runs leave alone. Tabs are named after the table, e.g. `sf1.customer`.
- **SQL: Run SQL Query** from the editor title bar or `Cmd+Enter` / `Ctrl+Enter`. If text is selected only the selection runs; otherwise the whole editor runs.
- **Autocomplete from live metadata** — typing `tpch.` suggests schemas, `tpch.sf1.` suggests tables, and `tpch.sf1.customer.` suggests columns with their types. Results are cached briefly and refresh with the connection.
- **Execution feedback in the editor**: a timing line above the statement (`✓ 619ms · 1,500 row(s)`) plus a green tick or red cross in the gutter.
- Long-running statements show a cancellable progress indicator and abort the underlying request when cancelled.

### Results
Results open in an editor tab beside your query. `Run` reuses one tab; `New Tab` opens another so results can be compared. If another editor group is already open — a chat panel, a second file — results become a tab **in that group** rather than splitting the window again. The tab is an ordinary editor, so you can drag it anywhere and VS Code remembers the position; later results follow it there.

- **Sortable columns** — click a header to cycle ascending → descending → unsorted. Numbers sort numerically, text case-insensitively, and NULLs always sort last.
- **Resizable columns** — drag a header edge; double-click it to reset.
- **Row limit box** — defaults to 100. For table previews, raising it re-queries Trino for more rows.
- **Export to CSV or TSV**, honouring the current sort and limit. CSV uses RFC 4180 quoting; TSV collapses tabs and newlines.
- **Info** shows the connection, user, timestamp, duration, row counts, column count, sort order, and the statement that ran.
- Readable grid: sticky header, row numbers, zebra striping, right-aligned numerics, and distinct NULL styling.
- **Errors appear in the same panel** with the full server response — Trino's error JSON including `errorName` and `errorLocation` — not a truncated notification.

### Row cap
Queries without a `LIMIT` could otherwise pull an entire table into memory. The extension stops fetching at `sqlExplorer.query.maxRows` (default 10,000), **cancels the query on the coordinator**, and shows a banner so truncation is never silent. Any connection can override the cap in its own settings.

### Commands

| Command | Description |
| --- | --- |
| `SQL: Add Connection` | Create a new coordinator connection. |
| `SQL: Edit Connection` | Change an existing connection's details. |
| `SQL: Remove Connection` | Delete a connection and its saved password. |
| `SQL: Use Connection for Queries` | Make a connection the active one for SQL. |
| `SQL: Connect` | Connect and load catalogs. |
| `SQL: New SQL Query` | Open a new SQL editor. |
| `SQL: Run SQL Query` | Execute the selection, or the whole editor if nothing is selected. |
| `SQL: Preview Table Data` | Run a bounded `SELECT` against the selected table. |
| `SQL: Show Table DDL` | Open `SHOW CREATE TABLE` output for the selected table. |
| `New Query Here` | Open a SQL editor scoped to the selected node. |
| `SQL: Refresh Catalogs` | Reload the tree and clear cached metadata. |
| `SQL: Cancel Running Query` | Stop a running query on the coordinator. |
| `SQL: Run Statement` | Run one statement into the shared results tab. |
| `SQL: Run Statement in New Tab` | Run one statement into its own results tab. |

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `sqlExplorer.connections` | `[]` | Saved connections. Managed by the Connections view; passwords are kept in Secret Storage, not here. |
| `sqlExplorer.query.maxRows` | `10000` | Hard cap on rows fetched for any statement. A connection can override it. |
| `sqlExplorer.preview.rowLimit` | `100` | Rows shown in the results grid, and fetched for a table preview. |

Settings previously named `trino.*` are deprecated but still read: values are migrated into the `sqlExplorer.*` keys automatically on first run, and saved passwords are kept.

## Getting started

1. Install the extension, or run it from source:
   ```bash
   npm install
   npm run compile
   ```
   Then open the project in VS Code and press `F5` to launch the Extension Development Host.
2. Select the SQL Explorer icon in the Activity Bar, then **+** (or **Add Connection**).
3. Enter the host, port, SSL/HTTPS choice, and user, plus an optional password. You can also paste a full `jdbc:trino://…` or `http(s)://…` URL into **Host** and let the other fields populate themselves.
4. Select **Save & Connect**.
5. Expand a catalog to browse schemas, tables, and columns. Double-click a table to preview its data.
6. Run **SQL: New SQL Query**, write a statement, and execute it with `Cmd+Enter` / `Ctrl+Enter`.

## Roadmap

- **Query history and saved queries** — persist previously run statements, re-run them, and bookmark favourites.
- **Enterprise authentication** — OAuth2, JWT, and Kerberos beyond the current user and password.
- **Natural ordering for text sorts** — restore `item9` before `item10` for text columns without the performance cost.

Suggestions and issues are welcome at the [project repository](https://github.com/Abhishek009/trino-plugin).

## Notes

The SQL console executes directly against the configured coordinator. Use appropriate `LIMIT` clauses and follow your organization's data-access policies.

## License

[MIT](LICENSE)
