/**
 * Static file server for the built viewer app (Vite output in dist/).
 *
 * The route prefix is /api/mol-structure/viewer; everything after it maps
 * into the dist directory. Path traversal is refused, MIME types come from a
 * small extension table, and responses carry an mtime+size etag so a rebuilt
 * dist answers 304 only to clients that already have the current files.
 * no-cache (not immutable) is deliberate: the viewer rebuilds during plugin
 * development, and the bridge's appRev poll expects a fresh index.html.
 *
 * @module host/static.js
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.cif': 'text/plain; charset=utf-8',
    '.pdb': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
}

export function createStatic({ root, logger = console } = {}) {
    return async function serve(req, res) {
        let urlPath
        try {
            urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
        } catch {
            res.writeHead(400).end('bad request')
            return
        }
        const rel = urlPath.replace(/^\/api\/mol-structure\/viewer\/?/, '')
        const relClean = rel === '' ? 'index.html' : rel
        const filePath = path.resolve(root, relClean)
        if (filePath !== root && !filePath.startsWith(path.resolve(root) + path.sep)) {
            res.writeHead(403).end('forbidden')
            return
        }

        let st
        try {
            st = await fsp.stat(filePath)
            if (st.isDirectory()) {
                const index = path.join(filePath, 'index.html')
                st = await fsp.stat(index)
                return sendFile(res, req, index, st)
            }
            return sendFile(res, req, filePath, st)
        } catch (error) {
            if (error?.code !== 'ENOENT') logger.warn?.(`mol-structure: static read failed (${error?.message ?? error})`)
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
        }
    }

    function sendFile(res, req, filePath, st) {
        const etag = `"${Math.round(st.mtimeMs)}-${st.size}"`
        if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { etag })
            res.end()
            return
        }
        const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
        res.writeHead(200, {
            'content-type': type,
            'content-length': st.size,
            etag,
            'cache-control': 'no-cache',
        })
        if (req.method === 'HEAD') { res.end(); return }
        const stream = fs.createReadStream(filePath)
        stream.on('error', () => { try { res.destroy() } catch { /* already gone */ } })
        stream.pipe(res)
    }
}
