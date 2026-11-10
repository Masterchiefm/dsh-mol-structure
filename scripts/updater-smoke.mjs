/**
 * Updater smoke test — no network, no harness.
 *
 * Drives the full upgrade lifecycle against a mock `fetch` that serves a
 * manifest and its files from a temp "repository" directory:
 * - version comparison + manifest parsing (sha pins, path safety);
 * - check → apply (files swapped, versions bumped) with activation;
 * - tampered file → sha256 refusal, previous files restored;
 * - failed activation → disk restored + recovery state recorded;
 * - recovery reconciliation after restart.
 *
 * @module scripts/updater-smoke.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { releaseBytes } from '../tools/release-bytes.mjs'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const updaterUrl = new URL('../host/updater.js', import.meta.url)
const { PluginUpdater, downloadManifest, parseManifest, compareVersions } = await import(updaterUrl)

let failures = 0
function check(label, ok, detail) {
    if (ok) console.log(`ok  ${label}`)
    else { failures++; console.log(`FAIL ${label}${detail ? ' — ' + detail : ''}`) }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dms-updater-'))

// --- version compare --------------------------------------------------------
check('version ordering', compareVersions('1.2.3', '1.2.3') === 0
    && compareVersions('1.2.3', '1.2.4') < 0
    && compareVersions('1.0.0-rc.1', '1.0.0') < 0
    && compareVersions('2.0.0', '1.9.9') > 0)

// --- fake repository ---------------------------------------------------------
const repoDir = path.join(root, 'repo')
const files = {
    'package.json': JSON.stringify({ name: 'dsh-mol-structure', version: '9.9.9' }),
    'index.js': 'export const version = "9.9.9"\nexport const name = "mol-structure"\n',
    'host/updater.js': 'export {}\n',
}
for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repoDir, rel)), { recursive: true })
    fs.writeFileSync(path.join(repoDir, rel), body)
}

function buildManifest(version, notes = 'smoke release') {
    const rows = Object.keys(files).sort().map(rel => {
        const body = Buffer.from(files[rel])
        return { path: rel, size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') }
    })
    return { version, base: '../', publishedAt: Date.now(), notes, files: rows }
}

const manifestV1 = buildManifest('9.9.9')

/** Mock fetch: answers repo-relative paths; `tamper` flips one file's bytes. */
function makeFetch({ tamper = false, dropManifest = false } = {}) {
    return async (url) => {
        const u = new URL(url)
        const rel = decodeURIComponent(u.pathname).replace(/^.*?\/dsh-mol-structure(@[0-9a-f]{40})?\//, '')
        if (rel === 'commits/main') {
            // GitHub's `application/vnd.github.sha` commit resolution
            return { ok: true, status: 200, text: async () => 'a'.repeat(40) }
        }
        if (rel === 'feed/manifest.json') {
            if (dropManifest) return { ok: false, status: 404, text: async () => '' }
            return { ok: true, status: 200, text: async () => JSON.stringify(manifestV1) }
        }
        let body = files[rel]
        if (body === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
        if (tamper && rel === 'index.js') body = body.replace('9.9.9', '0.0.0')
        const buffer = Buffer.from(body)
        return { ok: true, status: 200, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) }
    }
}

// --- manifest validation -------------------------------------------------------
{
    const fetched = await downloadManifest(['https://cdn.jsdelivr.net/gh/Masterchiefm/dsh-mol-structure@main/feed/manifest.json'], {
        fetchImpl: makeFetch(),
    })
    check('unsigned manifest accepted by downloadManifest', fetched.manifest.version === '9.9.9')
    check('jsdelivr snapshot pinned to commit SHA', /\/dsh-mol-structure@[0-9a-f]{40}\//.test(fetched.source), fetched.source)
}
{
    let threw = ''
    try { await downloadManifest(['https://example.com/feed/manifest.json'], { fetchImpl: makeFetch({ dropManifest: true }) }) }
    catch (e) { threw = e.message }
    check('downloadManifest fails when no source answers', /no manifest source answered/.test(threw), threw)
    const tampered = JSON.parse(JSON.stringify(manifestV1))
    tampered.files[0].sha256 = 'nothex'.repeat(11).slice(0, 64)
    check('parseManifest rejects bad sha format', (() => { try { parseManifest(tampered); return false } catch (e) { return /sha256/.test(e.message) } })())
    const evil = { ...manifestV1, base: 'https://evil.example/' }
    check('absolute manifest base rejected', (() => { try { parseManifest(evil); return false } catch (e) { return /relative/.test(e.message) } })())
    const escape = { ...manifestV1, files: [{ path: '../../etc/passwd', size: 1, sha256: 'a'.repeat(64) }] }
    check('path traversal rejected', (() => { try { parseManifest(escape); return false } catch (e) { return /safe relative path/.test(e.message) } })())
    const drift = buildManifest('9.9.9')
    drift.files[0].sha256 = 'b'.repeat(64) // well-formed but wrong pin
    check('wrong sha pin still parses (enforced at staging)', parseManifest(drift).files[0].sha256 === 'b'.repeat(64))
}

// --- successful upgrade -------------------------------------------------------
const pkgDir = path.join(root, 'installed')
fs.mkdirSync(pkgDir, { recursive: true })
fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-mol-structure', version: '0.4.0' }))
fs.writeFileSync(path.join(pkgDir, 'index.js'), 'export const version = "0.4.0"\n')

const dataDir = path.join(root, 'data')
const updater = new PluginUpdater({
    pkgDir, dataDir,
    settings: () => ({ updateCheckHours: 6 }),
    runningVersion: '0.4.0',
    fetchImpl: makeFetch(),
})

const status0 = updater.status()
check('initial status has no update', status0.available === false && status0.phase === 'idle')

const probe = await updater.check()
check('check reports newer version', probe.available === true && probe.latest === '9.9.9')

const applied = await updater.apply({
    activate: async installed => ({ ok: true, version: installed.version }),
})
check('apply reports swap', applied.version === '9.9.9' && applied.previous === '0.4.0')
check('package.json upgraded on disk', JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version === '9.9.9')
check('index.js upgraded on disk', fs.readFileSync(path.join(pkgDir, 'index.js'), 'utf8').includes('9.9.9'))
check('upgrade state complete', updater.loadUpgradeState().phase === 'complete')
check('rollback copy retained', fs.existsSync(updater.backupDir))

// same version applies cleanly again (idempotent re-install)
const reapplied = await updater.apply({ activate: async installed => ({ ok: true, version: installed.version }) })
check('re-apply same version succeeds', reapplied.version === '9.9.9')

// --- tampered download refuses and rolls back ---------------------------------
const pkgDir2 = path.join(root, 'installed2')
fs.mkdirSync(pkgDir2, { recursive: true })
fs.writeFileSync(path.join(pkgDir2, 'package.json'), JSON.stringify({ name: 'dsh-mol-structure', version: '0.4.0' }))
fs.writeFileSync(path.join(pkgDir2, 'index.js'), 'export const version = "0.4.0"\n')

const updater2 = new PluginUpdater({
    pkgDir: pkgDir2, dataDir: path.join(root, 'data2'),
    runningVersion: '0.4.0',
    fetchImpl: makeFetch({ tamper: true }),
})
let tamperError = ''
try { await updater2.apply({ activate: async () => ({ ok: true, version: '9.9.9' }) }) }
catch (e) { tamperError = e.message }
check('tampered file refuses install', /staging failed|sha256 mismatch/.test(tamperError), tamperError)
check('tampered install leaves disk untouched', fs.readFileSync(path.join(pkgDir2, 'index.js'), 'utf8').includes('0.4.0'))

// --- failed activation restores disk and flags recovery ------------------------
const pkgDir3 = path.join(root, 'installed3')
fs.mkdirSync(pkgDir3, { recursive: true })
fs.writeFileSync(path.join(pkgDir3, 'package.json'), JSON.stringify({ name: 'dsh-mol-structure', version: '0.4.0' }))
fs.writeFileSync(path.join(pkgDir3, 'index.js'), 'export const version = "0.4.0"\n')

const updater3 = new PluginUpdater({
    pkgDir: pkgDir3, dataDir: path.join(root, 'data3'),
    runningVersion: '0.4.0',
    fetchImpl: makeFetch(),
})
let activationError = ''
try { await updater3.apply({ activate: async () => ({ ok: false, error: 'boom' }) }) }
catch (e) { activationError = e.message }
check('failed activation surfaces error', /upgrade failed/.test(activationError), activationError)
check('failed activation restores disk', fs.readFileSync(path.join(pkgDir3, 'index.js'), 'utf8').includes('0.4.0'))
const recoveryState = updater3.loadUpgradeState()
check('recovery state recorded', ['rolled-back', 'recovery-required'].includes(recoveryState.phase), recoveryState.phase)

// a successor reconciles recovery when the disk and runtime match the backup
const successor = new PluginUpdater({
    pkgDir: pkgDir3, dataDir: path.join(root, 'data3'),
    runningVersion: recoveryState.from,
})
successor.reconcileRecovery()
check('recovery reconciled by successor', successor.loadUpgradeState().phase === 'rolled-back', successor.loadUpgradeState().phase)
check('recovery no longer blocks apply', await (async () => {
    // apply would reach check(); with a dropping manifest it fails in check, not on recovery
    const blocked = new PluginUpdater({
        pkgDir: pkgDir3, dataDir: path.join(root, 'data3'),
        runningVersion: '0.4.0',
        fetchImpl: makeFetch({ dropManifest: true }),
    })
    return blocked.apply({}).then(() => 'no-error').catch(e => /no manifest source answered/.test(e.message) ? 'not-blocked' : `unexpected: ${e.message}`)
})() === 'not-blocked')

// concurrent apply lock
const lockSym = Symbol.for('mol-structure.upgrade-locks')
globalThis[lockSym].add(pkgDir3)
let lockError = ''
try { await successor.apply({}) } catch (e) { lockError = e.message }
globalThis[lockSym].delete(pkgDir3)
check('concurrent apply locked', /already running/.test(lockError), lockError)

// --- shipped feed/manifest.json (when present) must be current ------------------
const feedFile = path.join(packageDir, 'feed', 'manifest.json')
if (fs.existsSync(feedFile)) {
    const shipped = JSON.parse(fs.readFileSync(feedFile, 'utf8'))
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version
    check('feed manifest matches package.json version', shipped.version === pkgVersion, `${shipped.version} vs ${pkgVersion}`)
    const stale = shipped.files.filter(row => {
        const full = path.join(packageDir, ...row.path.split('/'))
        if (!fs.existsSync(full)) return true
        // compare against canonical LF bytes, same as build-manifest.mjs
        return crypto.createHash('sha256').update(releaseBytes(full)).digest('hex') !== row.sha256
    })
    check('feed manifest hashes match the working copy', stale.length === 0, stale.slice(0, 3).map(r => r.path).join(', '))
}

// cleanup
fs.rmSync(root, { recursive: true, force: true })

if (failures > 0) {
    console.log(`\n${failures} check(s) FAILED`)
    process.exit(1)
}
console.log('\nall updater smoke checks passed')
