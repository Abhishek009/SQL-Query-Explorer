import * as vscode from 'vscode';
import { TrinoColumn } from './types';
import { escapeHtml } from './util';

export interface ImportMessage {
    type: 'import';
    /** Column name -> index into the file's header row, or -1 to leave that column out. */
    mapping: Record<string, number>;
    truncateFirst: boolean;
}

export function isImportMessage(value: unknown): value is ImportMessage {
    return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'import';
}

/**
 * Lets the user match the CSV file's columns to the target table's before
 * anything is written. Defaults each target column to the file column with
 * the same name, case-insensitively, when one exists.
 */
export function importFormHtml(
    webview: vscode.Webview,
    fileName: string,
    tableLabel: string,
    headers: string[],
    previewRows: string[][],
    totalDataRows: number,
    columns: TrinoColumn[]
): string {
    const nonce = String(Date.now());
    const byLowerName = new Map(headers.map((header, index) => [header.trim().toLowerCase(), index]));

    const styles = `
:root{--gap:12px;--radius:6px}
*{box-sizing:border-box}
body{color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px;margin:0;padding:22px 20px 96px}
.page{max-width:720px;margin:0 auto}
h1{font-size:1.3em;margin:0 0 4px;font-weight:600}
.sub{color:var(--vscode-descriptionForeground);margin:0 0 18px;font-size:.92em}
.card{border:1px solid var(--vscode-panel-border,rgba(128,128,128,.32));border-radius:var(--radius);background:var(--vscode-editorWidget-background,rgba(128,128,128,.05));padding:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:5px 8px;font-size:.92em;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.25))}
th{color:var(--vscode-descriptionForeground);font-weight:600;white-space:nowrap}
select{width:100%;padding:4px 6px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(128,128,128,.5));border-radius:4px;font-family:inherit;font-size:13px}
.mono{font-family:var(--vscode-editor-font-family,monospace);font-size:.9em}
.dim{color:var(--vscode-descriptionForeground)}
.preview{overflow-x:auto;max-height:220px;overflow-y:auto}
.switch{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;margin-top:10px}
.actions{position:fixed;left:0;right:0;bottom:0;display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;background:var(--vscode-editor-background,#1f1f1f);border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.3))}
.actions-inner{width:100%;max-width:720px;margin:0 auto;display:flex;justify-content:flex-end;gap:10px}
button{padding:7px 18px;border:0;border-radius:4px;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button:hover{background:var(--vscode-button-hoverBackground)}
button.secondary{color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));background:var(--vscode-button-secondaryBackground,transparent);border:1px solid var(--vscode-panel-border,rgba(128,128,128,.45))}
button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground,rgba(128,128,128,.16))}
.alert{display:none;margin-bottom:14px;padding:9px 12px;border-radius:4px;color:var(--vscode-inputValidation-errorForeground,var(--vscode-foreground));background:var(--vscode-inputValidation-errorBackground,rgba(190,60,60,.16));border:1px solid var(--vscode-inputValidation-errorBorder,rgba(190,60,60,.7))}
.alert.show{display:block}`;

    const headerOptions = (selected: number) => [
        `<option value="-1"${selected === -1 ? ' selected' : ''}>— Skip (leave NULL) —</option>`,
        ...headers.map((header, index) =>
            `<option value="${index}"${index === selected ? ' selected' : ''}>${escapeHtml(header)}</option>`)
    ].join('');

    const columnRows = columns.map(column => {
        const matched = byLowerName.get(column.name.trim().toLowerCase());
        const selected = matched ?? -1;
        return `<tr>
      <td><span class="mono">${escapeHtml(column.name)}</span><br><span class="dim">${escapeHtml(column.type)}${column.extra ? ` · ${escapeHtml(column.extra)}` : ''}</span></td>
      <td><select data-column="${escapeHtml(column.name)}">${headerOptions(selected)}</select></td>
    </tr>`;
    }).join('');

    const previewHead = headers.map(header => `<th>${escapeHtml(header)}</th>`).join('');
    const previewBody = previewRows.map(row =>
        `<tr>${headers.map((_, index) => `<td>${escapeHtml(row[index] ?? '')}</td>`).join('')}</tr>`
    ).join('');

    const body = `
<div class="page">
  <h1>Import into ${escapeHtml(tableLabel)}</h1>
  <p class="sub">${escapeHtml(fileName)} — ${totalDataRows.toLocaleString()} data row(s)</p>
  <div id="error" class="alert" role="alert"></div>

  <div class="card">
    <table><thead><tr><th>Table column</th><th>File column</th></tr></thead>
    <tbody>${columnRows}</tbody></table>
  </div>

  <div class="card">
    <div class="dim" style="margin-bottom:8px">Preview — first ${previewRows.length} row(s)</div>
    <div class="preview"><table><thead><tr>${previewHead}</tr></thead><tbody>${previewBody}</tbody></table></div>
  </div>

  <label class="switch"><input id="truncate" type="checkbox"><span>Delete existing rows first</span></label>
</div>
<div class="actions">
  <div class="actions-inner">
    <button type="button" id="cancel" class="secondary">Cancel</button>
    <button type="button" id="submit">Import ${totalDataRows.toLocaleString()} Row(s)</button>
  </div>
</div>`;

    const script = `const vscode=acquireVsCodeApi();
const byId=id=>document.getElementById(id);
byId('cancel').addEventListener('click',()=>{vscode.postMessage({type:'cancel'});});
byId('submit').addEventListener('click',()=>{
  const mapping={};
  document.querySelectorAll('select[data-column]').forEach(sel=>{ mapping[sel.dataset.column]=Number(sel.value); });
  const mapped=Object.values(mapping).some(v=>v>=0);
  const box=byId('error');
  if(!mapped){ box.textContent='Map at least one column before importing.'; box.classList.add('show'); return; }
  box.classList.remove('show');
  vscode.postMessage({type:'import', mapping, truncateFirst:byId('truncate').checked});
});`;

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Import Data</title><style>${styles}</style></head><body>${body}<script nonce="${nonce}">${script}</script></body></html>`;
}
