import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

/**
 * Where snowflake-sdk is downloaded to, set once at activation. Kept as a
 * module-level path rather than threaded through every SqlClient call site,
 * since only SnowflakeClient and its Connect To DB tab ever need it.
 */
let runtimeDir: string | undefined;

export function initSnowflakeRuntime(context: vscode.ExtensionContext): void {
    runtimeDir = path.join(context.globalStorageUri.fsPath, 'snowflake-runtime');
}

/** Points at a pre-installed runtime for tests, bypassing the extension host entirely. */
export function setSnowflakeRuntimeDirForTests(dir: string): void {
    runtimeDir = dir;
}

function requireRuntimeDir(): string {
    if (!runtimeDir) { throw new Error('Snowflake runtime location was never initialised.'); }
    return runtimeDir;
}

export function snowflakeModulePath(): string {
    return path.join(requireRuntimeDir(), 'node_modules', 'snowflake-sdk');
}

export function isSnowflakeInstalled(): boolean {
    return fs.existsSync(path.join(snowflakeModulePath(), 'package.json'));
}

/**
 * Downloads snowflake-sdk via npm, on demand, the first time a Snowflake
 * connection is set up. The official driver pulls in AWS/Azure/GCS SDKs for
 * its bulk-load (PUT/GET) features this extension never uses, so bundling it
 * into dist/extension.js would triple the package size for every install —
 * the same reasoning that keeps better-sqlite3/@duckdb/node-api out too.
 */
export async function installSnowflake(onOutput: (line: string) => void, token?: vscode.CancellationToken): Promise<void> {
    const dir = requireRuntimeDir();
    fs.mkdirSync(dir, { recursive: true });
    // Without a package.json here, npm walks up to the nearest ancestor one to
    // find its "project root" — harmless for a real install (this lives under
    // globalStorageUri, never inside a project), but a real risk for anyone
    // pointing runtimeDir at a path nested under a repo (e.g. in tests) — it
    // silently reconciles the WRONG project's node_modules against its
    // package.json instead, which can prune real, unrelated packages there.
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) { fs.writeFileSync(manifest, '{}'); }
    await new Promise<void>((resolve, reject) => {
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const child = spawn(npm, ['install', 'snowflake-sdk', '--no-save', '--omit=dev', '--no-audit', '--no-fund'], {
            cwd: dir
        });
        const cancellation = token?.onCancellationRequested(() => {
            child.kill();
            reject(new Error('Installation cancelled.'));
        });
        child.stdout.on('data', (data: Buffer) => onOutput(data.toString()));
        child.stderr.on('data', (data: Buffer) => onOutput(data.toString()));
        child.on('error', error => { cancellation?.dispose(); reject(error); });
        child.on('exit', code => {
            cancellation?.dispose();
            if (code === 0) { resolve(); } else { reject(new Error(`npm install exited with code ${code}.`)); }
        });
    });
}
