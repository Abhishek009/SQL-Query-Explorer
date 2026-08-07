import { escapeHtml } from '../../util';
import type { ConnectionFormData } from '../../connectionForm';

/**
 * Supabase's field set. Under the hood it is Postgres over the wire protocol —
 * see PostgresClient — so this tab only differs from PostgreSQL's in what it
 * asks for: a project ref or connection string instead of a bare host, and
 * defaults (user `postgres`, database `postgres`, SSL on) that match a hosted
 * Supabase project rather than a local server.
 */
export function supabaseFieldsHtml(values: ConnectionFormData, passwordHint: string, hasPassword: boolean): string {
    const forgetRow = hasPassword
        ? '<label class="switch small"><input id="s-clearPassword" type="checkbox"><span class="track"></span><span class="switch-label">Forget the saved password</span></label>'
        : '<input id="s-clearPassword" type="checkbox" hidden>';
    const advancedOpen = values.maxRows ? ' open' : '';
    return `
    <section class="card compact">
      <div class="field">
        <label class="lbl" for="s-name">Connection name</label>
        <input id="s-name" value="${escapeHtml(values.name)}" placeholder="Supabase project">
      </div>
      <div class="field">
        <label class="lbl" for="s-host">Project reference or host<span class="req">*</span></label>
        <input id="s-host" value="${escapeHtml(values.host)}" placeholder="db.xxxxxxxxxxxxxxxx.supabase.co">
        <p class="hint">Paste the project ref from its dashboard URL, the host, or the whole "Connection string" (<code>postgresql://postgres:[PASSWORD]@db.xxxx.supabase.co:5432/postgres</code>) from Project Settings → Database — the other fields fill themselves in.</p>
      </div>
      <div class="field row">
        <div></div>
        <div>
          <label class="lbl" for="s-port">Port<span class="req">*</span></label>
          <input id="s-port" type="number" min="1" max="65535" value="${escapeHtml(values.port)}" placeholder="5432">
        </div>
      </div>
      <div class="field row-eq">
        <div>
          <label class="lbl" for="s-user">Username<span class="req">*</span></label>
          <input id="s-user" value="${escapeHtml(values.user)}" placeholder="postgres">
        </div>
        <div>
          <label class="lbl" for="s-password">Database password</label>
          <input id="s-password" type="password" autocomplete="new-password" placeholder="${passwordHint}">
        </div>
      </div>
      ${forgetRow}
      <div class="field">
        <label class="lbl" for="s-database">Database</label>
        <input id="s-database" value="${escapeHtml(values.database)}" placeholder="postgres">
      </div>
      <label class="switch">
        <input id="s-ssl" type="checkbox" ${values.sslEnabled || !values.host ? 'checked' : ''}>
        <span class="track"></span>
        <span class="switch-label">SSL</span>
      </label>
      <p class="hint">Supabase requires SSL for hosted projects; turn it off only for a local <code>supabase start</code> database.</p>
    </section>
    <details class="advanced"${advancedOpen}>
      <summary>Advanced</summary>
      <div class="field">
        <label class="lbl" for="s-maxRows">Maximum rows to fetch</label>
        <input id="s-maxRows" type="number" min="1" max="1000000" value="${escapeHtml(values.maxRows)}" placeholder="Leave blank to use the global setting">
      </div>
    </details>`;
}
