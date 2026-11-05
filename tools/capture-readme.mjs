/**
 * README screenshots — real dsh GUI, full window (chat + right sidebar).
 *
 * Opens the live dsh web GUI in headless Chromium (cookie minted the same
 * way dsh's /connect endpoint does), opens the plugin's 「结构视图」 sidebar
 * tab, drives the viewer through the open /command interface, and captures
 * the WHOLE window (not just the viewer pane).
 *
 * Run: node tools/capture-readme.mjs [guiUrl]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import crypto from 'node:crypto'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(packageDir, 'docs', 'screenshots', 'readme')
fs.mkdirSync(outDir, { recursive: true })

const gui = process.argv[2] || 'http://127.0.0.1:52041'
const base = `${gui}/api/mol-structure`
const cifPath = path.join(packageDir, 'public', 'structures', '4oo8.cif').replaceAll('\\', '/')

const BASE_GROUPS = [
    { chain: 'A', kind: 'ranges', ranges: [[3, 1366]], repr: 'molecular-surface', color: '#8FA3B8', alpha: 0.45 },
    { chain: 'A', kind: 'ranges', ranges: [[3, 1366]], repr: 'cartoon', color: '#5B6B7B' },
    { chain: 'B', kind: 'ranges', ranges: [[1, 97]], repr: 'cartoon', color: '#CF3A3A' },
    { chain: 'C', kind: 'ranges', ranges: [[0, 20]], repr: 'cartoon', color: '#38B6D8' },
]

const VIEWS = [
    { id: 'sa9-ov', title: 'SaCas9 总览（surface + cartoon）', groups: BASE_GROUPS,
      camera: { yaw: 255, pitch: 12, zoom: 1.15 }, settle: 25000 },
    { id: 'sa9-pam', title: 'PAM 识别特写（蛋白–DNA 互作）',
      groups: [...BASE_GROUPS, { chain: 'A', kind: 'residues', residues: [1106, 1107, 1108, 1109, 1110], repr: 'ball-and-stick', color: '#F97316' }],
      hbonds: [{ a: { chain: 'A', seq: 1107 }, b: { chain: 'C', seq: 0 } }, { a: { chain: 'A', seq: 1109 }, b: { chain: 'C', seq: 1 } }],
      labels: [
          { kind: 'pill', chain: 'A', seq: 1107, text: 'K1107 (PI)' },
          { kind: 'pill', chain: 'A', seq: 1109, text: 'S1109' },
          { kind: 'pill', chain: 'C', seq: 1, text: 'PAM 端 dA0–dG1', color: '#E23B3B' },
      ],
      camera: { yaw: 250, pitch: 8, zoom: 2.6, target: [-28.39, 101.19, -13.97] }, settle: 25000 },
    { id: 'sa9-hetero', title: 'seed 异源双链特写（蛋白–RNA–DNA 互作）',
      groups: [...BASE_GROUPS, { chain: 'A', kind: 'residues', residues: [72, 75, 401, 402, 403, 404, 405], repr: 'ball-and-stick', color: '#EAB308' }],
      hbonds: [{ a: { chain: 'A', seq: 403 }, b: { chain: 'B', seq: 20 } }, { a: { chain: 'A', seq: 75 }, b: { chain: 'B', seq: 20 } }],
      labels: [
          { kind: 'pill', chain: 'A', seq: 403, text: 'R403' },
          { kind: 'pill', chain: 'A', seq: 75, text: 'R75' },
          { kind: 'pill', chain: 'A', seq: 72, text: 'Y72' },
          { kind: 'pill', chain: 'B', seq: 20, text: 'sgRNA–DNA 异源双链', color: '#E23B3B' },
      ],
      camera: { yaw: 250, pitch: 10, zoom: 2.5, target: [-26.23, 115.31, -22.88] }, settle: 25000 },
]

async function command(op, args, cookie) {
    const res = await fetch(`${base}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ op, args }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${op} -> HTTP ${res.status}: ${JSON.stringify(json)}`)
    return json
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// --- mint a browser-session cookie the same way dsh's /connect does ---------
// cookie value = v1.<b64url(payload)>.<b64url(hmacSHA256(secretBytes, body))>
function b64url(buf) {
    return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
function mintCookie(guiUrl) {
    const { host } = new URL(guiUrl)
    const credFile = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml')
    const yamlText = fs.readFileSync(credFile, 'utf8')
    const m = yamlText.match(/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/)
    if (!m) throw new Error('browser-session secret not found in .credentials.yaml')
    const secretBytes = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    const now = Date.now()
    const body = b64url(Buffer.from(JSON.stringify({
        version: 1,
        authority: host,
        issuedAt: now,
        expiresAt: now + 24 * 3600 * 1000,
    }), 'utf8'))
    const sig = b64url(crypto.createHmac('sha256', secretBytes).update(body).digest())
    return {
        name: 'dsh-auth-' + b64url(crypto.createHash('sha256').update(host).digest()),
        value: `v1.${body}.${sig}`,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Strict',
    }
}

async function launchBrowser() {
    for (const opts of [undefined, { channel: 'msedge' }, { channel: 'chrome' }]) {
        try { return await chromium.launch(opts) } catch { /* next */ }
    }
    throw new Error('no usable Chromium/Edge/Chrome for Playwright')
}

const browser = await launchBrowser()
try {
    const cookie = mintCookie(gui)
    const context = await browser.newContext({ viewport: { width: 1680, height: 980 }, deviceScaleFactor: 2 })
    await context.addCookies([cookie])
    const page = await context.newPage()
    page.on('pageerror', (e) => console.log('PAGE-ERROR', e.message))
    console.log('opening', gui)
    await page.goto(gui, { waitUntil: 'domcontentloaded' })
    await sleep(8000)

    // dismiss the preview-notes dialog if it shows
    await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button,[role="button"],div,span')]
            .filter(e => (e.textContent || '').trim() === '继续').at(-1)
        if (btn) btn.click()
    })
    await sleep(2000)

    // already open from a previous run? then just reuse the viewer iframe
    const iframeReady = await page.evaluate(() => {
        const f = [...document.querySelectorAll('iframe')]
            .find(f => (f.src || '').includes('/api/mol-structure/viewer'))
        return !!f && !!f.contentDocument
            && (f.contentDocument.getElementById('status')?.textContent || '').includes('ready')
    })
    if (!iframeReady) {
        // open the right sidebar (top-right pane toggle), then the 结构视图 tab
        await page.evaluate(() => {
            const els = [...document.querySelectorAll('button,[role="button"]')]
            const toggle = els.find(e => {
                const r = e.getBoundingClientRect()
                return r.width > 0 && r.left > window.innerWidth - 120 && r.top < 80
            })
            if (toggle) toggle.click()
        })
        await sleep(2500)
        const clicked = await page.evaluate(() => {
            const cands = [...document.querySelectorAll('button, [role="tab"], [role="button"], div, span')]
                .filter(el => (el.textContent || '').trim() === '结构视图')
            const el = cands[cands.length - 1]
            if (el) { el.click(); return true }
            return false
        })
        console.log('tab clicked:', clicked)
        if (!clicked) throw new Error('结构视图 tab not found in GUI DOM')
    }

    // wait for the plugin viewer iframe to be ready
    await page.waitForFunction(() => {
        const f = [...document.querySelectorAll('iframe')]
            .find(f => (f.src || '').includes('/api/mol-structure/viewer'))
        return !!f && !!f.contentDocument
            && (f.contentDocument.getElementById('status')?.textContent || '').includes('ready')
    }, null, { timeout: 120000 })
    console.log('viewer iframe ready')

    // drive THIS page's viewer directly (host /command would broadcast to
    // every connected viewer and another one may grab the commands)
    const frame = page.frames().find(f => f.url().includes('/api/mol-structure/viewer'))
    if (!frame) throw new Error('viewer frame not found')
    const dispatch = (op, args) => frame.evaluate(([o, a]) => window.__molApi.dispatch(o, a), [op, args])

    // load the cif via an in-frame blob URL (viewer load op needs a URL;
    // the host-side token path broadcasts to every connected viewer)
    const b64 = fs.readFileSync(cifPath).toString('base64')
    const load = await frame.evaluate(async (b) => {
        const bin = atob(b)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const url = URL.createObjectURL(new Blob([bytes], { type: 'text/plain' }))
        window.__molBlobUrl = url
        return window.__molApi.dispatch('load', { url, name: '4oo8.cif' })
    }, b64)
    console.log('load ok:', load && load.ok !== false, JSON.stringify(load).slice(0, 120))
    await sleep(12000)

    // register the three panels host-side (panelDefine is a host op; the
    // registry is shared with every viewer through the SSE panels event)
    const ck = `${cookie.name}=${cookie.value}`
    for (const v of VIEWS) {
        await command('panelDefine', {
            id: v.id, title: v.title, groups: v.groups,
            hbonds: v.hbonds, labels: v.labels,
            view: v.camera, apply: false,
        }, ck)
    }

    const blobUrl = await frame.evaluate(() => window.__molBlobUrl)
    for (const v of VIEWS) {
        await frame.evaluate(async (a) => window.__molApi.dispatch('figure', { id: a.id, structureUrl: a.url }), { id: v.id, url: blobUrl })
        await sleep(v.settle)
        // re-assert this view's exact annotations (previous panel's labels /
        // measurement lines can linger otherwise) and the calibrated camera
        const ann = await frame.evaluate(async (a) => {
            await window.__molApi.dispatch('labels', { labels: [] })
            await new Promise(r => setTimeout(r, 400))
            const r1 = await window.__molApi.dispatch('labels', { labels: a.labels }).catch(e => 'ERR ' + e.message)
            const r2 = await window.__molApi.dispatch('hbonds', { clear: true }).catch(e => 'ERR ' + e.message)
            const r3 = a.hbonds.length
                ? await window.__molApi.dispatch('hbonds', { pairs: a.hbonds }).catch(e => 'ERR ' + e.message)
                : 'skip'
            return [JSON.stringify(r1).slice(0, 100), JSON.stringify(r2).slice(0, 80), JSON.stringify(r3).slice(0, 80)]
        }, { labels: v.labels ?? [], hbonds: v.hbonds ?? [] })
        console.log('annotations', v.id, ann)
        await sleep(1500)
        // Mol* auto-fits after building — re-assert the calibrated camera
        await dispatch('camera', { view: v.camera })
        await sleep(2500)
        const out = path.join(outDir, `${v.id}.png`)
        await page.screenshot({ path: out })
        console.log('saved', out)
    }
} finally {
    await browser.close().catch(() => {})
}
console.log('done')
