#!/usr/bin/env node
/**
 * Release manifest builder for the in-app self-updater.
 *
 * Walks the release file set (runtime files only: package.json, index.js,
 * client.js, cordis.patch.yml, icon.svg, README.md, LICENSE, host/, src/,
 * dist/), hashes each file, and writes `feed/manifest.json`. There is no
 * signature: the manifest's SHA-256 pins and the fixed https repository
 * hosts carry the trust.
 *
 * Usage:
 *   node tools/build-manifest.mjs [--notes "..."] [--min-supported 0.5.0]
 *
 * @module tools/build-manifest.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_ENTRIES = [
    'package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'icon.svg',
    'README.md', 'LICENSE',
    'host', 'src', 'dist',
]
const MAX_FILE_BYTES = 12 * 1024 * 1024

function parseArgs(argv) {
    const out = {}
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--') continue
        if (arg === '--notes') out.notes = argv[++i]
        else if (arg === '--min-supported') out.minSupported = argv[++i]
        else throw new Error(`unknown argument "${arg}"`)
    }
    return out
}

function listReleaseFiles(dir) {
    const out = []
    const visit = (current, rel) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name.endsWith('.dms-new') || entry.name.endsWith('.dms-old')) continue
            const child = path.join(current, entry.name)
            const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
            if (entry.isDirectory()) visit(child, childRel)
            else if (entry.isFile()) out.push(childRel)
        }
    }
    for (const entry of RELEASE_ENTRIES) {
        const full = path.join(dir, entry)
        if (!fs.existsSync(full)) {
            if (entry === 'README.md' || entry === 'LICENSE') continue // optional
            throw new Error(`release entry missing: ${entry}`)
        }
        const stat = fs.statSync(full)
        if (stat.isDirectory()) visit(full, entry)
        else out.push(entry)
    }
    return [...new Set(out)].sort()
}

function main() {
    const args = parseArgs(process.argv)

    const files = listReleaseFiles(packageDir)
    const rows = files.map(rel => {
        const full = path.join(packageDir, ...rel.split('/'))
        const size = fs.statSync(full).size
        if (size > MAX_FILE_BYTES) throw new Error(`${rel} (${size} bytes) exceeds the updater's per-file cap`)
        const sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        return { path: rel, size, sha256 }
    })

    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
    const manifest = {
        version: pkg.version,
        base: '../',
        // ms epoch — parseManifest normalizes to this shape.
        publishedAt: Date.now(),
        notes: args.notes ?? '',
        ...(args.minSupported ? { minSupported: args.minSupported } : {}),
        files: rows,
    }

    const feedDir = path.join(packageDir, 'feed')
    fs.mkdirSync(feedDir, { recursive: true })
    fs.writeFileSync(path.join(feedDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`feed/manifest.json written: v${manifest.version}, ${rows.length} files, ${
        rows.reduce((sum, row) => sum + row.size, 0)} bytes total`)
}

main()
