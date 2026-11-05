/**
 * Capture the Cas9 publication panels headlessly (mock harness + real browser).
 *
 * Reproducible alternative to the GUI iframe: loads 4UN3, re-registers the
 * cas9-* panels, applies each with the bridge, and saves full-page PNGs
 * (WebGL canvas + HTML labels) into docs/screenshots/cas9/.
 *
 * Run: node tools/capture-cas9.mjs [panelId …]   (default: all)
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(packageDir, 'docs', 'screenshots', 'cas9')
fs.mkdirSync(outDir, { recursive: true })

// --- mock harness (same shape as scripts/bridge-e2e.mjs) ---------------------
const routes = []
const toolDefs = new Map()
function makeCtx() {
    return {
        logger: { info: () => {}, warn: () => {} },
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
apply(makeCtx(), { screenshotDir: fs.mkdtempSync('mol-cap-') })

const eventsRoute = routes.find(r => r.kind === 'exact')
const viewerRoute = routes.find(r => r.path === '/api/mol-structure/viewer')
const apiRoute = routes.find(r => r.path === '/api/mol-structure')
const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0]
    if (p === '/api/mol-structure/events') return void eventsRoute.handler(req, res)
    if (p.startsWith('/api/mol-structure/viewer')) return void viewerRoute.handler(req, res)
    if (p.startsWith('/api/mol-structure')) return void apiRoute.handler(req, res)
    res.writeHead(404).end()
})
const port = await new Promise((res, rej) => { server.listen(0, '127.0.0.1', () => res(server.address().port)); server.on('error', rej) })
const base = `http://127.0.0.1:${port}`

// --- panel definitions (mirror of the GUI-registered cas9-* panels) ---------
const g = (chain, id, ranges, repr, color, alpha) => ({ chain, id, kind: 'ranges', ranges, repr, color, ...(alpha !== undefined ? { alpha } : {}) })
const r = (chain, id, residues, repr, color) => ({ chain, id, kind: 'residues', residues, repr, color })
const hb = (a, b) => ({ a, b })
const DOMAINS = [
    g('B', 'ruvcI', [[1, 93]], 'cartoon', '#2E86C9'),
    g('B', 'rec1', [[94, 179]], 'cartoon', '#C9CED4'),
    g('B', 'rec2', [[180, 293]], 'cartoon', '#AEB4BC'),
    g('B', 'rec3', [[294, 672]], 'cartoon', '#979FA8'),
    g('B', 'bh', [[673, 706]], 'cartoon', '#2FCC3B'),
    g('B', 'wed', [[707, 774]], 'cartoon', '#EDDE4C'),
    g('B', 'hnh', [[775, 1008]], 'cartoon', '#E37FB0'),
    g('B', 'ruvcIII', [[1085, 1100]], 'cartoon', '#2E86C9'),
    g('B', 'pi', [[1101, 1364]], 'cartoon', '#E3B422'),
]
const NUC = [g('A', 'rna', [[1, 81]], 'cartoon', '#CF3A3A'), g('C', 'ts', [[1, 28]], 'cartoon', '#E0457B'), g('D', 'nts', [[2, 12]], 'cartoon', '#38B6D8')]

const PANELS = {
    'cas9-ov': {
        title: 'Cas9 总览（域色）',
        groups: [...DOMAINS,
            r('B', 'ruvcCat', [10, 762, 840, 983], 'ball-and-stick', '#22C55E'),
            r('B', 'hnhCat', [839, 840], 'ball-and-stick', '#22D3EE'),
            ...NUC],
        view: { yaw: 255, pitch: 10, zoom: 1.15 },
        labels: [
            { text: 'PI (PAM recognition)', chain: 'B', seq: 1101 },
            { text: 'REC lobe (sgRNA channel)', chain: 'B', seq: 400 },
            { text: 'HNH (cleaves TS)', chain: 'B', seq: 900 },
            { text: 'RuvC (cleaves NTS)', chain: 'B', seq: 30 },
            { text: 'sgRNA-TS heteroduplex', chain: 'A', seq: 10 },
        ],
    },
    'cas9-surf': {
        title: 'Cas9 半透明表面 + 核酸 cartoon',
        groups: [
            g('B', 'surf', [[1, 1364]], 'molecular-surface', '#8FA3B8', 0.45),
            g('B', 'cartoonGhost', [[1, 1364]], 'cartoon', '#5B6B7B', 0.5),
            ...NUC,
        ],
        view: { yaw: 255, pitch: 10, zoom: 1.15 },
        labels: [
            { text: 'sgRNA-TS 异源双链', chain: 'A', seq: 10 },
            { text: 'PAM 口袋（PI）', chain: 'B', seq: 1335 },
            { text: 'HNH', chain: 'B', seq: 900 },
        ],
    },
    'cas9-pam': {
        title: 'PAM 识别（PI 域）',
        groups: [
            g('B', 'piGhost', [[1101, 1364]], 'cartoon', '#E3B422', 0.25),
            g('C', 'tsStick', [[1, 8]], 'ball-and-stick', '#E0457B'),
            g('D', 'ntsStick', [[8, 12]], 'ball-and-stick', '#38B6D8'),
            g('D', 'pam', [[10, 12]], 'ball-and-stick', '#DC2626'),
            r('B', 'pamRes', [1333, 1335, 1356, 1350, 1351], 'ball-and-stick', '#F97316'),
            r('B', 'piClamp', [1107, 1108, 1136, 1118], 'ball-and-stick', '#111827'),
        ],
        view: { yaw: 255, pitch: 10, zoom: 1.15 },
        hbonds: [hb({ chain: 'B', seq: 1333 }, { chain: 'D', seq: 10 }), hb({ chain: 'B', seq: 1335 }, { chain: 'D', seq: 11 }), hb({ chain: 'B', seq: 1350 }, { chain: 'D', seq: 12 }), hb({ chain: 'B', seq: 1107 }, { chain: 'C', seq: 2 })],
        labels: [
            { text: 'R1335 读 PAM 碱基', chain: 'B', seq: 1335 },
            { text: 'R1333', chain: 'B', seq: 1333 },
            { text: "PAM: 5'-TGG (+1..+3)", chain: 'D', seq: 10 },
        ],
    },
    'cas9-duplex': {
        title: '异源双链与 seed 通道',
        groups: [
            g('B', 'ghost', [[1, 1364]], 'cartoon', '#9CA3AF', 0.15),
            g('A', 'rnaGuide', [[1, 20]], 'ball-and-stick', '#CF3A3A'),
            g('C', 'tsComp', [[9, 28]], 'ball-and-stick', '#E0457B'),
            r('B', 'seedRes', [69, 70, 71, 72, 74, 403, 450, 661], 'ball-and-stick', '#F97316'),
            r('B', 'nestRes', [1105, 1349, 1356], 'ball-and-stick', '#7C3AED'),
        ],
        view: { yaw: 255, pitch: 15, zoom: 2.6 },
        hbonds: [hb({ chain: 'B', seq: 450 }, { chain: 'A', seq: 10 }), hb({ chain: 'B', seq: 403 }, { chain: 'A', seq: 6 }), hb({ chain: 'B', seq: 69 }, { chain: 'A', seq: 13 })],
        labels: [
            { text: 'sgRNA-TS 异源双链（seed）', chain: 'A', seq: 10 },
            { text: 'Y450', chain: 'B', seq: 450 },
            { text: 'R403', chain: 'B', seq: 403 },
            { text: 'F1105 碱基堆积', chain: 'B', seq: 1105 },
        ],
    },
    'cas9-cat': {
        title: '双核酸酶催化中心',
        groups: [
            g('B', 'ghost', [[1, 1364]], 'cartoon', '#9CA3AF', 0.15),
            g('C', 'tsStick', [[1, 28]], 'ball-and-stick', '#E0457B'),
            g('D', 'ntsStick', [[2, 12]], 'ball-and-stick', '#38B6D8'),
            r('B', 'ruvcTetrad', [10, 762, 840, 983], 'ball-and-stick', '#22C55E'),
            r('B', 'hnhCat', [839, 840, 854, 863], 'ball-and-stick', '#22D3EE'),
            { comp: 'MG', id: 'mg', kind: 'het', label: 'Mg2+', repr: 'ball-and-stick', color: '#A3E635' },
        ],
        view: { yaw: 255, pitch: 15, zoom: 2.6 },
        hbonds: [hb({ chain: 'B', seq: 983 }, { chain: 'D', seq: 3 }), hb({ chain: 'B', seq: 840 }, { chain: 'C', seq: 14 })],
        labels: [
            { text: 'RuvC tetrad（切 NTS）', chain: 'B', seq: 983 },
            { text: 'HNH 催化对（切 TS）', chain: 'B', seq: 840 },
        ],
    },
    'cas9-mut': {
        title: '点突变候选（靠近核酸的残基）',
        groups: [
            g('B', 'ghost', [[1, 1364]], 'cartoon', '#9CA3AF', 0.15),
            ...NUC,
            r('B', 'mutRes', [69, 70, 71, 72, 74, 403, 450, 661, 1105, 1107, 1108, 1118, 1123, 1122, 1136, 1333, 1335, 1356, 497, 926], 'ball-and-stick', '#F97316'),
        ],
        view: { yaw: 255, pitch: 10, zoom: 1.15 },
        hbonds: [hb({ chain: 'B', seq: 497 }, { chain: 'C', seq: 15 }), hb({ chain: 'B', seq: 926 }, { chain: 'C', seq: 19 }), hb({ chain: 'B', seq: 1136 }, { chain: 'D', seq: 4 }), hb({ chain: 'B', seq: 70 }, { chain: 'A', seq: 12 })],
        labels: [
            { text: 'N497→K（TS 骨架加盐桥）', chain: 'B', seq: 497 },
            { text: 'Q926→K（TS 骨架加盐桥）', chain: 'B', seq: 926 },
            { text: 'S1136→R（NTS 骨架）', chain: 'B', seq: 1136 },
            { text: 'R69-R74 簇（保守）', chain: 'B', seq: 70 },
            { text: 'R1333/R1335（PAM 扩展起点）', chain: 'B', seq: 1335 },
        ],
    },
}

// --- drive -------------------------------------------------------------------
const exec = { signal: new AbortController().signal }
const cif = path.join(packageDir, 'public', 'structures', '4un3.cif')
if (!fs.existsSync(cif)) { console.error('missing', cif); process.exit(1) }

let browser
for (const opts of [undefined, { channel: 'msedge' }, { channel: 'chrome' }]) {
    try { browser = await chromium.launch(opts); break } catch { /* next */ }
}
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => console.log('PAGE-ERROR', e.message))
await page.goto(`${base}/api/mol-structure/viewer/index.html`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => (document.getElementById('status')?.textContent || '').includes('ready'), null, { timeout: 180000 })

const load = toolDefs.get('mol_load')
const loaded = await load.execute({ path: cif, autoViews: false }, exec)
console.log('loaded:', loaded?.ok, 'chains:', loaded?.inventory?.chains?.length)

const define = toolDefs.get('mol_panel_define')
const figure = toolDefs.get('mol_figure')
const camera = toolDefs.get('mol_camera')

async function settle(ms = 9000) {
    await page.waitForFunction(() => (document.getElementById('status')?.textContent || '').includes('ready'), null, { timeout: 120000 }).catch(() => {})
    await page.waitForTimeout(ms)
}

for (const [id, spec] of Object.entries(PANELS)) {
    await define.execute({ id, title: spec.title, groups: spec.groups, labels: spec.labels, hbonds: spec.hbonds, view: spec.view }, exec)
    await figure.execute({ figure: id }, exec)
    await settle()
    await camera.execute({ view: spec.view }, exec)
    await page.waitForTimeout(2500)
    const out = path.join(outDir, `${id}-page.png`)
    await page.screenshot({ path: out })
    console.log('captured', out)
}

await browser.close()
server.close()
console.log('done')
