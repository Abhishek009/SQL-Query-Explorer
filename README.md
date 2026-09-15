# SQL Query Explorer

A VS Code extension for browsing database schemas and running SQL without leaving the editor.

Supports **[Trino](https://trino.io)**, **[PostgreSQL](https://www.postgresql.org)**, **[Supabase](https://supabase.com)**, **[SQLite](https://www.sqlite.org)**, **[DuckDB](https://duckdb.org)**, **[MySQL](https://www.mysql.com)**, **[MariaDB](https://mariadb.org)**, **[MongoDB](https://www.mongodb.com)**, and **[Snowflake](https://www.snowflake.com)**. The explorer, results grid, and editor features are shared by all of them, so further engines slot in behind the same interface.

### Database support

| Database | Status |
| --- | --- |
| [Trino](https://trino.io) | Supported |
| [PostgreSQL](https://www.postgresql.org) | Supported |
| [Supabase](https://supabase.com) | Supported |
| [SQLite](https://www.sqlite.org) | Supported |
| [DuckDB](https://duckdb.org) | Supported |
| [MySQL](https://www.mysql.com) | Supported |
| [MariaDB](https://mariadb.org) | Supported |
| [MongoDB](https://www.mongodb.com) | Supported |
| [Snowflake](https://www.snowflake.com) | Supported |

## Features

### Connections
- **Pick the engine when adding a connection** — PostgreSQL, Trino, Supabase, SQLite, DuckDB, MySQL, MariaDB, MongoDB, or Snowflake — and the form shows only the fields that engine needs. PostgreSQL is the first tab and the default when you open **Add Connection**.
- **Test Connection** runs a real query against the details you typed, before saving anything.
- **Manage several servers at once** — dev, staging, and production sit side by side in the **Connections** view. Add one with the **+** button, then edit, remove, or refresh each from its context menu.
- One connection is **active** for queries at a time; right-click → **Use Connection for Queries** to switch.
- **Paste a JDBC connection string or a full URL into the Host field** and the rest of the form fills itself in — see [Connection URL formats](#connection-url-formats).
- **Trino → Advanced → "Verify server certificate"** (default on) can be turned off for a coordinator behind a load balancer/proxy presenting a certificate for the wrong hostname — the same escape hatch as the JDBC driver's `SSLVerification=NONE`. Leave it on unless you have a specific, known reason not to: turning it off trusts *any* certificate the server presents.
- **Supabase** gets its own tab in **Connect To DB**. Paste the project's **Connection string** (from Project Settings → Database) or just its project ref into the Host field and the host, port, user, and database fill themselves in — see [Supabase connections](#supabase-connections).
- **SQLite** gets its own tab too, with nothing but a **Database file** field, native **Browse…**/**New Database…** pickers, and a one-time **Install** step — no host, port, user, password, or SSL, since it's a local file rather than a server. See [SQLite connections](#sqlite-connections).
- **DuckDB** gets a tab with the same local-file shape and install step as SQLite — see [DuckDB connections](#duckdb-connections).
- **MySQL** gets its own tab too — host/port/user/password/database/SSL, the same shape as PostgreSQL's. See [MySQL connections](#mysql-connections).
- **MariaDB** gets its own tab as well, identical in shape to MySQL's and backed by the same client — it's the same wire protocol underneath. See [MariaDB connections](#mariadb-connections).
- **MongoDB** gets its own tab too, and is the one engine here that doesn't speak SQL — the editor takes Mongo shell syntax instead (`db.collection.find({...})`). See [MongoDB connections](#mongodb-connections).
- **Snowflake** gets its own tab, addressed by account identifier rather than host/port, with a choice of username/password or browser-based SSO — see [Snowflake connections](#snowflake-connections).
- Passwords are stored in **VS Code Secret Storage**, never in `settings.json`. Every password field has a **Show/Hide** toggle to check what you typed before saving.
- Trino traffic goes through the `/v1/statement` REST endpoint; PostgreSQL, Supabase, MySQL, MariaDB, MongoDB, and Snowflake use their native wire protocols; SQLite and DuckDB open their file directly on disk.
- For PostgreSQL, Supabase, MySQL, MariaDB, MongoDB, and Snowflake the tree's top level lists **databases** on the server, so siblings of the one you opened are browsable too. For SQLite and DuckDB the file itself is the only database, so the tree goes straight to its tables and views.

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

SQLite has no server to point at — the file on disk *is* the database — so the **SQLite** tab is just a **Database file** field, **Browse…**/**New Database…** buttons backed by VS Code's native file pickers, and an install banner. There's no host, port, user, password, or SSL to configure.

Neither SQLite's nor DuckDB's engine is bundled with the extension — both are native modules, downloaded on demand the first time you open their tab, rather than shipped in every install whether or not anyone uses them (Snowflake's driver works the same way, for a different reason — see [Snowflake connections](#snowflake-connections)):
1. If the engine isn't downloaded yet, the tab shows a banner — click **Install**. This runs `npm install` in the background, into the extension's own storage (not your project), not the extension's `.vsix`. For SQLite that's a one-time **~2MB** download.
2. Once installed, it stays installed for every connection of that engine afterward.
3. **Test Connection** and **Save & Connect** work as soon as the banner reports **SQLite is installed and ready.**

Details:
- Requires `npm` on your `PATH` (bundled with any Node.js install) — if the install fails immediately, that's the most likely reason.
- **Browse…** points at a `.db`/`.sqlite` file that already exists; **New Database…** opens a native Save dialog and creates an empty file wherever you choose, ready to connect to immediately.
- The connection stores an absolute path; moving or renaming the file breaks it the same way a renamed folder would in any other tool — edit the connection and browse to the new location.
- The tree's top level goes straight to **Tables/Views**, skipping the database picker that Postgres/Supabase show, since one file only ever has one database.
- Table DDL is the table's own literal `CREATE TABLE`/`CREATE VIEW` statement, exactly as SQLite stored it — not reassembled from catalog metadata like PostgreSQL's is.
- Runs through [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3).

#### DuckDB connections

The **DuckDB** tab looks and works like SQLite's — same **Database file**/**Browse…**/**New Database…**/install-banner shape — just a much bigger download: DuckDB's native module runs **40–120MB per platform**, versus ~2MB for SQLite's, since it's a full analytical engine (its own SQL parser, vectorized execution, Parquet/CSV readers) rather than SQLite's minimalist row store. That size difference is exactly why neither engine is bundled — see [SQLite connections](#sqlite-connections) for the shared install flow.

Details beyond what SQLite's section covers:
- Unlike SQLite, DuckDB auto-creates a file the first time anything opens it, so **New Database…** is a convenience rather than a strict requirement — pointing **Browse…** at a not-yet-existing path would also work, though the native file picker only ever lists files that already exist.
- Table DDL comes from DuckDB's own `duckdb_tables()`/`duckdb_views()` — the literal `CREATE` statement, like SQLite, not reassembled metadata like PostgreSQL's.
- Schema introspection uses DuckDB's Postgres-compatible `information_schema`, so column types and nullability read the same way they would against a Postgres connection.
- Runs through [`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api).

#### MySQL connections

MySQL's tab looks like PostgreSQL's — host, port, username, password, an optional default database, and an SSL toggle — but unlike Postgres, MySQL doesn't require picking one database up front: leave the **Default database** field blank and the tree lists every database the user can see; fill it in to scope a fresh SQL editor to one by default.

Details:
- MySQL has no level between a database and its tables the way Postgres has schemas, so the tree's schema level just repeats the database's name rather than introducing a fake concept — `mydb → mydb → Tables/Views` reads a little redundant but keeps the same three-level shape every other engine uses.
- Table DDL is `SHOW CREATE TABLE`/`SHOW CREATE VIEW`'s literal output, like SQLite and DuckDB, not reassembled from catalog metadata.
- Runs through [`mysql2`](https://www.npmjs.com/package/mysql2), a pure-JS driver with no native binary — bundled normally, no install-on-demand step like SQLite/DuckDB need.
- Identifiers are quoted with backticks (MySQL's own convention), not the double quotes every other engine here uses.

#### MariaDB connections

MariaDB gets its own tab with the identical shape to MySQL's — host, port, username, password, an optional default database, and an SSL toggle, with the same blank-database-means-browse-everything behaviour.

Details:
- Runs through the exact same `MySqlClient`/[`mysql2`](https://www.npmjs.com/package/mysql2) code path as MySQL: mysql2 already speaks MariaDB's wire protocol, so there's no separate driver or client class, just a different tab and connection type — the same way Supabase reuses PostgreSQL's client.
- **Test Connection** and query results correctly say "MariaDB", not "MySQL", reading it off the server's own version string rather than assuming.
- Everything else — schema-repeats-database, backtick-quoted identifiers, `SHOW CREATE TABLE` DDL, multi-statement script support — is identical to [MySQL connections](#mysql-connections) above, since it's the same server family under the hood.

#### MongoDB connections

MongoDB's tab has the same host/port/username/password/database/SSL shape as MySQL's, but two fields work differently since Mongo has no fixed port scheme and often no auth at all:

- **Port** is optional. Leave it blank for a manually typed host and the connection is built as `mongodb://host` (the driver's own default port applies); it's mainly left blank automatically when you paste a connection string (see below), since `mongodb+srv://` addresses carry no port of their own.
- **Username** is optional — a local MongoDB with auth disabled, common in development, needs neither a username nor a password.
- **Paste a full `mongodb://` or `mongodb+srv://` connection string into Host** (e.g. Atlas' "Connect your application" string) and the user, password, and default database fill themselves in; the host(s), port, and any query parameters (`replicaSet`, `authSource`, `retryWrites`, …) stay together as one string in Host rather than being split apart, since a replica set's extra hosts and Atlas' SRV-based discovery don't reduce to a single host/port pair the way MySQL's or Postgres' do.
- Leave **Default database** blank to browse every database the connection is authorised to list; set it to scope a fresh query editor to one by default, or to skip the `listDatabases` server command entirely for a restricted user (some shared Atlas tiers only grant access to one database, not the admin-level command needed to enumerate all of them).

**The query editor takes Mongo shell syntax, not SQL** — the same commands you'd type into `mongosh`:

```js
db.orders.find({ status: "shipped" }).sort({ createdAt: -1 }).limit(20)
db.orders.aggregate([{ $match: { status: "shipped" } }, { $count: "total" }])
db.orders.updateOne({ _id: ObjectId("...") }, { $set: { status: "delivered" } })
db.getCollectionNames()
```

Details:
- Supported methods: `find` (with chained `.sort()`/`.limit()`/`.skip()`/`.project()`), `findOne`, `aggregate`, `countDocuments`, `distinct`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `replaceOne`, `deleteOne`, `deleteMany`, `drop`, plus the db-level `getCollectionNames`, `stats`, and `runCommand`.
- Shell-only constructors work as expected inside a command — `ObjectId("...")`, `ISODate("...")`, `NumberLong(...)`, `NumberInt(...)`, `NumberDecimal(...)`. Argument text runs in a sandboxed `vm` context with only those constructors available, not Node's real globals, so a mistyped or pasted command can't reach outside the query itself.
- Collections have no fixed schema, so the tree's "columns" and **Show Table DDL** output are both inferred by sampling up to 20 documents — DDL shows the inferred field shape plus one example document rather than a `CREATE TABLE`.
- A mutation reports an affected-count summary (`updateOne — matched 1, modified 1`) rather than an empty grid, the same as every other engine here.
- Runs through the official [`mongodb`](https://www.npmjs.com/package/mongodb) driver, a pure-JS package with no native binary — bundled normally, no install-on-demand step like SQLite/DuckDB need.

#### Snowflake connections

Snowflake has no host/port — it's addressed by **account identifier** instead (e.g. `xy12345.us-east-1`, or the newer `orgname-accountname` form) — and always connects over TLS, so there's no SSL toggle either. Two more fields are Snowflake-only:

- **Warehouse** is required — unlike every other field here, Snowflake has no default to fall back to, and queries fail outright without one.
- **Authentication** is a choice of **Username & Password** or **External Browser (SSO)**. The latter opens your system browser to sign in through your identity provider (Okta, Azure AD, …) and stores no password at all — the Snowflake driver handles the whole redirect/callback flow itself, the extension just waits for it to finish.

**Default database**/**Default schema** and **Role** work like Postgres/MySQL's optional defaults — leave the database blank to browse every one the role can see.

Like SQLite and DuckDB, **Snowflake's driver is downloaded on demand** rather than bundled, for a different reason than either: the official `snowflake-sdk` pulls in AWS/Azure/GCS SDKs for bulk-load (`PUT`/`GET`) features this extension never uses, which would triple the extension's package size for every install if bundled. The Snowflake tab shows the same install banner SQLite/DuckDB do — see [SQLite connections](#sqlite-connections) for the shared flow — just a smaller, one-time **~8MB** download.

Details:
- Snowflake has a real schema level between database and table, unlike MySQL/MongoDB, so the tree reads `database → schema → Tables/Views` without the repeated-name workaround those need.
- Table DDL comes from Snowflake's own `GET_DDL()` function — the literal `CREATE` statement, like MySQL/SQLite/DuckDB, not reassembled from catalog metadata.
- A database/schema/table reference can be written directly in SQL without a separate connection per database, like Trino — `SELECT * FROM otherdb.schema.table` works from any session the role can reach it from.
- Runs through the official [`snowflake-sdk`](https://www.npmjs.com/package/snowflake-sdk) driver.

#### Importing CSV data

Right-click any table (not a view) and choose **Import Data from CSV…** to load rows from a local file without hand-writing `INSERT` statements:

1. Pick a `.csv` file. The first row is always treated as the header.
2. A mapping screen shows every column in the table beside a dropdown of the file's columns — pre-matched by name where they agree, otherwise left to **Skip**. A preview of the first few file rows sits below it so you can sanity-check before committing.
3. Optionally check **Delete existing rows first** to replace the table's contents rather than append to them.
4. **Import** runs in batches of 500 rows per statement through the same connection — ordinary `INSERT` statements for every SQL engine, or `insertMany([...])` documents for MongoDB.

Details:
- A cell is inserted as a number only when the *target column's* inferred type looks numeric (`INTEGER`, `REAL`, `DECIMAL`, … for SQL engines; `number` for MongoDB's sampled columns); otherwise it's inserted as a string. A numeric column with unparseable text in a given row gets `NULL` for that cell rather than failing the whole import.
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
- **SQL: Format Query** reindents and re-cases the selection (or the whole editor if nothing is selected), using the SQL dialect of whichever connection the editor is scoped to — PostgreSQL, MySQL/MariaDB, SQLite, DuckDB, Snowflake, and Trino each get their own rules; MongoDB queries are left alone since they aren't SQL. Also registered as VS Code's formatter for `.sql` files, so `Format Document` (`Shift+Alt+F`) and `editor.formatOnSave` work too — add `"[sql]": { "editor.formatOnSave": true }` to your settings to format automatically. Indentation follows the editor's own tab size; keyword casing follows `sqlExplorer.format.keywordCase`.

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
- **Click a cell to copy it** to the clipboard, with a brief flash for feedback; **Shift+click a second cell** to select a rectangular range and copy it as TSV, spreadsheet-style.
- **Double-click a cell to expand it** into a side panel — a JSON/object value is pretty-printed rather than shown as the compact single-line form the grid uses inline. Closes on Escape, the ✕ button, or clicking outside it.
- **Filter box** hides rows that don't match what you type, across every column — display-only, so it never changes what CSV/TSV/INSERT export sends.
- **Columns button** toggles which columns are shown, for a wide result set — hidden columns stay out of the way visually but are never dropped from export.
- **Select rows (click a row number; Shift/Cmd+click for several) and copy them as INSERT statements** — or, for a MongoDB connection, as a `db.<collection>.insertMany([...])` call — handy for seeding another table or environment with a few rows. Column identifiers are quoted the way the source engine requires (backticks for MySQL/MariaDB, double quotes elsewhere); the table/collection name is read off the query's own `FROM`/`db.<name>.` — check it before running the copied statement elsewhere.
- **Row limit box** — defaults to 100. For table previews, raising it re-queries Trino for more rows.
- **Export to CSV or TSV**, honouring the current sort and limit. CSV uses RFC 4180 quoting; TSV collapses tabs and newlines.
- **Info** shows the connection, user, timestamp, duration, row counts, column count, sort order, and the statement that ran.
- Readable grid: sticky header, row numbers, zebra striping, right-aligned numerics, and distinct NULL styling.
- **Errors appear in the same panel** with the full server response — Trino's error JSON including `errorName` and `errorLocation` — not a truncated notification.

### Row cap
Queries without a `LIMIT` could otherwise pull an entire table into memory. The extension stops fetching at `sqlExplorer.query.maxRows` (default 10,000), **cancels the query on the coordinator**, and shows a banner so truncation is never silent. Any connection can override the cap in its own settings.

### Query history and saved queries
Two views live below Connections in the sidebar, so an ad-hoc query is never lost once you've run it once.

- **History** records every statement run from a SQL editor (`Run SQL Query` / `Run Statement`), success or failure, grouped by connection with the newest first. Click an entry to run it again, or right-click for **Open in Editor**, **Copy SQL**, **Save as Favorite…**, or **Remove from History**. The search icon filters by SQL text across every connection. Kept locally per machine — not something to sync as a setting — and capped at `sqlExplorer.history.limit` entries per connection (default 500, oldest dropped first).
- **Saved Queries** are named, organized into folders you create with **New Folder**, and persist as ordinary settings so they carry over with Settings Sync. Save the current SQL editor with the **Save** icon in its title bar (`SQL: Save Current Query…`) — re-saving into the same editor updates that same entry instead of creating a duplicate. From the tree, a query can be run, opened in an editor, inserted into whatever editor is active, renamed, moved to another folder, duplicated, or deleted; a folder can be renamed or deleted (which removes everything nested inside it, after confirming).

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
| `SQL: Save Current Query…` | Save the active SQL editor's selection (or whole contents) as a saved query. |
| `SQL: New Saved Query…` | Create a saved query and open it for editing. |
| `SQL: New Saved Query Folder…` | Create a folder to organize saved queries into. |
| `SQL: Search Query History` | Filter the History view by SQL text. |
| `SQL: Clear All Query History` | Remove every recorded history entry. |
| `SQL: Format Query` | Reformat the selection, or the whole editor, for the connection's SQL dialect. |

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `sqlExplorer.connections` | `[]` | Saved connections. Managed by the Connections view; passwords are kept in Secret Storage, not here. |
| `sqlExplorer.query.maxRows` | `10000` | Hard cap on rows fetched for any statement. A connection can override it. |
| `sqlExplorer.preview.rowLimit` | `100` | Rows shown in the results grid, and fetched for a table preview. |
| `sqlExplorer.history.limit` | `500` | Maximum history entries kept per connection. |
| `sqlExplorer.format.keywordCase` | `upper` | Keyword casing for `SQL: Format Query` / format-on-save: `upper`, `lower`, or `preserve`. |
| `sqlExplorer.savedQueries` | `[]` | Saved queries. Managed by the Saved Queries view. |

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

- **Enterprise authentication** — OAuth2, JWT, and Kerberos beyond the current user and password.
- **Natural ordering for text sorts** — restore `item9` before `item10` for text columns without the performance cost.

Suggestions and issues are welcome at the [project repository](https://github.com/Abhishek009/SQL-Query-Explorer).

## Notes

The SQL console executes directly against the configured coordinator. Use appropriate `LIMIT` clauses and follow your organization's data-access policies.

## License

[MIT](LICENSE)
