import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { connectionFormHtml } from '../src/connectionForm';
import type { ConnectionFormData } from '../src/connectionForm';

function buildValues(overrides: Partial<ConnectionFormData> = {}): ConnectionFormData {
    return {
        name: '', engine: 'snowflake', host: '', port: '', sslEnabled: false, sslVerify: true,
        user: '', catalog: '', schema: '', database: '', file: '', maxRows: '',
        warehouse: '', role: '', authMethod: 'password',
        ...overrides
    };
}

/** Renders the actual webview HTML/script into a real DOM and runs it, the way VS Code's webview host would. */
function renderInJsdom(values: ConnectionFormData) {
    const webview = { cspSource: 'vscode-resource:' } as unknown as Parameters<typeof connectionFormHtml>[0];
    const html = connectionFormHtml(webview, values, false, false);
    const posted: unknown[] = [];
    const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        beforeParse(contentWindow) {
            (contentWindow as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi =
                () => ({ postMessage: message => { posted.push(message); } });
        }
    });
    return { window: dom.window, posted };
}

describe('Snowflake tab: authentication method toggle', () => {
    it('starts on Username & Password, with the password field visible', () => {
        const { window } = renderInJsdom(buildValues());
        expect((window.document.getElementById('f-auth-password') as unknown as HTMLInputElement).checked).toBe(true);
        expect((window.document.getElementById('f-password-field') as unknown as HTMLElement).hidden).toBe(false);
        expect((window.document.getElementById('f-browser-hint') as unknown as HTMLElement).hidden).toBe(true);
    });

    it('starts on External Browser when editing a connection saved that way, with the password field already hidden', () => {
        const { window } = renderInJsdom(buildValues({ authMethod: 'externalbrowser' }));
        expect((window.document.getElementById('f-auth-browser') as unknown as HTMLInputElement).checked).toBe(true);
        expect((window.document.getElementById('f-password-field') as unknown as HTMLElement).hidden).toBe(true);
        expect((window.document.getElementById('f-forget-row') as unknown as HTMLElement).hidden).toBe(true);
        expect((window.document.getElementById('f-browser-hint') as unknown as HTMLElement).hidden).toBe(false);
    });

    it('hides the password field and shows the browser hint when switched to External Browser', () => {
        const { window } = renderInJsdom(buildValues());
        const browserRadio = window.document.getElementById('f-auth-browser') as unknown as HTMLInputElement;
        browserRadio.checked = true;
        browserRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
        expect((window.document.getElementById('f-password-field') as unknown as HTMLElement).hidden).toBe(true);
        expect((window.document.getElementById('f-browser-hint') as unknown as HTMLElement).hidden).toBe(false);
    });

    it('shows the password field again when switched back to Username & Password', () => {
        const { window } = renderInJsdom(buildValues({ authMethod: 'externalbrowser' }));
        const passwordRadio = window.document.getElementById('f-auth-password') as unknown as HTMLInputElement;
        passwordRadio.checked = true;
        passwordRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
        expect((window.document.getElementById('f-password-field') as unknown as HTMLElement).hidden).toBe(false);
        expect((window.document.getElementById('f-browser-hint') as unknown as HTMLElement).hidden).toBe(true);
    });
});

describe('Snowflake tab: submitting the form', () => {
    it('posts account, warehouse, role, and auth method as typed', () => {
        const { window, posted } = renderInJsdom(buildValues());
        (window.document.getElementById('f-host') as unknown as HTMLInputElement).value = 'xy12345.us-east-1';
        (window.document.getElementById('f-user') as unknown as HTMLInputElement).value = 'alice';
        (window.document.getElementById('f-warehouse') as unknown as HTMLInputElement).value = 'COMPUTE_WH';
        (window.document.getElementById('f-role') as unknown as HTMLInputElement).value = 'ANALYST';
        (window.document.getElementById('test') as unknown as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

        // The tab's own on-load install check also lands in `posted` — only the
        // Test Connection click's own message matters here.
        expect(posted).toContainEqual(expect.objectContaining({
            type: 'test', engine: 'snowflake', host: 'xy12345.us-east-1', user: 'alice',
            warehouse: 'COMPUTE_WH', role: 'ANALYST', authMethod: 'password'
        }));
    });

    it('posts authMethod: externalbrowser when that radio is selected', () => {
        const { window, posted } = renderInJsdom(buildValues());
        const browserRadio = window.document.getElementById('f-auth-browser') as unknown as HTMLInputElement;
        browserRadio.checked = true;
        browserRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
        (window.document.getElementById('test') as unknown as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        expect(posted).toContainEqual(expect.objectContaining({ type: 'test', authMethod: 'externalbrowser' }));
    });
});

describe('Snowflake tab: install banner', () => {
    it('checks install status once the tab is opened, and the Install button posts installRuntime', () => {
        const { window, posted } = renderInJsdom(buildValues());
        window.document.querySelector('.tab[data-engine="snowflake"]')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        expect(posted).toContainEqual({ type: 'checkRuntime', engine: 'snowflake' });

        window.postMessage({ type: 'runtimeStatus', engine: 'snowflake', installed: false }, '*');
    });

    it('shows the Install button once told the driver is missing, and reflects install progress/completion', () => {
        const { window, posted } = renderInJsdom(buildValues());
        const banner = window.document.getElementById('snowflake-install-banner') as unknown as HTMLElement;
        const button = window.document.getElementById('snowflake-install-button') as unknown as HTMLButtonElement;
        const text = window.document.getElementById('snowflake-install-text') as unknown as HTMLElement;

        window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'runtimeStatus', engine: 'snowflake', installed: false } }));
        expect(button.hidden).toBe(false);
        expect(banner.className).toContain('missing');

        button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        expect(posted).toContainEqual({ type: 'installRuntime', engine: 'snowflake' });
        expect(banner.className).toContain('checking');

        window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'runtimeInstallDone', engine: 'snowflake', ok: true, message: 'Snowflake is installed and ready.' } }));
        expect(banner.className).toContain('ready');
        expect(text.textContent).toBe('Snowflake is installed and ready.');
        expect(button.hidden).toBe(true);
    });
});
