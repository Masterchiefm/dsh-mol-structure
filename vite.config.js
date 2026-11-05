import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// Local Mol* (v5) playground for reproducing the Kato et al. 2022
// IscB–ωRNA–DNA figures (PDB 7XHT). No remote code is loaded at runtime.
// The single copy of the big static assets lives in dist/ (tracked, and the
// self-updater downloads them from the repo): dev serves /molstar.css and
// /structures/* straight from dist/, and builds keep those files in place
// (emptyOutDir: false + tools/prebuild-clean.mjs clears only regenerables).
const MIME = {
    '.css': 'text/css',
    '.json': 'application/json',
    '.cif': 'application/octet-stream',
    '.bcif': 'application/octet-stream',
};

export default defineConfig({
    base: './',
    publicDir: false,
    server: {
        port: 5173,
        open: false,
    },
    build: {
        target: 'es2022',
        chunkSizeWarningLimit: 5000,
        emptyOutDir: false,
    },
    optimizeDeps: {
        include: ['molstar'],
    },
    plugins: [
        {
            name: 'serve-dist-static',
            configureServer(server) {
                server.middlewares.use((req, res, next) => {
                    const url = (req.url || '').split('?')[0];
                    const rel = url === '/molstar.css' || url.startsWith('/structures/')
                        ? decodeURIComponent(url)
                        : null;
                    if (!rel) return next();
                    const full = path.join(root, 'dist', rel);
                    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return next();
                    res.setHeader('content-type', MIME[path.extname(full)] ?? 'application/octet-stream');
                    fs.createReadStream(full).pipe(res);
                });
            },
        },
    ],
});
