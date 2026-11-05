/**
 * Memory probe — quantify viewer-page memory growth across repeated
 * figure/panel rebuilds and screenshots (the agent-session workload).
 *
 * Run: node scripts/mem-probe.mjs   (needs `npm run build` first)
 *
 * @module scripts/mem-probe.mjs
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shotsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mol-mem-'))

if (!fs.existsSync(path.join(packageDir, 'dist', 'index.html'))) {
    console.error('dist/index.html missing — run npm run build first')
    process.exit(1)
}

const routes = []
const toolDefs = new Map()
function makeCtx() {
    return {
        logger: { info: () => {}, warn: (m) => console.log('[warn]', m) },
        get: () => undefined,
        effect(fn) { return fn() },
        inject(deps, cb) {
            cb({
                webServer: { register: (route) => { routes.push(route); return () => {} } },
                tools: { register: (def) => { toolDefs.set(def.name, def); return () => {} } },
                effect(fn) { return fn() },
            })
        },
    }
}
const { apply } = await import('../index.js')
apply(makeCtx(), { screenshotDir: shotsDir })

const eventsRoute = routes.find(r => r.kind === 'exact')
const viewerRoute = routes.find(r => r.path === '/api/mol-structure/viewer')
const apiRoute = routes.find(r => r.path === '/api/mol-structure')
const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0]
    if (pathname === '/api/mol-structure/events') return void eventsRoute.handler(req, res)
    if (pathname.startsWith('/api/mol-structure/viewer')) return void viewerRoute.handler(req, res)
    if (pathname.startsWith('/api/mol-structure')) return void apiRoute.handler(req, res)
    res.writeHead(404).end()
})
const port = await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    server.on('error', reject)
})
const base = `http://127.0.0.1:${port}`

async function launchBrowser() {
    for (const opts of [undefined, { channel: 'msedge' }, { channel: 'chrome' }]) {
        try { return await chromium.launch(opts) } catch { /* try next */ }
    }
    throw new Error('no usable Chromium/Edge/Chrome')
}

const exec = { signal: new AbortController().signal }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mb = (n) => (n / 1048576).toFixed(1)

const browser = await launchBrowser()
try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 })
    page.on('pageerror', (e) => console.log('PAGE-ERROR', e.message))
    await page.goto(`${base}/api/mol-structure/viewer/index.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => (document.getElementById('status')?.textContent || '').includes('ready'), null, { timeout: 180000 })
    await sleep(1000)

    const call = (name, args) => toolDefs.get(name).execute(args ?? {}, exec)
    const heap = () => page.evaluate(() => {
        const gl = window.__viewer.plugin.canvas3d.webgl.gl
        const mem = window.performance.memory ? window.performance.memory.usedJSHeapSize : 0
        const resources = gl ? gl.getExtension('WEBGL_lose_context') : null // probe only
        const drawCalls = window.__viewer.plugin.canvas3d?.stats ? window.__viewer.plugin.canvas3d.stats.drawCalls : undefined
        return { heap: mem, canvases: document.querySelectorAll('canvas').length, drawCalls }
    })

    console.log('baseline', JSON.stringify(await heap()))

    await call('mol_load', { path: '6w5c.cif' })
    await sleep(4000)
    console.log('after load', JSON.stringify(await heap()))

    // the agent-session workload: repeated full rebuilds of a surface-heavy
    // custom panel + alternating close-ups + screenshots
    const panel = {
        id: 'mem-probe', title: 'mem probe',
        groups: [
            { chain: 'A', kind: 'ranges', ranges: [[1, 1093]], repr: 'molecular-surface', color: '#8FA3B8', alpha: 0.45 },
            { chain: 'A', kind: 'ranges', ranges: [[1, 1093]], repr: 'cartoon', color: '#C9CED4' },
            { chain: 'B', kind: 'ranges', ranges: [[-22, 27]], repr: 'cartoon', color: '#E8791D' },
            { chain: 'C', kind: 'ranges', ranges: [[1, 36]], repr: 'cartoon', color: '#D95FC0' },
        ],
        view: { yaw: 250, pitch: 10, zoom: 1.1 },
    }
    await call('mol_panel_define', { ...panel, apply: true })
    await sleep(6000)

    for (let i = 1; i <= 8; i++) {
        await call('mol_figure', { figure: 'mem-probe' })
        await sleep(5000)
        const h = await heap()
        console.log(`rebuild ${i}`, JSON.stringify(h))
    }

    for (let i = 1; i <= 3; i++) {
        await call('mol_screenshot')
        await sleep(1500)
        console.log(`shot ${i}`, JSON.stringify(await heap()))
    }

    // force GC if the page exposes --js-flags; report regardless
    try {
        await page.evaluate(() => window.gc?.())
        console.log('after forced gc', JSON.stringify(await heap()))
    } catch { /* no gc flag */ }

    console.log('shots dir', shotsDir)
} finally {
    await browser.close().catch(() => {})
    server.close()
}
