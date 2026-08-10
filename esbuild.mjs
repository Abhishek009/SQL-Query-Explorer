import { build, context } from 'esbuild';

// pg is a real runtime dependency, and .vscodeignore keeps node_modules out
// of the package, so it is bundled into this one file like everything else.
// SQLite (better-sqlite3) and DuckDB (@duckdb/node-api) are native modules
// downloaded on demand rather than bundled — see sqliteClient.ts/duckdbClient.ts
// — so they are never project dependencies for esbuild to find in the first
// place; their `require()` calls are dynamic (computed paths, not literal
// specifiers) specifically so esbuild leaves them alone.
const options = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    minify: process.argv.includes('--production')
};

if (process.argv.includes('--watch')) {
    const ctx = await context(options);
    await ctx.watch();
    console.log('watching…');
} else {
    await build(options);
    console.log('bundled to dist/extension.js');
}
