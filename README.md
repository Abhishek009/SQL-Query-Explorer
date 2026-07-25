# Trino Explorer (Phase 1)

A VS Code extension that connects to a Trino coordinator and lists its catalogs in the Trino activity-bar view.

## Use

1. Run `npm install` and `npm run compile`.
2. Open the project in VS Code and press `F5` to launch the Extension Development Host.
3. Select the Trino icon in the Activity Bar, then choose **Configure Connection**.
4. In the connection window, enter the host, port, SSL/HTTPS choice, user, and any optional password, catalog, or schema. Passwords are held in VS Code Secret Storage.
5. Select **Save & Connect** (or use Refresh in the Catalogs view).
6. Select **Trino: New SQL Query** from the Command Palette or the query button in the Catalogs view. This opens a native VS Code SQL editor, so normal SQL editor features and GitHub Copilot are available.
7. Select **Trino: Run SQL Query** from the editor title bar or press `Cmd+Enter` / `Ctrl+Enter`. If text is selected, only the selection runs; otherwise the whole editor runs. Results open in a separate Trino Query Results panel.

The Explorer displays a lazy hierarchy of **connection → catalog → schema → table**. Expand a catalog or schema to load its contents from Trino. The extension builds the coordinator URL from the host, port, and SSL choice, then uses Trino's `/v1/statement` endpoint to load metadata and execute SQL. Query results are shown in a table in the SQL Console. Optional default `catalog` and `schema` can also be set under `trino.connection` settings.

The SQL Console is intended for direct execution against the configured coordinator. Use appropriate `LIMIT` clauses and follow your organization's data-access policies.
