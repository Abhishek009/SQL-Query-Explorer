# SQL Query Explorer

A VS Code extension for browsing database schemas and running SQL without leaving the editor.

Supports **[Trino](https://trino.io)**, **[PostgreSQL](https://www.postgresql.org)**, **[Supabase](https://supabase.com)**, and **[SQLite](https://www.sqlite.org)**. The explorer, results grid, and editor features are shared by all of them, so further engines slot in behind the same interface.

### Database support

| Database | Status |
| --- | --- |
| [Trino](https://trino.io) | Supported |
| [PostgreSQL](https://www.postgresql.org) | Supported |
| [Supabase](https://supabase.com) | Supported |
| [SQLite](https://www.sqlite.org) | Supported |
| [MySQL](https://www.mysql.com) | Not yet supported |
| [Snowflake](https://www.snowflake.com) | Not yet supported |

## Features

### Connections
- **Pick the engine when adding a connection** — Trino, PostgreSQL, Supabase, or SQLite — and the form shows only the fields that engine needs.
- **Test Connection** runs a real query against the details you typed, before saving anything.
- **Manage several servers at once** — dev, staging, and production sit side by side in the **Connections** view. Add one with the **+** button, then edit, remove, or refresh each from its context menu.
- One connection is **active** for queries at a time; right-click → **Use Connection for Queries** to switch.
- **Paste a JDBC connection string or a full URL into the Host field** and the rest of the form fills itself in — see [Connection URL formats](#connection-url-formats).
- **Supabase** gets its own tab in **Connect To DB**. Paste the project's **Connection string** (from Project Settings → Database) or just its project ref into the Host field and the host, port, user, and database fill themselves in — see [Supabase connections](#supabase-connections).
- **SQLite** gets its own tab too, with nothing but a **Database file** field and a native **Browse…** picker — no host, port, user, password, or SSL, since it's a local file rather than a server. See [SQLite connections](#sqlite-connections).
- Passwords are stored in **VS Code Secret Storage**, never in `settings.json`.
- Trino traffic goes through the `/v1/statement` REST endpoint; PostgreSQL and Supabase use the native Postgres wire protocol; SQLite opens the file directly on disk.
- For PostgreSQL and Supabase the tree's top level lists **databases** on the server, so siblings of the one you opened are browsable too. For SQLite the file itself is the only database, so the tree goes straight to its tables and views.

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

#### Supabase connections

Supabase is hosted PostgreSQL, so it talks the same wire protocol and shares PostgreSQL's client under the hood — it just gets defaults and a paste target suited to a Supabase project. The Host field on the **Supabase** tab accepts:

| You enter | Resolves to |
| --- | --- |
| `abcdefghijklmnop` (a bare project ref) | Host `db.abcdefghijklmnop.supabase.co` |
| `db.abcdefghijklmnop.supabase.co` | Used as-is |
| `postgresql://postgres:yourpassword@db.abcdefghijklmnop.supabase.co:5432/postgres` | Host, port, user, database, and password all filled in |

Details:
- The full **Connection string** from Project Settings → Database — including the placeholder `[YOUR-PASSWORD]` some copies contain — pastes cleanly; a real password in the string is picked up, a placeholder is not.
- Port defaults to `5432` and user to `postgres`, matching a direct connection; change them for a pooled connection (port `6543`) or a custom role.
- SSL defaults **on**, since hosted Supabase requires it. Turn it off only for a local `supabase start` database.
- Fields already typed into the form take precedence over anything the pasted string carries.

#### SQLite connections

SQLite has no server to point at — the file on disk *is* the database — so the **SQLite** tab is just a **Database file** field, a **Browse…** button, and a **New Database…** button, all backed by VS Code's native file pickers. There's no host, port, user, password, or SSL to configure, and **Test Connection** simply opens the file and reads its `sqlite_version()`.

Details:
- **Browse…** points at a `.db`/`.sqlite` file that already exists; **New Database…** opens a native Save dialog and creates an empty file wherever you choose, ready to connect to immediately.
- The connection stores an absolute path; moving or renaming the file breaks it the same way a renamed folder would in any other tool — edit the connection and browse to the new location.
- The tree's top level goes straight to **Tables/Views**, skipping the database picker that Postgres/Supabase show, since one file only ever has one database.
- Table DDL is the table's own literal `CREATE TABLE`/`CREATE VIEW` statement, exactly as SQLite stored it — not reassembled from catalog metadata like PostgreSQL's is.
- Runs through [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), a native module shipped with prebuilt binaries for macOS, Windows, and Linux (x64 and arm64) so nothing needs compiling on install.

#### Importing CSV data

Right-click any table (not a view) and choose **Import Data from CSV…** to load rows from a local file without hand-writing `INSERT` statements:

1. Pick a `.csv` file. The first row is always treated as the header.
2. A mapping screen shows every column in the table beside a dropdown of the file's columns — pre-matched by name where they agree, otherwise left to **Skip**. A preview of the first few file rows sits below it so you can sanity-check before committing.
3. Optionally check **Delete existing rows first** to replace the table's contents rather than append to them.
4. **Import** runs ordinary batched `INSERT` statements (500 rows per statement) through the same connection, so it works identically across Trino, PostgreSQL, Supabase, and SQLite — no per-engine import path.

Details:
- A cell is inserted as a number only when the *target column's* declared type looks numeric (`INTEGER`, `REAL`, `DECIMAL`, …); otherwise it's inserted as a quoted string. A numeric column with unparseable text in a given row gets `NULL` for that cell rather than failing the whole import.
- An empty cell always becomes `NULL`, regardless of column type.
- If a batch fails partway through, the import stops there and reports how many rows made it in before the error — earlier batches are not rolled back.
- There's no Excel (`.xlsx`) support yet, only CSV.

### Explorer
- Lazy hierarchy of **connection → catalog → schema → Tables/Views → table → column**, fetched only when you expand a node.
- **Tables and views are grouped into folders** with counts, for example `Tables (10)` and `Views (3)`.
- **Columns show their data type** beside the name, with comments and the fully-qualified name on hover.
- **Double-click a table** to preview its rows, or use the inline preview icon / context menu for a single click.
- **New Query Here** — hover a catalog, schema, table, or view and click the new-file icon to open a SQL editor already scoped to it, with that connection made active.
- **Right-click a table or view → Show Table DDL** to open its `SHOW CREATE TABLE` / `SHOW CREATE VIEW` output in a SQL editor.
- **Right-click a table → Import Data from CSV…** to load rows from a local `.csv` file. Match each table column to a file column (defaulted by matching names), preview the first rows, optionally clear the table first, then import — works against any engine, since it runs as ordinary batched `INSERT` statements through the same connection. See [Importing CSV data](#importing-csv-data).

### SQL editor and execution
- **SQL: New SQL Query** opens a native VS Code SQL editor, so normal editing, syntax highlighting, and GitHub Copilot all work.
- **Run / New Tab actions above every statement** — `Run` reuses a single results tab, so repeated runs replace it in place; `New Tab` opens a separate tab that later runs leave alone. Tabs are named after the table, e.g. `sf1.customer`.
- **SQL: Run SQL Query** from the editor title bar or `Cmd+Enter` / `Ctrl+Enter`. If text is selected only the selection runs; otherwise the whole editor runs.
- **Autocomplete from live metadata** — typing `tpch.` suggests schemas, `tpch.sf1.` suggests tables, and `tpch.sf1.customer.` suggests columns with their types. Results are cached briefly and refresh with the connection.
- **Execution feedback in the editor**: a timing line above the statement (`✓ 619ms · 1,500 row(s)`) plus a green tick or red cross in the gutter.
- Long-running statements show a cancellable progress indicator and abort the underlying request when cancelled.

#### Per-editor connection and database

Every SQL editor shows its own `$(plug) Connection` and `$(database) Database` lenses above the first line, independent of whichever connection is active elsewhere:

- A new file defaults to the active connection, so it runs without any setup.
- Click the `$(plug)` lens to point just this editor at a different connection (**SQL: Select Connection for This Query**); click `$(database)` to switch its catalog or database (**SQL: Select Catalog or Database for This Query**) from a live list fetched from that connection.
- A saved file can instead pin its scope with header comments, which the lenses respect and display:
  ```sql
  -- Connection: Production
  -- Database: analytics
  ```
  An explicit pick from the lens overrides a header; a header overrides the active connection.

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
| `SQL: Import Data from CSV…` | Load rows from a local CSV file into the selected table. |
| `New Query Here` | Open a SQL editor scoped to the selected node. |
| `SQL: Refresh Catalogs` | Reload the tree and clear cached metadata. |
| `SQL: Cancel Running Query` | Stop a running query on the coordinator. |
| `SQL: Run Statement` | Run one statement into the shared results tab. |
| `SQL: Run Statement in New Tab` | Run one statement into its own results tab. |
| `SQL: Select Connection for This Query` | Point the current editor at a different connection, without changing the active one. |
| `SQL: Select Catalog or Database for This Query` | Switch the catalog (Trino) or database (PostgreSQL/Supabase/SQLite) the current editor runs against. |

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
2. Select the SQL Query Explorer icon in the Activity Bar, then **+** (or **Add Connection**).
3. Enter the host, port, SSL/HTTPS choice, and user, plus an optional password. You can also paste a full `jdbc:trino://…` or `http(s)://…` URL into **Host** and let the other fields populate themselves.
4. Select **Save & Connect**.
5. Expand a catalog to browse schemas, tables, and columns. Double-click a table to preview its data.
6. Run **SQL: New SQL Query**, write a statement, and execute it with `Cmd+Enter` / `Ctrl+Enter`.

## Roadmap

- **Query history and saved queries** — persist previously run statements, re-run them, and bookmark favourites.
- **Enterprise authentication** — OAuth2, JWT, and Kerberos beyond the current user and password.
- **Natural ordering for text sorts** — restore `item9` before `item10` for text columns without the performance cost.

Suggestions and issues are welcome at the [project repository](https://github.com/Abhishek009/sql-explorer).

## Notes

The SQL console executes directly against the configured coordinator. Use appropriate `LIMIT` clauses and follow your organization's data-access policies.

## License

[MIT](LICENSE)
