/**
 * Registry of user/program-defined viewer panels (自定义视图).
 *
 * A panel is a named macro over the existing viewer ops: scene groups, an
 * optional camera pose or residue focus, optional labels and H-bond pairs —
 * everything the built-in paper figures are made of, but registered at
 * runtime instead of compiled into src/papers/*.js.
 *
 * Registrations arrive from two places that share this one validation path:
 * the `mol_panel_define` agent tool and the `POST /api/mol-structure/command`
 * route that external local programs use. The registry is host-side memory:
 * the viewer learns about changes through the SSE `panels` event, and
 * `mol_figure`/`POST /command {op:"figure"}` apply registered ids like the
 * built-in ones. Definitions do not survive a host reload — re-register.
 *
 * @module host/panels.js
 */

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const REPR = ['cartoon', 'molecular-surface', 'ball-and-stick', 'pipe-and-planks', 'gaussian-surface', 'line', 'point']

function hexColorOrNull(value) {
    return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : null
}

function residueRef(value, label) {
    if (!value || typeof value.chain !== 'string' || value.chain === '') {
        throw new Error(`${label} must be {chain: string, seq?: number}`)
    }
    return { chain: value.chain, seq: typeof value.seq === 'number' ? value.seq : 0 }
}

/** Validate scene groups (same DSL as the mol_scene tool). */
export function validateGroups(groups) {
    if (!Array.isArray(groups) || groups.length === 0) throw new Error('groups is required (non-empty array)')
    return groups.map((g, i) => {
        if (!g || typeof g !== 'object') throw new Error(`groups[${i}] must be an object`)
        const kind = g.kind ?? (g.comp !== undefined ? 'het' : g.residues !== undefined ? 'residues' : 'ranges')
        if (kind === 'het' && typeof g.comp !== 'string') throw new Error(`groups[${i}] kind=het needs comp`)
        if (kind !== 'het' && typeof g.chain !== 'string') throw new Error(`groups[${i}] needs chain`)
        if (kind === 'ranges' && !Array.isArray(g.ranges)) throw new Error(`groups[${i}] kind=ranges needs ranges [[lo,hi],…]`)
        if (kind === 'residues' && !Array.isArray(g.residues)) throw new Error(`groups[${i}] kind=residues needs residues [n,…]`)
        if (g.kind !== undefined && !['ranges', 'residues', 'het'].includes(g.kind)) throw new Error(`groups[${i}] bad kind "${g.kind}"`)
        if (g.repr !== undefined && !REPR.includes(g.repr)) throw new Error(`groups[${i}] bad repr "${g.repr}"`)
        if (g.color !== undefined && hexColorOrNull(g.color) === null) throw new Error(`groups[${i}] bad color "${g.color}"`)
        if (g.alpha !== undefined && !(typeof g.alpha === 'number' && g.alpha >= 0 && g.alpha <= 1)) throw new Error(`groups[${i}] alpha must be 0–1`)
        return { ...g, kind }
    })
}

/** Validate one label spec (same shape as the mol_labels tool). */
function validateLabels(labels) {
    if (!Array.isArray(labels) || labels.length === 0) throw new Error('labels must be a non-empty array')
    return labels.map((l, i) => {
        if (!l || typeof l.text !== 'string') throw new Error(`labels[${i}] needs text`)
        const hasAnchor = l.xyz || l.anchorKey || (typeof l.chain === 'string')
        if (!hasAnchor) throw new Error(`labels[${i}] "${l.text}" needs anchorKey, chain+seq, or xyz`)
        if (l.kind !== undefined && !['pill', 'marker', 'text', 'circle'].includes(l.kind)) throw new Error(`labels[${i}] bad kind "${l.kind}"`)
        for (const key of ['bg', 'color']) {
            if (l[key] !== undefined && hexColorOrNull(l[key]) === null) throw new Error(`labels[${i}] bad ${key} "${l[key]}"`)
        }
        return l
    })
}

/** Validate H-bond pairs (same shape as the mol_hbonds tool). */
function validatePairs(pairs) {
    if (!Array.isArray(pairs) || pairs.length === 0) throw new Error('hbonds must be a non-empty array')
    return pairs.map((p, i) => {
        const clean = {
            a: residueRef(p?.a, `hbonds[${i}].a`),
            b: residueRef(p?.b, `hbonds[${i}].b`),
        }
        if (hexColorOrNull(p?.color)) clean.color = p.color
        return clean
    })
}

/** Validate an action panel's op chain ([{label, op, args}, …]). */
function validateActions(actions) {
    if (!Array.isArray(actions) || actions.length === 0) throw new Error('actions must be a non-empty array')
    const OPS = new Set(['style', 'focus', 'camera', 'labels', 'hbonds', 'select', 'canvas', 'toast', 'figure', 'scene', 'align', 'structconn', 'query', 'mode'])
    return actions.map((a, i) => {
        if (!a || typeof a.op !== 'string' || !OPS.has(a.op)) {
            throw new Error(`actions[${i}] needs op, one of: ${[...OPS].join(', ')}`)
        }
        const clean = { op: a.op }
        if (typeof a.label === 'string' && a.label.trim()) clean.label = a.label.trim().slice(0, 60)
        if (a.args !== undefined) {
            if (typeof a.args !== 'object' || Array.isArray(a.args)) throw new Error(`actions[${i}].args must be an object`)
            clean.args = a.args
        }
        return clean
    })
}

/**
 * Create the registry.
 *
 * @param {{logger?: object}} [opts]
 * @returns {{define: (spec: object) => object, remove: (id: string) => boolean, list: () => object[], has: (id: string) => boolean, get: (id: string) => object|undefined}}
 */
export function createPanels({ logger = console } = {}) {
    const panels = new Map() // id → spec
    let autoId = 1

    function define(spec) {
        if (!spec || typeof spec !== 'object') throw new Error('panel spec required')
        let { id } = spec
        if (id === undefined || id === null || id === '') {
            id = `view-${Date.now()}-${autoId++}`
        }
        if (typeof id !== 'string' || !ID_RE.test(id)) {
            throw new Error(`bad panel id "${id}" — letters/digits/-/_ , start alphanumeric, ≤64 chars`)
        }
        if (typeof spec.title !== 'string' || spec.title.trim() === '') throw new Error('title is required')
        // Two panel kinds: view (scene macro, default) and action (op chain).
        const kind = spec.kind === 'action' ? 'action' : undefined
        const clean = {
            id,
            title: spec.title.trim().slice(0, 80),
            custom: true,
        }
        if (kind === 'action') {
            clean.kind = 'action'
            clean.actions = validateActions(spec.actions)
            panels.set(id, clean)
            logger.info?.(`mol-structure: action panel "${id}" defined (${panels.size} custom)`)
            return clean
        }
        if (spec.structureUrl !== undefined) {
            if (typeof spec.structureUrl !== 'string' || spec.structureUrl === '') throw new Error('structureUrl must be a non-empty string')
            clean.structureUrl = spec.structureUrl
        }
        clean.groups = validateGroups(spec.groups)
        if (spec.view !== undefined) {
            const v = spec.view
            if (typeof v.yaw !== 'number' || typeof v.pitch !== 'number') throw new Error('view needs numeric yaw and pitch')
            clean.view = { yaw: v.yaw, pitch: v.pitch }
            if (typeof v.zoom === 'number') clean.view.zoom = v.zoom
            if (typeof v.roll === 'number') clean.view.roll = v.roll
            if (Array.isArray(v.target) && v.target.length === 3 && v.target.every((n) => typeof n === 'number')) {
                clean.view.target = [...v.target]
            }
        } else if (spec.focus !== undefined) {
            clean.focus = residueRef(spec.focus, 'focus')
            if (typeof spec.focus.radius === 'number') clean.focus.radius = spec.focus.radius
        }
        if (spec.labels !== undefined) clean.labels = validateLabels(spec.labels)
        if (spec.hbonds !== undefined) clean.hbonds = validatePairs(spec.hbonds)
        panels.set(id, clean)
        logger.info?.(`mol-structure: panel "${id}" defined (${panels.size} custom)`)
        return clean
    }

    function remove(id) {
        return panels.delete(String(id))
    }

    function list() {
        return [...panels.values()]
    }

    function has(id) {
        return panels.has(String(id))
    }

    function get(id) {
        return panels.get(String(id))
    }

    return { define, remove, list, has, get }
}
