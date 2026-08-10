import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

/**
 * Where better-sqlite3's native module is downloaded to, set once at
 * activation. Kept as a module-level path rather than threaded through every
 * SqlClient call site, since only SqliteClient and its Connect To DB tab ever
 * need it.
 */
let runtimeDir: string | undefined;

export function initSqliteRuntime(context: vscode.ExtensionContext): void {
    runtimeDir = path.join(context.globalStorageUri.fsPath, 'sqlite-runtime');
}

/** Points at a pre-installed runtime for tests, bypassing the extension host entirely. */
export function setSqliteRuntimeDirForTests(dir: string): void {
    runtimeDir = dir;
}

function requireRuntimeDir(): string {
    if (!runtimeDir) { throw new Error('SQLite runtime location was never initialised.'); }
    return runtimeDir;
}

export function sqliteModulePath(): string {
    return path.join(requireRuntimeDir(), 'node_modules', 'better-sqlite3');
}

export function isSqliteInstalled(): boolean {
    return fs.existsSync(path.join(sqliteModulePath(), 'package.json'));
}

/**
 * Downloads better-sqlite3's native module via npm, on demand, the first time
 * a SQLite connection is set up. Uses npm rather than hand-rolling a tarball
 * fetch so platform/architecture selection and integrity checking are npm's
 * problem, not ours.
 */
export async function installSqlite(onOutput: (line: string) => void, token?: vscode.CancellationToken): Promise<void> {
    const dir = requireRuntimeDir();
    fs.mkdirSync(dir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const child = spawn(npm, ['install', 'better-sqlite3', '--no-save', '--omit=dev', '--no-audit', '--no-fund'], {
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
