/**
 * dsh-mol-structure — Host half of the plugin.
 *
 * Mounts, beside the other harness plugins:
 * - the agent tools (`mol_*`) on `ctx.tools`, driving the embedded Mol* page
 *   through the SSE command bridge;
 * - HTTP routes under `/api/mol-structure`: the built viewer app (static),
 *   the JSON command/status API, the `/events` SSE stream, and one-shot
 *   structure file downloads — all behind the same trust fence the kernel
 *   applies to its own `/api`;
 * - self hot-reload: `POST /api/mol-structure/reload` swaps the running
 *   plugin for the code on disk, and `watch: true` in the bundle config adds
 *   a directory watcher for development.
 *
 * `webServer` is the only hard dependency: the viewer page is the whole
 * point, and a composition without an HTTP server has nothing for this
 * plugin to serve. `tools` is reached through a nested `ctx.inject` fiber
 * so routes still mount on compositions where the model-facing tool
 * registry is absent.
 *
 * @module index.js
 */

import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { rejectionFor } from './host/trust.js'
import { createPush } from './host/push.js'
import { createHostState } from './host/state.js'
import { createStatic } from './host/static.js'
import { createPanels } from './host/panels.js'
import { createTools, VIEWER_COMMAND_OPS } from './host/tools.js'
import { isReloading, selfReload, watchPackage } from './host/reload.js'
import { PluginUpdater } from './host/updater.js'
import { FIGURES } from './src/config.js'

export const name = 'mol-structure'
export const version = '0.5.1'

/** The composition must serve HTTP; everything else is optional below. */
export const inject = ['webServer']

const GEN_SYMBOL = Symbol.for('mol-structure.generation')

/** `$DSH_HOME` else `~/.dsh` — the same resolution the harness home-paths helper uses. */
function resolveDshHome() {
    const fromEnv = process.env.DSH_HOME
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
    return path.join(os.homedir(), '.dsh')
}

function numberOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function apply(ctx, config) {
    const logger = ctx.logger ?? console
    const packageDir = fileURLToPath(new URL('./', import.meta.url))
    const distDir = path.join(packageDir, 'dist')
    const shotsDir = (typeof config?.screenshotDir === 'string' && config.screenshotDir.trim() !== '')
        ? path.resolve(config.screenshotDir.trim())
        : path.join(resolveDshHome(), 'mol-structure', 'shots')
    const commandTimeoutMs = numberOr(config?.commandTimeoutMs, 90000)

    // Hot reload re-enters apply; the generation counter lives on globalThis so
    // the new generation knows it replaced a predecessor.
    const gen = (globalThis[GEN_SYMBOL] ?? 0) + 1
    globalThis[GEN_SYMBOL] = gen

    const push = createPush({ logger })
    const state = createHostState({ logger, push, commandTimeoutMs })
    const serveStatic = createStatic({ root: distDir, logger })
    const panels = createPanels({ logger })

    if (!fs.existsSync(path.join(distDir, 'index.html'))) {
        // Fail loud: the viewer must be built (`npm run build`) before install.
        throw new Error(`viewer app missing — dist/index.html not found under ${packageDir} (run "npm run build")`)
    }

    function appRev() {
        try {
            const st = fs.statSync(path.join(distDir, 'index.html'))
            return `${Math.round(st.mtimeMs)}-${st.size}`
        } catch {
            return 'none'
        }
    }

    // Watch the built viewer: whenever dist/index.html changes (npm run build
    // + copy), push a `reload` event so open viewer pages refresh themselves
    // immediately instead of relying on the throttled in-page appRev poll.
    let lastAppRevSeen = appRev()
    const appRevTimer = setInterval(() => {
        const next = appRev()
        if (next === lastAppRevSeen) return
        lastAppRevSeen = next
        logger.info?.(`mol-structure: viewer build changed (${next}) — reloading viewers`)
        push.emit('reload', { appRev: next, gen })
    }, 1500)
    appRevTimer.unref?.() // never keep the process alive just for this poll
    ctx.effect(() => () => clearInterval(appRevTimer), 'mol-structure: viewer build watcher')

    // --- user settings (Settings → General row writes here) ------------------
    // Persisted by the Host half in $DSH_HOME/mol-structure/settings.json so
    // the preference survives restarts without touching the bundle config.
    // Bundle config `controlCard` still outranks the stored value.
    const settingsDir = path.join(resolveDshHome(), 'mol-structure')
    const settingsFile = path.join(settingsDir, 'settings.json')
    const statesDir = path.join(settingsDir, 'states')
    const exportsDir = path.join(settingsDir, 'exports')
    const CONTROL_CARD_MODES = new Set(['auto', 'show', 'hide'])
    const VIEWER_MODES = new Set(['simple', 'full'])
    let userSettings = { controlCard: 'auto', defaultMode: 'simple', pixelScale: 1.5, updateCheckHours: 6 }
    try {
        const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
        if (CONTROL_CARD_MODES.has(raw?.controlCard)) userSettings.controlCard = raw.controlCard
        if (VIEWER_MODES.has(raw?.defaultMode)) userSettings.defaultMode = raw.defaultMode
        const ps = Number(raw?.pixelScale)
        if (Number.isFinite(ps) && ps >= 0.5 && ps <= 3) userSettings.pixelScale = ps
        const uch = Number(raw?.updateCheckHours)
        if (Number.isFinite(uch) && uch >= 0 && uch <= 168) userSettings.updateCheckHours = Math.trunc(uch)
        if (typeof raw?.updateNotifiedFor === 'string') userSettings.updateNotifiedFor = raw.updateNotifiedFor
    } catch { /* first run or unreadable — defaults */ }

    function controlCardMode() {
        if (config?.controlCard === 'show' || config?.controlCard === 'hide') return config.controlCard
        return userSettings.controlCard
    }

    function defaultViewerMode() {
        if (config?.defaultMode === 'full' || config?.defaultMode === 'simple') return config.defaultMode
        return userSettings.defaultMode
    }

    /** Render resolution multiplier (canvas ×pixelScale² GPU memory). Bundle
     *  config outranks the stored value; clamped to 0.5–3. */
    function viewerPixelScale() {
        const n = Number(config?.pixelScale)
        if (Number.isFinite(n) && n >= 0.5 && n <= 3) return n
        const s = Number(userSettings.pixelScale)
        return Number.isFinite(s) && s >= 0.5 && s <= 3 ? s : 1.5
    }

    /** Agent-callable text file store for state snapshots and mmCIF exports. */
    const SAFE_NAME_RE = /^[\w.-]{1,120}$/
    function resolveStorePath(dir, name) {
        const clean = path.basename(String(name))
        if (!SAFE_NAME_RE.test(clean)) throw new Error(`bad file name "${name}" — letters/digits/./-/_ only`)
        return path.join(dir, clean)
    }
    const fileStore = {
        async saveState(name, text) {
            const file = resolveStorePath(statesDir, name.endsWith('.json') ? name : `${name}.json`)
            await fsp.mkdir(statesDir, { recursive: true })
            await fsp.writeFile(file, text, 'utf8')
            return { path: file }
        },
        async readState(name) {
            const file = resolveStorePath(statesDir, name.endsWith('.json') ? name : `${name}.json`)
            return fsp.readFile(file, 'utf8')
        },
        async saveExport(name, text) {
            const file = resolveStorePath(exportsDir, name.endsWith('.cif') ? name : `${name}.cif`)
            await fsp.mkdir(exportsDir, { recursive: true })
            await fsp.writeFile(file, text, 'utf8')
            return { path: file }
        },
    }

    function settingsPayload() {
        return {
            controlCard: userSettings.controlCard,
            defaultMode: userSettings.defaultMode,
            pixelScale: userSettings.pixelScale,
            updateCheckHours: userSettings.updateCheckHours,
            effective: { controlCard: controlCardMode(), defaultMode: defaultViewerMode(), pixelScale: viewerPixelScale() },
            overridden: {
                controlCard: config?.controlCard === 'show' || config?.controlCard === 'hide',
                defaultMode: config?.defaultMode === 'full' || config?.defaultMode === 'simple',
            },
            version,
        }
    }

    // --- in-app self-update ---------------------------------------------------
    // Checks the GitHub release manifest on a timer (updateCheckHours, default
    // 6; 0 disables), notifies open viewers once per new version over SSE, and
    // applies releases as download → verify → backup → swap → hot reload with
    // full rollback (see host/updater.js).
    const updater = new PluginUpdater({
        pkgDir: packageDir,
        dataDir: settingsDir,
        settings: () => userSettings,
        log: message => logger.info?.(message),
        runningVersion: version,
    })
    let updateCheckTimer = undefined
    let disposed = false

    /** Push an `update` event once per version (manual checks force a re-push). */
    function pushUpdate(force = false) {
        if (disposed) return
        const status = updater.status()
        if (status.available !== true || status.latest === '') return
        if (!force && status.latest === userSettings.updateNotifiedFor) return
        userSettings.updateNotifiedFor = status.latest
        try {
            fs.mkdirSync(settingsDir, { recursive: true })
            fs.writeFileSync(settingsFile, `${JSON.stringify(userSettings, null, 2)}\n`, 'utf8')
        } catch (error) {
            logger.warn?.(`mol-structure: could not persist update notification mark (${error?.message ?? error})`)
        }
        push.emit('update', { current: status.current, latest: status.latest, notes: status.notes })
    }

    function updateCheckDue() {
        const hours = userSettings.updateCheckHours
        if (!(Number.isFinite(hours) && hours > 0)) return false
        return Date.now() - updater.checkedAt >= hours * 3600_000
    }

    function scheduleUpdateCheck() {
        if (updateCheckTimer !== undefined) { clearInterval(updateCheckTimer); updateCheckTimer = undefined }
        if (!(Number.isFinite(userSettings.updateCheckHours) && userSettings.updateCheckHours > 0)) return
        // Hourly tick; the actual check fires only when the interval is due, so
        // a process that lives shorter than the interval simply checks once.
        updateCheckTimer = setInterval(() => {
            if (updateCheckDue()) void updater.check().then(() => pushUpdate(false)).catch(() => {})
        }, 3600_000)
        updateCheckTimer.unref?.()
    }

    ctx.effect(() => () => {
        disposed = true
        if (updateCheckTimer !== undefined) clearInterval(updateCheckTimer)
    }, 'mol-structure: update check timer')

    // First check happens shortly after mount so an open settings page sees
    // the banner without waiting for the first hourly tick. `updateCheck:
    // false` in the bundle config disables the timer entirely (tests, air-gapped setups).
    if (config?.updateCheck !== false) {
        setTimeout(() => {
            if (updateCheckDue()) void updater.check().then(() => pushUpdate(false)).catch(() => {})
        }, 15_000).unref?.()
        scheduleUpdateCheck()
    }

    /** The successor generation registers this notification callback: only the
     *  caller that confirmed selfReload may announce the completed upgrade. */
    const pendingKey = Symbol.for('mol-structure.pending-upgrade')
    const pendingUpgrade = globalThis[pendingKey]
    if (pendingUpgrade?.version === version) {
        pendingUpgrade.notify = () => {
            if (disposed) return
            push.emit('upgraded', { version })
        }
    }

    async function applyUpgrade(requestedVersion) {
        if (isReloading()) throw new Error('a reload is already in progress')
        let pending
        try {
            const result = await updater.apply({
                version: requestedVersion,
                activate: async installed => {
                    pending = { version: installed.version }
                    globalThis[pendingKey] = pending
                    return selfReload(ctx, { logger, expectedVersion: installed.version })
                },
            })
            try { pending?.notify?.() } catch (error) { logger.warn?.(`mol-structure: upgrade notification failed (${error?.message ?? error})`) }
            return { ...result, reloaded: true }
        } finally {
            if (globalThis[pendingKey] === pending) globalThis[pendingKey] = undefined
        }
    }

    function updateStatusPayload() {
        return { ...updater.status(), notifiedFor: userSettings.updateNotifiedFor, checkHours: userSettings.updateCheckHours, repo: 'Masterchiefm/dsh-mol-structure' }
    }

    async function writeSettings(patch) {
        if (patch?.controlCard !== undefined) {
            if (!CONTROL_CARD_MODES.has(patch.controlCard)) throw new Error('controlCard must be "auto", "show" or "hide"')
            userSettings.controlCard = patch.controlCard
        }
        if (patch?.defaultMode !== undefined) {
            if (!VIEWER_MODES.has(patch.defaultMode)) throw new Error('defaultMode must be "simple" or "full"')
            userSettings.defaultMode = patch.defaultMode
        }
        if (patch?.pixelScale !== undefined) {
            const n = Number(patch.pixelScale)
            if (!Number.isFinite(n) || n < 0.5 || n > 3) throw new Error('pixelScale must be a number in [0.5, 3]')
            userSettings.pixelScale = n
        }
        if (patch?.updateCheckHours !== undefined) {
            const n = Number(patch.updateCheckHours)
            if (!Number.isFinite(n) || n < 0 || n > 168) throw new Error('updateCheckHours must be a number in [0, 168] (0 = off)')
            userSettings.updateCheckHours = Math.trunc(n)
            scheduleUpdateCheck()
        }
        await fsp.mkdir(settingsDir, { recursive: true })
        await fsp.writeFile(settingsFile, `${JSON.stringify(userSettings, null, 2)}\n`, 'utf8')
        // Live update for the already-open viewer page(s).
        push.emit('settings', { ui: { controlCard: controlCardMode(), mode: defaultViewerMode(), pixelScale: viewerPixelScale() } })
        try {
            unwrap(await state.submitCommand({ op: 'ui', args: { controlCard: controlCardMode() }, timeoutMs: 10000 }))
        } catch { /* viewer closed — hello carries the value next load */ }
        return settingsPayload()
    }

    const tools = createTools({
        state, push, figures: FIGURES, panels,
        bundledDir: path.join(distDir, 'structures'),
        savePng, files: fileStore, logger,
    })

    function helloPayload() {
        return {
            version, gen, appRev: appRev(), shotsDir,
            connected: state.viewerLive(),
            panels: panels.list(),
            ui: { controlCard: controlCardMode(), mode: defaultViewerMode(), pixelScale: viewerPixelScale() },
        }
    }

    async function savePng(dataUrl) {
        const base64 = dataUrl.slice('data:image/png;base64,'.length)
        const buffer = Buffer.from(base64, 'base64')
        if (buffer.length === 0) throw new Error('empty PNG payload')
        await fsp.mkdir(shotsDir, { recursive: true })
        const file = path.join(shotsDir, `${Date.now()}-view.png`)
        await fsp.writeFile(file, buffer)
        return { path: file, bytes: buffer.length }
    }

    // --- trust fence --------------------------------------------------------
    // The connection service may publish long after this fiber loads, so the
    // decision is read per request through a late-binding view.
    const fenceConnection = () => ctx.get('connection')
    const logAdmissionRejection = (decision) => {
        logger.warn?.(`mol-structure: rejected request with ${decision.status} (${decision.source}/${decision.reason})`)
    }

    function json(res, status, body) {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
    }

    function readJsonBody(req, limit) {
        return new Promise((resolve, reject) => {
            let size = 0
            const chunks = []
            req.on('data', (chunk) => {
                size += chunk.length
                if (size > limit) {
                    reject(new Error('request body too large'))
                    req.destroy()
                    return
                }
                chunks.push(chunk)
            })
            req.on('end', () => {
                if (chunks.length === 0) return resolve({})
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch {
                    reject(new Error('invalid JSON body'))
                }
            })
            req.on('error', reject)
        })
    }

    /** Wrap one handler with the trust fence and a JSON error fallback. */
    function guarded(handler) {
        return (req, res) => {
            const rejection = rejectionFor(req, fenceConnection(), logAdmissionRejection)
            if (rejection !== undefined) {
                res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
                res.end(rejection === 401 ? 'unauthorized' : rejection === 503 ? 'admission unavailable' : 'forbidden')
                return
            }
            Promise.resolve(handler(req, res)).catch((error) => {
                logger.warn?.(`mol-structure: route failed (${error?.message ?? error})`)
                if (!res.headersSent) json(res, 500, { error: String(error?.message ?? error) })
                else try { res.end() } catch { /* socket gone */ }
            })
        }
    }

    /** Unwrap a viewer command envelope ({ok, result|error}) into a result or a thrown Error. */
    function unwrap(envelope) {
        if (!envelope || typeof envelope !== 'object' || !('ok' in envelope)) throw new Error('malformed viewer reply')
        if (envelope.ok === false) throw new Error(envelope.error || 'viewer command failed')
        return envelope.result
    }

    function stateSnapshot() {
        const v = state.viewer
        return {
            version, gen, appRev: appRev(),
            connected: state.viewerLive(),
            lastSeenAgeMs: v.lastSeen ? Date.now() - v.lastSeen : null,
            status: v.status,
            figure: v.figure,
            structure: v.structure,
            lastUserSelection: v.selection,
            pendingCommands: state.pendingCount(),
            customPanels: panels.list(),
        }
    }

    function triggerReload(reason) {
        if (isReloading()) return
        logger.info?.(`mol-structure: hot reload requested (${reason})`)
        setTimeout(() => {
            // No expectedVersion: unlike the in-app updater, this path reloads
            // whatever is on disk — that is the point during development.
            selfReload(ctx, { logger })
                .then((result) => {
                    if (result.ok) logger.info?.(`mol-structure: hot reload done, now at ${result.version} (gen ${gen})`)
                    else logger.warn?.(`mol-structure: hot reload failed: ${result.error} (restored=${result.restored})`)
                })
                .catch((error) => logger.warn?.(`mol-structure: hot reload threw (${error?.message ?? error})`))
        }, 50)
    }

    // --- HTTP API -------------------------------------------------------------
    async function api(req, res) {
        const { pathname } = new URL(req.url, 'http://localhost')
        if (req.method === 'GET' && pathname === '/api/mol-structure/state') {
            return json(res, 200, stateSnapshot())
        }
        if (req.method === 'GET' && pathname === '/api/mol-structure/settings') {
            return json(res, 200, settingsPayload())
        }
        if (req.method === 'POST' && pathname === '/api/mol-structure/settings') {
            const body = await readJsonBody(req, 1e6)
            return json(res, 200, { ok: true, settings: await writeSettings(body) })
        }
        if (req.method === 'POST' && pathname === '/api/mol-structure/status') {
            const body = await readJsonBody(req, 2e6)
            state.noteStatus(body)
            return json(res, 200, helloPayload())
        }
        if (req.method === 'POST' && pathname === '/api/mol-structure/selection') {
            const body = await readJsonBody(req, 2e6)
            if (body?.selection) state.noteSelection(body.selection)
            return json(res, 200, { ok: true })
        }
        if (req.method === 'POST' && pathname === '/api/mol-structure/result') {
            const body = await readJsonBody(req, 64e6) // screenshot dataUrls are large
            state.resolveCommand(body?.id, { ok: body?.ok !== false, result: body?.result ?? null, error: body?.error })
            return json(res, 200, { ok: true })
        }
        if (req.method === 'POST' && pathname === '/api/mol-structure/command') {
            // The generic interface for external local programs: same command
            // vocabulary as the agent tools. Host-side ops (panel registry,
            // load by path) are handled here; everything else forwards to the
            // viewer page over the SSE bridge.
            const body = await readJsonBody(req, 8e6)
            const op = body?.op
            const args = body?.args ?? {}
            if (op === 'panelDefine') {
                const defined = panels.define(args)
                push.emit('panels', { panels: panels.list() })
                if (args.apply) {
                    const applied = unwrap(await state.submitCommand({ op: 'figure', args: { id: defined.id }, timeoutMs: commandTimeoutMs }))
                    return json(res, 200, { ok: true, panel: defined, applied })
                }
                return json(res, 200, { ok: true, panel: defined })
            }
            if (op === 'panelRemove') {
                const removed = panels.remove(args?.id)
                if (removed) push.emit('panels', { panels: panels.list() })
                return json(res, 200, { ok: true, removed })
            }
            let forward = op
            const forwardArgs = { ...args }
            if (op === 'figure' && forwardArgs.id === undefined && forwardArgs.figure !== undefined) {
                // accept the tool-style parameter name as well
                forwardArgs.id = forwardArgs.figure
            }
            if (op === 'load') {
                // accept a local path like the mol_load tool does
                const { url, name, isBinary } = await tools.resolveLoad(String(args?.path ?? ''))
                forward = 'load'
                forwardArgs.url = url
                forwardArgs.name = name
                forwardArgs.isBinary = isBinary
            } else if (!VIEWER_COMMAND_OPS.includes(op)) {
                return json(res, 400, { error: `unknown op "${op}" — host ops: panelDefine, panelRemove, load; viewer ops: ${VIEWER_COMMAND_OPS.join(', ')}` })
            }
            const result = unwrap(await state.submitCommand({ op: forward, args: forwardArgs, timeoutMs: numberOr(args?.timeoutMs, commandTimeoutMs) }))
            return json(res, 200, { ok: true, result })
        }
        if (req.method === 'GET' && pathname === '/api/mol-structure/update') {
            return json(res, 200, updateStatusPayload())
        }
        if (req.method === 'POST' && pathname === '/api/mol-structure/update/check') {
            const outcome = await updater.check()
            pushUpdate(true)
            return json(res, 200, { ok: true, ...outcome, status: updateStatusPayload() })
        }
        if (req.method === 'POST' && pathname === '/api/mol-structure/update/apply') {
            const body = await readJsonBody(req, 1e6)
            const requested = typeof body?.version === 'string' && body.version.trim() !== '' ? body.version.trim() : undefined
            const result = await applyUpgrade(requested)
            return json(res, 200, { ok: true, result })
        }
        if (req.method === 'POST' && pathname === '/api/mol-structure/reload') {
            const status = updater.status()
            if (status.applying) return json(res, 409, { error: 'an upgrade is already running' })
            if (status.recoveryRequired) {
                return json(res, 409, { error: `restore the retained upgrade backup before reloading (${status.recoveryBackup})` })
            }
            json(res, 200, { ok: true, note: 'hot reload started; connections will reset once the new generation is live' })
            triggerReload('api')
            return
        }
        if (req.method === 'GET' && pathname.startsWith('/api/mol-structure/load/')) {
            const token = pathname.slice('/api/mol-structure/load/'.length)
            if (!tools.serveLoaded(token, res)) json(res, 404, { error: 'unknown or expired load token' })
            return
        }
        json(res, 404, { error: 'not found' })
    }

    /** Adopt one request as a live push stream, after the trust fence. */
    function eventsRoute(req, res) {
        push.attach(req, res, helloPayload())
    }

    // --- registrations --------------------------------------------------------
    // Exact dispatch outranks the prefixes, so the SSE hub owns /events while
    // everything else lands on the JSON API; the longer /viewer prefix wins
    // the static app before the API prefix can answer.
    ctx.inject(['webServer'], (scoped) => {
        scoped.effect(() => scoped.webServer.register({ kind: 'exact', path: '/api/mol-structure/events', handler: guarded(eventsRoute) }), 'mol-structure: events stream')
        scoped.effect(() => scoped.webServer.register({ kind: 'prefix', path: '/api/mol-structure/viewer', handler: guarded(serveStatic) }), 'mol-structure: viewer static')
        scoped.effect(() => scoped.webServer.register({ kind: 'prefix', path: '/api/mol-structure', handler: guarded(api) }), 'mol-structure: api routes')
        logger.info?.('mol-structure: viewer mounted at /api/mol-structure/viewer/')
    })

    // The tools fiber pends independently: a composition without ctx.tools
    // still serves the viewer, it just has no agent controls.
    ctx.inject(['tools'], (scoped) => {
        scoped.effect(() => {
            const disposers = tools.definitions.map(d => scoped.tools.register(d))
            return () => { for (const dispose of disposers) dispose() }
        }, 'mol-structure: agent tools')
        logger.info?.(`mol-structure: registered ${tools.definitions.length} agent tools`)
    })

    ctx.effect(() => () => {
        push.dispose()
        state.dispose()
    }, 'mol-structure: push + state')

    if (config?.watch === true) {
        ctx.effect(() => watchPackage(packageDir, {
            logger,
            onChange: () => triggerReload('file change'),
        }), 'mol-structure: package watcher')
    }
}
