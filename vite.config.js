import { defineConfig } from 'vite';

// Local Mol* (v5) playground for reproducing the Kato et al. 2022
// IscB–ωRNA–DNA figures (PDB 7XHT). No remote code is loaded at runtime:
// structures are served from ./public/structures and the molstar UI css
// from ./public/molstar.css (copied from the installed npm package).
export default defineConfig({
    base: './',
    server: {
        port: 5173,
        open: false,
    },
    build: {
        target: 'es2022',
        chunkSizeWarningLimit: 5000,
    },
    optimizeDeps: {
        include: ['molstar'],
    },
});
