import { build, context } from 'esbuild';

// The extension now has a real runtime dependency (pg), and .vscodeignore keeps
// node_modules out of the package, so everything must be bundled into one file.
const options = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],          // provided by the host, never bundled
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
