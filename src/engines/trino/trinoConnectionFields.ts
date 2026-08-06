import { escapeHtml } from '../../util';
import type { ConnectionFormData } from '../../connectionForm';

/**
 * Trino's field set. Kept as its own module, not shared with Postgres's, so
 * an engine-specific addition — a token-auth toggle, say — only ever touches
 * this one file.
 */
export function trinoFieldsHtml(values: ConnectionFormData, passwordHint: string, hasPassword: boolean): string {
    const forgetRow = hasPassword
        ? '<label class="switch small"><input id="t-clearPassword" type="checkbox"><span class="track"></span><span class="switch-label">Forget the saved password</span></label>'
        : '<input id="t-clearPassword" type="checkbox" hidden>';
    const advancedOpen = values.maxRows ? ' open' : '';
    return `
    <section class="card compact">
      <div class="field">
        <label class="lbl" for="t-name">Connection name</label>
        <input id="t-name" value="${escapeHtml(values.name)}" placeholder="Development database">
      </div>
      <div class="field row">
        <div>
          <label class="lbl" for="t-host">Host<span class="req">*</span></label>
          <input id="t-host" value="${escapeHtml(values.host)}" placeholder="localhost">
        </div>
        <div>
          <label class="lbl" for="t-port">Port<span class="req">*</span></label>
          <input id="t-port" type="number" min="1" max="65535" value="${escapeHtml(values.port)}" placeholder="8080">
        </div>
      </div>
      <div class="field row-eq">
        <div>
          <label class="lbl" for="t-user">Username<span class="req">*</span></label>
          <input id="t-user" value="${escapeHtml(values.user)}" placeholder="your.username">
        </div>
        <div>
          <label class="lbl" for="t-password">Password</label>
          <input id="t-password" type="password" autocomplete="new-password" placeholder="${passwordHint}">
        </div>
      </div>
      ${forgetRow}
      <div class="field row-eq">
        <div>
          <label class="lbl" for="t-catalog">Default catalog</label>
          <input id="t-catalog" value="${escapeHtml(values.catalog)}" placeholder="hive">
        </div>
        <div>
          <label class="lbl" for="t-schema">Default schema</label>
          <input id="t-schema" value="${escapeHtml(values.schema)}" placeholder="default">
        </div>
      </div>
      <label class="switch">
        <input id="t-ssl" type="checkbox" ${values.sslEnabled ? 'checked' : ''}>
        <span class="track"></span>
        <span class="switch-label">SSL</span>
      </label>
    </section>
    <details class="advanced"${advancedOpen}>
      <summary>Advanced</summary>
      <div class="field">
        <label class="lbl" for="t-maxRows">Maximum rows to fetch</label>
        <input id="t-maxRows" type="number" min="1" max="1000000" value="${escapeHtml(values.maxRows)}" placeholder="Leave blank to use the global setting">
      </div>
    </details>`;
}
