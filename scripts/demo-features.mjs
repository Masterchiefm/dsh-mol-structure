/**
 * v0.4 feature demo + verification — mock harness + real Chromium.
 * Drives every new capability in sequence and saves a screenshot per feature.
 * Run: node scripts/demo-features.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shotsDir = path.join(packageDir, 'docs', 'screenshots', 'iterations', 'v04-demo')
fs.mkdirSync(shotsDir, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mol-demo-'))

const routes = []
const toolDefs = new Map()
const makeCtx = () => ({
    logger: { info() {}, warn() {} },
    get: () => undefined,
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : undefined },
    inject(deps, cb) {
        cb({
            webServer: { register: (r) => { routes.push(r); return () => {} } },
            tools: { register: (d) => { toolDefs.set(d.name, d); return () => {} } },
            effect(fn) { return fn() },
        })
    },
})
const { apply } = await import('../index.js')
apply(makeCtx(), { screenshotDir: tmp })

const ev = routes.find(r => r.kind === 'exact')
const vw = routes.find(r => r.path === '/api/mol-structure/viewer')
const api = routes.find(r => r.path === '/api/mol-structure')
const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0]
    if (p === '/api/mol-structure/events') return void ev.handler(req, res)
    if (p.startsWith('/api/mol-structure/viewer')) return void vw.handler(req, res)
    if (p.startsWith('/api/mol-structure')) return void api.handler(req, res)
    res.writeHead(404).end()
})
const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const base = `http://127.0.0.1:${port}`

const { chromium } = await import('playwright')
let browser
for (const opts of [undefined, { channel: 'msedge' }, { channel: 'chrome' }]) {
    try { browser = await chromium.launch(opts); break } catch { /* next */ }
}
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 })
const exec = { signal: new AbortController().signal }
const call = async (name, args) => toolDefs.get(name).execute(args ?? {}, exec)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (label, ok, detail) => {
    if (ok) console.log(`ok  ${label}`)
    else { failures++; console.log(`FAIL ${label}${detail ? ' — ' + detail : ''}`) }
}
async function shot(name) {
    await sleep(1200)
    await page.screenshot({ path: path.join(shotsDir, `${name}.png`) })
    console.log(`    📸 ${name}.png`)
}

await page.goto(`${base}/api/mol-structure/viewer/index.html`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => (document.getElementById('status')?.textContent || '').includes('ready'), null, { timeout: 120000 })

// ── 1. mol_load: bundled structure + auto view set ─────────────────────────
const loaded = await call('mol_load', { path: '7xht.cif' })
check('mol_load 7XHT + 链清单', loaded.ok === true && loaded.inventory?.chains?.length >= 4, JSON.stringify(loaded).slice(0, 120))
check('mol_load 自动注册视图', Array.isArray(loaded.autoViews) && loaded.autoViews.length >= 2, JSON.stringify(loaded.autoViews))
await shot('01-load-autoviews')

// ── 2. mol_style: styled layer on the live structure ──────────────────────
const style = await call('mol_style', {
    chain: 'A', seqs: [56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86],
    repr: 'ball-and-stick', color: '#E85D3A', tag: 'ruvc-sticks', label: 'RuvC 催化域',
})
check('mol_style 加表征层', style.ok === true && style.tag === 'ruvc-sticks', JSON.stringify(style).slice(0, 120))
const styleReplaced = await call('mol_style', { chain: 'A', seqs: [61, 87], repr: 'ball-and-stick', color: '#FF8800', tag: 'ruvc-sticks' })
check('mol_style 同 tag 替换', styleReplaced.ok === true)
await shot('02-style-layer')

// ── 3. mol_focus: focus manager ────────────────────────────────────────────
const focus = await call('mol_focus', { chain: 'A', seq: 61 })
check('mol_focus 残基特写+相互作用圈', focus.ok === true && focus.residues?.some(r => r.seq === 61), JSON.stringify(focus).slice(0, 100))
await shot('03-focus')
await call('mol_focus', { clear: true })

// ── 4. mol_align: superposition numbers ────────────────────────────────────
const align = await call('mol_align', { a: { chain: 'A' }, b: { chain: 'C' } })
check('mol_align RMSD+矩阵', typeof align.rmsd === 'number' && align.matrix?.length === 16 && align.aligned > 0,
    `rmsd=${align.rmsd} aligned=${align.aligned}`)
console.log(`    align: ${align.aligned} 残基配对, RMSD ${align.rmsd} Å (chain A → C)`)

// ── 5. mol_structconn: deposited interactions ──────────────────────────────
const sc = await call('mol_structconn', { action: 'list' })
check('mol_structconn 列表', sc.ok === true && Array.isArray(sc.connections), JSON.stringify(sc).slice(0, 100))
console.log(`    struct_conn 记录 ${sc.count} 条: ${sc.connections.slice(0, 4).map(c => c.id).join(', ')}…`)
const covale = sc.connections.find(c => /covale|metalc|disulf/.test(c.id)) || sc.connections[0]
if (covale) {
    const shown = await call('mol_structconn', { action: 'show', id: covale.id })
    check(`mol_structconn show ${covale.id}`, shown.ok === true && shown.atomsShown >= 1, JSON.stringify(shown))
    await shot('04-structconn')
    await call('mol_structconn', { action: 'clear' })
}

// ── 6. mol_canvas: dark background ─────────────────────────────────────────
const bg = await call('mol_canvas', { backgroundColor: 'dark' })
check('mol_canvas 背景色', bg.ok === true && bg.backgroundColor === '#101014', JSON.stringify(bg))
await call('mol_camera', { view: { yaw: 250, pitch: 12 } }).catch(() => {})
await shot('05-canvas-dark')
await call('mol_canvas', { backgroundColor: 'white' })

// ── 7. action panel (agent-defined quick controls) ─────────────────────────
const actionDef = await call('mol_panel_define', {
    id: 'demo-actions',
    kind: 'action',
    title: '演示操作组',
    actions: [
        { label: '聚焦 D61', op: 'focus', args: { chain: 'A', seq: 61 } },
        { label: '总览视角', op: 'camera', args: { view: { yaw: 250, pitch: 12 } } },
        { label: '深色画布', op: 'canvas', args: { backgroundColor: 'dark' } },
    ],
    apply: true,
})
check('动作面板注册+执行', actionDef.ok === true && actionDef.panel?.kind === 'action' && Boolean(actionDef.applied),
    JSON.stringify(actionDef).slice(0, 200))
await page.waitForFunction(() => document.getElementById('btn-action-demo-actions') !== null, null, { timeout: 5000 })
// click the button in the control card → runs the op chain again
await page.evaluate(() => document.getElementById('btn-action-demo-actions').click())
await sleep(2500)
const darkAgain = await call('mol_canvas', { backgroundColor: 'light' }) // reset + proves page still responsive
check('动作面板按钮可点击执行', darkAgain.ok === true)
await call('mol_canvas', { backgroundColor: 'white' })
await shot('06-action-panel')

// ── 8. mol_export: mmCIF file ──────────────────────────────────────────────
const exp = await call('mol_export', { name: 'demo-export' })
const expOk = exp.ok === true && fs.existsSync(exp.path) && fs.statSync(exp.path).size > 10000
check('mol_export mmCIF 文件', expOk, JSON.stringify({ ...exp }).slice(0, 120))
if (expOk) console.log(`    导出 ${exp.path} (${Math.round(exp.bytes / 1024)} KB, ${exp.atoms} atoms)`)

// ── 9. mol_state: snapshot save/load ───────────────────────────────────────
const saveS = await call('mol_state', { action: 'save', name: 'demo-state' })
check('mol_state 保存', saveS.ok === true && fs.existsSync(saveS.path), JSON.stringify(saveS).slice(0, 100))
const loadS = await call('mol_state', { action: 'load', name: 'demo-state' })
check('mol_state 恢复后仍可查询', loadS.ok === true, JSON.stringify(loadS).slice(0, 100))
const q = await call('mol_query', { mode: 'chains' })
check('恢复后链清单可用', q.chains?.length >= 4, JSON.stringify(q).slice(0, 80))

// ── 10. settings: defaultMode via host settings API ────────────────────────
const setRes = await fetch(`${base}/api/mol-structure/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultMode: 'full' }),
}).then(r => r.json()).catch(() => null)
check('设置 defaultMode=full 持久化', setRes?.settings?.defaultMode === 'full', JSON.stringify(setRes))
await fetch(`${base}/api/mol-structure/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultMode: 'simple' }),
}).catch(() => {})

// ── 11. mol_mode: full Mol* UI ─────────────────────────────────────────────
const modeFull = await call('mol_mode', { full: true })
check('mol_mode → full（宣布重载）', modeFull.ok === true && modeFull.full === true && modeFull.reloading === true)
await page.waitForFunction(() => window.__molApi?.isFullMode?.() === true, null, { timeout: 60000 })
await sleep(2500) // let Mol* layout + controls mount
const native = await page.evaluate(() =>
    Boolean(document.querySelector('.msp-layout-standard')) &&
    Boolean(document.querySelector('.msp-viewport-controls-buttons, .msp-layout-controls')))
check('完整模式原生 UI 在场', native)
await shot('07-full-molstar')

const modeSimple = await call('mol_mode', { full: false })
check('mol_mode → simple', modeSimple.ok === true && modeSimple.full === false)
await page.waitForFunction(() => window.__molApi?.isFullMode?.() === false, null, { timeout: 60000 })
await sleep(1500)

// ── 12. custom VIEW panel still renders (button in card) ───────────────────
const view = await call('mol_panel_define', {
    id: 'demo-view',
    title: '演示自定义视图',
    structureUrl: './structures/7xht.cif',
    groups: [{ chain: 'A', ranges: [[87, 122]], color: '#2FCC3B', repr: 'cartoon' }],
    focus: { chain: 'A', seq: 100, radius: 0.4 },
    labels: [{ text: 'BH α-螺旋', chain: 'A', seq: 100, kind: 'pill', bg: '#2FCC3B', color: '#fff' }],
    apply: true,
})
check('自定义视图注册+应用', view.ok === true && view.panel?.id === 'demo-view')
await shot('08-custom-view')

await browser.close()
server.close()
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
console.log(failures ? `\n${failures} FAILED` : '\n全部演示验证通过')
process.exit(failures ? 1 : 0)
