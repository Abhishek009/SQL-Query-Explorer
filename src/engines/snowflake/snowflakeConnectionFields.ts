import { escapeHtml } from '../../util';
import type { ConnectionFormData } from '../../connectionForm';

/**
 * Snowflake's field set. No host/port or SSL toggle — Snowflake is addressed
 * by account identifier instead, and always over TLS — but it does need a
 * warehouse and an authentication method, neither of which any other engine
 * here has.
 */
export function snowflakeFieldsHtml(values: ConnectionFormData, passwordHint: string, hasPassword: boolean): string {
    const forgetRow = hasPassword
        ? '<label class="switch small"><input id="f-clearPassword" type="checkbox"><span class="track"></span><span class="switch-label">Forget the saved password</span></label>'
        : '<input id="f-clearPassword" type="checkbox" hidden>';
    const advancedOpen = values.maxRows ? ' open' : '';
    const isExternalBrowser = values.authMethod === 'externalbrowser';
    return `
    <section class="card compact">
      <div id="snowflake-install-banner" class="install-banner">
        <span id="snowflake-install-text">Checking whether Snowflake is installed…</span>
        <button type="button" id="snowflake-install-button" class="secondary" hidden>Install</button>
      </div>
      <div class="field">
        <label class="lbl" for="f-name">Connection name</label>
        <input id="f-name" value="${escapeHtml(values.name)}" placeholder="Production warehouse">
      </div>
      <div class="field">
        <label class="lbl" for="f-host">Account identifier<span class="req">*</span></label>
        <input id="f-host" value="${escapeHtml(values.host)}" placeholder="xy12345.us-east-1, or orgname-accountname">
      </div>
      <div class="field">
        <label class="lbl">Authentication</label>
        <div class="radio-row">
          <label><input type="radio" name="f-authMethod" id="f-auth-password" value="password" ${isExternalBrowser ? '' : 'checked'}> Username &amp; Password</label>
          <label><input type="radio" name="f-authMethod" id="f-auth-browser" value="externalbrowser" ${isExternalBrowser ? 'checked' : ''}> External Browser (SSO)</label>
        </div>
      </div>
      <div class="field row-eq">
        <div>
          <label class="lbl" for="f-user">Username<span class="req">*</span></label>
          <input id="f-user" value="${escapeHtml(values.user)}" placeholder="your.username">
        </div>
        <div id="f-password-field" ${isExternalBrowser ? 'hidden' : ''}>
          <label class="lbl" for="f-password">Password</label>
          <input id="f-password" type="password" autocomplete="new-password" placeholder="${passwordHint}">
        </div>
      </div>
      <div id="f-forget-row" ${isExternalBrowser ? 'hidden' : ''}>${forgetRow}</div>
      <p class="hint" id="f-browser-hint" ${isExternalBrowser ? '' : 'hidden'}>Save &amp; Connect opens your system browser to sign in through your identity provider. No password is stored for this connection.</p>
      <div class="field">
        <label class="lbl" for="f-warehouse">Warehouse<span class="req">*</span></label>
        <input id="f-warehouse" value="${escapeHtml(values.warehouse)}" placeholder="COMPUTE_WH">
      </div>
      <div class="field row-eq">
        <div>
          <label class="lbl" for="f-catalog">Default database</label>
          <input id="f-catalog" value="${escapeHtml(values.catalog)}" placeholder="Leave blank to browse every database the role can see">
        </div>
        <div>
          <label class="lbl" for="f-schema">Default schema</label>
          <input id="f-schema" value="${escapeHtml(values.schema)}" placeholder="PUBLIC">
        </div>
      </div>
      <div class="field">
        <label class="lbl" for="f-role">Role</label>
        <input id="f-role" value="${escapeHtml(values.role)}" placeholder="Leave blank to use your default role">
      </div>
    </section>
    <details class="advanced"${advancedOpen}>
      <summary>Advanced</summary>
      <div class="field">
        <label class="lbl" for="f-maxRows">Maximum rows to fetch</label>
        <input id="f-maxRows" type="number" min="1" max="1000000" value="${escapeHtml(values.maxRows)}" placeholder="Leave blank to use the global setting">
      </div>
    </details>`;
}
