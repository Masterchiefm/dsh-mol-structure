/**
 * In-app self-updater for dsh-mol-structure.
 *
 * The plugin updates itself from the GitHub repository it is published in
 * (github.com/Masterchiefm/dsh-mol-structure): a manifest at
 * `feed/manifest.json` lists every file of the release with its size and
 * SHA-256. Applying an update is
 * download → verify → stage → backup → replace → verify → hot reload:
 *
 * - downloads land in a staging directory under the plugin's data dir and are
 *   hash-checked before anything on the installed copy is touched;
 * - the running process keeps executing from its in-memory module graph, so
 *   replacing files on disk cannot disturb a live viewer session;
 * - the installed package is backed up first; a failed verification or a
 *   failed reload restores it from that same backup;
 * - replacements are written as `<file>.dms-new` beside their target and
 *   renamed over it, so a crash mid-swap cannot truncate a file that the next
 *   boot will import (transient Windows EPERM from indexers is retried).
 *
 * Adapted from dsh-our-free-model's src/updater.js (same transaction shape,
 * sized for this plugin: dist bundles up to ~6 MB per file, ~200 files).
 *
 * @module host/updater.js
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const REPO = 'Masterchiefm/dsh-mol-structure'

/** Discovery locations, in preference order. Official mutable refs are
 *  resolved to a full commit before fetching either the manifest or its
 *  files, so a moving branch cannot mix snapshots across mirrors. */
export const DEFAULT_MANIFEST_SOURCES = [
    `https://raw.githubusercontent.com/${REPO}/main/feed/manifest.json`,
    `https://cdn.jsdelivr.net/gh/${REPO}@main/feed/manifest.json`,
    `https://raw.githubusercontent.com/${REPO}/master/feed/manifest.json`,
]

/** Deterministic JSON: sorted keys, no whitespace, `undefined` dropped
 *  (object fields) or nulled (array slots) —the release tooling uses it to
 *  canonicalize optional signatures; the updater itself does not enforce one. */
export function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(row => stableStringify(row ?? null)).join(',')}]`
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
        return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
    }
    return JSON.stringify(value ?? null)
}

/** Cache hint only: query strings cannot refresh jsDelivr's branch resolution. */
export function bustCdnCache(url, now = Date.now()) {
    try {
        const parsed = new URL(url)
        if (parsed.hostname.endsWith('.jsdelivr.net')) {
            parsed.searchParams.set('dms', Math.floor(now / 60_000).toString())
            return parsed.href
        }
    } catch { /* malformed URL: let fetch report it */ }
    return url
}

const MAX_MANIFEST_BYTES = 512 * 1024
// The release ships built bundles (~4.6 MB) and bundled structures (~5 MB).
const MAX_FILE_BYTES = 12 * 1024 * 1024
const MAX_FILES = 200
const SHA_RE = /^[0-9a-f]{64}$/
// Hot reload evaluates a fresh updater module before the old request finishes.
// A process-wide lock keeps the successor from starting a second transaction.
const UPGRADE_LOCKS = Symbol.for('mol-structure.upgrade-locks')
const upgradeLocks = globalThis[UPGRADE_LOCKS] ??= new Set()

/** Parse `1.2.3` / `1.2.3-rc.4` into a comparable tuple; `null` when malformed. */
export function parseVersion(value) {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(String(value ?? '').trim())
    if (match === null) return null
    const pre = match[4] === undefined ? null : match[4].split('.')
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre }
}

/** -1 | 0 | 1 in semver precedence; a pre-release sorts before its release. */
export function compareVersions(a, b) {
    const left = parseVersion(a)
    const right = parseVersion(b)
    if (left === null || right === null) return a === b ? 0 : a > b ? 1 : -1
    for (const key of ['major', 'minor', 'patch']) {
        if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
    }
    if (left.pre === null && right.pre === null) return 0
    if (left.pre === null) return 1
    if (right.pre === null) return -1
    const width = Math.max(left.pre.length, right.pre.length)
    for (let i = 0; i < width; i += 1) {
        const x = left.pre[i]
        const y = right.pre[i]
        if (x === undefined) return -1
        if (y === undefined) return 1
        const xn = /^\d+$/.test(x)
        const yn = /^\d+$/.test(y)
        if (xn && yn && Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
        if (xn !== yn) return xn ? -1 : 1
        if (x !== y) return x < y ? -1 : 1
    }
    return 0
}

/** Validate the manifest document.
 *  @returns {object} {version, notes, publishedAt, base, files} */
export function parseManifest(payload) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('manifest must be a JSON object')
    }
    const version = typeof payload.version === 'string' ? payload.version.trim() : ''
    if (parseVersion(version) === null) throw new Error(`manifest version "${version}" is not a valid semver`)
    const base = typeof payload.base === 'string' && payload.base !== '' ? payload.base : '../'
    // The base is resolved against the manifest's own URL, so it must stay
    // relative: an absolute value would point every download at a host of the
    // manifest author's choosing, with the sha256 pins riding inside the same
    // forged document. A relative URL cannot leave the manifest's origin.
    if (/^[a-z][a-z0-9+.-]*:/i.test(base) || base.startsWith('//') || base.startsWith('/') || base.includes('\\')) {
        throw new Error(`manifest base "${base}" must be a path relative to the manifest`)
    }
    const rows = payload.files
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('manifest carries no file list')
    if (rows.length > MAX_FILES) throw new Error(`manifest lists ${rows.length} files, above the ${MAX_FILES} cap`)
    const files = []
    const seen = new Set()
    for (const row of rows) {
        const file = parseFileEntry(row)
        if (seen.has(file.path)) throw new Error(`manifest lists ${file.path} twice`)
        seen.add(file.path)
        files.push(file)
    }
    if (!seen.has('package.json')) throw new Error('manifest must include package.json')
    if (!seen.has('index.js')) throw new Error('manifest must include index.js')
    return {
        version,
        base,
        files,
        notes: typeof payload.notes === 'string' ? payload.notes.slice(0, 32 * 1024) : '',
        publishedAt: timestampOf(payload.publishedAt) ?? 0,
        ...typeof payload.minSupported === 'string' ? { minSupported: payload.minSupported } : {},
    }
}

function parseFileEntry(row) {
    const rel = typeof row?.path === 'string' ? row.path.trim() : ''
    const normalized = rel.replace(/\\/g, '/')
    if (normalized === '' || normalized.startsWith('/') || normalized.includes('../') || normalized.endsWith('..')
        || /[A-Za-z]:/.test(normalized) || normalized.split('/').includes('')) {
        throw new Error(`manifest file path "${rel}" is not a safe relative path`)
    }
    const sha256 = typeof row?.sha256 === 'string' ? row.sha256.toLowerCase() : ''
    if (!SHA_RE.test(sha256)) throw new Error(`manifest entry "${normalized}" has no valid sha256`)
    const size = row?.size
    if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE_BYTES) {
        throw new Error(`manifest entry "${normalized}" has an out-of-range size`)
    }
    return { path: normalized, sha256, size }
}

function timestampOf(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    if (typeof value !== 'string' || value === '') return undefined
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : undefined
}

/** Resolve one manifest-relative path against the manifest's URL. */
export function fileUrlOf(manifestUrl, manifest, relativePath) {
    return new URL(manifest.base + relativePath.split('/').map(encodeURIComponent).join('/'), manifestUrl).href
}

/** Pin an official discovery URL to a full commit without changing the
 *  manifest format. One resolution is reused across mirrors in this check. */
async function snapshotManifestSource(source, fetchImpl, signal, revisions) {
    const url = new URL(source)
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return source
    const rawPrefix = `/${REPO}/`
    const cdnPrefix = `/gh/${REPO}@`
    const prefix = url.hostname === 'raw.githubusercontent.com' ? rawPrefix
        : url.hostname === 'cdn.jsdelivr.net' ? cdnPrefix : null
    if (prefix === null || !url.pathname.startsWith(prefix)) return source
    const match = /^([^/]+)\/feed\/manifest\.json$/.exec(url.pathname.slice(prefix.length))
    if (match === null) return source
    const ref = match[1]
    if (/^[a-f0-9]{40}$/.test(ref)) return source
    // Never insert arbitrary URL/path syntax into a resolver request.
    if (!/^[A-Za-z0-9._-]+$/.test(ref)) throw new Error('unsupported update source ref')
    let revision = revisions.get(ref)
    if (revision === undefined) {
        const response = await fetchImpl(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`, {
            redirect: 'error', signal,
            headers: { accept: 'application/vnd.github.sha', 'user-agent': 'dsh-mol-structure-updater' },
        })
        if (!response.ok) throw new Error(`snapshot resolution failed for ${ref}: HTTP ${response.status}`)
        const text = (await response.text()).trim()
        if (text.length > MAX_MANIFEST_BYTES) throw new Error('snapshot resolution response too large')
        const sha = /^[a-f0-9]{40}$/.test(text) ? text : JSON.parse(text)?.sha
        if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) {
            throw new Error(`snapshot resolution did not return a full commit SHA for ${ref}`)
        }
        revision = sha
        revisions.set(ref, revision)
    }
    url.pathname = `${prefix}${revision}/feed/manifest.json`
    return url.href
}

/** Fetch the first source that answers with a well-formed, sha256-pinned
 *  manifest. Mirrors are untrusted as code sources; the pins inside the
 *  manifest and the fixed https hosts carry the trust. */
export async function downloadManifest(sources, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
    const failures = []
    const revisions = new Map()
    for (const source of sources) {
        try {
            const signal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
            const snapshot = await snapshotManifestSource(source, fetchImpl, signal, revisions)
            const response = await fetchImpl(bustCdnCache(snapshot), {
                redirect: 'error',
                headers: { accept: 'application/json' },
                signal,
            })
            if (!response.ok) { failures.push(`${source} -> HTTP ${response.status}`); continue }
            const text = await response.text()
            if (text.length > MAX_MANIFEST_BYTES) { failures.push(`${source} -> manifest too large`); continue }
            const manifest = parseManifest(JSON.parse(text))
            return { manifest, source: snapshot }
        } catch (error) {
            failures.push(`${source} -> ${error?.message ?? error}`)
        }
    }
    throw new Error(`no manifest source answered (${failures.join('; ')})`)
}

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Download and hash-verify the whole release into `stageDir`. */
const STAGE_ATTEMPTS = 3
const STAGE_BACKOFF_MS = 700

function isTransientDownloadError(error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true
    return /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|terminated|socket/i.test(String(error?.message ?? error))
}

/** jsDelivr's primary edge can redirect to raw, which is unavailable on some
 *  client networks. Try the gcore edge at the exact same SHA/path —never an
 *  arbitrary Location or a mutable branch. Size/hash checks stay outside the
 *  transport fallback and cannot authorize another body. */
function stagedFileSources(manifestUrl, manifest, relativePath) {
    const file = fileUrlOf(manifestUrl, manifest, relativePath)
    const url = new URL(file)
    const prefix = `/gh/${REPO}@`
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.jsdelivr.net' || url.port
        || url.username || url.password || !url.pathname.startsWith(prefix)
        || !/^[a-f0-9]{40}\//.test(url.pathname.slice(prefix.length))) return [file]
    url.hostname = 'gcore.jsdelivr.net'
    return [file, url.href]
}

export async function stageRelease({ manifest, manifestUrl, stageDir, fetchImpl = fetch, concurrency = 4, onProgress = () => {}, timeoutMs = 60000 }) {
    fs.rmSync(stageDir, { recursive: true, force: true })
    fs.mkdirSync(stageDir, { recursive: true })
    let done = 0
    let bytes = 0
    let cursor = 0
    const failures = []
    const workers = Array.from({ length: Math.min(concurrency, manifest.files.length) }, async () => {
        while (cursor < manifest.files.length) {
            const file = manifest.files[cursor++]
            const target = path.join(stageDir, ...file.path.split('/'))
            const sources = stagedFileSources(manifestUrl, manifest, file.path)
            let lastError
            for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt += 1) {
                try {
                    const signal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
                    let body
                    for (let mirror = 0; mirror < sources.length; mirror++) {
                        try {
                            const response = await fetchImpl(bustCdnCache(sources[mirror]), { redirect: 'error', signal })
                            if (!response.ok) throw new Error(`HTTP ${response.status}`)
                            body = Buffer.from(await response.arrayBuffer())
                            break
                        } catch (error) {
                            const status = /^HTTP (\d{3})$/.exec(String(error?.message ?? ''))?.[1]
                            const canFallback = status ? /^(3\d\d|404|429|5\d\d)$/.test(status) : isTransientDownloadError(error)
                            if (!canFallback || mirror === sources.length - 1 || signal?.aborted) throw error
                        }
                    }
                    if (body.length !== file.size) throw new Error(`size ${body.length} != manifest ${file.size}`)
                    const digest = crypto.createHash('sha256').update(body).digest('hex')
                    if (digest !== file.sha256) throw new Error('sha256 mismatch')
                    fs.mkdirSync(path.dirname(target), { recursive: true })
                    fs.writeFileSync(target, body)
                    done += 1
                    bytes += body.length
                    onProgress({ done, total: manifest.files.length, file: file.path })
                    lastError = null
                    break
                } catch (error) {
                    lastError = error
                    const httpStatus = /^HTTP (\d{3})$/.exec(String(error?.message ?? ''))?.[1]
                    const retryable = httpStatus ? httpStatus === '429' || httpStatus.startsWith('5') : isTransientDownloadError(error)
                    if (attempt >= STAGE_ATTEMPTS || !retryable) break
                    await new Promise(resolve => setTimeout(resolve, STAGE_BACKOFF_MS * attempt))
                }
            }
            if (lastError) failures.push(`${file.path}: ${lastError?.message ?? lastError}`)
        }
    })
    await Promise.all(workers)
    if (failures.length > 0) {
        fs.rmSync(stageDir, { recursive: true, force: true })
        throw new Error(`staging failed: ${failures.join('; ')}`)
    }
    return { bytes, files: done }
}

/** The staged copy is checked against the manifest before install touches anything. */
export function verifyStaged(stageDir, manifest) {
    for (const file of manifest.files) {
        const target = path.join(stageDir, ...file.path.split('/'))
        let stat
        try { stat = fs.statSync(target) } catch { throw new Error(`staged file missing: ${file.path}`) }
        if (stat.size !== file.size) throw new Error(`staged size drift for ${file.path}`)
        if (sha256File(target) !== file.sha256) throw new Error(`staged hash drift for ${file.path}`)
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(stageDir, 'package.json'), 'utf8'))
    if (pkg.version !== manifest.version) throw new Error(`staged package.json says ${pkg.version}, manifest says ${manifest.version}`)
}

/** Top-level entries that belong to the repository (or this working copy)
 *  rather than to a release. A sweep must never treat them as "files the new
 *  release dropped" —a git-clone or linked development copy always has them,
 *  and it is the same directory the upgrader operates on. */
const REPOSITORY_SCAFFOLDING = ['feed', 'scripts', 'tools', 'docs', 'reference', 'node_modules', 'public', '.git', '.github']

/** Walk a directory into relative file paths, skipping release scratch files
 *  (`*.dms-new` / `*.dms-old`) and repository scaffolding. */
export function listPackageFiles(dir) {
    const out = []
    const visit = (current, rel) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name.endsWith('.dms-new') || entry.name.endsWith('.dms-old')) continue
            if (rel === '' && (entry.name.startsWith('.') || REPOSITORY_SCAFFOLDING.includes(entry.name))) continue
            const child = path.join(current, entry.name)
            const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
            if (entry.isDirectory()) visit(child, childRel)
            else if (entry.isFile()) out.push(childRel)
        }
    }
    if (fs.existsSync(dir)) visit(dir, '')
    return out
}

/** Copy the current package aside so a failed swap can be undone.
 *  @returns {number} files backed up */
export function backupPackage(pkgDir, backupDir) {
    const snapshot = packageSnapshot(pkgDir)
    const pending = `${backupDir}.pending-${crypto.randomUUID()}`
    const previous = `${backupDir}.previous-${crypto.randomUUID()}`
    let movedPrevious = false
    try {
        fs.mkdirSync(pending, { recursive: true })
        for (const file of snapshot.files) {
            const target = path.join(pending, ...file.path.split('/'))
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.copyFileSync(path.join(pkgDir, ...file.path.split('/')), target)
        }
        verifySnapshot(pending, snapshot)
        // The copy must describe the preimage that is actually about to be
        // replaced —detect edits during backup too.
        verifySnapshot(pkgDir, snapshot)
        fs.writeFileSync(path.join(pending, '.dms-backup.json'), JSON.stringify(snapshot))
        if (fs.existsSync(backupDir)) {
            fs.renameSync(backupDir, previous)
            movedPrevious = true
        }
        try {
            fs.renameSync(pending, backupDir)
        } catch (error) {
            if (movedPrevious) fs.renameSync(previous, backupDir)
            throw error
        }
        if (movedPrevious) {
            try { fs.rmSync(previous, { recursive: true, force: true }) } catch { /* retain it */ }
        }
        return snapshot.files.length
    } finally {
        try { fs.rmSync(pending, { recursive: true, force: true }) } catch { /* retain it */ }
    }
}

function packageSnapshot(dir) {
    const files = listPackageFiles(dir).sort().map(rel => {
        const file = path.join(dir, ...rel.split('/'))
        return { path: rel, size: fs.statSync(file).size, sha256: sha256File(file) }
    })
    if (!files.some(file => file.path === 'package.json') || !files.some(file => file.path === 'index.js')) {
        throw new Error(`no complete rollback copy in ${dir} —package.json and index.js are required`)
    }
    return { files }
}

function verifySnapshot(dir, snapshot) {
    const paths = listPackageFiles(dir).sort()
    if (paths.join('\n') !== snapshot.files.map(file => file.path).sort().join('\n')) {
        throw new Error('rollback file set mismatch')
    }
    for (const file of snapshot.files) {
        const target = path.join(dir, ...file.path.split('/'))
        if (fs.statSync(target).size !== file.size || sha256File(target) !== file.sha256) {
            throw new Error(`rollback hash drift for ${file.path}`)
        }
    }
}

function backupSnapshot(backupDir) {
    if (listPackageFiles(backupDir).length === 0) {
        throw new Error(`no rollback copy in ${backupDir} —leaving the installed package untouched`)
    }
    const metadata = path.join(backupDir, '.dms-backup.json')
    // Older releases did not leave a receipt. Keep their complete backups usable.
    if (!fs.existsSync(metadata)) return packageSnapshot(backupDir)
    const snapshot = JSON.parse(fs.readFileSync(metadata, 'utf8'))
    if (!Array.isArray(snapshot?.files) || snapshot.files.length === 0
        || snapshot.files.some(file => file === null || typeof file !== 'object')
        || !snapshot.files.some(file => file.path === 'package.json')
        || !snapshot.files.some(file => file.path === 'index.js')
        || snapshot.files.some(file => typeof file.path !== 'string' || file.path.startsWith('/')
            || file.path.includes('\\') || file.path.split('/').some(part => part === '' || part === '.' || part === '..')
            || /:/.test(file.path) || !SHA_RE.test(file.sha256) || !Number.isInteger(file.size) || file.size < 0)
        || new Set(snapshot.files.map(file => file.path)).size !== snapshot.files.length) {
        throw new Error('invalid rollback receipt')
    }
    verifySnapshot(backupDir, snapshot)
    return snapshot
}

/** Put a backed-up copy back in place (used when a swap or reload fails). */
export function restoreBackup(backupDir, pkgDir) {
    // Never let a missing rollback copy turn into a wipe.
    const snapshot = backupSnapshot(backupDir)
    const backup = snapshot.files.map(file => file.path)
    const failures = []
    for (const rel of backup) {
        // Survive a locked file: attempting every entry keeps the restore as
        // complete as this machine allows instead of crashing halfway.
        try {
            const target = path.join(pkgDir, ...rel.split('/'))
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.copyFileSync(path.join(backupDir, ...rel.split('/')), target)
        } catch (error) { failures.push(`${rel} (${error?.message ?? error})`) }
    }
    // Restore first. Deleting every installed file before copying made a
    // denied copy destroy files that could otherwise still aid recovery.
    try {
        for (const rel of listPackageFiles(pkgDir)) {
            if (backup.includes(rel)) continue
            try { fs.rmSync(path.join(pkgDir, ...rel.split('/')), { force: true, recursive: true }) }
            catch (error) { failures.push(`${rel} (${error?.message ?? error})`) }
        }
        verifySnapshot(pkgDir, snapshot)
    } catch (error) { failures.push(String(error?.message ?? error)) }
    if (failures.length > 0) throw new Error(`rollback incomplete: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? ` +${failures.length - 3} more` : ''}`)
}

/** Windows can transiently refuse a rename while a file is scanned; retry briefly. */
async function renameWithRetry(from, to) {
    let delay = 60
    for (let attempt = 0; ; attempt += 1) {
        try {
            fs.renameSync(from, to)
            return
        } catch (error) {
            if (attempt >= 4 || !['EPERM', 'EACCES', 'ENOENT'].includes(error?.code)) throw error
            await new Promise(resolve => setTimeout(resolve, delay))
            delay *= 4
        }
    }
}

/** Move a verified staging directory into the installed package location.
 *  Every file goes through a same-directory `<name>.dms-new` so the final hop
 *  is a same-volume rename; the running module graph is unaffected. */
export async function installStaged(stageDir, pkgDir, files) {
    for (const rel of files) {
        const parts = rel.split('/')
        const source = path.join(stageDir, ...parts)
        const target = path.join(pkgDir, ...parts)
        const pending = `${target}.dms-new`
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(source, pending)
        await renameWithRetry(pending, target)
    }
    // A file the new release dropped must not linger from the old one.
    for (const rel of listPackageFiles(pkgDir)) {
        if (files.includes(rel)) continue
        fs.rmSync(path.join(pkgDir, ...rel.split('/')), { force: true, recursive: true })
    }
}

/** Read back everything that was just written; one drifted byte aborts the swap. */
export function verifyInstalled(pkgDir, manifest) {
    for (const file of manifest.files) {
        const target = path.join(pkgDir, ...file.path.split('/'))
        if (!fs.existsSync(target)) throw new Error(`installed file missing: ${file.path}`)
        if (sha256File(target) !== file.sha256) throw new Error(`installed hash drift for ${file.path}`)
    }
}

/** The upgrade lifecycle. The optional `activate` callback lets the Host
 *  include hot reload in the transaction; without it only files are installed. */
export class PluginUpdater {
    /**
     * @param {object} deps
     * @param {string} deps.pkgDir - installed package directory
     * @param {string} deps.dataDir - plugin data dir (staging, backup, history)
     * @param {() => {updateCheckHours?: number}} [deps.settings]
     * @param {(message: string) => void} [deps.log]
     * @param {typeof fetch} [deps.fetchImpl]
     * @param {string} [deps.runningVersion] - version captured by the running module
     */
    constructor({ pkgDir, dataDir, settings = () => ({}), log = () => {}, fetchImpl = fetch, defaultSources = DEFAULT_MANIFEST_SOURCES, runningVersion }) {
        this.deps = { pkgDir, dataDir, settings, log, fetchImpl, defaultSources, runningVersion }
        this.latest = undefined
        this.checkedAt = 0
        this.error = ''
        this.history = this.loadHistory()
    }

    get stageDir() { return path.join(this.deps.dataDir, 'upgrade-stage') }
    get backupDir() { return path.join(this.deps.dataDir, 'rollback') }
    get stateFile() { return path.join(this.deps.dataDir, 'upgrade-state.json') }

    loadUpgradeState() {
        try {
            const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
            if (state === null || !['installing', 'activating', 'recovery-required', 'rolled-back', 'complete'].includes(state.phase)) {
                throw new Error('invalid transaction phase')
            }
            return state
        } catch (error) {
            if (error?.code === 'ENOENT') return undefined
            return { phase: 'recovery-required', error: `could not read upgrade state (${error?.message ?? error})` }
        }
    }

    saveUpgradeState(state) {
        fs.mkdirSync(this.deps.dataDir, { recursive: true })
        const pending = `${this.stateFile}.tmp`
        fs.writeFileSync(pending, JSON.stringify(state), { mode: 0o600 })
        fs.renameSync(pending, this.stateFile)
    }

    reconcileRecovery() {
        const state = this.loadUpgradeState()
        if (upgradeLocks.has(this.deps.pkgDir) || !['installing', 'activating', 'recovery-required'].includes(state?.phase)) return
        try {
            verifySnapshot(this.deps.pkgDir, backupSnapshot(this.backupDir))
            if ((this.deps.runningVersion ?? this.currentVersion()) !== state.from) return
            this.saveUpgradeState({ ...state, phase: 'rolled-back', error: '', diskRestored: true, runtimeRestored: true })
        } catch { /* keep the blocker until both the bytes and runtime match */ }
    }

    currentVersion() {
        try {
            return String(JSON.parse(fs.readFileSync(path.join(this.deps.pkgDir, 'package.json'), 'utf8')).version ?? '')
        } catch {
            return ''
        }
    }

    loadHistory() {
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(this.deps.dataDir, 'updates.json'), 'utf8'))
            return Array.isArray(parsed?.applied) ? parsed.applied : []
        } catch {
            return []
        }
    }

    recordHistory(entry) {
        // A hot reload creates a successor before the caller finishes; merge
        // with durable history so both instances read the final outcome.
        this.history = [...this.loadHistory(), entry].slice(-20)
        try {
            fs.mkdirSync(this.deps.dataDir, { recursive: true })
            fs.writeFileSync(path.join(this.deps.dataDir, 'updates.json'), JSON.stringify({ applied: this.history }, undefined, 2))
        } catch (error) {
            this.deps.log?.(`mol-structure: could not write update history (${error?.message ?? error})`)
        }
    }

    status() {
        const installedVersion = this.currentVersion()
        const current = this.deps.runningVersion ?? installedVersion
        const state = this.loadUpgradeState()
        const active = upgradeLocks.has(this.deps.pkgDir)
        const unfinished = ['installing', 'activating'].includes(state?.phase)
        const recoveryRequired = state?.phase === 'recovery-required' || (unfinished && !active)
        const available = this.latest !== undefined && compareVersions(this.latest.version, current) > 0
        this.history = this.loadHistory()
        return {
            current,
            runningVersion: current,
            installedVersion,
            versionMismatch: current !== installedVersion,
            recoveryRequired,
            phase: state?.phase ?? 'idle',
            latest: this.latest?.version ?? '',
            available,
            notes: this.latest?.notes ?? '',
            publishedAt: this.latest?.publishedAt ?? 0,
            checkedAt: this.checkedAt,
            applying: active,
            error: state?.error || this.error,
            recoveryBackup: recoveryRequired ? this.backupDir : undefined,
            lastApplied: this.history[this.history.length - 1] ?? undefined,
        }
    }

    /** Manifest sources. Deliberately immune to any settings value: an update
     *  source is a code source, and a config field pointing it anywhere else
     *  is the one-step path from "wrote a config field" to "executed arbitrary
     *  code in the host process". */
    sources() {
        return this.deps.defaultSources
    }

    /** Fetch and evaluate the latest manifest. */
    async check() {
        try {
            this.reconcileRecovery()
            const { manifest, source } = await downloadManifest(this.sources(), { fetchImpl: this.deps.fetchImpl })
            const current = this.deps.runningVersion ?? this.currentVersion()
            if (manifest.minSupported !== undefined && current !== '' && compareVersions(current, manifest.minSupported) < 0) {
                throw new Error(`update path requires at least ${manifest.minSupported}; ${current} is installed`)
            }
            this.latest = manifest
            this.manifestUrl = source
            this.checkedAt = Date.now()
            this.error = ''
            this.deps.log?.(`mol-structure: update check via ${source} -> ${manifest.version} (installed ${current})`)
            return { available: compareVersions(manifest.version, current) > 0, current, latest: manifest.version }
        } catch (error) {
            this.error = String(error?.message ?? error)
            throw error
        }
    }

    /** Download, verify and install one manifest. Idempotent for the same version. */
    async apply({ version, onProgress = () => {}, activate } = {}) {
        if (upgradeLocks.has(this.deps.pkgDir)) throw new Error('an upgrade is already running')
        this.reconcileRecovery()
        const priorState = this.loadUpgradeState()
        if (['installing', 'activating', 'recovery-required'].includes(priorState?.phase)) {
            throw new Error(`previous upgrade requires recovery; restore the verified backup in ${this.backupDir} and restart before upgrading again`)
        }
        upgradeLocks.add(this.deps.pkgDir)
        const previous = this.currentVersion()
        let targetVersion = version ?? ''
        let state
        let installed = false
        let activated = false
        try {
            // Re-check immediately before installing: the owner may have pushed
            // a new manifest since the last check, and a stale cached manifest
            // would verify downloads against hashes nobody stands behind.
            await this.check()
            const manifest = this.latest
            if (manifest === undefined) throw new Error('no manifest available')
            targetVersion = manifest.version
            if (version !== undefined && manifest.version !== version) throw new Error(`manifest offers ${manifest.version}, not ${version}`)
            if (compareVersions(manifest.version, previous) < 0) throw new Error(`installed ${previous} is newer than ${manifest.version}`)

            onProgress({ phase: 'download' })
            const staged = await stageRelease({
                manifest, manifestUrl: this.manifestUrl ?? this.sources()[0], stageDir: this.stageDir,
                fetchImpl: this.deps.fetchImpl, onProgress,
            })
            verifyStaged(this.stageDir, manifest)

            onProgress({ phase: 'install' })
            const backedUp = backupPackage(this.deps.pkgDir, this.backupDir)
            state = { from: previous, to: manifest.version, at: Date.now(), phase: 'installing' }
            // Persist the intent before the first installed byte changes.
            this.saveUpgradeState(state)
            const result = { version: manifest.version, previous, files: manifest.files.length, bytes: staged.bytes }
            try {
                installed = true
                await installStaged(this.stageDir, this.deps.pkgDir, manifest.files.map(file => file.path))
                verifyInstalled(this.deps.pkgDir, manifest)
                if (activate !== undefined) {
                    state = { ...state, phase: 'activating' }
                    this.saveUpgradeState(state)
                    onProgress({ phase: 'reload' })
                    const activation = await activate(result)
                    if (activation?.ok !== true) {
                        throw Object.assign(new Error(activation?.error ?? 'hot reload did not confirm activation'), { runtimeRestored: activation?.restored === true })
                    }
                    if (activation.version !== manifest.version) {
                        throw new Error(`activation version mismatch: expected ${manifest.version}, got ${String(activation.version ?? '(missing)')}`)
                    }
                    activated = true
                }
            } catch (error) {
                // The installed copy is in an unknown state: put the old one
                // back before surfacing the failure.
                let restoreError = null
                try { restoreBackup(this.backupDir, this.deps.pkgDir) } catch (rollbackError) { restoreError = rollbackError }
                state = {
                    ...state,
                    phase: restoreError !== null || (state.phase === 'activating' && error.runtimeRestored !== true) ? 'recovery-required' : 'rolled-back',
                    diskRestored: restoreError === null,
                    runtimeRestored: state.phase !== 'activating' || error.runtimeRestored === true,
                }
                if (restoreError !== null) {
                    throw new Error(`upgrade failed (${error?.message ?? error}); rollback also failed (${restoreError?.message ?? restoreError})`)
                }
                throw new Error(`upgrade failed, previous files restored (${error?.message ?? error})`)
            }
            this.saveUpgradeState({ ...state, phase: 'complete', activated })
            try { fs.rmSync(this.stageDir, { recursive: true, force: true }) } catch (error) { this.deps.log?.(`mol-structure: staging cleanup failed (${error?.message ?? error})`) }
            const record = { from: previous, to: manifest.version, at: Date.now(), ok: true, files: manifest.files.length, bytes: staged.bytes, backedUp, activated }
            this.recordHistory(record)
            this.checkedAt = Date.now()
            this.deps.log?.(`mol-structure: upgraded ${previous} -> ${manifest.version} (${manifest.files.length} files)`)
            return result
        } catch (error) {
            this.error = String(error?.message ?? error)
            if (state !== undefined && installed) {
                try {
                    this.saveUpgradeState({ ...state, phase: activated ? 'complete' : state.phase, error: this.error, activated })
                } catch (stateError) {
                    this.error += `; could not persist upgrade outcome (${stateError?.message ?? stateError})`
                }
            }
            const record = { from: previous, to: targetVersion, at: Date.now(), ok: false, error: this.error }
            this.recordHistory(record)
            throw new Error(this.error)
        } finally {
            upgradeLocks.delete(this.deps.pkgDir)
        }
    }
}
