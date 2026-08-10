import { escapeHtml } from '../../util';
import type { ConnectionFormData } from '../../connectionForm';

/**
 * SQLite's field set is nothing like the others': there is no host, port,
 * user, password, or SSL — just a file on disk. Browse opens a native picker
 * through the extension host, since a webview cannot touch the filesystem.
 * The native module itself is downloaded on demand rather than bundled, so
 * the tab leads with an install banner the same way DuckDB's does.
 */
export function sqliteFieldsHtml(values: ConnectionFormData): string {
    const advancedOpen = values.maxRows ? ' open' : '';
    return `
    <section class="card compact">
      <div id="sqlite-install-banner" class="install-banner">
        <span id="sqlite-install-text">Checking whether SQLite is installed…</span>
        <button type="button" id="sqlite-install-button" class="secondary" hidden>Install</button>
      </div>
      <div class="field">
        <label class="lbl" for="l-name">Connection name</label>
        <input id="l-name" value="${escapeHtml(values.name)}" placeholder="Local database">
      </div>
      <div class="field">
        <label class="lbl" for="l-file">Database file<span class="req">*</span></label>
        <div class="row" style="grid-template-columns:minmax(0,1fr) auto auto">
          <input id="l-file" value="${escapeHtml(values.file)}" placeholder="/path/to/database.db">
          <button type="button" id="l-browse" class="secondary">Browse…</button>
          <button type="button" id="l-new" class="secondary">New Database…</button>
        </div>
        <p class="hint"><b>Browse</b> points at a <code>.db</code>/<code>.sqlite</code> file that already exists; <b>New Database</b> creates an empty one wherever you choose to save it.</p>
      </div>
    </section>
    <details class="advanced"${advancedOpen}>
      <summary>Advanced</summary>
      <div class="field">
        <label class="lbl" for="l-maxRows">Maximum rows to fetch</label>
        <input id="l-maxRows" type="number" min="1" max="1000000" value="${escapeHtml(values.maxRows)}" placeholder="Leave blank to use the global setting">
      </div>
    </details>`;
}
