import { escapeHtml } from '../../util';
import type { ConnectionFormData } from '../../connectionForm';

/** MongoDB's field set — a pasted mongodb:// or mongodb+srv:// string in Host fills the rest in, see mongodbUrls.ts. */
export function mongodbFieldsHtml(values: ConnectionFormData, passwordHint: string, hasPassword: boolean): string {
    const forgetRow = hasPassword
        ? '<label class="switch small"><input id="g-clearPassword" type="checkbox"><span class="track"></span><span class="switch-label">Forget the saved password</span></label>'
        : '<input id="g-clearPassword" type="checkbox" hidden>';
    const advancedOpen = values.maxRows ? ' open' : '';
    return `
    <section class="card compact">
      <div class="field">
        <label class="lbl" for="g-name">Connection name</label>
        <input id="g-name" value="${escapeHtml(values.name)}" placeholder="Development database">
      </div>
      <div class="field row">
        <div>
          <label class="lbl" for="g-host">Host<span class="req">*</span></label>
          <input id="g-host" value="${escapeHtml(values.host)}" placeholder="localhost, or paste a mongodb:// / mongodb+srv:// connection string">
        </div>
        <div>
          <label class="lbl" for="g-port">Port</label>
          <input id="g-port" type="number" min="1" max="65535" value="${escapeHtml(values.port)}" placeholder="27017">
        </div>
      </div>
      <p class="hint">Pasting a full connection string (e.g. from Atlas' "Connect" dialog) fills in the rest of this form and ignores Port.</p>
      <div class="field row-eq">
        <div>
          <label class="lbl" for="g-user">Username</label>
          <input id="g-user" value="${escapeHtml(values.user)}" placeholder="Leave blank if auth is disabled">
        </div>
        <div>
          <label class="lbl" for="g-password">Password</label>
          <input id="g-password" type="password" autocomplete="new-password" placeholder="${passwordHint}">
        </div>
      </div>
      ${forgetRow}
      <div class="field">
        <label class="lbl" for="g-database">Default database</label>
        <input id="g-database" value="${escapeHtml(values.database)}" placeholder="Leave blank to browse every database on the server">
      </div>
      <label class="switch">
        <input id="g-ssl" type="checkbox" ${values.sslEnabled ? 'checked' : ''}>
        <span class="track"></span>
        <span class="switch-label">SSL</span>
      </label>
    </section>
    <details class="advanced"${advancedOpen}>
      <summary>Advanced</summary>
      <div class="field">
        <label class="lbl" for="g-maxRows">Maximum rows to fetch</label>
        <input id="g-maxRows" type="number" min="1" max="1000000" value="${escapeHtml(values.maxRows)}" placeholder="Leave blank to use the global setting">
      </div>
    </details>`;
}
