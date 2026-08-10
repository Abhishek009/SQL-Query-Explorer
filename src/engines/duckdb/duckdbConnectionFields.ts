import { escapeHtml } from '../../util';
import type { ConnectionFormData } from '../../connectionForm';

/**
 * DuckDB's field set matches SQLite's — a local file, no server — plus an
 * install banner: the native module (~100MB) is downloaded on demand rather
 * than bundled, so this tab has to offer that as its first step.
 */
export function duckdbFieldsHtml(values: ConnectionFormData): string {
    const advancedOpen = values.maxRows ? ' open' : '';
    return `
    <section class="card compact">
      <div id="duckdb-install-banner" class="install-banner">
        <span id="duckdb-install-text">Checking whether DuckDB is installed…</span>
        <button type="button" id="duckdb-install-button" class="secondary" hidden>Install</button>
      </div>
      <div class="field">
        <label class="lbl" for="d-name">Connection name</label>
        <input id="d-name" value="${escapeHtml(values.name)}" placeholder="Local database">
      </div>
      <div class="field">
        <label class="lbl" for="d-file">Database file<span class="req">*</span></label>
        <div class="row" style="grid-template-columns:minmax(0,1fr) auto auto">
          <input id="d-file" value="${escapeHtml(values.file)}" placeholder="/path/to/database.duckdb">
          <button type="button" id="d-browse" class="secondary">Browse…</button>
          <button type="button" id="d-new" class="secondary">New Database…</button>
        </div>
        <p class="hint"><b>Browse</b> points at a <code>.duckdb</code> file that already exists; <b>New Database</b> creates an empty one wherever you choose to save it.</p>
      </div>
    </section>
    <details class="advanced"${advancedOpen}>
      <summary>Advanced</summary>
      <div class="field">
        <label class="lbl" for="d-maxRows">Maximum rows to fetch</label>
        <input id="d-maxRows" type="number" min="1" max="1000000" value="${escapeHtml(values.maxRows)}" placeholder="Leave blank to use the global setting">
      </div>
    </details>`;
}
