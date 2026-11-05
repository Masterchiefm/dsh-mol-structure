#!/usr/bin/env node
/**
 * Clear only the vite-regenerated parts of dist/ before `vite build`.
 * dist/structures and dist/molstar.css are the tracked, single-copy static
 * assets (served in dev by the vite middleware and downloaded file-by-file by
 * the self-updater), so the build must not wipe them.
 *
 * @module tools/prebuild-clean.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
for (const entry of ['assets', 'index.html']) {
    const full = path.join(dist, entry);
    fs.rmSync(full, { recursive: true, force: true });
}
console.log('dist/ cleared (assets, index.html); structures & molstar.css kept');
