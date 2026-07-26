# Trino Explorer

A VS Code extension that connects to a [Trino](https://trino.io) coordinator, lets you browse its catalogs, schemas, and tables from the Activity Bar, and run SQL against it without leaving the editor.

## Features

### Connection management
- **Configure Connection** window for host, port, SSL/HTTPS, user, and optional password, catalog, and schema.
- **Paste a JDBC connection string or a full URL into the Host field** and the rest of the form fills itself in — see [Connection URL formats](#connection-url-formats).
- Passwords are stored in **VS Code Secret Storage**, never in `settings.json`.
- The coordinator URL is built from the host, port, and SSL choice; all metadata and query traffic goes through Trino's `/v1/statement` endpoint.
- Connection defaults are also editable under the `trino.connection` settings section.

#### Connection URL formats

The Host field and the `trino.connection.url` setting both accept a plain host name, an HTTP(S) URL, or a Trino JDBC connection string. JDBC URLs are translated to the equivalent REST endpoint:

| You enter | Resolves to |
| --- | --- |
| `trino.example.com` | `http://trino.example.com:8080` |
| `https://trino.example.com:8443` | `https://trino.example.com:8443` |
| `jdbc:trino://trino.example.com:8443/hive/default?SSL=true` | `https://trino.example.com:8443`, catalog `hive`, schema `default` |
| `jdbc:trino://localhost:8080/tpch` | `http://localhost:8080`, catalog `tpch` |

Details:
- `SSL=true` selects HTTPS, as does port `443`. Parameter names are matched case-insensitively.
- A `/catalog/schema` path and a `user=` parameter populate those fields; anything you have already typed into the form takes precedence.
- `jdbc:presto://` is accepted for older deployments.
- A password in the URL is **ignored by design**, so it never lands in `settings.json` in clear text — enter it in the form instead, where it goes to Secret Storage.
- JDBC-only parameters such as `SSLVerification`, `KerberosRemoteServiceName`, and `extraCredentials` are parsed but not yet applied.

### Catalog explorer
- Dedicated **Trino** container in the Activity Bar with a **Catalogs** tree view.
- Lazy hierarchy of **connection → catalog → schema → table** — children are fetched from Trino only when you expand a node.
- **Refresh** action to reload catalogs after changes on the coordinator.

### SQL editor and execution
- **Trino: New SQL Query** opens a native VS Code SQL editor, so normal editing features, syntax highlighting, and GitHub Copilot all work.
- **Trino: Run SQL Query** from the editor title bar or `Cmd+Enter` / `Ctrl+Enter`. If text is selected only the selection runs; otherwise the whole editor runs.
- Results render as a table in a separate **Trino Query Results** panel.
- Long-running statements show a cancellable progress indicator and abort the underlying HTTP request when cancelled.

### Commands

| Command | Description |
| --- | --- |
| `Trino: Connect` | Connect using the saved configuration and load catalogs. |
| `Trino: Configure Connection` | Open the connection window to edit connection details. |
| `Trino: New SQL Query` | Open a new SQL editor bound to the connection. |
| `Trino: Run SQL Query` | Execute the selection, or the whole editor if nothing is selected. |
| `Trino: Refresh Catalogs` | Reload the catalog tree. |

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `trino.connection.name` | `Trino Connection` | Display name for the connection in the Explorer. |
| `trino.connection.url` | `http://localhost:8080` | Coordinator URL. Accepts `http(s)://host:port` or a JDBC string such as `jdbc:trino://host:port/catalog/schema?SSL=true`. |
| `trino.connection.user` | _(empty)_ | User sent in the `X-Trino-User` header. |
| `trino.connection.catalog` | _(empty)_ | Optional catalog used for the session. |
| `trino.connection.schema` | _(empty)_ | Optional schema used for the session. |

## Getting started

1. Install the extension, or run it from source:
   ```bash
   npm install
   npm run compile
   ```
   Then open the project in VS Code and press `F5` to launch the Extension Development Host.
2. Select the Trino icon in the Activity Bar, then choose **Configure Connection**.
3. Enter the host, port, SSL/HTTPS choice, user, and any optional password, catalog, or schema. You can also paste a full `jdbc:trino://…` or `http(s)://…` URL into **Host** and let the other fields populate themselves.
4. Select **Save & Connect** (or use **Refresh** in the Catalogs view).
5. Expand a catalog to browse its schemas and tables.
6. Run **Trino: New SQL Query**, write a statement, and execute it with `Cmd+Enter` / `Ctrl+Enter`.

## Roadmap

Planned additions, roughly in the order they are being worked on.

### Next up
- **Multiple saved connections** — manage several coordinators (dev / stage / prod), switch between them in the Explorer, and see them side by side in the tree instead of the single connection supported today.
- **Export query results** — save or copy the results grid as CSV or JSON.
- **Table preview and DDL** — right-click a table to inspect column names and types, preview rows with a bounded `SELECT`, and generate `SHOW CREATE TABLE`.

### Later
- **SQL autocomplete from live metadata** — IntelliSense for catalog, schema, table, and column names driven by the connected coordinator.

Suggestions and issues are welcome at the [project repository](https://github.com/Abhishek009/trino-plugin).

## Notes

The SQL console executes directly against the configured coordinator. Use appropriate `LIMIT` clauses and follow your organization's data-access policies.

## License

[MIT](LICENSE)
