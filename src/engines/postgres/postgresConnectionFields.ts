import { escapeHtml } from '../../util';
import type { ConnectionFormData } from '../../connectionForm';

/** PostgreSQL's field set — independent of Trino's, see the note in trinoConnectionFields.ts. */
export function postgresFieldsHtml(values: ConnectionFormData, passwordHint: string, hasPassword: boolean): string {
    const forgetRow = hasPassword
        ? '<label class="switch small"><input id="p-clearPassword" type="checkbox"><span class="track"></span><span class="switch-label">Forget the saved password</span></label>'
        : '<input id="p-clearPassword" type="checkbox" hidden>';
    const advancedOpen = values.maxRows ? ' open' : '';
    return `
    <section class="card compact">
      <div class="field">
        <label class="lbl" for="p-name">Connection name</label>
        <input id="p-name" value="${escapeHtml(values.name)}" placeholder="Development database">
      </div>
      <div class="field row">
        <div>
          <label class="lbl" for="p-host">Host<span class="req">*</span></label>
          <input id="p-host" value="${escapeHtml(values.host)}" placeholder="localhost">
        </div>
        <div>
          <label class="lbl" for="p-port">Port<span class="req">*</span></label>
          <input id="p-port" type="number" min="1" max="65535" value="${escapeHtml(values.port)}" placeholder="5432">
        </div>
      </div>
      <div class="field row-eq">
        <div>
          <label class="lbl" for="p-user">Username<span class="req">*</span></label>
          <input id="p-user" value="${escapeHtml(values.user)}" placeholder="your.username">
        </div>
        <div>
          <label class="lbl" for="p-password">Password</label>
          <input id="p-password" type="password" autocomplete="new-password" placeholder="${passwordHint}">
        </div>
      </div>
      ${forgetRow}
      <div class="field">
        <label class="lbl" for="p-database">Database</label>
        <input id="p-database" value="${escapeHtml(values.database)}" placeholder="postgres">
      </div>
      <label class="switch">
        <input id="p-ssl" type="checkbox" ${values.sslEnabled ? 'checked' : ''}>
        <span class="track"></span>
        <span class="switch-label">SSL</span>
      </label>
    </section>
    <details class="advanced"${advancedOpen}>
      <summary>Advanced</summary>
      <div class="field">
        <label class="lbl" for="p-maxRows">Maximum rows to fetch</label>
        <input id="p-maxRows" type="number" min="1" max="1000000" value="${escapeHtml(values.maxRows)}" placeholder="Leave blank to use the global setting">
      </div>
    </details>`;
}
