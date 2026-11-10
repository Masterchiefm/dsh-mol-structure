/**
 * Canonical bytes for release-file hashing.
 *
 * The self-updater downloads raw git blobs (LF) from GitHub/jsDelivr and
 * verifies both size and sha256 against feed/manifest.json. Pins therefore
 * must be computed over LF content regardless of the local working copy's
 * EOL (Windows `core.autocrlf` checks text files out as CRLF). Text files
 * (no NUL byte) are normalized CRLF/CR → LF; binary files pass verbatim.
 *
 * @module tools/release-bytes.mjs
 */

import fs from 'node:fs'

export function releaseBytes(file) {
    const buf = fs.readFileSync(file)
    if (buf.includes(0)) return buf
    return Buffer.from(buf.toString('utf8').replaceAll('\r\n', '\n').replaceAll('\r', '\n'), 'utf8')
}
