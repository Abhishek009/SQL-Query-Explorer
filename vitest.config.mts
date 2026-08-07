import { defineConfig } from 'vitest/config';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        setupFiles: ['test/setup/env.ts'],
        testTimeout: 20_000,
        hookTimeout: 20_000
    },
    resolve: {
        // The real `vscode` module only exists inside the VS Code extension host;
        // outside of it (here) these engine clients only ever use it for types,
        // cancellation tokens, and settings reads, so a small shim stands in.
        alias: { vscode: path.resolve(here, 'test/setup/vscode-shim.ts') }
    }
});
