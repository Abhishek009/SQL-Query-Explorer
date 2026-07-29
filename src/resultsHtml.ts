import * as vscode from 'vscode';
import { ErrorState, ResultsState } from './types';
import { visibleRows } from './sorting';
import { formatDuration } from './util';

export function emptyResultsHtml(webview: vscode.Webview): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';"></head><body style="color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family);padding:14px">Run a query to see results here.</body></html>`;
}

export function queryErrorHtml(webview: vscode.Webview, state: ErrorState): string {
    const { connection, sql, message, details } = state;
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const detailBlock = details && details.trim() && details.trim() !== message.trim()
        ? `<h2>Server response</h2><pre class="details">${escape(details)}</pre>`
        : '';
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{color:var(--vscode-foreground);font-family:var(--vscode-font-family);margin:0;padding:10px 14px;height:100%;box-sizing:border-box;overflow:auto}h1{font-size:1.05em;margin:0 0 4px;color:var(--vscode-errorForeground)}h2{font-size:.95em;margin:20px 0 6px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.04em}.note{margin:0 0 14px;color:var(--vscode-descriptionForeground)}pre{font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,13px);white-space:pre-wrap;word-break:break-word;padding:12px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));border-radius:3px;background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.1));margin:0}pre.message{border-left:3px solid var(--vscode-errorForeground)}</style></head><body><h1>Query failed</h1><p class="note">${escape(connection.name)} — ${escape(connection.url)}</p><pre class="message">${escape(message)}</pre>${detailBlock}${sql ? `<h2>Statement</h2><pre>${escape(sql)}</pre>` : ''}</body></html>`;
}

export function sqlResultsHtml(webview: vscode.Webview, state: ResultsState): string {
    const { result, connection, limit } = state;
    const displayedRows = visibleRows(state);
    const nonce = String(Date.now());
    const escape = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const format = (value: unknown) => value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    const isNumeric = (value: unknown) => typeof value === 'number'
        || (typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value.trim()));
    const cell = (value: unknown) => {
        const text = format(value);
        const classes = value === null || value === undefined ? 'nul' : isNumeric(value) ? 'num' : '';
        const title = text.length > 60 ? ` title="${escape(text)}"` : '';
        return `<td class="${classes}"${title}>${escape(text)}</td>`;
    };
    const arrow = (index: number) => state.sort?.column === index ? (state.sort.direction === 'asc' ? ' ▲' : ' ▼') : '';
    const headers = `<th class="rownum"></th>${result.columns
        .map((column, index) => `<th class="sortable${state.sort?.column === index ? ' sorted' : ''}" data-col="${index}" title="Sort by ${escape(column)}">${escape(column)}<span class="arrow">${arrow(index)}</span></th>`)
        .join('')}`;
    const rows = displayedRows
        .map((row, index) => `<tr><th class="rownum">${index + 1}</th>${result.columns.map((_, column) => cell(row[column])).join('')}</tr>`)
        .join('');
    const fetched = result.rows.length;
    const note = state.subtitle ?? (fetched > displayedRows.length
        ? `${displayedRows.length.toLocaleString()} of ${fetched.toLocaleString()} rows`
        : `${fetched.toLocaleString()} row(s)`);
    const table = result.columns.length
        ? `<div class="results"><table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p>Statement completed. No rows returned.</p>';
    const info = [
        ['Connection', `${connection.name} (${connection.url})`],
        ['User', connection.user],
        ['Executed', new Date(state.executedAt).toLocaleString()],
        ['Duration', formatDuration(state.milliseconds)],
        ['Rows fetched', `${fetched.toLocaleString()}${result.truncated ? ` (capped at ${(result.maxRows ?? fetched).toLocaleString()})` : ''}`],
        ['Rows shown', `${displayedRows.length.toLocaleString()} (limit ${limit.toLocaleString()})`],
        ['Columns', String(result.columns.length)],
        ['Sorted by', state.sort ? `${result.columns[state.sort.column]} ${state.sort.direction === 'asc' ? 'ascending' : 'descending'}` : 'none']
    ].map(([label, value]) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join('');
    const infoPanel = `<div id="info" class="info" hidden><dl>${info}</dl>${state.sql ? `<div class="sqlwrap"><div class="sqllabel">Statement</div><pre>${escape(state.sql)}</pre></div>` : ''}</div>`;
    const capBanner = result.truncated
        ? `<div class="banner">Stopped at the ${(result.maxRows ?? fetched).toLocaleString()} row cap — the query had more rows. Raise <code>trino.query.maxRows</code>, or set a per-connection limit, to fetch more.</div>`
        : '';
    const toolbar = `<div class="bar"><span class="note"><b>${escape(connection.name)}</b> — ${note} · ${formatDuration(state.milliseconds)}</span><span class="spacer"></span><label for="limit">Limit</label><input id="limit" type="number" min="1" max="10000" step="50" value="${limit}" title="Maximum rows to display"><button id="info-toggle" class="ghost" title="Show query details">Info</button><button id="csv" title="Export displayed rows as CSV">CSV</button><button id="tsv" title="Export displayed rows as TSV">TSV</button></div>${capBanner}${infoPanel}`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>html,body{height:100%}body{display:flex;flex-direction:column;color:var(--vscode-foreground);font-family:var(--vscode-font-family);margin:0;padding:8px 12px;box-sizing:border-box;overflow:hidden}.bar{flex:0 0 auto;display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}.spacer{flex:1 1 auto}.note{color:var(--vscode-descriptionForeground);font-size:.9em}label{font-size:.9em;color:var(--vscode-descriptionForeground)}input{width:74px;padding:3px 6px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(128,128,128,.55));border-radius:2px}button{padding:3px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:2px;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}
button.ghost{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border,rgba(128,128,128,.45))}
button.ghost:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.18))}
.banner{flex:0 0 auto;margin:0 0 8px;padding:6px 10px;border-radius:3px;font-size:.9em;color:var(--vscode-inputValidation-warningForeground,var(--vscode-foreground));background:var(--vscode-inputValidation-warningBackground,rgba(190,145,23,.18));border:1px solid var(--vscode-inputValidation-warningBorder,rgba(190,145,23,.6))}
.banner code{background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.18));padding:0 4px;border-radius:2px}
.info{flex:0 0 auto;margin:0 0 8px;padding:10px 12px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));border-radius:4px;background:var(--vscode-textBlockQuote-background,rgba(128,128,128,.07));max-height:38%;overflow:auto}
.info dl{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;margin:0;font-size:.9em}
.info dt{color:var(--vscode-descriptionForeground);white-space:nowrap}
.info dd{margin:0}
.sqlwrap{margin-top:10px}
.sqllabel{color:var(--vscode-descriptionForeground);font-size:.85em;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
.info pre{margin:0;padding:8px 10px;white-space:pre-wrap;word-break:break-word;font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,12px);background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.12));border-radius:3px}
th.sortable{cursor:pointer}
th.sortable:hover{background-color:var(--vscode-list-hoverBackground,rgba(128,128,128,.2))}
th.sorted{color:var(--vscode-textLink-foreground,inherit)}
.arrow{font-size:.85em;opacity:.9}.results{flex:1 1 auto;min-height:0;overflow:auto;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));border-radius:4px}
table{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%;font-size:var(--vscode-editor-font-size,13px)}
thead th{position:sticky;top:0;z-index:2;background-color:var(--vscode-panel-background,var(--vscode-editor-background,#1f1f1f));background-clip:padding-box;box-shadow:0 1px 0 var(--vscode-panel-border,rgba(128,128,128,.4));border-right:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));font-weight:600;text-align:left;white-space:nowrap;padding:7px 14px 7px 12px;letter-spacing:.01em}
tbody td{padding:5px 12px;vertical-align:top;max-width:460px;overflow:hidden;text-overflow:ellipsis;white-space:pre-wrap;word-break:break-word;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.16));border-right:1px solid var(--vscode-panel-border,rgba(128,128,128,.24))}
tbody tr td:last-child,thead th:last-child{border-right:0}
tbody tr:nth-child(even){background:var(--vscode-tree-tableOddRowsBackground,rgba(128,128,128,.055))}
tbody tr:hover{background:var(--vscode-list-hoverBackground,rgba(128,128,128,.13))}
tbody tr:last-child td,tbody tr:last-child th{border-bottom:0}
.rownum{position:sticky;left:0;z-index:1;width:1%;white-space:nowrap;background-color:var(--vscode-panel-background,var(--vscode-editor-background,#1f1f1f));background-clip:padding-box;color:var(--vscode-editorLineNumber-foreground,rgba(128,128,128,.8));font-weight:400;text-align:right;padding:5px 8px;user-select:none;box-shadow:1px 0 0 var(--vscode-panel-border,rgba(128,128,128,.3));font-variant-numeric:tabular-nums}
thead .rownum{z-index:3}
.grip{position:absolute;top:0;right:0;width:7px;height:100%;cursor:col-resize;user-select:none}
.grip:hover,.grip.active{background:var(--vscode-focusBorder,rgba(128,128,128,.7))}
td.num{text-align:right;font-family:var(--vscode-editor-font-family,monospace);font-variant-numeric:tabular-nums}
td.nul{color:var(--vscode-descriptionForeground);font-style:italic;opacity:.75}</style></head><body>${toolbar}${table}<script nonce="${nonce}">const vscode=acquireVsCodeApi();const box=document.getElementById('limit');const send=()=>{const v=Number(box.value);if(Number.isFinite(v)&&v>0)vscode.postMessage({type:'limit',value:v});};box.addEventListener('change',send);box.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();send();}});document.getElementById('csv').addEventListener('click',()=>vscode.postMessage({type:'download',format:'csv'}));document.getElementById('tsv').addEventListener('click',()=>vscode.postMessage({type:'download',format:'tsv'}));
const info=document.getElementById('info');document.getElementById('info-toggle').addEventListener('click',()=>{info.hidden=!info.hidden;});
document.querySelectorAll('thead th.sortable').forEach(th=>{th.addEventListener('click',e=>{if(e.target.classList.contains('grip'))return;vscode.postMessage({type:'sort',value:Number(th.dataset.col)});});});
document.querySelectorAll('thead th:not(.rownum)').forEach(th=>{const grip=document.createElement('span');grip.className='grip';th.appendChild(grip);grip.addEventListener('mousedown',e=>{e.preventDefault();e.stopPropagation();const startX=e.clientX;const startWidth=th.offsetWidth;grip.classList.add('active');document.body.style.cursor='col-resize';const move=ev=>{const width=Math.max(48,startWidth+ev.clientX-startX);th.style.width=width+'px';th.style.minWidth=width+'px';th.style.maxWidth=width+'px';};const stop=()=>{grip.classList.remove('active');document.body.style.cursor='';document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',stop);};document.addEventListener('mousemove',move);document.addEventListener('mouseup',stop);});grip.addEventListener('dblclick',e=>{e.preventDefault();th.style.width='';th.style.minWidth='';th.style.maxWidth='';});});</script></body></html>`;
}
