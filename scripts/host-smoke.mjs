/**
 * Host-half smoke test — no harness required.
 *
 * Runs `apply()` against a mock context (fake webServer/tools/connection),
 * then pokes the API route with fake req/res objects to prove: the trust
 * fence admits same-origin loopback requests and rejects foreign hosts; the
 * JSON API answers state/status/result; unknown paths 404; every mol_ tool
 * registers.
 *
 * Run after `npm run build` (apply refuses to mount without dist/index.html;
 * the script stages a stub only when the real build is absent).
 *
 * @module scripts/host-smoke.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// --- stage a dist stub only when no build exists ---------------------------
const distIndex = path.join(packageDir, 'dist', 'index.html')
const stagedStub = !fs.existsSync(distIndex)
if (stagedStub) {
    fs.mkdirSync(path.dirname(distIndex), { recursive: true })
    fs.writeFileSync(distIndex, '<!doctype html><title>smoke stub</title>')
}

const { apply, version, name } = await import('../index.js')

// --- mock harness context ---------------------------------------------------
const routes = []
const toolDefs = new Map()
const disposers = []

function makeCtx() {
    return {
        logger: { info: () => {}, warn: (m) => console.log('[warn]', m) },
        get: () => undefined, // no connection service → structural fence layer
        effect: (fn, label) => {
            const out = fn()
            if (typeof out === 'function') disposers.push(out)
            void label
        },
        inject(deps, cb) {
            const scoped = {
                webServer: { register: (route) => { routes.push(route); return () => {} } },
                tools: { register: (def) => { toolDefs.set(def.name, def); return () => {} } },
                effect(fn) { return fn() },
            }
            cb(scoped)
        },
    }
}

apply(makeCtx(), {})

let failures = 0
function check(label, ok, detail) {
    if (ok) console.log(`ok  ${label}`)
    else { failures++; console.log(`FAIL ${label}${detail ? ' — ' + detail : ''}`) }
}

check('plugin name export', name === 'mol-structure')
check('plugin version export', typeof version === 'string' && version.length > 0)
check('three routes registered', routes.length === 3, `got ${routes.length}`)
const routeKey = (r) => `${r.kind}:${r.path}`
check(
    'route paths',
    routes.map(routeKey).join('|') === 'exact:/api/mol-structure/events|prefix:/api/mol-structure/viewer|prefix:/api/mol-structure',
    routes.map(routeKey).join(' | '),
)
check('mol tools registered', toolDefs.size >= 11 && [...toolDefs.keys()].every(n => n.startsWith('mol_')),
    [...toolDefs.keys()].join(','))
check('tool contract (name/description/parameters/output/execute)',
    [...toolDefs.values()].every(d => typeof d.name === 'string' && typeof d.description === 'string'
        && d.parameters && d.output && typeof d.output.render === 'function' && typeof d.execute === 'function'))

// --- wire-schema gate: `parameters` reaches the model API untouched
// (projectToolSchema passes it through), so it must be CANONICAL JSON Schema.
// The DSL's inline `required: true` once shipped raw and the provider rejected
// every request ("…{\"type\":\"string\",\"required\":true,…} is not of type
// \"string\""), so this gate mirrors the kernel's supported-keyword subset.
const SCHEMA_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title'])
const schemaViolations = []
function walkSchema(node, path, seen) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        schemaViolations.push(`${path} must be a schema object`)
        return
    }
    if (seen.has(node)) return
    seen.add(node)
    for (const key of Object.keys(node)) {
        if (!SCHEMA_KEYWORDS.has(key)) schemaViolations.push(`${path}.${key} is not a supported wire keyword`)
    }
    if (node.description !== undefined && typeof node.description !== 'string') {
        schemaViolations.push(`${path}.description must be a string`)
    }
    if (typeof node.type !== 'string') schemaViolations.push(`${path}.type must be a string`)
    if (node.required !== undefined) {
        if (!Array.isArray(node.required) || !node.required.every(k => typeof k === 'string')) {
            schemaViolations.push(`${path}.required must be a string array at the object level, never inline/boolean`)
        }
    }
    if (node.type === 'object' && node.properties !== undefined) {
        if (typeof node.properties !== 'object' || Array.isArray(node.properties)) {
            schemaViolations.push(`${path}.properties must be an object`)
            return
        }
        for (const [key, child] of Object.entries(node.properties)) {
            walkSchema(child, `${path}.properties.${key}`, seen)
        }
    }
    if (node.type === 'array' && node.items !== undefined) walkSchema(node.items, `${path}.items`, seen)
}
for (const def of toolDefs.values()) walkSchema(def.parameters, `${def.name}.parameters`, new Set())
check('tool parameters are canonical wire JSON Schema (no inline required)', schemaViolations.length === 0,
    schemaViolations.slice(0, 5).join('; '))

// --- mol_select no-viewer error path (submitCommand must reject cleanly).
// Runs BEFORE any POST /status: once a heartbeat marks the viewer live the
// command would legitimately wait for the SSE round-trip (and its timeout).
{
    const select = toolDefs.get('mol_select')
    try {
        await select.execute({}, { signal: new AbortController().signal })
        check('mol_select without viewer throws', false, 'resolved instead')
    } catch (error) {
        check('mol_select without viewer throws', /viewer not connected/.test(String(error?.message)), error?.message)
    }
}

// --- fake http round-trips ----------------------------------------------------
function makeReq(method, url, headers = {}, body = null) {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = headers
    req.destroy = () => {}
    queueMicrotask(() => {
        if (body) req.emit('data', Buffer.from(body))
        req.emit('end')
    })
    return req
}

function makeRes() {
    const res = { headersSent: false, statusCode: 0, headers: {}, body: null }
    let done
    res.finished = new Promise((resolve) => { done = resolve })
    res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers ?? {}; res.headersSent = true; return res }
    res.end = (data) => { res.body = data ?? ''; done(); return res }
    res.destroy = () => done()
    return res
}

const apiRoute = routes.find(r => r.kind === 'prefix' && r.path === '/api/mol-structure')

{
    const res = makeRes()
    apiRoute.handler(makeReq('GET', '/api/mol-structure/state', { host: '127.0.0.1:5173' }), res)
    await res.finished
    const body = JSON.parse(res.body)
    check('GET state → 200 same-origin', res.statusCode === 200 && body.version === version && typeof body.gen === 'number')
}
{
    const res = makeRes()
    apiRoute.handler(makeReq('GET', '/api/mol-structure/state', { host: 'evil.example.com' }), res)
    await res.finished
    check('GET state → 403 foreign host', res.statusCode === 403, `got ${res.statusCode}`)
}
{
    const res = makeRes()
    apiRoute.handler(makeReq('GET', '/api/mol-structure/state', { host: '127.0.0.1:5173', origin: 'https://elsewhere.example' }), res)
    await res.finished
    check('GET state → 403 cross-origin Origin', res.statusCode === 403, `got ${res.statusCode}`)
}
{
    const res = makeRes()
    apiRoute.handler(makeReq('POST', '/api/mol-structure/status', { host: '127.0.0.1:5173' }, JSON.stringify({ status: 'ready', figure: 'fig1b' })), res)
    await res.finished
    check('POST status → 200 hello envelope', res.statusCode === 200 && JSON.parse(res.body).appRev !== undefined)
    const res2 = makeRes()
    apiRoute.handler(makeReq('GET', '/api/mol-structure/state', { host: '127.0.0.1:5173' }), res2)
    await res2.finished
    const body = JSON.parse(res2.body)
    check('status heartbeat marks viewer live', body.connected === true && body.figure === 'fig1b')
}
{
    const res = makeRes()
    apiRoute.handler(makeReq('POST', '/api/mol-structure/selection', { host: '127.0.0.1:5173' }, JSON.stringify({ selection: { source: 'user', kind: 'click', text: 'A/61 ASP', residues: [{ chain: 'A', seq: 61, comp: 'ASP' }] } })), res)
    await res.finished
    const res2 = makeRes()
    apiRoute.handler(makeReq('GET', '/api/mol-structure/state', { host: '127.0.0.1:5173' }), res2)
    await res2.finished
    const body = JSON.parse(res2.body)
    check('selection report stored', body.lastUserSelection?.text === 'A/61 ASP')
}
{
    const res = makeRes()
    apiRoute.handler(makeReq('POST', '/api/mol-structure/result', { host: '127.0.0.1:5173' }, JSON.stringify({ id: 999, ok: true, result: { fine: 1 } })), res)
    await res.finished
    check('POST result (unknown id) → 200 no-op', res.statusCode === 200)
}
{
    const res = makeRes()
    apiRoute.handler(makeReq('GET', '/api/mol-structure/nothing', { host: '127.0.0.1:5173' }), res)
    await res.finished
    check('unknown API path → 404', res.statusCode === 404)
}
{
    // external-program command surface: registry op, whitelist, /state sync
    check('mol_panel_define tool registered', toolDefs.has('mol_panel_define'))
    const res = makeRes()
    apiRoute.handler(makeReq('POST', '/api/mol-structure/command', { host: '127.0.0.1:5173' },
        JSON.stringify({ op: 'panelDefine', args: { id: 'smoke-view', title: '冒烟视图', groups: [{ chain: 'A', ranges: [[1, 10]], color: '#111111' }] } })), res)
    await res.finished
    const body = res.statusCode === 200 ? JSON.parse(res.body) : null
    check('POST /command panelDefine → 200', res.statusCode === 200 && body?.panel?.id === 'smoke-view', res.body?.slice(0, 120))
    const res2 = makeRes()
    apiRoute.handler(makeReq('GET', '/api/mol-structure/state', { host: '127.0.0.1:5173' }), res2)
    await res2.finished
    const stateBody = JSON.parse(res2.body)
    check('custom panel listed in /state', stateBody.customPanels?.some(p => p.id === 'smoke-view'))
    const res3 = makeRes()
    apiRoute.handler(makeReq('POST', '/api/mol-structure/command', { host: '127.0.0.1:5173' }, JSON.stringify({ op: 'bogus' })), res3)
    await res3.finished
    check('POST /command unknown op → 400', res3.statusCode === 400)
    const res4 = makeRes()
    apiRoute.handler(makeReq('POST', '/api/mol-structure/command', { host: '127.0.0.1:5173' },
        JSON.stringify({ op: 'panelDefine', args: { title: '坏面板', groups: [{ chain: 'A', ranges: 'nope' }] } })), res4)
    await res4.finished
    check('POST /command invalid panel → 500 with reason', res4.statusCode === 500 && /ranges/.test(res4.body), res4.body?.slice(0, 120))
}
{
    const res = makeRes()
    apiRoute.handler(makeReq('POST', '/api/mol-structure/status', { host: '127.0.0.1:5173' }, '{broken'), res)
    await res.finished
    check('bad JSON body → 500', res.statusCode === 500, `got ${res.statusCode}`)
}

// --- disposers are functions ---------------------------------------------------
check('effects produced disposers', disposers.every(d => typeof d === 'function'))

if (stagedStub) {
    // leave the stub: apply() needs dist/index.html again on the next run,
    // and a real `npm run build` overwrites it with the real app.
    console.log('note: staged a dist/index.html stub (run npm run build for the real viewer)')
}

if (failures > 0) {
    console.log(`\n${failures} check(s) FAILED`)
    process.exit(1)
}
console.log('\nall host smoke checks passed')
