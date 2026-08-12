import { escapeHtml } from '../../util';
import type { ConnectionFormData } from '../../connectionForm';

/** MySQL's field set — independent of Postgres's, see the note in trinoConnectionFields.ts. */
export function mysqlFieldsHtml(values: ConnectionFormData, passwordHint: string, hasPassword: boolean): string {
    const forgetRow = hasPassword
        ? '<label class="switch small"><input id="m-clearPassword" type="checkbox"><span class="track"></span><span class="switch-label">Forget the saved password</span></label>'
        : '<input id="m-clearPassword" type="checkbox" hidden>';
    const advancedOpen = values.maxRows ? ' open' : '';
    return `
    <section class="card compact">
      <div class="field">
        <label class="lbl" for="m-name">Connection name</label>
        <input id="m-name" value="${escapeHtml(values.name)}" placeholder="Development database">
      </div>
      <div class="field row">
        <div>
          <label class="lbl" for="m-host">Host<span class="req">*</span></label>
          <input id="m-host" value="${escapeHtml(values.host)}" placeholder="localhost">
        </div>
        <div>
          <label class="lbl" for="m-port">Port<span class="req">*</span></label>
          <input id="m-port" type="number" min="1" max="65535" value="${escapeHtml(values.port)}" placeholder="3306">
        </div>
      </div>
      <div class="field row-eq">
        <div>
          <label class="lbl" for="m-user">Username<span class="req">*</span></label>
          <input id="m-user" value="${escapeHtml(values.user)}" placeholder="root">
        </div>
        <div>
          <label class="lbl" for="m-password">Password</label>
          <input id="m-password" type="password" autocomplete="new-password" placeholder="${passwordHint}">
        </div>
      </div>
      ${forgetRow}
      <div class="field">
        <label class="lbl" for="m-database">Default database</label>
        <input id="m-database" value="${escapeHtml(values.database)}" placeholder="Leave blank to browse every database on the server">
      </div>
      <label class="switch">
        <input id="m-ssl" type="checkbox" ${values.sslEnabled ? 'checked' : ''}>
        <span class="track"></span>
        <span class="switch-label">SSL</span>
      </label>
    </section>
    <details class="advanced"${advancedOpen}>
      <summary>Advanced</summary>
      <div class="field">
        <label class="lbl" for="m-maxRows">Maximum rows to fetch</label>
        <input id="m-maxRows" type="number" min="1" max="1000000" value="${escapeHtml(values.maxRows)}" placeholder="Leave blank to use the global setting">
      </div>
    </details>`;
}
