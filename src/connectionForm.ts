import * as vscode from 'vscode';
import { parseTrinoUrl } from './urls';

export interface ConnectionFormData {
    name: string;
    host: string;
    port: string;
    sslEnabled: boolean;
    user: string;
    catalog: string;
    schema: string;
    maxRows: string;
}

export interface ConnectionMessage extends ConnectionFormData {
    type: 'save';
    password: string;
    clearPassword: boolean;
    connect: boolean;
}

export function isConnectionMessage(value: unknown): value is ConnectionMessage {
    return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'save';
}

/**
 * Lets the Host field accept a whole URL — pasting jdbc:trino://host:port/catalog
 * fills in the host, port, SSL, catalog, schema, and user instead of failing.
 * Values already typed into those fields win over the ones in the URL.
 */
export function expandPastedUrl(message: ConnectionMessage): ConnectionMessage {
    const parsed = parseTrinoUrl(message.host);
    if (!parsed) { return message; }
    return {
        ...message,
        host: parsed.host,
        port: parsed.port ?? message.port,
        sslEnabled: parsed.sslEnabled ?? message.sslEnabled,
        user: message.user.trim() || parsed.user,
        catalog: message.catalog.trim() || parsed.catalog,
        schema: message.schema.trim() || parsed.schema
    };
}

/** Blank means "use the global cap", so an empty field stores nothing. */
export function parseMaxRows(value: string): number | undefined {
    const parsed = Number(value.trim());
    return value.trim() && Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

export function validateConnection(value: ConnectionMessage): string | undefined {
    if (/:\/\//.test(value.host)) { return 'Could not read that URL. Use a host name, http(s)://host:port, or jdbc:trino://host:port.'; }
    if (!value.host.trim()) { return 'Enter a host name, an IP address, or paste a JDBC/HTTP URL.'; }
    if (!/^\d+$/.test(value.port.trim()) || Number(value.port) < 1 || Number(value.port) > 65535) { return 'Port must be between 1 and 65535.'; }
    if (!value.user.trim()) { return 'Trino user is required.'; }
    return undefined;
}

export function connectionFormHtml(webview: vscode.Webview, values: ConnectionFormData, isEdit: boolean, hasPassword: boolean): string {
    const nonce = String(Date.now());
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const passwordHint = hasPassword ? 'Leave blank to keep the saved password' : 'Optional';
    const forgetRow = hasPassword
        ? '<label class="switch small"><input id="clearPassword" type="checkbox"><span class="track"></span><span class="switch-label">Forget the saved password</span></label>'
        : '<input id="clearPassword" type="checkbox" hidden>';
    const advancedOpen = values.catalog || values.schema || values.maxRows ? ' open' : '';

    const styles = `
:root{--gap:18px;--radius:6px}
*{box-sizing:border-box}
body{color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px;margin:0;padding:28px 20px 96px}
.page{max-width:640px;margin:0 auto}
.head{display:flex;align-items:flex-start;gap:14px;margin-bottom:22px}
.badge{flex:0 0 auto;width:38px;height:38px;border-radius:10px;display:grid;place-items:center;font-size:17px;font-weight:700;color:#fff;background:linear-gradient(135deg,#2f7ce0,#1f4fa8);box-shadow:0 2px 8px rgba(0,0,0,.25)}
h1{font-size:1.32em;margin:0 0 4px;font-weight:600;letter-spacing:-.01em}
.sub{margin:0;color:var(--vscode-descriptionForeground);line-height:1.5}
.card{border:1px solid var(--vscode-panel-border,rgba(128,128,128,.32));border-radius:var(--radius);background:var(--vscode-editorWidget-background,rgba(128,128,128,.05));padding:16px 18px 20px;margin-bottom:14px}
.card-title{display:flex;align-items:center;gap:8px;font-size:.78em;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--vscode-descriptionForeground);margin:0 0 14px}
.card-title::after{content:"";flex:1 1 auto;height:1px;background:var(--vscode-panel-border,rgba(128,128,128,.25))}
.field{margin-bottom:var(--gap)}
.field:last-child{margin-bottom:0}
label.lbl{display:block;margin:0 0 6px;font-weight:600}
.req{color:var(--vscode-charts-red,#e5534b);margin-left:2px}
input[type=text],input[type=password],input[type=number],input:not([type]){width:100%;padding:7px 10px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(128,128,128,.5));border-radius:4px;font-family:inherit;font-size:13px;transition:border-color .12s,box-shadow .12s}
input::placeholder{color:var(--vscode-input-placeholderForeground,rgba(128,128,128,.75))}
input:hover{border-color:var(--vscode-inputOption-hoverBackground,rgba(128,128,128,.7))}
input:focus{outline:none;border-color:var(--vscode-focusBorder,#2f7ce0);box-shadow:0 0 0 2px color-mix(in srgb,var(--vscode-focusBorder,#2f7ce0) 30%,transparent)}
.hint{margin:6px 0 0;font-size:.9em;color:var(--vscode-descriptionForeground);line-height:1.45}
.row{display:grid;grid-template-columns:minmax(0,1fr) 130px;gap:12px}
.switch{display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none;margin:0}
.switch input{position:absolute;opacity:0;width:0;height:0}
.track{position:relative;flex:0 0 auto;width:34px;height:19px;border-radius:19px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(128,128,128,.6));transition:background .15s,border-color .15s}
.track::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--vscode-descriptionForeground);transition:transform .15s,background .15s}
.switch input:checked+.track{background:var(--vscode-button-background,#2f7ce0);border-color:var(--vscode-button-background,#2f7ce0)}
.switch input:checked+.track::after{transform:translateX(15px);background:var(--vscode-button-foreground,#fff)}
.switch input:focus-visible+.track{box-shadow:0 0 0 2px color-mix(in srgb,var(--vscode-focusBorder,#2f7ce0) 45%,transparent)}
.switch-label{font-weight:600}
.switch.small .switch-label{font-weight:400;color:var(--vscode-descriptionForeground)}
.switch.small{margin-top:10px}
details{border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.22));margin-top:2px;padding-top:12px}
summary{cursor:pointer;font-weight:600;list-style:none;display:flex;align-items:center;gap:7px;color:var(--vscode-foreground)}
summary::-webkit-details-marker{display:none}
summary::before{content:"\\25B8";display:inline-block;transition:transform .15s;color:var(--vscode-descriptionForeground)}
details[open] summary::before{transform:rotate(90deg)}
.details-body{margin-top:16px}
code{background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.16));padding:1px 5px;border-radius:3px;font-family:var(--vscode-editor-font-family,monospace);font-size:.92em}
.alert{display:none;align-items:flex-start;gap:8px;margin-bottom:14px;padding:9px 12px;border-radius:4px;color:var(--vscode-inputValidation-errorForeground,var(--vscode-foreground));background:var(--vscode-inputValidation-errorBackground,rgba(190,60,60,.16));border:1px solid var(--vscode-inputValidation-errorBorder,rgba(190,60,60,.7))}
.alert.show{display:flex}
.alert::before{content:"\\26A0";flex:0 0 auto}
.actions{position:fixed;left:0;right:0;bottom:0;display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;background:var(--vscode-editor-background,#1f1f1f);border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.3))}
.actions-inner{width:100%;max-width:640px;margin:0 auto;display:flex;justify-content:flex-end;gap:10px}
button{padding:7px 18px;border:0;border-radius:4px;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button:hover{background:var(--vscode-button-hoverBackground)}
button.secondary{color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));background:var(--vscode-button-secondaryBackground,transparent);border:1px solid var(--vscode-panel-border,rgba(128,128,128,.45))}
button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground,rgba(128,128,128,.16))}
button:focus-visible{outline:2px solid var(--vscode-focusBorder,#2f7ce0);outline-offset:2px}
@media(max-width:520px){.row{grid-template-columns:1fr}}`;

    const body = `
<div class="page">
  <div class="head">
    <div class="badge">T</div>
    <div>
      <h1>${isEdit ? 'Edit connection' : 'New Trino connection'}</h1>
      <p class="sub">Point the explorer at a Trino coordinator. </p>
    </div>
  </div>
  <div id="error" class="alert" role="alert"></div>
  <form id="connection">
    <section class="card">
      <h2 class="card-title">Coordinator</h2>
      <div class="field">
        <label class="lbl" for="name">Connection name</label>
        <input id="name" value="${escape(values.name)}" placeholder="Development Trino">
        <p class="hint">Shown in the Connections view.</p>
      </div>
      <div class="field row">
        <div>
          <label class="lbl" for="host">Host<span class="req">*</span></label>
          <input id="host" value="${escape(values.host)}" placeholder="trino.example.com" required>
        </div>
        <div>
          <label class="lbl" for="port">Port<span class="req">*</span></label>
          <input id="port" type="number" min="1" max="65535" value="${escape(values.port)}" required>
        </div>
      </div>
      <label class="switch">
        <input id="sslEnabled" type="checkbox" ${values.sslEnabled ? 'checked' : ''}>
        <span class="track"></span>
        <span class="switch-label">Enable SSL / HTTPS</span>
      </label>
      <p class="hint">Required when the coordinator serves TLS. Ports 443 and 8443 enable this automatically.</p>
    </section>

    <section class="card">
      <h2 class="card-title">Authentication</h2>
      <div class="field">
        <label class="lbl" for="user">User<span class="req">*</span></label>
        <input id="user" value="${escape(values.user)}" required placeholder="your.username">
        <p class="hint">Sent as the <code>X-Trino-User</code> header.</p>
      </div>
      <div class="field">
        <label class="lbl" for="password">Password</label>
        <input id="password" type="password" autocomplete="new-password" placeholder="${passwordHint}">
        <p class="hint">Stored in VS Code Secret Storage, never in settings.json.</p>
        ${forgetRow}
      </div>
    </section>

    <section class="card">
      <details${advancedOpen}>
        <summary>Session defaults and limits</summary>
        <div class="details-body">
          <div class="field row">
            <div>
              <label class="lbl" for="catalog">Default catalog</label>
              <input id="catalog" value="${escape(values.catalog)}" placeholder="hive">
            </div>
            <div>
              <label class="lbl" for="schema">Default schema</label>
              <input id="schema" value="${escape(values.schema)}" placeholder="default">
            </div>
          </div>
          <div class="field">
            <label class="lbl" for="maxRows">Maximum rows to fetch</label>
            <input id="maxRows" type="number" min="1" max="1000000" value="${escape(values.maxRows)}" placeholder="Leave blank to use the global setting">
            <p class="hint">Caps how many rows are pulled from a single statement. Blank uses <code>trino.query.maxRows</code>.</p>
          </div>
        </div>
      </details>
    </section>
  </form>
</div>
<div class="actions">
  <div class="actions-inner">
    <button type="submit" form="connection" class="secondary" data-connect="false">Save</button>
    <button type="submit" form="connection" data-connect="true">Save &amp; Connect</button>
  </div>
</div>`;

    const script = `const vscode=acquireVsCodeApi();let connect=true;
document.querySelectorAll('button[type=submit]').forEach(b=>b.addEventListener('click',()=>{connect=b.dataset.connect==='true';}));
document.getElementById('connection').addEventListener('submit',e=>{e.preventDefault();const byId=id=>document.getElementById(id);
vscode.postMessage({type:'save',name:byId('name').value,host:byId('host').value,port:byId('port').value,sslEnabled:byId('sslEnabled').checked,user:byId('user').value,password:byId('password').value,clearPassword:byId('clearPassword').checked,catalog:byId('catalog').value,schema:byId('schema').value,maxRows:byId('maxRows').value,connect});});
window.addEventListener('message',e=>{if(e.data.type==='error'){const box=document.getElementById('error');box.textContent=e.data.message;box.classList.add('show');box.scrollIntoView({block:'nearest'});}});
document.getElementById('host').focus();`;

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Trino Connection</title><style>${styles}</style></head><body>${body}<script nonce="${nonce}">${script}</script></body></html>`;
}
