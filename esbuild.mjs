import { build, context } from 'esbuild';

// The extension now has real runtime dependencies (pg, better-sqlite3), and
// .vscodeignore keeps node_modules out of the package, so everything must be
// bundled into one file — except better-sqlite3, which is a native addon
// (a compiled .node binary) that cannot be bundled into JS. It stays a real
// require() and .vscodeignore carves out its own package directory instead.
const options = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode', 'better-sqlite3'],
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
