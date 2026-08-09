import * as vscode from 'vscode';
import { trinoFieldsHtml } from './engines/trino/trinoConnectionFields';
import { postgresFieldsHtml } from './engines/postgres/postgresConnectionFields';
import { supabaseFieldsHtml } from './engines/supabase/supabaseConnectionFields';
import { sqliteFieldsHtml } from './engines/sqlite/sqliteConnectionFields';

export interface ConnectionFormData {
    name: string;
    engine: 'trino' | 'postgres' | 'supabase' | 'sqlite';
    host: string;
    port: string;
    sslEnabled: boolean;
    user: string;
    catalog: string;
    schema: string;
    database: string;
    /** SQLite only: the local file path, which doubles as the connection's URL. */
    file: string;
    maxRows: string;
}

export interface ConnectionMessage extends ConnectionFormData {
    /** `save` stores the connection; `test` only checks that it works. */
    type: 'save' | 'test';
    password: string;
    clearPassword: boolean;
    connect: boolean;
}

export function isConnectionMessage(value: unknown): value is ConnectionMessage {
    const type = (value as { type?: unknown } | null)?.type;
    return typeof value === 'object' && value !== null && (type === 'save' || type === 'test');
}

/** The SQLite tab's Browse button, asking the extension host for a native file picker. */
export function isBrowseFileMessage(value: unknown): value is { type: 'browseFile' } {
    return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'browseFile';
}

/** The SQLite tab's New Database button, asking the extension host to create an empty file. */
export function isCreateFileMessage(value: unknown): value is { type: 'createFile' } {
    return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'createFile';
}

/** Blank means "use the global cap", so an empty field stores nothing. */
export function parseMaxRows(value: string): number | undefined {
    const parsed = Number(value.trim());
    return value.trim() && Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

export function validateConnection(value: ConnectionMessage): string | undefined {
    if (value.engine === 'sqlite') {
        return value.file.trim() ? undefined : 'Choose a SQLite database file.';
    }
    if (/:\/\//.test(value.host)) { return 'Could not read that URL. Use a host name, http(s)://host:port, or jdbc:trino://host:port.'; }
    if (!value.host.trim()) { return 'Enter a host name, an IP address, or paste a JDBC/HTTP URL.'; }
    if (!/^\d+$/.test(value.port.trim()) || Number(value.port) < 1 || Number(value.port) > 65535) { return 'Port must be between 1 and 65535.'; }
    if (!value.user.trim()) { return 'A user name is required.'; }
    return undefined;
}

const BLANK: ConnectionFormData = {
    name: '', engine: 'trino', host: '', port: '', sslEnabled: false,
    user: '', catalog: '', schema: '', database: '', file: '', maxRows: ''
};

export function connectionFormHtml(webview: vscode.Webview, values: ConnectionFormData, isEdit: boolean, hasPassword: boolean): string {
    const nonce = String(Date.now());
    const passwordHint = hasPassword ? 'Leave blank to keep the saved password' : 'Optional';
    // Only the active engine's pane gets the real values; the other starts
    // blank rather than showing data that belongs to a different connection.
    const trinoValues = values.engine === 'trino' ? values : { ...BLANK, engine: 'trino' as const };
    const postgresValues = values.engine === 'postgres' ? values : { ...BLANK, engine: 'postgres' as const };
    const supabaseValues = values.engine === 'supabase' ? values : { ...BLANK, engine: 'supabase' as const };
    const sqliteValues = values.engine === 'sqlite' ? values : { ...BLANK, engine: 'sqlite' as const };

    const styles = `
:root{--gap:12px;--radius:6px}
*{box-sizing:border-box}
body{color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px;margin:0;padding:22px 20px 96px}
.page{max-width:560px;margin:0 auto}
.head{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.badge{flex:0 0 auto;width:44px;height:44px;border-radius:11px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,#2f7ce0,#1f4fa8);box-shadow:0 2px 8px rgba(0,0,0,.25)}
.badge svg{width:24px;height:24px}
h1{font-size:1.42em;margin:0;font-weight:600;letter-spacing:-.01em}
.card{border:1px solid var(--vscode-panel-border,rgba(128,128,128,.32));border-radius:var(--radius);background:var(--vscode-editorWidget-background,rgba(128,128,128,.05));padding:16px}
.card.compact{padding:14px 16px}
.field{margin-bottom:var(--gap)}
.field:last-child{margin-bottom:0}
label.lbl{display:block;margin:0 0 5px;font-weight:600;font-size:.95em}
.req{color:var(--vscode-charts-red,#e5534b);margin-left:2px}
input[type=text],input[type=password],input[type=number],input:not([type]){width:100%;padding:6px 9px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(128,128,128,.5));border-radius:4px;font-family:inherit;font-size:13px;transition:border-color .12s,box-shadow .12s}
input::placeholder{color:var(--vscode-input-placeholderForeground,rgba(128,128,128,.75))}
input:hover{border-color:var(--vscode-inputOption-hoverBackground,rgba(128,128,128,.7))}
input:focus{outline:none;border-color:var(--vscode-focusBorder,#2f7ce0);box-shadow:0 0 0 2px color-mix(in srgb,var(--vscode-focusBorder,#2f7ce0) 30%,transparent)}
.hint{margin:5px 0 0;font-size:.87em;color:var(--vscode-descriptionForeground);line-height:1.4}
.row{display:grid;grid-template-columns:minmax(0,1fr) 110px;gap:10px}
.row-eq{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.switch{display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none;margin:var(--gap) 0 0}
.switch input{position:absolute;opacity:0;width:0;height:0}
.track{position:relative;flex:0 0 auto;width:34px;height:19px;border-radius:19px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(128,128,128,.6));transition:background .15s,border-color .15s}
.track::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--vscode-descriptionForeground);transition:transform .15s,background .15s}
.switch input:checked+.track{background:var(--vscode-button-background,#2f7ce0);border-color:var(--vscode-button-background,#2f7ce0)}
.switch input:checked+.track::after{transform:translateX(15px);background:var(--vscode-button-foreground,#fff)}
.switch input:focus-visible+.track{box-shadow:0 0 0 2px color-mix(in srgb,var(--vscode-focusBorder,#2f7ce0) 45%,transparent)}
.switch-label{font-weight:600}
.switch.small .switch-label{font-weight:400;color:var(--vscode-descriptionForeground)}
.switch.small{margin-top:6px}
details.advanced{border:1px solid var(--vscode-panel-border,rgba(128,128,128,.32));border-radius:var(--radius);background:var(--vscode-editorWidget-background,rgba(128,128,128,.05));padding:10px 16px;margin-top:12px}
details.advanced[open]{padding-bottom:14px}
summary{cursor:pointer;font-weight:600;list-style:none;display:flex;align-items:center;gap:7px;color:var(--vscode-foreground);padding:2px 0}
summary::-webkit-details-marker{display:none}
summary::before{content:"\\25B8";display:inline-block;transition:transform .15s;color:var(--vscode-descriptionForeground)}
details[open] summary::before{transform:rotate(90deg)}
details.advanced .field{margin-top:12px;margin-bottom:0}
code{background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.16));padding:1px 5px;border-radius:3px;font-family:var(--vscode-editor-font-family,monospace);font-size:.92em}
.alert{display:none;align-items:flex-start;gap:8px;margin-bottom:14px;padding:9px 12px;border-radius:4px;color:var(--vscode-inputValidation-errorForeground,var(--vscode-foreground));background:var(--vscode-inputValidation-errorBackground,rgba(190,60,60,.16));border:1px solid var(--vscode-inputValidation-errorBorder,rgba(190,60,60,.7))}
.alert.show{display:flex}
.result{display:none;align-items:flex-start;gap:8px;margin-top:12px;padding:9px 12px;border-radius:4px;font-size:.95em;white-space:pre-wrap;word-break:break-word}
.result.show{display:flex}
.result.ok{color:var(--vscode-testing-iconPassed,#2ea043);background:rgba(46,160,67,.12);border:1px solid rgba(46,160,67,.5)}
.result.bad{color:var(--vscode-inputValidation-errorForeground,var(--vscode-foreground));background:var(--vscode-inputValidation-errorBackground,rgba(190,60,60,.16));border:1px solid var(--vscode-inputValidation-errorBorder,rgba(190,60,60,.7))}
.result.busy{color:var(--vscode-descriptionForeground);background:rgba(128,128,128,.12);border:1px solid var(--vscode-panel-border,rgba(128,128,128,.35))}
.alert::before{content:"\\26A0";flex:0 0 auto}
.actions{position:fixed;left:0;right:0;bottom:0;display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;background:var(--vscode-editor-background,#1f1f1f);border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.3))}
.actions-inner{width:100%;max-width:640px;margin:0 auto;display:flex;justify-content:flex-end;gap:10px}
.tabs-label{margin:0 0 8px;font-size:.78em;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--vscode-descriptionForeground)}
.tabs{display:flex;align-items:center;flex-wrap:wrap;gap:2px;margin-bottom:20px;padding-bottom:10px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.3))}
.tab{appearance:none;border:0;background:transparent;padding:5px 9px;font-family:inherit;font-size:13px;font-weight:600;color:var(--vscode-descriptionForeground);cursor:pointer;border-bottom:2px solid transparent;display:inline-flex;align-items:center;gap:6px;border-radius:4px}
.tab:hover{color:var(--vscode-foreground);background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.12))}
.tab.active{color:var(--vscode-foreground);border-bottom-color:var(--vscode-focusBorder,#2f7ce0)}
.tab-icon{flex:0 0 auto;width:15px;height:15px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;line-height:1}
.pane{display:none}
.pane.active{display:block}
button{padding:7px 18px;border:0;border-radius:4px;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button:hover{background:var(--vscode-button-hoverBackground)}
button.secondary{color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));background:var(--vscode-button-secondaryBackground,transparent);border:1px solid var(--vscode-panel-border,rgba(128,128,128,.45))}
button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground,rgba(128,128,128,.16))}
button:focus-visible{outline:2px solid var(--vscode-focusBorder,#2f7ce0);outline-offset:2px}
@media(max-width:520px){.row,.row-eq{grid-template-columns:1fr}}`;

    const isPostgres = values.engine === 'postgres';
    const isSupabase = values.engine === 'supabase';
    const isSqlite = values.engine === 'sqlite';
    const isTrino = !isPostgres && !isSupabase && !isSqlite;
    const tab = (active: boolean) => active ? ' active' : '';
    const selected = (active: boolean) => active ? 'true' : 'false';

    const body = `
<div class="page">
  <div class="head">
    <div class="badge"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#fff" d="M3 4h18v4H3zm3 6h12v4H6zm3 6h6v4H9z"/></svg></div>
    <div>
      <h1>${isEdit ? 'Edit connection' : 'Connect To DB'}</h1>
    </div>
  </div>
  <div id="error" class="alert" role="alert"></div>
  <p class="tabs-label">Server Type</p>
  <div class="tabs" role="tablist">
    <button type="button" class="tab${tab(isTrino)}" data-pane="trino" data-engine="trino" role="tab" aria-selected="${selected(isTrino)}"><span class="tab-icon" style="background:#dd4b39">T</span>Trino</button>
    <button type="button" class="tab${tab(isPostgres)}" data-pane="postgres" data-engine="postgres" role="tab" aria-selected="${selected(isPostgres)}"><span class="tab-icon" style="background:#336791">P</span>PostgreSQL</button>
    <button type="button" class="tab${tab(isSupabase)}" data-pane="supabase" data-engine="supabase" role="tab" aria-selected="${selected(isSupabase)}"><span class="tab-icon" style="background:#3ecf8e">⚡</span>Supabase</button>
    <button type="button" class="tab${tab(isSqlite)}" data-pane="sqlite" data-engine="sqlite" role="tab" aria-selected="${selected(isSqlite)}"><span class="tab-icon" style="background:#003b57">L</span>SQLite</button>
  </div>
  <form id="connection">
   <div class="pane${tab(isTrino)}" data-pane="trino">${trinoFieldsHtml(trinoValues, passwordHint, hasPassword)}
   </div>
   <div class="pane${tab(isPostgres)}" data-pane="postgres">${postgresFieldsHtml(postgresValues, passwordHint, hasPassword)}
   </div>
   <div class="pane${tab(isSupabase)}" data-pane="supabase">${supabaseFieldsHtml(supabaseValues, passwordHint, hasPassword)}
   </div>
   <div class="pane${tab(isSqlite)}" data-pane="sqlite">${sqliteFieldsHtml(sqliteValues)}
   </div>
   <div id="result" class="result" role="status"></div>
  </form>
</div>
<div class="actions">
  <div class="actions-inner">
    <button type="button" id="test" class="secondary">Test Connection</button>
    <button type="submit" form="connection" class="secondary" data-connect="false">Save</button>
    <button type="submit" form="connection" data-connect="true">Save &amp; Connect</button>
  </div>
</div>`;

    const script = `const vscode=acquireVsCodeApi();
const byId=id=>document.getElementById(id);
let connect=true;
let engine='${values.engine}';

// Every tab just swaps which pane is visible; Trino/PostgreSQL additionally
// pick which engine's fields payload() reads from at submit time.
document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>{
  document.querySelectorAll('.tab').forEach(t=>{t.classList.remove('active');t.setAttribute('aria-selected','false');});
  document.querySelectorAll('.pane').forEach(p=>p.classList.remove('active'));
  tab.classList.add('active');
  tab.setAttribute('aria-selected','true');
  document.querySelector('.pane[data-pane="'+tab.dataset.pane+'"]').classList.add('active');
  if(tab.dataset.engine){ engine=tab.dataset.engine; }
}));

function trinoPayload(kind){
  const port=byId('t-port');
  return {type:kind,engine:'trino',name:byId('t-name').value,host:byId('t-host').value,
    port:port.value.trim()||port.placeholder,sslEnabled:byId('t-ssl').checked,user:byId('t-user').value,
    password:byId('t-password').value,clearPassword:byId('t-clearPassword').checked,
    catalog:byId('t-catalog').value,schema:byId('t-schema').value,database:'',
    maxRows:byId('t-maxRows').value,connect};
}
function postgresPayload(kind){
  const port=byId('p-port');
  return {type:kind,engine:'postgres',name:byId('p-name').value,host:byId('p-host').value,
    port:port.value.trim()||port.placeholder,sslEnabled:byId('p-ssl').checked,user:byId('p-user').value,
    password:byId('p-password').value,clearPassword:byId('p-clearPassword').checked,
    catalog:'',schema:'',database:byId('p-database').value,
    maxRows:byId('p-maxRows').value,connect};
}
function supabasePayload(kind){
  const port=byId('s-port'), user=byId('s-user');
  return {type:kind,engine:'supabase',name:byId('s-name').value,host:byId('s-host').value,
    port:port.value.trim()||port.placeholder,sslEnabled:byId('s-ssl').checked,user:user.value.trim()||user.placeholder,
    password:byId('s-password').value,clearPassword:byId('s-clearPassword').checked,
    catalog:'',schema:'',database:byId('s-database').value,
    maxRows:byId('s-maxRows').value,connect};
}
function sqlitePayload(kind){
  return {type:kind,engine:'sqlite',name:byId('l-name').value,host:'',port:'',sslEnabled:false,user:'',
    password:'',clearPassword:false,catalog:'',schema:'',database:'',file:byId('l-file').value,
    maxRows:byId('l-maxRows').value,connect};
}
const payloadByEngine={postgres:postgresPayload,supabase:supabasePayload,sqlite:sqlitePayload,trino:trinoPayload};
function payload(kind){ return payloadByEngine[engine](kind); }

document.querySelectorAll('button[type=submit]').forEach(b=>b.addEventListener('click',()=>{connect=b.dataset.connect==='true';}));
byId('connection').addEventListener('submit',e=>{e.preventDefault();vscode.postMessage(payload('save'));});
byId('test').addEventListener('click',()=>{
  const box=byId('result');
  box.className='result show busy';
  box.textContent='Testing connection…';
  vscode.postMessage(payload('test'));
});
byId('l-browse').addEventListener('click',()=>{ vscode.postMessage({type:'browseFile'}); });
byId('l-new').addEventListener('click',()=>{ vscode.postMessage({type:'createFile'}); });
window.addEventListener('message',e=>{
  if(e.data.type==='error'){
    const box=byId('error'); box.textContent=e.data.message; box.classList.add('show'); box.scrollIntoView({block:'nearest'});
  }
  if(e.data.type==='testResult'){
    const box=byId('result');
    box.className='result show '+(e.data.ok?'ok':'bad');
    box.textContent=e.data.message;
    box.scrollIntoView({block:'nearest'});
  }
  if(e.data.type==='fileChosen'){
    byId('l-file').value=e.data.path;
  }
});
const focusIds={trino:'t-host',postgres:'p-host',supabase:'s-host',sqlite:'l-file'};
byId(focusIds[engine]).focus();`;

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Trino Connection</title><style>${styles}</style></head><body>${body}<script nonce="${nonce}">${script}</script></body></html>`;
}
