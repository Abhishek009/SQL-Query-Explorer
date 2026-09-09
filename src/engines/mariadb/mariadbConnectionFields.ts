import { escapeHtml, passwordFieldHtml } from '../../util';
import type { ConnectionFormData } from '../../connectionForm';

/** MariaDB's field set — identical shape to MySQL's, since it's the same wire protocol underneath. */
export function mariadbFieldsHtml(values: ConnectionFormData, passwordHint: string, hasPassword: boolean): string {
    const forgetRow = hasPassword
        ? '<label class="switch small"><input id="a-clearPassword" type="checkbox"><span class="track"></span><span class="switch-label">Forget the saved password</span></label>'
        : '<input id="a-clearPassword" type="checkbox" hidden>';
    const advancedOpen = values.maxRows ? ' open' : '';
    return `
    <section class="card compact">
      <div class="field">
        <label class="lbl" for="a-name">Connection name</label>
        <input id="a-name" value="${escapeHtml(values.name)}" placeholder="Development database">
      </div>
      <div class="field row">
        <div>
          <label class="lbl" for="a-host">Host<span class="req">*</span></label>
          <input id="a-host" value="${escapeHtml(values.host)}" placeholder="localhost">
        </div>
        <div>
          <label class="lbl" for="a-port">Port<span class="req">*</span></label>
          <input id="a-port" type="number" min="1" max="65535" value="${escapeHtml(values.port)}" placeholder="3306">
        </div>
      </div>
      <div class="field row-eq">
        <div>
          <label class="lbl" for="a-user">Username<span class="req">*</span></label>
          <input id="a-user" value="${escapeHtml(values.user)}" placeholder="root">
        </div>
        <div>
          <label class="lbl" for="a-password">Password</label>
          ${passwordFieldHtml('a-password', passwordHint)}
        </div>
      </div>
      ${forgetRow}
      <div class="field">
        <label class="lbl" for="a-database">Default database</label>
        <input id="a-database" value="${escapeHtml(values.database)}" placeholder="Leave blank to browse every database on the server">
      </div>
      <label class="switch">
        <input id="a-ssl" type="checkbox" ${values.sslEnabled ? 'checked' : ''}>
        <span class="track"></span>
        <span class="switch-label">SSL</span>
      </label>
    </section>
    <details class="advanced"${advancedOpen}>
      <summary>Advanced</summary>
      <div class="field">
        <label class="lbl" for="a-maxRows">Maximum rows to fetch</label>
        <input id="a-maxRows" type="number" min="1" max="1000000" value="${escapeHtml(values.maxRows)}" placeholder="Leave blank to use the global setting">
      </div>
    </details>`;
}
