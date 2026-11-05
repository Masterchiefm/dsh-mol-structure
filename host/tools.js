/**
 * Model-facing tools for the structure viewer.
 *
 * Plain-object tool definitions registered on `ctx.tools` (the kernel never
 * runs instanceof checks, so a definition that satisfies the documented
 * ToolSchema + ToolOutputDefinition contract needs no runtime import from
 * @deepseek-ai/* — the same duck-typing every shipped third-party plugin
 * uses). Each viewer tool forwards one {op, args} command to the embedded
 * Mol* page over the SSE bridge and unwraps the POST /result envelope; args
 * are re-validated here because defineTool's schema validation does not wrap
 * duck-typed registrations.
 *
 * @module host/tools.js
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { validateGroups } from './panels.js'

/** Ops POST /api/mol-structure/command may forward to the viewer page. */
export const VIEWER_COMMAND_OPS = ['figure', 'figures', 'scene', 'camera', 'labels', 'hbonds', 'measure', 'select', 'query', 'screenshot', 'ui', 'interfaces', 'style', 'focus', 'align', 'structconn', 'canvas', 'toast', 'stateSave', 'stateLoad', 'export', 'mode']

const STRUCTURE_EXTS = new Set(['.cif', '.mmcif', '.mcif', '.bcif', '.pdb', '.ent', '.pdbqt', '.pqr', '.gro', '.xyz', '.mol', '.sdf', '.sd', '.mol2'])
const BINARY_STRUCTURE_EXTS = new Set(['.bcif'])
const MAX_STRUCTURE_BYTES = 200 * 1024 * 1024
const MAX_SHOT_BYTES = 64 * 1024 * 1024

/** Validate a {chain, seq} residue reference. */
function residueRef(value, label) {
    if (!value || typeof value.chain !== 'string' || value.chain === '') {
        throw new Error(`${label} must be {chain: string, seq?: number}`)
    }
    return { chain: value.chain, seq: typeof value.seq === 'number' ? value.seq : 0 }
}

function hexColorOrNull(value) {
    return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : null
}

/** One command round-trip to the viewer page. */
function unwrapEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object' || !('ok' in envelope)) {
        throw new Error('malformed viewer reply')
    }
    if (envelope.ok === false) throw new Error(envelope.error || 'viewer command failed')
    return envelope.result
}

/** In-memory cache of structure files handed to the viewer via one-shot URLs. */
function createFileCache({ bundledDir }) {
    const files = new Map() // token → {name, buffer}
    let nextToken = 1

    async function resolve(source) {
        let filePath
        if (path.isAbsolute(source)) {
            filePath = source
        } else {
            filePath = path.join(bundledDir, source)
        }
        if (!STRUCTURE_EXTS.has(path.extname(filePath).toLowerCase())) {
            throw new Error(`unsupported structure format "${path.extname(filePath)}" — one of ${[...STRUCTURE_EXTS].join('/')}`)
        }
        let st
        try {
            st = await fsp.stat(filePath)
        } catch {
            throw new Error(`file not found: ${filePath}`)
        }
        if (!st.isFile()) throw new Error(`not a file: ${filePath}`)
        if (st.size > MAX_STRUCTURE_BYTES) {
            throw new Error(`file too large (${Math.round(st.size / 1024 / 1024)} MB, limit ${MAX_STRUCTURE_BYTES / 1024 / 1024})`)
        }
        const buffer = await fsp.readFile(filePath)
        const token = `f${nextToken++}`
        // bound the cache: drop the oldest entry past 8 files
        if (files.size >= 8) files.delete(files.keys().next().value)
        files.set(token, { name: path.basename(filePath), buffer })
        const isBinary = BINARY_STRUCTURE_EXTS.has(path.extname(filePath).toLowerCase())
        return { token, name: path.basename(filePath), bytes: st.size, isBinary }
    }

    function get(token) {
        return files.get(token)
    }

    return { resolve, get }
}

/**
 * Build the tool definitions.
 *
 * @param {object} deps
 * @param {object} deps.state - the host state (viewer truth + submitCommand)
 * @param {object} deps.push - the SSE hub
 * @param {object} deps.figures - the figure registry (id → {title, paperId})
 * @param {string} deps.bundledDir - plugin dist/structures dir for bare filenames
 * @param {(dataUrl: string) => Promise<{path: string, bytes: number}>} deps.savePng
 * @param {object} [deps.panels] - custom panel registry (createPanels)
 * @param {object} [deps.logger]
 * @returns {{definitions: object[], serveLoaded: (token: string, res: import('node:http').ServerResponse) => boolean, resolveLoad: (source: string) => Promise<{token: string, name: string}>}}
 */
export function createTools({ state, push, figures, panels, bundledDir, savePng, files, logger = console }) {
    const fileCache = createFileCache({ bundledDir })

    // --- auto-registered views (mol_load / mol_autoviews) -------------------
    // Loading a structure defines a small standard view set: one overview plus
    // one close-up per significant chain interface (side chains + cartoon +
    // polar bonds + hot-spot labels). Everything visual is an OPTION — palette,
    // per-chain side-chain colours, bond colour, close-up scale, cutoffs and
    // the number of views — so users restyle by calling the tool, never by
    // editing this source file.
    const DEFAULT_PALETTE = ['#3E97DE', '#2FA96B', '#E8A13D', '#9B59D0', '#CF3A3A', '#4A9EA8']
    let autoPanelIds = []

    function autoDefinePanels(inventory, iface, options = {}) {
        if (!panels) return []
        for (const id of autoPanelIds) panels.remove(id)
        autoPanelIds = []
        const chains = inventory?.chains ?? []
        const palette = Array.isArray(options.palette) && options.palette.length
            ? options.palette.filter((c) => typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c))
            : DEFAULT_PALETTE
        const hbondColor = typeof options.hbondColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(options.hbondColor)
            ? options.hbondColor : '#22d3ee'
        const closeup = typeof options.closeup === 'number' && options.closeup > 0 ? options.closeup : 0.35
        const maxViews = Number.isInteger(options.maxViews) && options.maxViews > 0 ? Math.min(options.maxViews, 6) : 3
        // sideChainColors: {A:'#...', B:'#...'} overrides the chain-colour default
        const sideOverrides = options.sideChainColors && typeof options.sideChainColors === 'object'
            ? options.sideChainColors : null
        const titleTemplate = typeof options.titleTemplate === 'string' && options.titleTemplate.includes('{')
            ? options.titleTemplate : '界面 {a}–{b} 特写'
        const labelTemplate = typeof options.labelTemplate === 'string' && options.labelTemplate.includes('{')
            ? options.labelTemplate : '{comp}{seq}（{contacts}）'
        const labelsPerSide = Number.isInteger(options.labelsPerSide) && options.labelsPerSide >= 0
            ? Math.min(options.labelsPerSide, 8) : 3
        const wantOverview = options.overview !== false
        const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m))
        const colorOf = (chain) => {
            const idx = chains.findIndex((c) => c.chain === chain)
            return palette[(idx < 0 ? chains.length : idx) % palette.length]
        }
        const sideColorOf = (chain) => (sideOverrides && sideOverrides[chain]) || colorOf(chain)
        const defined = []
        const tryDefine = (spec) => {
            try {
                defined.push(panels.define(spec))
                autoPanelIds.push(spec.id)
            } catch (error) {
                logger.warn?.(`mol-structure: auto panel "${spec.id}" skipped (${error?.message ?? error})`)
            }
        }

        if (wantOverview && chains.length >= 1) {
            tryDefine({
                id: 'auto-overview',
                title: '总览（全部链）',
                groups: chains.map((c) => ({
                    id: `chain-${c.chain}`,
                    chain: c.chain,
                    kind: 'ranges',
                    ranges: [[c.seqRange[0], c.seqRange[1]]],
                    repr: 'cartoon',
                    color: colorOf(c.chain),
                })),
                view: { yaw: 250, pitch: 12, zoom: 1 },
            })
        }

        // Rank interfaces for the auto views: prefer pairs that involve the
        // largest chain (the receptor in antibody–receptor complexes), since
        // antigen–antibody interfaces are far smaller than the Fab's own
        // heavy/light interface and would otherwise never make the cut.
        const largestChain = [...chains].sort((l, r) => (r.residues ?? 0) - (l.residues ?? 0))[0]?.chain
        const ranked = [...(iface?.pairs ?? [])]
            .map((pair) => {
                const total = (pair.residues ?? []).reduce((sum, r) => sum + (r.contacts ?? 0), 0)
                const boost = pair.a === largestChain || pair.b === largestChain ? 1.6 : 1
                return { pair, score: total * boost }
            })
            .sort((l, r) => r.score - l.score)
            .slice(0, maxViews)
            .map((x) => x.pair)
        const pairs = ranked
        for (const pair of pairs) {
            const aRes = pair.residues.filter((r) => r.chain === pair.a).slice(0, 20)
            const bRes = pair.residues.filter((r) => r.chain === pair.b).slice(0, 20)
            if (aRes.length === 0 || bRes.length === 0) continue
            const hot = [...pair.residues].sort((l, r) => r.contacts - l.contacts)[0]
            const invOf = (chain) => chains.find((c) => c.chain === chain)
            const rangeOf = (chain) => {
                const inv = invOf(chain)
                return inv ? [inv.seqRange[0], inv.seqRange[1]] : null
            }
            const id = `auto-iface-${pair.a}${pair.b}`.replace(/[^a-zA-Z0-9_-]/g, '')
            // Side-chain sticks use each chain's own colour (same colour as its
            // cartoon), so an interface never re-keys residues to a new palette.
            const groups = []
            const rangeA = rangeOf(pair.a)
            const rangeB = rangeOf(pair.b)
            if (rangeA) groups.push({ id: 'base-a', chain: pair.a, kind: 'ranges', ranges: [rangeA], repr: 'cartoon', color: colorOf(pair.a), alpha: 0.18 })
            if (rangeB) groups.push({ id: 'base-b', chain: pair.b, kind: 'ranges', ranges: [rangeB], repr: 'cartoon', color: colorOf(pair.b), alpha: 0.35 })
            groups.push({ id: 'iface-a', chain: pair.a, kind: 'residues', residues: aRes.map((r) => r.seq), repr: 'ball-and-stick', color: sideColorOf(pair.a) })
            groups.push({ id: 'iface-b', chain: pair.b, kind: 'residues', residues: bRes.map((r) => r.seq), repr: 'ball-and-stick', color: sideColorOf(pair.b) })
            tryDefine({
                id,
                title: fill(titleTemplate, { a: pair.a, b: pair.b }),
                groups,
                focus: { chain: hot.chain, seq: hot.seq, radius: closeup },
                hbonds: (pair.polar ?? []).slice(0, 8).map((p) => ({ a: p.a, b: p.b, color: hbondColor })),
                labels: [
                    ...aRes.slice(0, labelsPerSide).map((r) => ({
                        text: fill(labelTemplate, { comp: r.comp, seq: r.seq, contacts: r.contacts, chain: r.chain }),
                        chain: r.chain, seq: r.seq, kind: 'pill', bg: sideColorOf(r.chain), color: '#ffffff',
                    })),
                    ...bRes.slice(0, labelsPerSide).map((r) => ({
                        text: fill(labelTemplate, { comp: r.comp, seq: r.seq, contacts: r.contacts, chain: r.chain }),
                        chain: r.chain, seq: r.seq, kind: 'pill', bg: sideColorOf(r.chain), color: '#ffffff',
                    })),
                ],
            })
        }
        return defined
    }

    async function run(op, args, exec, timeoutMs) {
        const envelope = await state.submitCommand({ op, args, timeoutMs, signal: exec?.signal })
        return unwrapEnvelope(envelope)
    }

    /** Stream one cached structure file to the viewer (GET /load/<token>). */
    function serveLoaded(token, res) {
        const file = fileCache.get(String(token))
        if (!file) return false
        res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'content-length': file.buffer.length,
            'content-disposition': `inline; filename="${file.name}"`,
            'cache-control': 'no-store',
        })
        res.end(file.buffer)
        return true
    }

    const jsonRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    const looseObject = { type: 'object' }

    const figureEnum = Object.keys(figures)
    const REPR = ['cartoon', 'molecular-surface', 'ball-and-stick', 'pipe-and-planks', 'gaussian-surface', 'line', 'point']

    // Canonical wire JSON Schema fragments (projectToolSchema passes `parameters`
    // through untouched, so these must be standard JSON Schema: no inline
    // `required`, requiredness lives in the parent's `required` array).
    const emptyParams = { type: 'object', properties: {} }
    const residuePoint = (description) => ({
        type: 'object',
        description,
        properties: {
            chain: { type: 'string', description: 'auth chain id, e.g. "A"' },
            seq: { type: 'number', description: 'auth seq id' },
        },
        required: ['chain'],
    })
    const groupItemSchema = {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'stable group id' },
            label: { type: 'string' },
            chain: { type: 'string', description: 'auth chain id, e.g. "A"' },
            kind: { type: 'string', enum: ['ranges', 'residues', 'het'], description: 'selection kind (default ranges)' },
            ranges: { type: 'array', description: '[[lo, hi], …] auth seq ranges for kind=ranges' },
            residues: { type: 'array', description: '[n, …] auth seq ids for kind=residues' },
            comp: { type: 'string', description: 'comp id for kind=het, e.g. "MG"' },
            repr: { type: 'string', enum: REPR, description: 'representation (default cartoon)' },
            color: { type: 'string', description: 'hex color, e.g. "#3E97DE"' },
            alpha: { type: 'number', description: '0–1 opacity' },
        },
    }
    const labelItemSchema = {
        type: 'object',
        properties: {
            text: { type: 'string', description: 'label text' },
            kind: { type: 'string', enum: ['pill', 'marker', 'text', 'circle'] },
            anchorKey: { type: 'string', description: 'key from the paper anchor JSON' },
            chain: { type: 'string', description: 'auth chain (residue anchor)' },
            seq: { type: 'number', description: 'auth seq id (residue anchor)' },
            xyz: { type: 'array', description: '[x, y, z] world anchor' },
            bg: { type: 'string', description: 'background hex' },
            color: { type: 'string', description: 'text hex' },
            dx: { type: 'number' },
            dy: { type: 'number' },
            size: { type: 'number', description: 'font size px (text) or circle diameter' },
        },
        required: ['text'],
    }
    const pairItemSchema = {
        type: 'object',
        properties: {
            a: residuePoint('first residue'),
            b: residuePoint('second residue'),
            color: { type: 'string', description: 'line/label hex' },
        },
        required: ['a', 'b'],
    }
    const focusSchema = {
        type: 'object',
        description: 'close in on one residue',
        properties: {
            chain: { type: 'string', description: 'auth chain id' },
            seq: { type: 'number', description: 'auth seq id' },
            radius: { type: 'number', description: 'scene-radius multiplier (default 1.6; smaller = closer)' },
        },
        required: ['chain'],
    }
    const viewSchema = {
        type: 'object',
        description: 'absolute orbit pose (degrees); target = [x,y,z] world-space center to aim at',
        properties: {
            yaw: { type: 'number' },
            pitch: { type: 'number' },
            zoom: { type: 'number' },
            roll: { type: 'number' },
            target: { type: 'array', items: { type: 'number' }, description: '[x,y,z] world-space camera target' },
        },
        required: ['yaw', 'pitch'],
    }

    const definitions = [
        {
            name: 'mol_panel',
            description: 'Open the Structure viewer panel in the right sidebar (embedded Mol* page). Call this FIRST whenever the user wants to see a molecular structure; all other mol_* tools require the panel to be open. Typical flow: mol_panel → mol_load → mol_autoviews / mol_panel_define → mol_figure / mol_camera → mol_screenshot. Example: {} (no arguments).',
            parameters: emptyParams,
            output: { schema: looseObject, render: jsonRender },
            async execute() {
                push.emit('panel', { open: true })
                return { ok: true, note: 'requested the right-sidebar Structure panel to open' }
            },
        },

        {
            name: 'mol_status',
            description: 'Report viewer state: page connected?, currently displayed figure/structure, and the user\'s latest click/selection. Cheap — use it to verify the panel is alive before screenshotting, or to read what residue the user just clicked (mol_status → lastUserSelection). Example: {} (no arguments).',
            parameters: emptyParams,
            output: { schema: looseObject, render: jsonRender },
            async execute() {
                const v = state.viewer
                return {
                    connected: state.viewerLive(),
                    lastSeenAgeMs: v.lastSeen ? Date.now() - v.lastSeen : null,
                    status: v.status,
                    figure: v.figure,
                    structure: v.structure,
                    lastUserSelection: v.selection,
                    pendingCommands: state.pendingCount(),
                }
            },
        },

        {
            name: 'mol_figure',
            description: `Apply a viewer panel by id: built-in publication figures (${figureEnum.join(', ')}) plus any custom panel registered via mol_panel_define. Note: scene rebuild + auto-camera take seconds; if you screenshot right after, wait or re-apply the camera pose. Example: {"figure":"cas9-ov"} (a custom panel) or {"figure":"fig1b"} (built-in).`,
            parameters: {
                type: 'object',
                properties: {
                    figure: { type: 'string', description: 'built-in figure id or registered custom panel id' },
                },
                required: ['figure'],
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 120000,
            async execute(args, exec) {
                if (!figureEnum.includes(args.figure) && !panels?.has(args.figure)) throw new Error(`unknown figure "${args.figure}"`)
                return run('figure', { id: args.figure }, exec, 110000)
            },
        },

        {
            name: 'mol_load',
            description: 'Load a local structure file (cif/bcif/mmcif, pdb/ent, pdbqt, pqr, gro, xyz, mol, sdf, mol2) and return a chain inventory. PROACTIVELY REGISTERED VIEWS: on success the host auto-registers 1 overview + up to maxViews interface close-up panels (side-chain sticks, polar lines, hot-spot labels) — use them via mol_figure, restyle via mol_autoviews, and register additional task-specific views with mol_panel_define. path is an absolute local path or a bundled filename (7xht.cif, 6w5c.cif). Example: {"path":"C:/structures/4un3.cif","palette":["#CF3A3A","#5158D8","#E0457B","#38B6D8"],"closeup":0.3} — palette is in returned inventory order.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'absolute local path or bundled filename' },
                    baseColor: { type: 'string', description: 'colour of the plain base cartoon (default #8FB3D9)' },
                    autoViews: { type: 'boolean', description: 'register the default view set (default true)' },
                    overview: { type: 'boolean', description: 'include the all-chains overview view (default true)' },
                    palette: {
                        type: 'array', items: { type: 'string' },
                        description: 'chain colours, one hex per chain in inventory order (default built-in palette)',
                    },
                    sideChainColors: {
                        type: 'object', description: 'per-chain side-chain stick colours, e.g. {"A":"#FF8800"} (default: the chain colour)',
                    },
                    hbondColor: { type: 'string', description: 'polar-contact line colour (default #22d3ee)' },
                    closeup: { type: 'number', description: 'close-up zoom scale for auto interface views (default 0.35; smaller = closer)' },
                    maxViews: { type: 'number', description: 'max auto interface views (default 3, max 6)' },
                    labelsPerSide: { type: 'number', description: 'hot-spot labels per chain side (default 3)' },
                    titleTemplate: { type: 'string', description: 'view title template with {a}/{b} chain ids (default "界面 {a}–{b} 特写")' },
                    labelTemplate: { type: 'string', description: 'label text template with {comp}{seq}{contacts} (default "{comp}{seq}（{contacts}）")' },
                    cutoff: { type: 'number', description: 'contact distance cutoff in Å (default 4.5)' },
                    polarCutoff: { type: 'number', description: 'polar-contact cutoff in Å (default 3.6)' },
                },
                required: ['path'],
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 120000,
            async execute(args, exec) {
                if (typeof args.path !== 'string' || args.path.trim() === '') throw new Error('path is required')
                const { token, name, isBinary } = await fileCache.resolve(args.path.trim())
                const url = `/api/mol-structure/load/${token}`
                const loaded = await run('load', { url, name, color: args.baseColor, isBinary }, exec, 110000)
                if (args.autoViews === false) return loaded
                // Proactively register a standard view set for what was loaded:
                // overview + up to `maxViews` interface close-ups (side chains,
                // polar bonds, hot-spot labels). Every visual is an option above.
                try {
                    const iface = await run('interfaces', { cutoff: args.cutoff, polarCutoff: args.polarCutoff }, exec, 60000)
                    const defined = autoDefinePanels(loaded?.inventory, iface, {
                        palette: args.palette,
                        sideChainColors: args.sideChainColors,
                        hbondColor: args.hbondColor,
                        closeup: args.closeup,
                        maxViews: args.maxViews,
                        overview: args.overview,
                        labelsPerSide: args.labelsPerSide,
                        titleTemplate: args.titleTemplate,
                        labelTemplate: args.labelTemplate,
                    })
                    if (defined.length) {
                        push.emit('panels', { panels: panels.list() })
                        return { ...loaded, autoViews: defined.map((p) => ({ id: p.id, title: p.title })) }
                    }
                } catch (error) {
                    logger.warn?.(`mol-structure: auto views skipped (${error?.message ?? error})`)
                }
                return loaded
            },
        },

        {
            name: 'mol_autoviews',
            description: 'Re-generate the auto view set for the ALREADY-LOADED structure (overview + interface close-ups) with new styling — restyle without reloading or editing anything. Example: {"palette":["#CF3A3A","#5158D8"],"closeup":0.3,"apply":"auto-iface-AB"} regenerates views and immediately applies the protein–protein close-up.',
            parameters: {
                type: 'object',
                properties: {
                    palette: { type: 'array', items: { type: 'string' }, description: 'chain colours in inventory order' },
                    sideChainColors: { type: 'object', description: 'per-chain side-chain colours, e.g. {"A":"#FF8800"}' },
                    hbondColor: { type: 'string', description: 'polar-line colour' },
                    closeup: { type: 'number', description: 'close-up zoom scale (smaller = closer)' },
                    maxViews: { type: 'number', description: 'max interface views (default 3)' },
                    overview: { type: 'boolean', description: 'include the all-chains overview view (default true)' },
                    labelsPerSide: { type: 'number', description: 'hot-spot labels per chain side (default 3)' },
                    titleTemplate: { type: 'string', description: 'view title template with {a}/{b}' },
                    labelTemplate: { type: 'string', description: 'label template with {comp}{seq}{contacts}' },
                    cutoff: { type: 'number', description: 'contact cutoff in Å (default 4.5)' },
                    polarCutoff: { type: 'number', description: 'polar cutoff in Å (default 3.6)' },
                    apply: { type: 'string', description: 'optional auto view id to apply right after regenerating' },
                },
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 120000,
            async execute(args, exec) {
                const inventory = await run('query', { mode: 'chains' }, exec, 60000)
                const iface = await run('interfaces', { cutoff: args.cutoff, polarCutoff: args.polarCutoff }, exec, 60000)
                const defined = autoDefinePanels(inventory, iface, {
                    palette: args.palette,
                    sideChainColors: args.sideChainColors,
                    hbondColor: args.hbondColor,
                    closeup: args.closeup,
                    maxViews: args.maxViews,
                    overview: args.overview,
                    labelsPerSide: args.labelsPerSide,
                    titleTemplate: args.titleTemplate,
                    labelTemplate: args.labelTemplate,
                })
                push.emit('panels', { panels: panels.list() })
                let applied = null
                if (typeof args.apply === 'string' && args.apply !== '') {
                    applied = await run('figure', { id: args.apply }, exec, 110000)
                }
                return { ok: true, views: defined.map((p) => ({ id: p.id, title: p.title })), applied }
            },
        },

        {
            name: 'mol_scene',
            description: 'One-shot custom scene (groups are drawn in order; later groups sit on top). Each group = one auth chain selection rendered in one uniform color. kinds: ranges=[[lo,hi],…] auth seq | residues=[n,…] | comp="MG" (het, needs color). Common recipe — translucent protein surface + nucleic-acid cartoons: [{"chain":"B","kind":"ranges","ranges":[[1,1364]],"repr":"molecular-surface","color":"#8FA3B8","alpha":0.45},{"chain":"B","kind":"ranges","ranges":[[1,1364]],"repr":"cartoon","color":"#C9CED4"},{"chain":"A","kind":"ranges","ranges":[[1,81]],"repr":"cartoon","color":"#CF3A3A"}]. For reusable panels prefer mol_panel_define.',
            parameters: {
                type: 'object',
                properties: {
                    structureUrl: { type: 'string', description: 'optional structure URL to (re)build from; omit to reuse the loaded one' },
                    groups: {
                        type: 'array', description: 'component groups, drawn in order',
                        items: groupItemSchema,
                    },
                },
                required: ['groups'],
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 120000,
            async execute(args, exec) {
                const groups = validateGroups(args.groups)
                return run('scene', { structureUrl: args.structureUrl, groups }, exec, 110000)
            },
        },

        {
            name: 'mol_camera',
            description: 'Move the camera. view = absolute orbit pose {yaw,pitch (deg around world axes), zoom (≈1/zoom is the close-up factor: 1 default, 2.5 ≈ 2.5× in), roll}; focus = close in on one residue {chain, seq, radius (multiplier, smaller = closer)}; rotateByDeg = relative spin. Best AFTER a figure/scene settles (Mol* auto-camera would otherwise override you — for close-ups apply once more after ~2s). Example: {"view":{"yaw":255,"pitch":15,"zoom":2.6}}.',
            parameters: {
                type: 'object',
                properties: {
                    focus: focusSchema,
                    view: viewSchema,
                    rotateByDeg: { type: 'number', description: 'rotate the current view around the vertical axis, degrees' },
                },
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 30000,
            async execute(args, exec) {
                const payload = {}
                if (args.focus !== undefined) {
                    payload.focus = residueRef(args.focus, 'focus')
                    if (typeof args.focus.radius === 'number') payload.focus.radius = args.focus.radius
                }
                if (args.view !== undefined) {
                    const v = args.view
                    if (typeof v.yaw !== 'number' || typeof v.pitch !== 'number') throw new Error('view needs numeric yaw and pitch')
                    payload.yaw = v.yaw; payload.pitch = v.pitch
                    if (typeof v.zoom === 'number') payload.zoom = v.zoom
                    if (typeof v.roll === 'number') payload.roll = v.roll
                    if (Array.isArray(v.target) && v.target.length === 3 && v.target.every((n) => typeof n === 'number')) payload.target = [...v.target]
                }
                if (typeof args.rotateByDeg === 'number') payload.rotateByDeg = args.rotateByDeg
                if (Object.keys(payload).length === 0) throw new Error('nothing to do — pass focus, view, or rotateByDeg')
                return run('camera', payload, exec, 25000)
            },
        },

        {
            name: 'mol_labels',
            description: 'HTML overlay labels anchored to the structure (replaces ALL labels). Each label needs text plus ONE anchor: residue {chain, seq} (most common), anchorKey (paper anchors), or xyz. kind: pill (default box) / marker / text / circle. NOTE: labels are HTML only — mol_screenshot PNGs do NOT include them; for labelled figures capture the whole page. Example: {"labels":[{"text":"PAM reader R1335","chain":"B","seq":1335,"kind":"pill"}]} or {"clear":true} to wipe.',
            parameters: {
                type: 'object',
                properties: {
                    clear: { type: 'boolean', description: 'remove all labels' },
                    labels: {
                        type: 'array', description: 'labels to show',
                        items: labelItemSchema,
                    },
                },
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 30000,
            async execute(args, exec) {
                if (args.clear) return run('labels', { clear: true }, exec, 25000)
                if (!Array.isArray(args.labels) || args.labels.length === 0) throw new Error('labels array required (or clear: true)')
                for (const l of args.labels) {
                    if (!l || typeof l.text !== 'string') throw new Error('each label needs text')
                    const hasAnchor = l.xyz || l.anchorKey || (typeof l.chain === 'string')
                    if (!hasAnchor) throw new Error(`label "${l.text}" needs anchorKey, chain+seq, or xyz`)
                }
                return run('labels', { labels: args.labels }, exec, 25000)
            },
        },

        {
            name: 'mol_hbonds',
            description: 'Distance lines between residue pairs (H-bond / contact annotation; centroid-to-centroid, drawn cyan). Replace-all semantics — pass the full pair list each time, or {"clear":true}. Example: {"pairs":[{"a":{"chain":"B","seq":1335},"b":{"chain":"D","seq":11}},{"a":{"chain":"B","seq":450},"b":{"chain":"A","seq":10}}]}.',
            parameters: {
                type: 'object',
                properties: {
                    clear: { type: 'boolean', description: 'remove all measurement lines' },
                    pairs: {
                        type: 'array', description: 'residue pairs to connect',
                        items: pairItemSchema,
                    },
                },
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 30000,
            async execute(args, exec) {
                if (args.clear) return run('hbonds', { clear: true }, exec, 25000)
                if (!Array.isArray(args.pairs) || args.pairs.length === 0) throw new Error('pairs required (or clear: true)')
                const clean = args.pairs.map((p, i) => ({
                    a: residueRef(p?.a, `pairs[${i}].a`),
                    b: residueRef(p?.b, `pairs[${i}].b`),
                    ...(hexColorOrNull(p?.color) ? { color: p.color } : {}),
                }))
                return run('hbonds', { pairs: clean }, exec, 25000)
            },
        },

        {
            name: 'mol_measure',
            description: 'Centroid-to-centroid distance between two residues in Å (no drawing — pair with mol_hbonds to annotate). Good first step to check whether a candidate contact is real before drawing lines. Example: {"a":{"chain":"B","seq":450},"b":{"chain":"A","seq":10}}.',
            parameters: {
                type: 'object',
                properties: {
                    a: residuePoint('first residue'),
                    b: residuePoint('second residue'),
                },
                required: ['a', 'b'],
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 30000,
            async execute(args, exec) {
                return run('measure', { a: residueRef(args.a, 'a'), b: residueRef(args.b, 'b') }, exec, 25000)
            },
        },

        {
            name: 'mol_query',
            description: 'Analysis queries on the loaded structure. mode=chains: chain inventory (always read this first after load — it defines palette order and auth seq ranges). mode=radius: residues within radius Å of one residue (binding-site neighborhoods, contact picking). Example: {"mode":"radius","chain":"B","seq":983,"radius":6} lists everything around catalytic H983.',
            parameters: {
                type: 'object',
                properties: {
                    mode: { type: 'string', enum: ['chains', 'radius'], description: 'query mode' },
                    chain: { type: 'string', description: 'center chain (mode=radius)' },
                    seq: { type: 'number', description: 'center residue (mode=radius)' },
                    radius: { type: 'number', description: 'radius in Å (default 5)' },
                },
                required: ['mode'],
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 30000,
            async execute(args, exec) {
                if (args.mode === 'radius') {
                    const center = residueRef({ chain: args.chain, seq: args.seq }, 'chain/seq')
                    return run('query', { mode: 'radius', chain: center.chain, seq: center.seq, radius: typeof args.radius === 'number' ? args.radius : 5 }, exec, 25000)
                }
                return run('query', { mode: 'chains' }, exec, 25000)
            },
        },

        {
            name: 'mol_select',
            description: 'Get/set the Mol* selection; returns what is selected. Call with NO arguments to read the user\'s current 3D click selection. Use seqs probes to verify residues exist before putting them in a panel (missing auth seqs are silently dropped from ranges). Example: {"chain":"B","seqs":[10,762,840,983]}.',
            parameters: {
                type: 'object',
                properties: {
                    chain: { type: 'string', description: 'auth chain to select; omit to just report the current selection' },
                    seqs: { type: 'array', description: 'auth seq ids to select within the chain; omit to select the whole chain' },
                    clear: { type: 'boolean', description: 'clear the selection' },
                },
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 30000,
            async execute(args, exec) {
                if (args.clear) return run('select', { clear: true }, exec, 25000)
                if (typeof args.chain === 'string' && args.chain !== '') {
                    const seqs = Array.isArray(args.seqs) ? args.seqs.filter(n => typeof n === 'number') : undefined
                    return run('select', { chain: args.chain, ...(seqs?.length ? { seqs } : {}) }, exec, 25000)
                }
                const current = await run('select', {}, exec, 25000)
                return { ...current, note: 'current selection (no change requested)' }
            },
        },

        {
            name: 'mol_screenshot',
            description: 'Capture the WebGL canvas as PNG (2× supersample), saved locally; returns the absolute path. Canvas ONLY — HTML labels are excluded; works even with the sidebar tab hidden (borrowed offscreen framebuffer). Works on stale background tabs too (forces a synchronous frame). Example: {} — then read the returned path, e.g. with read_image.',
            parameters: emptyParams,
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 45000,
            async execute(args, exec) {
                const result = await run('screenshot', {}, exec, 40000)
                const dataUrl = result?.__screenshotDataUrl
                if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) {
                    throw new Error('viewer returned no screenshot')
                }
                if (dataUrl.length > MAX_SHOT_BYTES) throw new Error('screenshot too large to save')
                const { path: savedPath, bytes } = await savePng(dataUrl)
                logger.info?.(`mol-structure: screenshot saved ${savedPath} (${bytes} bytes)`)
                return { path: savedPath, bytes, note: 'PNG saved; HTML labels are not part of the canvas capture' }
            },
        },
        {
            name: 'mol_panel_define',
            description: 'PROACTIVE VIEW REGISTRATION — the standard way to persist analysis views. Register a custom panel: kind="view" (default) = {groups, view|focus, labels, hbonds} applied like a built-in figure; kind="action" = op-chain quick buttons. Same id overwrites (idempotent edits). Appears in the viewer control card and is applied via mol_figure. Groups DSL: {chain, kind:"ranges"|"residues"|"het", ranges|residues|comp, repr, color, alpha, id, label}. Minimal example: {"id":"pam-pocket","title":"PAM 口袋","groups":[{"chain":"B","kind":"residues","residues":[1333,1335],"repr":"ball-and-stick","color":"#F97316"}],"hbonds":[{"a":{"chain":"B","seq":1335},"b":{"chain":"D","seq":11}}],"view":{"yaw":255,"pitch":10,"zoom":2.5},"apply":true}. ALWAYS register the key views you analyze (overview, interface close-ups, mutation candidates) so the user can replay them from the control card.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'panel id (auto-generated when omitted)' },
                    title: { type: 'string', description: 'button label' },
                    kind: { type: 'string', enum: ['view', 'action'], description: 'view (default) or action panel' },
                    apply: { type: 'boolean', description: 'switch the viewer to this panel immediately' },
                    structureUrl: { type: 'string', description: 'structure to (re)build from; omit to use the loaded one' },
                    groups: { type: 'array', description: 'scene groups, same DSL as mol_scene (required for view panels)', items: groupItemSchema },
                    view: viewSchema,
                    focus: focusSchema,
                    labels: { type: 'array', description: 'labels, same DSL as mol_labels', items: labelItemSchema },
                    hbonds: { type: 'array', description: 'distance-line pairs, same DSL as mol_hbonds', items: pairItemSchema },
                    actions: {
                        type: 'array',
                        description: 'op chain for kind=action, e.g. [{label:"全原子", op:"style", args:{...}}]',
                        items: {
                            type: 'object',
                            properties: {
                                label: { type: 'string', description: 'step description' },
                                op: { type: 'string', description: 'viewer op (style/focus/camera/labels/hbonds/select/canvas/toast/align/structconn/query/figure)' },
                                args: { type: 'object', description: 'op arguments' },
                            },
                            required: ['op'],
                        },
                    },
                },
                required: ['title'],
            },
            output: { schema: { type: 'object' }, render: jsonRender },
            timeoutMs: 120000,
            async execute(args, exec) {
                if (!panels) throw new Error('panel registry unavailable')
                const defined = panels.define(args)
                push.emit('panels', { panels: panels.list() })
                if (args.apply) {
                    const applied = await run('figure', { id: defined.id }, exec, 110000)
                    return { ok: true, panel: defined, applied: applied?.status ?? null }
                }
                return { ok: true, panel: defined }
            },
        },
        {
            name: 'mol_mode',
            description: 'Switch simple mode (agent canvas + control card) / full Mol* mode (native tree, sequence view). Page reloads; the op acks before reloading. Example: {"full":true}.',
            parameters: {
                type: 'object',
                properties: {
                    full: { type: 'boolean', description: 'true = full Mol* UI, false = simple agent mode' },
                },
                required: ['full'],
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 30000,
            async execute(args, exec) {
                return run('mode', { full: Boolean(args.full) }, exec, 25000)
            },
        },
        {
            name: 'mol_style',
            description: 'Add one representation layer on the CURRENT structure (no scene rebuild — fast overlays). Selection: chain + optional seqs, or comp for a ligand. Same tag replaces its layer. Transparency via alpha (0–1). Example: {"chain":"B","repr":"molecular-surface","color":"#8FA3B8","alpha":0.45,"tag":"surf"} for a translucent surface; {"comp":"MG","repr":"ball-and-stick","color":"#A3E635"} for Mg ions.',
            parameters: {
                type: 'object',
                properties: {
                    chain: { type: 'string', description: 'auth chain id' },
                    seqs: { type: 'array', description: 'auth seq ids (omit to style the whole chain)' },
                    comp: { type: 'string', description: 'ligand/hetero comp id, e.g. "MG" (overrides seqs)' },
                    repr: { type: 'string', enum: REPR, description: 'representation (default cartoon)' },
                    color: { type: 'string', description: 'hex color (default #3E97DE)' },
                    alpha: { type: 'number', description: '0–1 opacity' },
                    tag: { type: 'string', description: 'layer tag — same tag replaces the previous layer (default "agent-style")' },
                    focus: { type: 'boolean', description: 'center the camera on the selection afterwards' },
                },
                required: ['chain'],
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 60000,
            async execute(args, exec) {
                if (typeof args.chain !== 'string' || args.chain === '') throw new Error('chain is required')
                if (args.comp !== undefined && typeof args.comp !== 'string') throw new Error('comp must be a string')
                const seqs = Array.isArray(args.seqs) ? args.seqs.filter((n) => typeof n === 'number') : undefined
                return run('style', {
                    chain: args.chain,
                    ...(seqs?.length ? { seqs } : {}),
                    ...(args.comp !== undefined ? { comp: args.comp } : {}),
                    ...(typeof args.repr === 'string' ? { repr: args.repr } : {}),
                    ...(hexColorOrNull(args.color) ? { color: args.color } : {}),
                    ...(typeof args.alpha === 'number' ? { alpha: args.alpha } : {}),
                    ...(typeof args.tag === 'string' && args.tag ? { tag: args.tag } : {}),
                    ...(args.focus ? { focus: true } : {}),
                }, exec, 55000)
            },
        },
        {
            name: 'mol_focus',
            description: 'Mol* focus manager: ball-and-stick close-up of one residue + non-covalent interaction circles around it (like the viewer focus button). Best for "what does this residue touch". Example: {"chain":"B","seq":983} or {"clear":true}.',
            parameters: {
                type: 'object',
                properties: {
                    chain: { type: 'string', description: 'auth chain id' },
                    seq: { type: 'number', description: 'auth seq id' },
                    clear: { type: 'boolean', description: 'clear the focus' },
                },
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 30000,
            async execute(args, exec) {
                if (args.clear) return run('focus', { clear: true }, exec, 25000)
                const center = residueRef({ chain: args.chain, seq: args.seq }, 'chain/seq')
                return run('focus', { chain: center.chain, seq: center.seq }, exec, 25000)
            },
        },
        {
            name: 'mol_align',
            description: 'Least-squares Cα superposition, chain B onto chain A (residues paired by ordinal order — chains must cover the same length). Returns RMSD + 4×4 matrix; apply:true also transforms the scene. Example: {"a":{"chain":"A"},"b":{"chain":"C"},"apply":false}.',
            parameters: {
                type: 'object',
                properties: {
                    a: residuePoint('reference chain'),
                    b: residuePoint('chain to move onto a'),
                    apply: { type: 'boolean', description: 'apply the transform to the scene (default false)' },
                },
                required: ['a', 'b'],
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 60000,
            async execute(args, exec) {
                const a = residueRef(args.a, 'a')
                const b = residueRef(args.b, 'b')
                return run('align', { a: { chain: a.chain }, b: { chain: b.chain }, apply: Boolean(args.apply) }, exec, 55000)
            },
        },
        {
            name: 'mol_structconn',
            description: 'wwPDB struct_conn records of the loaded mmCIF: deposited H-bonds, salt bridges, disulfides, covale, metal coordination. list returns {id, distance, partners:[{chain, authSeq, comp, atom}]} — filter for pairs across chains to map interactions; show draws pink atoms + circles + zoom for one id. Example: {"action":"list"} then {"action":"show","id":"hydrog44"}.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'show', 'clear'], description: 'list (default) / show one by id / clear visuals' },
                    id: { type: 'string', description: 'struct_conn id (action=show), e.g. "disulf1"' },
                },
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 60000,
            async execute(args, exec) {
                const action = ['list', 'show', 'clear'].includes(args.action) ? args.action : 'list'
                return run('structconn', { action, ...(action === 'show' ? { id: String(args.id ?? '') } : {}) }, exec, 55000)
            },
        },
        {
            name: 'mol_canvas',
            description: 'Viewport background color — pick white/#ffffff for publication figures, dark for on-screen browsing. Example: {"backgroundColor":"white"}.',
            parameters: {
                type: 'object',
                properties: {
                    backgroundColor: { type: 'string', description: 'hex color or white/black/gray/light/dark' },
                },
                required: ['backgroundColor'],
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 30000,
            async execute(args, exec) {
                if (typeof args.backgroundColor !== 'string' || args.backgroundColor === '') throw new Error('backgroundColor is required')
                return run('canvas', { backgroundColor: args.backgroundColor }, exec, 25000)
            },
        },
        {
            name: 'mol_state',
            description: 'Full viewer snapshot (structure + representations + camera) as JSON in $DSH_HOME/mol-structure/states/. save before risky scene surgery, load to restore. Example: {"action":"save","name":"cas9-workspace"} then {"action":"load","name":"cas9-workspace"}.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['save', 'load'], description: 'save the current state or restore a saved one' },
                    name: { type: 'string', description: 'snapshot file name (default: timestamped for save; required for load)' },
                    path: { type: 'string', description: 'absolute snapshot path (alternative to name for load)' },
                },
                required: ['action'],
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 120000,
            async execute(args, exec) {
                if (!files?.saveState) throw new Error('state file store unavailable in this build')
                if (args.action === 'save') {
                    const saved = await run('stateSave', {}, exec, 110000)
                    const text = JSON.stringify(saved?.snapshot ?? null)
                    const name = args.name || `state-${Date.now()}`
                    const out = await files.saveState(name, text)
                    return { ok: true, ...out, bytes: text.length, note: 'structure URLs reference one-shot load tokens — re-run mol_load if a restored state cannot re-fetch' }
                }
                const name = args.name || (args.path ? String(args.path) : null)
                if (!name) throw new Error('load needs name (or path)')
                const text = await files.readState(name)
                const snapshot = JSON.parse(text)
                return run('stateLoad', { snapshot }, exec, 110000)
            },
        },
        {
            name: 'mol_export',
            description: 'Export the loaded structure as mmCIF text (atom_site…) to $DSH_HOME/mol-structure/exports/; returns the absolute path. Round-trip into PyMOL/ChimeraX or feed pipelines. Example: {"name":"cas9-4un3-export.cif"}.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'output file name (default: export-<timestamp>.cif)' },
                },
            },
            output: { schema: looseObject, render: jsonRender },
            timeoutMs: 120000,
            async execute(args, exec) {
                if (!files?.saveExport) throw new Error('export file store unavailable in this build')
                const result = await run('export', {}, exec, 110000)
                const text = result?.__cifText
                if (typeof text !== 'string' || text.length < 20) throw new Error('viewer returned no mmCIF data')
                const out = await files.saveExport(args.name || `export-${Date.now()}.cif`, text)
                return { ok: true, path: out.path, bytes: text.length, atoms: result?.atoms }
            },
        },
    ]

    /** Resolve a tool-style path argument into a load URL (used by POST /command). */
    async function resolveLoad(source) {
        const { token, name, isBinary } = await fileCache.resolve(source)
        return { token, name, isBinary, url: `/api/mol-structure/load/${token}` }
    }

    return { definitions, serveLoaded, resolveLoad }
}
