import { rmSync } from 'node:fs';

// better-sqlite3's runtime only ever touches lib/, prebuilds/, and its own
// package.json (see node_modules/better-sqlite3/lib/binding.js) — deps/ and
// src/ are C++ source, headers, and a bundled SQLite amalgamation used only
// when compiling from scratch, which is dead weight in a published extension
// carrying prebuilt binaries for every platform. vsce does not reliably
// support excluding paths nested under a negated .vscodeignore directory, so
// this runs as a real prepublish step instead. The nested node_modules/
// (node-addon-api, ~450KB) is left alone: it is also build-only, but removing
// it confuses vsce's own `npm list` integrity check during packaging.
const DEAD_WEIGHT = [
    'node_modules/better-sqlite3/deps',
    'node_modules/better-sqlite3/src',
    'node_modules/better-sqlite3/binding.gyp'
];

for (const path of DEAD_WEIGHT) {
    rmSync(path, { recursive: true, force: true });
}
console.log('Trimmed better-sqlite3 build-only files.');
