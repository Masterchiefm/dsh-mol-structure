/**
 * End-to-end bridge test — mock harness + real browser.
 *
 * Mounts the plugin's Host half under a real node:http server (the mock
 * context's webServer), then drives the built viewer page in headless
 * Chromium through the actual SSE/JSON bridge:
 *
 * - the viewer connects (SSE hello + status heartbeat);
 * - every mol_* tool round-trips a command and returns a canonical result;
 * - a click in the 3D view is reported to POST /selection;
 * - screenshots land on disk in a temp dir.
 *
 * The hot-reload path needs the real cordis loader/registry and is covered
 * on the harness itself (see docs/plugin.md §验证).
 *
 * Run: node scripts/bridge-e2e.mjs
 *
 * @module scripts/bridge-e2e.mjs
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shotsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mol-shots-'))

if (!fs.existsSync(path.join(packageDir, 'dist', 'index.html'))) {
    console.error('dist/index.html missing — run npm run build first')
    process.exit(1)
}

// --- mock harness context with a real HTTP dispatch -------------------------
const routes = []
const toolDefs = new Map()

function makeCtx() {
    return {
        logger: { info: () => {}, warn: (m) => console.log('[warn]', m) },
        get: () => undefined,
        effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : undefined },
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
console.log('mock harness at', base)

async function getState() {
    const res = await fetch(`${base}/api/mol-structure/state`)
    return res.json()
}

let failures = 0
function check(label, ok, detail) {
    if (ok) console.log(`ok  ${label}`)
    else { failures++; console.log(`FAIL ${label}${detail ? ' — ' + detail : ''}`) }
}
const exec = { signal: new AbortController().signal }

async function launchBrowser() {
    // bundled chromium → system Edge → system Chrome
    for (const opts of [undefined, { channel: 'msedge' }, { channel: 'chrome' }]) {
        try { return await chromium.launch(opts) } catch { /* try next */ }
    }
    throw new Error('no usable Chromium/Edge/Chrome for Playwright')
}

async function withPage(fn) {
    const browser = await launchBrowser()
    try {
        return await fn(browser)
    } finally {
        await browser.close().catch(() => {})
    }
}

// --- single browser session for the whole suite -----------------------------
await withPage(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 })
    page.on('pageerror', (e) => console.log('PAGE-ERROR', e.message))
    await page.goto(`${base}/api/mol-structure/viewer/index.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
        () => (document.getElementById('status')?.textContent || '').includes('ready'),
        null, { timeout: 180000 },
    )
    console.log('viewer page ready')

    let state = null
    for (let i = 0; i < 40; i++) {
        state = await getState()
        if (state.connected) break
        await new Promise(r => setTimeout(r, 250))
    }
    check('viewer connected over the bridge', state?.connected === true, JSON.stringify(state))

    const call = async (name, args) => {
        const def = toolDefs.get(name)
        if (!def) throw new Error(`tool ${name} not registered`)
        return def.execute(args ?? {}, exec)
    }

    // the viewer boots empty (no default paper panel); load the IscB structure
    // explicitly and wait for the debounced figure-name report
    const load0 = await call('mol_load', { path: '7xht.cif' })
    check('mol_load bundled 7XHT on boot', load0.ok === true, JSON.stringify(load0).slice(0, 200))
    for (let i = 0; i < 20 && state.figure !== '7xht.cif · 原始结构'; i++) {
        await new Promise(r => setTimeout(r, 250))
        state = await getState()
    }

    // --- mol_status
    const st = await call('mol_status')
    check('mol_status reports live viewer', st.connected === true && st.figure === '7xht.cif · 原始结构', JSON.stringify(st))

    // --- mol_query chains (7XHT: A protein, B RNA, C TS, D NTS)
    const chains = await call('mol_query', { mode: 'chains' })
    const chainIds = chains.chains.map(c => c.chain)
    check('mol_query chains lists 7XHT chains', ['A', 'B', 'C', 'D'].every(c => chainIds.includes(c)), chainIds.join(','))
    check('mol_query chain molecule types', chains.chains.some(c => c.moleculeType === 'Protein') && chains.chains.some(c => c.moleculeType === 'RNA'),
        JSON.stringify(chains.chains.map(c => [c.chain, c.moleculeType])))

    // --- mol_camera focus
    const cam = await call('mol_camera', { focus: { chain: 'A', seq: 61 } })
    check('mol_camera focus residue', cam.ok === true)
    await new Promise(r => setTimeout(r, 1700)) // 300ms animation + 500/1100ms delayed re-asserts

    // --- empty click must keep the focused center (camera pin), not reset it
    const targetBefore = await page.evaluate(() => [...window.__viewer.plugin.canvas3d.camera.state.target])
    const box0 = await page.evaluate(() => {
        const r = window.__viewer.plugin.canvas3d.webgl.gl.canvas.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
    })
    await page.mouse.click(box0.x + 6, box0.y + 6) // empty corner
    await new Promise(r => setTimeout(r, 800)) // click + debounced selection report
    const targetAfter = await page.evaluate(() => [...window.__viewer.plugin.canvas3d.camera.state.target])
    const drift = Math.hypot(targetBefore[0] - targetAfter[0], targetBefore[1] - targetAfter[1], targetBefore[2] - targetAfter[2])
    check('empty click keeps the centered close-up', drift < 0.5,
        `drift ${drift.toFixed(2)} Å before=${targetBefore.map(v => v.toFixed(1))} after=${targetAfter.map(v => v.toFixed(1))}`)

    // --- mol_labels (computed residue anchor)
    const lab = await call('mol_labels', { labels: [{ text: 'ASP 61', chain: 'A', seq: 61, kind: 'pill', bg: '#CF3A3A', color: '#fff' }] })
    check('mol_labels residue anchor', lab.ok === true && lab.labels === 1)
    const labelCount = await page.evaluate(() => document.querySelectorAll('.label-layer > div').length)
    check('label element rendered in page', labelCount >= 1, `got ${labelCount}`)

    // --- mol_hbonds + mol_measure
    const hb = await call('mol_hbonds', { pairs: [{ a: { chain: 'A', seq: 61 }, b: { chain: 'A', seq: 87 } }] })
    check('mol_hbonds draws pair', hb.ok === true && hb.pairs[0].ok === true, JSON.stringify(hb))
    const meas = await call('mol_measure', { a: { chain: 'A', seq: 61 }, b: { chain: 'A', seq: 87 } })
    check('mol_measure returns Å distance', typeof meas.distance === 'number' && meas.distance > 0, JSON.stringify(meas))

    // --- mol_select (agent-driven; should be reported as agent source)
    const sel = await call('mol_select', { chain: 'A', seqs: [61, 87] })
    check('mol_select sets selection', sel.ok === true && sel.residues.length === 2, JSON.stringify(sel))
    await new Promise(r => setTimeout(r, 600)) // debounced POST /selection
    state = await getState()
    check('agent selection reported to host', state.lastUserSelection?.source === 'agent', JSON.stringify(state.lastUserSelection))

    // --- user click in the 3D view → user selection report
    await call('mol_select', { clear: true }).catch(() => {})
    const canvasBox = await page.evaluate(() => {
        const c = window.__viewer.plugin.canvas3d.webgl.gl.canvas
        const r = c.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    await page.mouse.click(canvasBox.x, canvasBox.y)
    await new Promise(r => setTimeout(r, 1200))
    state = await getState()
    // soft: the center pixel may or may not hit an atom; both outcomes prove
    // the click path only when it hits. Report, and require no crash.
    console.log('click report:', state.lastUserSelection ? `${state.lastUserSelection.source}/${state.lastUserSelection.kind}: ${state.lastUserSelection.text}` : '(no atom under cursor)')

    // --- mol_screenshot
    const shot = await call('mol_screenshot')
    const shotOk = typeof shot.path === 'string' && fs.existsSync(shot.path) && fs.statSync(shot.path).size > 1000
    check('mol_screenshot saves PNG', shotOk, JSON.stringify({ ...shot, path: shot.path }))

    // --- mol_figure back to a paper panel
    const fig = await call('mol_figure', { figure: 'fig3c' })
    check('mol_figure applies panel', fig.ok === true && fig.figure === 'fig3c')

    // --- 「重载视图」 rebuilds the last figure and reports completion
    await page.evaluate(() => document.getElementById('btn-reload-view').click())
    const reloaded = await page.waitForFunction(
        () => (document.getElementById('status')?.textContent || '').includes('视图已重载'),
        null, { timeout: 20000 },
    ).then(() => true).catch(() => false)
    check('reload-view button rebuilds the last figure', reloaded)

    // --- mol_load bundled structure + mol_scene on it
    const loaded = await call('mol_load', { path: '6w5c.cif' })
    check('mol_load bundles + inventories 6W5C', loaded.ok === true && loaded.inventory?.chains?.length >= 3,
        JSON.stringify(loaded.inventory?.chains?.map(c => c.chain)))
    check('mol_load auto-registers views', Array.isArray(loaded.autoViews) && loaded.autoViews.length >= 2,
        JSON.stringify(loaded.autoViews))

    // --- mol_autoviews restyles via the interface (no source edits)
    const restyled = await call('mol_autoviews', {
        palette: ['#FF0000', '#00FF00', '#0000FF'],
        sideChainColors: { A: '#FFAA00' },
        hbondColor: '#FFFF00',
        closeup: 0.5,
        maxViews: 1,
    })
    check('mol_autoviews restyles via interface', restyled.ok === true && restyled.views?.length >= 1,
        JSON.stringify(restyled).slice(0, 200))
    const paletted = await page.evaluate(() => {
        const spec = window.__molApi.customPanels.get('auto-overview')
        return spec ? spec.groups.map(g => g.color) : null
    })
    check('custom palette applied to auto overview', Array.isArray(paletted) && paletted[0] === '#FF0000', JSON.stringify(paletted))
    await new Promise(r => setTimeout(r, 400))
    await new Promise(r => setTimeout(r, 900))
    const autoBtn = await page.evaluate((id) => document.getElementById(`btn-custom-${id}`) !== null, loaded.autoViews?.[0]?.id)
    check('auto view button rendered in card', autoBtn, JSON.stringify(loaded.autoViews?.[0]))
    const scene = await call('mol_scene', {
        groups: [
            { id: 'rec', chain: 'A', ranges: [[1, 400]], color: '#EDDE4C', repr: 'cartoon' },
            { id: 'ruvc', chain: 'A', ranges: [[401, 700]], color: '#3E97DE', repr: 'cartoon' },
        ],
    })
    check('mol_scene builds groups on loaded structure', scene.ok === true && scene.groups === 2)

    // --- custom panel registry: agent defines → button appears → external program applies
    const defined = await call('mol_panel_define', {
        id: 'e2e-view',
        title: 'E2E 自定义视图',
        groups: [{ chain: 'A', ranges: [[1, 300]], color: '#2FCC3B' }],
        view: { yaw: 210, pitch: 8, zoom: 1 },
        labels: [{ text: 'N-term', chain: 'A', seq: 50, kind: 'pill', bg: '#CF3A3A', color: '#fff' }],
        apply: true,
    })
    check('mol_panel_define registers + applies', defined.ok === true && defined.panel?.id === 'e2e-view', JSON.stringify(defined).slice(0, 120))
    await page.waitForFunction(() => document.getElementById('btn-custom-e2e-view') !== null, null, { timeout: 5000 })
    check('custom panel button rendered in control card', true)
    await new Promise(r => setTimeout(r, 1200)) // delayed camera re-assert + label render
    const labelCount2 = await page.evaluate(() => document.querySelectorAll('.label-layer > div').length)
    check('custom panel labels rendered', labelCount2 >= 1, `got ${labelCount2}`)

    // external local program (no Origin header — like a Python script on this machine)
    const ext = async (op, args) => {
        const r = await fetch(`${base}/api/mol-structure/command`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op, args }),
        })
        return { status: r.status, body: await r.json() }
    }
    const listing = await ext('figures')
    check('external program lists figures incl. custom', listing.status === 200
        && listing.body.result?.figures?.some(f => f.id === 'e2e-view' && f.custom === true))
    const applied = await ext('figure', { figure: 'e2e-view' })
    check('external program applies custom panel', applied.status === 200 && applied.body.result?.ok === true
        && applied.body.result?.custom === true, JSON.stringify(applied.body).slice(0, 150))
    const rejected = await ext('bogus-op')
    check('external program unknown op → 400', rejected.status === 400)

    await call('mol_figure', { figure: 'fig1b' }).catch(() => {})
    await new Promise(r => setTimeout(r, 800))

    // --- v0.4 capability set: style / focus / align / structconn / canvas ---
    const style1 = await call('mol_style', { chain: 'A', seqs: [61, 87], repr: 'ball-and-stick', color: '#FF8800', tag: 'e2e-style' })
    check('mol_style adds a styled layer', style1.ok === true && style1.tag === 'e2e-style', JSON.stringify(style1).slice(0, 150))
    const style2 = await call('mol_style', { chain: 'A', seqs: [61], repr: 'cartoon', color: '#00AA00', tag: 'e2e-style' })
    check('mol_style replaces the same-tag layer', style2.ok === true)
    const foc = await call('mol_focus', { chain: 'A', seq: 61 })
    check('mol_focus closes in on a residue', foc.ok === true && foc.residues?.length >= 1, JSON.stringify(foc).slice(0, 120))
    check('mol_focus clear', (await call('mol_focus', { clear: true })).ok === true)
    const align = await call('mol_align', { a: { chain: 'A' }, b: { chain: 'C' } })
    check('mol_align computes RMSD + 4×4 matrix', typeof align.rmsd === 'number' && Array.isArray(align.matrix) && align.matrix.length === 16 && align.aligned >= 1,
        JSON.stringify(align).slice(0, 120))
    const sc = await call('mol_structconn', { action: 'list' })
    check('mol_structconn lists mmCIF connections', sc.ok === true && Array.isArray(sc.connections), JSON.stringify(sc).slice(0, 100))
    const bg = await call('mol_canvas', { backgroundColor: 'dark' })
    check('mol_canvas sets background', bg.ok === true && bg.backgroundColor === '#101014', JSON.stringify(bg))
    await call('mol_canvas', { backgroundColor: 'white' }).catch(() => {})

    // --- v0.4 capability set: export + state snapshots ---
    const exp = await call('mol_export', { name: 'e2e-export' })
    check('mol_export writes mmCIF file', exp.ok === true && typeof exp.path === 'string' && fs.existsSync(exp.path) && fs.statSync(exp.path).size > 10000,
        JSON.stringify({ ...exp, path: exp.path }).slice(0, 150))
    const saveS = await call('mol_state', { action: 'save', name: 'e2e-state' })
    check('mol_state saves a snapshot file', saveS.ok === true && typeof saveS.path === 'string' && fs.existsSync(saveS.path), JSON.stringify(saveS).slice(0, 120))
    const loadS = await call('mol_state', { action: 'load', name: 'e2e-state' })
    check('mol_state restores a snapshot', loadS.ok === true, JSON.stringify(loadS).slice(0, 150))

    // --- v0.4: action panels (agent-defined quick controls) ---
    let actionApplied
    try {
        actionApplied = await call('mol_panel_define', {
            id: 'e2e-actions',
            kind: 'action',
            title: 'E2E 操作组',
            actions: [
                { label: '聚焦 61', op: 'focus', args: { chain: 'A', seq: 61 } },
                { label: '回到总览', op: 'camera', args: { view: { yaw: 250, pitch: 12 } } },
            ],
            apply: true,
        })
    } catch (e) {
        console.log('action panel apply error:', e?.message, '\n', e?.stack?.split('\n').slice(0, 3).join('\n'))
    }
    check('action panel registered + applied', actionApplied?.ok === true && actionApplied?.panel?.kind === 'action' && Boolean(actionApplied?.applied),
        JSON.stringify(actionApplied).slice(0, 200))
    const actionBtn = await page.waitForFunction(
        () => document.getElementById('btn-action-e2e-actions') !== null, null, { timeout: 5000 },
    ).then(() => true).catch(() => false)
    check('action panel button rendered in control card', actionBtn)

    // --- page reload restores the last view automatically (blank-canvas fix)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
        () => (document.getElementById('status')?.textContent || '').includes('ready'),
        null, { timeout: 120000 },
    )
    const restored = await page.waitForFunction(
        () => (document.getElementById('status')?.textContent || '').includes('视图已重载'),
        null, { timeout: 60000 },
    ).then(() => true).catch(() => false)
    check('last view restored automatically after page reload', restored)

    // --- v0.4: full Mol* mode switch (reloads the page; last — runs at the end)
    const modeFull = await call('mol_mode', { full: true })
    check('mol_mode switches to full (reload announced)', modeFull.ok === true && modeFull.full === true && modeFull.reloading === true,
        JSON.stringify(modeFull))
    // the reload is async (800 ms delay so the op result POSTs first) — wait on
    // the flag itself, not the status line (ready is already set pre-reload)
    await page.waitForFunction(() => window.__molApi?.isFullMode?.() === true, null, { timeout: 60000 })
    const fullOn = await page.evaluate(() => window.__molApi.isFullMode() === true
        && document.getElementById('btn-mode')?.textContent.includes('开'))
    check('full Mol* mode active after reload', fullOn)
    const nativeUI = await page.evaluate(() =>
        Boolean(document.querySelector('.msp-layout-standard, .msp-viewport-controls-buttons')))
    check('full mode native Mol* UI present', nativeUI)
    const modeSimple = await call('mol_mode', { full: false })
    check('mol_mode switches back to simple', modeSimple.ok === true && modeSimple.full === false)
    await page.waitForFunction(() => window.__molApi?.isFullMode?.() === false, null, { timeout: 60000 })
    check('simple mode restored after reload', await page.evaluate(() => window.__molApi.isFullMode() === false))
})

server.close()
try { fs.rmSync(shotsDir, { recursive: true, force: true }) } catch { /* best effort */ }

if (failures > 0) {
    console.log(`\n${failures} e2e check(s) FAILED`)
    process.exit(1)
}
console.log('\nall bridge e2e checks passed')
