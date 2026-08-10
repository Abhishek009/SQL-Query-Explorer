import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

/**
 * Where the DuckDB native module is downloaded to, set once at activation.
 * Kept as a module-level path rather than threaded through every SqlClient
 * call site, since only DuckdbClient and its Connect To DB tab ever need it.
 */
let runtimeDir: string | undefined;

export function initDuckdbRuntime(context: vscode.ExtensionContext): void {
    runtimeDir = path.join(context.globalStorageUri.fsPath, 'duckdb-runtime');
}

/** Points at a pre-installed runtime for tests, bypassing the extension host entirely. */
export function setDuckdbRuntimeDirForTests(dir: string): void {
    runtimeDir = dir;
}

function requireRuntimeDir(): string {
    if (!runtimeDir) { throw new Error('DuckDB runtime location was never initialised.'); }
    return runtimeDir;
}

export function duckdbModulePath(): string {
    return path.join(requireRuntimeDir(), 'node_modules', '@duckdb', 'node-api');
}

export function isDuckdbInstalled(): boolean {
    return fs.existsSync(path.join(duckdbModulePath(), 'package.json'));
}

/**
 * Downloads DuckDB's native module (~100MB, platform-specific) via npm. Uses
 * npm rather than hand-rolling a tarball fetch so platform/architecture
 * selection and integrity checking are npm's problem, not ours.
 */
export async function installDuckdb(onOutput: (line: string) => void, token?: vscode.CancellationToken): Promise<void> {
    const dir = requireRuntimeDir();
    fs.mkdirSync(dir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const child = spawn(npm, ['install', '@duckdb/node-api', '--no-save', '--omit=dev', '--no-audit', '--no-fund'], {
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
