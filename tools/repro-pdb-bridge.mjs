// Repro: load the binder/TfR1 aligned PDB through the real viewer bridge.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const routes = []
function makeCtx() {
    return {
        logger: { info: () => {}, warn: (m) => console.log('[warn]', m) },
        get: () => undefined,
        effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : undefined },
        inject(deps, cb) {
            cb({
                webServer: { register: (route) => { routes.push(route); return () => {} } },
                tools: { register: () => {} },
                effect(fn) { return fn() },
            })
        },
    }
}
const { apply } = await import('../index.js')
apply(makeCtx(), {})

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
const port = await new Promise((res, rej) => { server.listen(0, '127.0.0.1', () => res(server.address().port)); server.on('error', rej) })
const base = `http://127.0.0.1:${port}`

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'msedge' }))
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on('pageerror', (e) => console.log('PAGE-ERROR', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR', m.text().slice(0, 2000)) })
await page.goto(`${base}/api/mol-structure/viewer/index.html`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => (document.getElementById('status')?.textContent || '').includes('ready'), null, { timeout: 120000 })
console.log('viewer ready')

async function command(op, args) {
    const res = await fetch(`${base}/api/mol-structure/command`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, args }),
    })
    return res.json()
}

console.log('scene bundled →', JSON.stringify(await command('scene', { structureUrl: 'structures/7xht.cif', groups: [ {id:'g',chain:'A',ranges:[[3,100]],color:'#2FCC3B',repr:'cartoon'} ] })).slice(0, 1500))
const pdb = 'C:/Users/moqiq/Downloads/TfR1_SHEET_binder_01_aligned_to_9gh7.pdb'
console.log('load PDB →', JSON.stringify(await command('load', { path: pdb })).slice(0, 400))
console.log('load again →', JSON.stringify(await command('load', { path: pdb })).slice(0, 400))
const cif = 'C:/Users/moqiq/Downloads/TfR1_SHEET_binder_01.cif'
console.log('load CIF →', JSON.stringify(await command('load', { path: cif })).slice(0, 400))
console.log('scene cif →', JSON.stringify(await command('scene', { groups: [ {id:'rec',chain:'A',ranges:[[197,379]],color:'#EDDE4C',repr:'cartoon'} ] })).slice(0, 2000))
await page.waitForTimeout(500)
console.log('scene again →', JSON.stringify(await command('scene', { groups: [ {id:'rec',chain:'A',ranges:[[197,379]],color:'#EDDE4C',repr:'cartoon'} ] })).slice(0, 2000))
await page.evaluate(() => window.__molApi.dispatch('labels', { labels: [
  { text: 'binder N-helix E5-V10', chain: 'B', seq: 5, kind: 'pill', bg: '#2FA96B', color: '#fff' },
  { text: 'E69 <-> Q197', chain: 'B', seq: 69, kind: 'pill', bg: '#2FA96B', color: '#fff' },
  { text: 'T73 <-> K374', chain: 'B', seq: 73, kind: 'pill', bg: '#2FA96B', color: '#fff' },
  { text: 'M65-I77 hydrophobic core', chain: 'B', seq: 66, kind: 'pill', bg: '#334155', color: '#fff' },
  { text: 'TfR1 Gln197', chain: 'A', seq: 197, kind: 'pill', bg: '#334155', color: '#fff' },
  { text: 'Tyr211', chain: 'A', seq: 211, kind: 'pill', bg: '#334155', color: '#fff' },
  { text: 'R208-L212 stripe', chain: 'A', seq: 208, kind: 'pill', bg: '#334155', color: '#fff' },
  { text: 'TfR1 Asn215', chain: 'A', seq: 215, kind: 'pill', bg: '#334155', color: '#fff' },
] }))
console.log('interfaces →', JSON.stringify(await command('interfaces', {})).slice(0, 800))
await page.waitForTimeout(1500)
// open the control card so the layout (chip + card in the same corner) is visible
await page.evaluate(() => document.getElementById('btn-card-toggle').click())
await page.waitForTimeout(400)
await page.screenshot({ path: 'docs/screenshots/iterations/leader-labels-check.png', fullPage: false })
console.log('page screenshot saved')
await browser.close()
server.close()
