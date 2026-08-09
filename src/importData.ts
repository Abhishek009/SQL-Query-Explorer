import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { createClient } from './client';
import { ExplorerItem, TrinoExplorerProvider } from './explorer';
import { RunningQueryRegistry } from './runningQueries';
import { parseCsv } from './csv';
import { importFormHtml, isImportMessage } from './importForm';
import { quoteIdentifier, quoteLiteral, summarize } from './util';

/** Rows per INSERT statement — large enough to be fast, small enough that one
 *  statement never gets close to a coordinator's/driver's max-query-size limit. */
const BATCH_SIZE = 500;

const NUMERIC_TYPE = /^(int|integer|bigint|smallint|tinyint|float|double|decimal|numeric|real)/i;

/** A cell's SQL literal, typed by the target column rather than guessed from the text. */
export function cellLiteral(raw: string | undefined, columnType: string): string {
    if (raw === undefined || raw === '') { return 'NULL'; }
    if (NUMERIC_TYPE.test(columnType)) {
        return Number.isFinite(Number(raw)) ? raw : 'NULL';
    }
    return quoteLiteral(raw);
}

export async function importDataFromFile(
    store: ConnectionStore,
    secrets: vscode.SecretStorage,
    provider: TrinoExplorerProvider,
    registry: RunningQueryRegistry,
    item?: ExplorerItem
): Promise<void> {
    const connection = store.get(item?.connectionId);
    if (!connection || !item?.catalog || !item.schema || !item.table || item.contextValue !== 'sqlExplorer.table') { return; }
    const { catalog, schema, table } = item;
    const tableLabel = `${schema}.${table}`;

    const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        title: `Import data into ${tableLabel}`,
        filters: { 'CSV files': ['csv'] }
    });
    if (!picked?.[0]) { return; }

    const bytes = await vscode.workspace.fs.readFile(picked[0]);
    const rows = parseCsv(Buffer.from(bytes).toString('utf8'));
    if (rows.length === 0) {
        vscode.window.showWarningMessage(`${picked[0].fsPath} is empty.`);
        return;
    }
    const [headers, ...dataRows] = rows;
    if (dataRows.length === 0) {
        vscode.window.showWarningMessage('The file has a header row but no data rows.');
        return;
    }

    const client = createClient(secrets, connection, registry);
    const columns = await client.columns(catalog, schema, table);
    if (!columns.length) {
        vscode.window.showErrorMessage(`Could not read the columns of ${tableLabel}.`);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'sqlExplorerImport',
        `Import into ${table}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = importFormHtml(
        panel.webview,
        picked[0].fsPath.split('/').pop() ?? picked[0].fsPath,
        tableLabel,
        headers,
        dataRows.slice(0, 5),
        dataRows.length,
        columns
    );

    panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!isImportMessage(message)) { panel.dispose(); return; }
        const mapped = columns
            .map(column => ({ column, sourceIndex: message.mapping[column.name] ?? -1 }))
            .filter(entry => entry.sourceIndex >= 0);
        if (!mapped.length) { return; }

        const qualified = client.qualify(catalog, schema, table);
        const columnList = mapped.map(entry => quoteIdentifier(entry.column.name)).join(', ');
        panel.dispose();

        let imported = 0;
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Importing into ${tableLabel}…`, cancellable: true },
                async (progress, token) => {
                    if (message.truncateFirst) {
                        await client.query(`DELETE FROM ${qualified}`, token, catalog);
                    }
                    for (let start = 0; start < dataRows.length; start += BATCH_SIZE) {
                        if (token.isCancellationRequested) { break; }
                        const batch = dataRows.slice(start, start + BATCH_SIZE);
                        const values = batch.map(row =>
                            `(${mapped.map(entry => cellLiteral(row[entry.sourceIndex], entry.column.type)).join(', ')})`
                        ).join(', ');
                        await client.query(`INSERT INTO ${qualified} (${columnList}) VALUES ${values}`, token, catalog);
                        imported += batch.length;
                        progress.report({
                            message: `${imported.toLocaleString()} / ${dataRows.length.toLocaleString()} row(s)`,
                            increment: (batch.length / dataRows.length) * 100
                        });
                    }
                }
            );
            provider.refreshItem(item);
            vscode.window.showInformationMessage(`Imported ${imported.toLocaleString()} row(s) into ${tableLabel}.`);
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(
                `Import into ${tableLabel} stopped after ${imported.toLocaleString()} row(s): ${summarize(text)}`
            );
            if (imported > 0) { provider.refreshItem(item); }
        }
    }, undefined);
}
