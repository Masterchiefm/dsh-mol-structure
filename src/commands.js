/**
 * Viewer-side implementations of the bridge command set.
 *
 * The dsh plugin's agent tools submit {op, args} commands; the bridge SSE
 * delivers them here. Two families:
 * - paper panels: `figure`/`figures` reuse the calibrated figure configs;
 * - generic structure work (`load`/`scene`/`camera`/`labels`/`hbonds`/
 *   `measure`/`select`/`query`): the same primitives scenes.js uses, but with
 *   anchors computed from the coordinates instead of pre-generated files, so
 *   they work on any loaded structure.
 *
 * Every handler returns a JSON-serializable value; the bridge POSTs it back
 * to the host as the tool result.
 */
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder.js';
import { Color } from 'molstar/lib/mol-util/color/index.js';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra/3d/vec3.js';
import { StructureElement } from 'molstar/lib/mol-model/structure/structure/element.js';
import { StructureProperties } from 'molstar/lib/mol-model/structure/structure/properties.js';
import { MoleculeType } from 'molstar/lib/mol-model/structure/model/types.js';
import { canonicalLoci, trajectoryFormat } from './scenes.js';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra/3d/mat4.js';

const AMP = MS.struct.atomProperty.macromolecular;

const chainTest = (chain) => MS.core.set.has([MS.set(chain), AMP.auth_asym_id()]);

const REPRS = ['cartoon', 'molecular-surface', 'ball-and-stick', 'pipe-and-planks', 'gaussian-surface', 'line', 'point'];

function hexOrNull(value) {
    return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : null;
}

function residuesExpr(chain, seqs) {
    return MS.struct.generator.atomGroups({
        'chain-test': chainTest(chain),
        'residue-test': seqs.length === 1
            ? MS.core.rel.eq([AMP.auth_seq_id(), seqs[0]])
            : MS.core.set.has([MS.set(...seqs), AMP.auth_seq_id()]),
    });
}

// --- shared primitives (also used by generic ops) ----------------------------

function requireStructure(ctx) {
    if (!ctx.structure || !ctx.structure.obj || !ctx.structure.obj.data) {
        // Lazy rebind: a state-snapshot restore replaces the tree asynchronously;
        // pick the first structure the hierarchy knows about.
        const structures = ctx.plugin.managers?.structure?.hierarchy?.current?.structures ?? [];
        const cell = structures[0]?.cell;
        if (cell?.obj?.data) {
            ctx.setStructure(cell, null);
            return ctx.structure;
        }
        throw new Error('no structure loaded — call mol_load or mol_figure first');
    }
    return ctx.structure;
}

async function residueLociOf(ctx, chain, seq) {
    const structure = requireStructure(ctx);
    const { compile } = await import('molstar/lib/mol-script/runtime/query/base.js');
    const { QueryContext } = await import('molstar/lib/mol-model/structure/query/context.js');
    const { StructureSelection } = await import('molstar/lib/mol-model/structure/query/selection.js');
    const query = compile(residuesExpr(chain, [seq]));
    const sel = query(new QueryContext(structure.obj.data));
    return canonicalLoci(StructureSelection.toLociWithCurrentUnits(sel));
}

/** World-space centroid of one residue (auth chain + seq). */
async function residueCentroid(ctx, chain, seq) {
    const loci = await residueLociOf(ctx, chain, seq);
    if (StructureElement.Loci.isEmpty(loci)) throw new Error(`residue ${chain}/${seq} not found`);
    const { sphere } = StructureElement.Loci.getBoundary(loci);
    return [sphere.center[0], sphere.center[1], sphere.center[2]];
}

function lociIsEmpty(loci) {
    return !loci || loci.kind !== 'element-loci' || StructureElement.Loci.isEmpty(loci);
}

/** Describe a StructureElement.Loci as a compact residue list (model-facing). */
function describeElementLoci(loci, limit = 30) {
    if (lociIsEmpty(loci)) return { atoms: 0, residues: [], truncated: false };
    const seen = new Map();
    let atoms = 0;
    let truncated = false;
    const push = (l) => {
        atoms++;
        if (atoms > 4000) { truncated = true; return; }
        const chain = StructureProperties.chain.auth_asym_id(l);
        const seq = StructureProperties.residue.auth_seq_id(l);
        const comp = StructureProperties.residue.label_comp_id(l);
        const key = `${chain}/${seq}`;
        if (!seen.has(key)) {
            if (seen.size >= limit) { truncated = true; return; }
            seen.set(key, { chain, seq, comp });
        }
    };
    StructureElement.Loci.forEachLocation(loci, push);
    return { atoms, residues: [...seen.values()], truncated };
}

// --- shared state-tree helpers -------------------------------------------------

/** The StateObjectCell of the currently loaded structure (hierarchy manager). */
function structureCell(ctx) {
    const structures = ctx.plugin.managers?.structure?.hierarchy?.current?.structures ?? [];
    for (const s of structures) {
        if (s?.cell?.obj?.data === ctx.structure.obj.data) return s.cell;
    }
    // Fall back to the first structure cell when identity was rebuilt (stateLoad).
    for (const s of structures) {
        if (s?.cell?.obj?.data) return s.cell;
    }
    throw new Error('structure cell not found in the state tree');
}

/** Remove every state cell carrying a tag (agent-style representations etc.). */
async function removeTagged(ctx, tag) {
    const { StateSelection, StateTransform } = await import('molstar/lib/mol-state/index.js');
    const state = ctx.plugin.state.data;
    let removed = 0;
    for (;;) {
        const ref = StateSelection.findTagInSubtree(state.tree, StateTransform.RootRef, tag);
        if (!ref) break;
        await state.build().delete(ref).commit();
        removed++;
    }
    return removed;
}

/** Cα (or first-atom) coordinate tables for two chains, paired by residue ordinal. */
function caTablesOfChains(ctx, chainA, chainB) {
    const structure = requireStructure(ctx).obj.data;
    const model = structure.models[0];
    const h = model.atomicHierarchy;
    const pos = model.atomicConformation;
    const atomName = h.atoms.label_atom_id;
    const resOf = (chain) => {
        const out = [];
        for (let cI = 0; cI < h.chains._rowCount; cI++) {
            if (h.chains.auth_asym_id.value(cI) !== chain) continue;
            const firstRes = h.residueAtomSegments.index[h.chainAtomSegments.offsets[cI]];
            const lastRes = h.residueAtomSegments.index[h.chainAtomSegments.offsets[cI + 1] - 1];
            for (let r = firstRes; r <= lastRes; r++) {
                const a0 = h.residueAtomSegments.offsets[r];
                const a1 = h.residueAtomSegments.offsets[r + 1];
                let pick = a0;
                for (let a = a0; a < a1; a++) {
                    if (atomName.value(a) === 'CA') { pick = a; break; }
                }
                if (a1 > a0) out.push(pick);
            }
        }
        return out;
    };
    const caA = resOf(chainA);
    const caB = resOf(chainB);
    const n = Math.min(caA.length, caB.length);
    if (!n) throw new Error(`no alignable residues — chain ${chainA}: ${caA.length}, chain ${chainB}: ${caB.length}`);
    const a = { x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
    const b = { x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
    for (let i = 0; i < n; i++) {
        a.x[i] = pos.x[caA[i]]; a.y[i] = pos.y[caA[i]]; a.z[i] = pos.z[caA[i]];
        b.x[i] = pos.x[caB[i]]; b.y[i] = pos.y[caB[i]]; b.z[i] = pos.z[caB[i]];
    }
    return { a, b, n };
}

// --- camera -------------------------------------------------------------------

function structureRadius(ctx) {
    // Compute the bounding sphere from raw coordinates: Mol*'s Loci boundary
    // returned an implausible radius (≈254 Å for a 110 Å complex), which made
    // every focus multiplier land back at the whole-structure view.
    try {
        const model = ctx.structure?.obj?.data?.models?.[0];
        const pos = model?.atomicConformation;
        // atomicConformation has x/y/z only (no elementCount) — fall back to the
        // coordinate array length, then the atoms table row count.
        const n = pos?.elementCount ?? pos?.x?.length ?? model?.atomicHierarchy?.atoms?._rowCount ?? 0;
        if (n > 0) {
            let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
            for (let i = 0; i < n; i++) {
                const x = pos.x[i], y = pos.y[i], z = pos.z[i];
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
                if (z < z0) z0 = z; if (z > z1) z1 = z;
            }
            return Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2;
        }
    } catch { /* fall through */ }
    try {
        if (ctx.structure?.obj?.data) {
            return StructureElement.Loci.getBoundary(StructureElement.Loci.all(ctx.structure.obj.data)).sphere.radius;
        }
    } catch { /* ignore */ }
    return 60;
}

function focusOn(ctx, target, radiusScale) {
    const plugin = ctx.plugin;
    const cam = plugin.canvas3d.camera;
    const scale = radiusScale ?? 1.6;
    // The orbit path is the one proven to zoom: zoom = 1/scale (0.3 → 3.3×,
    // 1.6 → 0.6×), with the target moved onto the residue.
    const zoom = Math.max(1 / Math.max(scale, 0.05), 0.1);
    const st = cam.state;
    const dx = st.position[0] - st.target[0];
    const dy = st.position[1] - st.target[1];
    const dz = st.position[2] - st.target[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const yawDeg = Math.atan2(dx / len, dz / len) * 180 / Math.PI;
    const pitchDeg = Math.asin(Math.max(-1, Math.min(1, dy / len))) * 180 / Math.PI;
    ctx.applyView({ yaw: yawDeg, pitch: pitchDeg, zoom, target: [target[0], target[1], target[2]] }, null);
    // Pin the focus point: an empty click must not snap back to the default center.
    ctx.setCameraPin?.([target[0], target[1], target[2]]);
    plugin.canvas3d.requestDraw();
}

// --- ops -----------------------------------------------------------------------

/** Map a filename to a Mol* data-format id + binary flag (null = sniff). */
function formatFromName(name) {
    const n = String(name || '').toLowerCase().split('?')[0];
    const map = [
        [/\.(cif|mmcif|mcif)$/, 'mmcif', false],
        [/\.bcif$/, 'mmcif', true],
        [/\.(pdb|ent)$/, 'pdb', false],
        [/\.pdbqt$/, 'pdbqt', false],
        [/\.pqr$/, 'pqr', false],
        [/\.gro$/, 'gro', false],
        [/\.xyz$/, 'xyz', false],
        [/\.mol$/, 'mol', false],
        [/\.(sdf|sd)$/, 'sdf', false],
        [/\.mol2$/, 'mol2', false],
    ];
    for (const [re, fmt, bin] of map) {
        if (re.test(n)) return { format: fmt, isBinary: bin };
    }
    return null;
}

const ops = {
    /** List built-in paper panels plus runtime-registered custom panels. */
    figures(ctx) {
        return {
            current: ctx.currentFigure,
            status: ctx.status(),
            figures: [
                ...Object.entries(ctx.FIGURES).map(([id, fig]) => ({ id, title: fig.title, paper: fig.paperId })),
                ...(ctx.customPanels ? [...ctx.customPanels.values()].map((p) => ({ id: p.id, title: p.title, custom: true })) : []),
            ],
        };
    },

    /** Apply viewer UI preferences pushed by the Host (Settings → General). */
    ui(ctx, { controlCard } = {}) {
        if (controlCard !== undefined) {
            if (typeof ctx.applyControlCardMode !== 'function') throw new Error('controlCard UI unavailable in this build');
            ctx.applyControlCardMode(controlCard);
        }
        return { ok: true };
    },

    /** Apply a panel by id: built-in paper figures plus runtime-registered custom panels. */
    async figure(ctx, { id }) {
        if (!id) throw new Error(`figure id required — built-in: ${Object.keys(ctx.FIGURES).join(', ')}; custom panels add more`);
        if (ctx.FIGURES[id]) {
            await ctx.applyFigure(id);
            return { ok: true, figure: id, status: ctx.status() };
        }
        const custom = ctx.customPanels?.get(id);
        if (!custom) {
            const customIds = ctx.customPanels ? [...ctx.customPanels.keys()].join(', ') : '';
            throw new Error(`unknown figure "${id}" — built-in: ${Object.keys(ctx.FIGURES).join(', ')}${customIds ? `; custom: ${customIds}` : ''}`);
        }
        // Action panels are control macros, not scenes: run their op chain.
        if (custom.kind === 'action') {
            const results = [];
            for (const step of custom.actions ?? []) {
                results.push({ label: step.label, op: step.op, result: await ops[step.op]?.(ctx, step.args ?? {}) ?? null });
            }
            return { ok: true, figure: id, kind: 'action', results, status: ctx.status() };
        }
        await applyPanelSpec(ctx, custom);
        ctx.setActive?.(id);
        return { ok: true, figure: id, custom: true, status: ctx.status() };
    },

    /**
     * Load a structure from a one-shot host URL (agent-supplied local path or
     * plugin-bundled file). Renders a plain polymer cartoon until a scene op
     * replaces it.
     */
    async load(ctx, { url, name, color }) {
        if (!url) throw new Error('missing url (issued by the mol_load tool)');
        const plugin = ctx.plugin;
        await plugin.clear(false);
        const fmt = formatFromName(name) ?? formatFromName(url);
        const data = await plugin.builders.data.download(
            { url, isBinary: fmt?.isBinary ?? false }, { key: 'structure' },
        );
        // Token URLs (/load/fN) carry no extension, and the replayed name may be
        // a token id rather than the real filename — sniff the payload itself
        // (same helper the scene builder uses).
        const trajectory = await plugin.builders.structure.parseTrajectory(
            data, fmt?.format ?? trajectoryFormat(url, data),
        );
        const model = await plugin.builders.structure.createModel(trajectory);
        const structure = await plugin.builders.structure.createStructure(model, { name: 'model', params: {} });
        ctx.setStructure(structure, url); // also update structureUrl, or scene/measure ops rebuild the PREVIOUS structure
        // plain readable base scene (cartoon only draws the polymer anyway)
        const baseColor = typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#8FB3D9';
        const comp = await plugin.builders.structure.tryCreateComponentFromExpression(
            structure,
            MS.struct.generator.all(),
            'structure-all',
            { label: 'Structure' },
        );
        if (comp) {
            await plugin.builders.structure.representation.addRepresentation(comp, {
                type: 'cartoon',
                type_params: { quality: 'high' },
                color: 'uniform',
                colorParams: { value: Color.fromHexStyle(baseColor) },
            }, { tag: 'polymer' });
        }
        ctx.currentFigure = null;
        ctx.labels.set([]);
        ctx.reportStatus({ figure: `${name || 'structure'} · 原始结构`, panel: null });
        // Auto-fit: frame the whole structure after Mol* settles its own
        // auto-focus (same delayed re-apply the paper views need). The timers
        // must no-op once another scene build cleared the canvas — a camera
        // setState on a disposed tree corrupts the following ops.
        const loaded = structure;
        const refit = () => {
            // Yield while another scene builds: a camera setState inside an
            // open state transaction corrupts it ("reading 'ref'").
            if (ctx.structure !== loaded || ctx.sceneBuilding) return;
            try { ctx.applyView({ yaw: 250, pitch: 12, zoom: 1 }); } catch { /* canvas replaced mid-timer */ }
        };
        refit();
        setTimeout(refit, 400);
        setTimeout(refit, 800);
        return { ok: true, structure: name || 'structure', inventory: await ops.query(ctx, { mode: 'chains' }) };
    },

    /** Build a custom scene: groups of {chain, ranges|residues|comp, repr, color}. */
    async scene(ctx, { structureUrl, groups }) {
        const url = structureUrl || ctx.structureUrl;
        if (!url) throw new Error('no structure loaded — pass structureUrl or call mol_load/mol_figure first');
        const cfg = {
            structureUrl: url,
            groups: (groups || []).map((g) => ({
                ...g,
                kind: g.kind ?? (g.comp !== undefined ? 'het' : g.residues !== undefined ? 'residues' : 'ranges'),
            })),
        };
        const structure = await ctx.buildSceneGeneric(cfg);
        ctx.setStructure(structure, url);
        ctx.currentFigure = null;
        // Name the view after the actual structure, not an internal panel id.
        const structName = decodeURIComponent(url).split('/').pop() || 'structure';
        ctx.reportStatus({ figure: `${structName} · 自定义视图`, panel: null });
        return { ok: true, groups: (groups || []).length, figure: `${structName} · 自定义视图`, status: ctx.status() };
    },

    /** Camera: absolute orbit pose, focus on a residue, or relative rotation. */
    async camera(ctx, args) {
        return applyCamera(ctx, args);
    },

    /** Apply a registered custom panel spec (scene + camera + labels + hbonds macro). */
    async panelApply(ctx, spec) {
        return applyPanelSpec(ctx, spec);
    },

    /** Set HTML labels; anchors: anchorKey (paper panels), chain+seq, or xyz. */
    async labels(ctx, args) {
        if (args.clear) {
            ctx.labels.set([]);
            return { ok: true, cleared: true };
        }
        return applyLabels(ctx, Array.isArray(args.labels) ? args.labels : []);
    },

    /** Distance lines between residue pairs (H-bond / contact annotation). */
    async hbonds(ctx, args) {
        if (args.clear) {
            const { StateSelection, StateTransform } = await import('molstar/lib/mol-state/index.js');
            const state = ctx.plugin.state.data;
            // the measurement manager keeps every cell under one tagged group
            const groupRef = StateSelection.findTagInSubtree(state.tree, StateTransform.RootRef, 'measurement-group');
            if (groupRef) {
                await state.build().delete(groupRef).commit();
            }
            return { ok: true, cleared: true };
        }
        const pairs = Array.isArray(args.pairs) ? args.pairs : [];
        if (pairs.length === 0) throw new Error('pairs required: [{a:{chain,seq}, b:{chain,seq}}, …]');
        const added = [];
        for (const p of pairs) {
            if (!p?.a?.chain || !p?.b?.chain) throw new Error('each pair needs a:{chain,seq} and b:{chain,seq}');
            const lociA = await residueLociOf(ctx, p.a.chain, p.a.seq ?? 0);
            const lociB = await residueLociOf(ctx, p.b.chain, p.b.seq ?? 0);
            if (lociIsEmpty(lociA) || lociIsEmpty(lociB)) {
                added.push({ ...p, ok: false, error: 'residue not found' });
                continue;
            }
            await ctx.plugin.managers.structure.measurement.addDistance(lociA, lociB, {
                customText: ' ',
                visualParams: {
                    visuals: ['lines'],
                    textColor: Color.fromHexStyle(p.color || '#4FC3F7'),
                    textSize: 0.01,
                    borderWidth: 0,
                    unitLabel: '',
                },
                lineParams: { lineSize: 1.5 },
            });
            added.push({ ...p, ok: true });
        }
        return { ok: added.some((x) => x.ok), pairs: added };
    },

    /** Centroid distance between two residues (analysis, no drawing). */
    async measure(ctx, args) {
        for (const key of ['a', 'b']) {
            if (!args[key]?.chain) throw new Error(`missing ${key} {chain, seq}`);
        }
        const [ca, cb] = await Promise.all([
            residueCentroid(ctx, args.a.chain, args.a.seq ?? 0),
            residueCentroid(ctx, args.b.chain, args.b.seq ?? 0),
        ]);
        const d = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
        return { distance: Number(d.toFixed(2)), unit: 'Å', note: 'residue-centroid distance' };
    },

    /** Set / clear / report the Mol* selection (also mirrors user clicks). */
    async select(ctx, args) {
        const manager = ctx.plugin.managers.structure.selection;
        if (args.clear) {
            manager.clear();
            return { ok: true, cleared: true };
        }
        if (args.chain !== undefined) {
            const seqs = Array.isArray(args.seqs) && args.seqs.length ? args.seqs : null;
            const structure = requireStructure(ctx);
            const { compile } = await import('molstar/lib/mol-script/runtime/query/base.js');
            const { QueryContext } = await import('molstar/lib/mol-model/structure/query/context.js');
            const { StructureSelection } = await import('molstar/lib/mol-model/structure/query/selection.js');
            const expr = seqs
                ? residuesExpr(args.chain, seqs)
                : MS.struct.generator.atomGroups({ 'chain-test': chainTest(args.chain) });
            const sel = compile(expr)(new QueryContext(structure.obj.data));
            const loci = canonicalLoci(StructureSelection.toLociWithCurrentUnits(sel));
            if (lociIsEmpty(loci)) throw new Error(`selection empty (chain ${args.chain}${seqs ? ' seqs ' + seqs.join(',') : ''})`);
            ctx.markAgentSelection();
            manager.fromLoci('set', loci);
            const described = describeElementLoci(loci);
            ctx.reportSelection({ source: 'agent', kind: 'select', text: described.residues.map((r) => `${r.chain}/${r.seq} ${r.comp}`).join(', '), ...described });
            return { ok: true, ...described, source: 'agent' };
        }
        const current = ctx.readSelection();
        return { ...current, note: 'no chain given — reporting the current selection' };
    },

    /** Analysis queries that do not change the scene. */
    async query(ctx, args) {
        const structure = requireStructure(ctx);
        const data = structure.obj.data;
        if (args.mode === 'chains' || args.mode === undefined) {
            const chains = [];
            for (const model of data.models) {
                const h = model.atomicHierarchy;
                const nC = h.chains._rowCount;
                for (let cI = 0; cI < nC; cI++) {
                    const start = h.residueAtomSegments.index[h.chainAtomSegments.offsets[cI]];
                    const endExcl = h.residueAtomSegments.index[h.chainAtomSegments.offsets[cI + 1] - 1] + 1;
                    const mid = (start + endExcl) >> 1;
                    const molType = MoleculeType[model.atomicHierarchy.derived.residue.moleculeType[mid]];
                    chains.push({
                        chain: h.chains.auth_asym_id.value(cI),
                        labelChain: h.chains.label_asym_id.value(cI),
                        entity: h.chains.label_entity_id.value(cI),
                        moleculeType: molType,
                        residues: endExcl - start,
                        seqRange: [h.residues.auth_seq_id.value(start), h.residues.auth_seq_id.value(endExcl - 1)],
                    });
                }
            }
            return { mode: 'chains', chains };
        }
        if (args.mode === 'radius') {
            const { chain, seq, radius } = args;
            if (chain === undefined) throw new Error('radius query needs center {chain, seq}');
            const { compile } = await import('molstar/lib/mol-script/runtime/query/base.js');
            const { QueryContext } = await import('molstar/lib/mol-model/structure/query/context.js');
            const { StructureSelection } = await import('molstar/lib/mol-model/structure/query/selection.js');
            const expr = MS.struct.filter.within({
                0: MS.struct.generator.atomGroups({}),
                target: residuesExpr(chain, [seq ?? 0]),
                'max-radius': radius ?? 5,
            });
            const sel = compile(expr)(new QueryContext(data));
            const loci = canonicalLoci(StructureSelection.toLociWithCurrentUnits(sel));
            return {
                mode: 'radius',
                center: { chain, seq: seq ?? 0 },
                radius: radius ?? 5,
                ...describeElementLoci(loci, 40),
            };
        }
        throw new Error(`unknown query mode "${args.mode}" (chains | radius)`);
    },

    /**
     * Pairwise chain-interface analysis: per-residue heavy-atom contact counts
     * (< cutoff, default 4.5 Å) and the closest polar residue pairs
     * (< polarCutoff, default 3.6 Å). Feeds the host's auto-registered
     * "界面 X–Y 特写" panels — no scene change.
     */
    async interfaces(ctx, args = {}) {
        const structure = requireStructure(ctx);
        const model = structure.obj.data.models[0];
        const pos = model.atomicConformation; // { x, y, z, elementCount }
        const h = model.atomicHierarchy;
        const cutoff = typeof args.cutoff === 'number' ? args.cutoff : 4.5;
        const polarCutoff = typeof args.polarCutoff === 'number' ? args.polarCutoff : 3.6;
        const c2 = cutoff * cutoff;
        const p2 = polarCutoff * polarCutoff;

        const residues = [];
        // Atoms carry label_comp_id only; chain/seq live on chains/residues —
        // map residue → chain through the segment offsets (atoms.auth_asym_id
        // does not exist on AtomicHierarchy).
        for (let cI = 0; cI < h.chains._rowCount; cI++) {
            const firstRes = h.residueAtomSegments.index[h.chainAtomSegments.offsets[cI]];
            const lastRes = h.residueAtomSegments.index[h.chainAtomSegments.offsets[cI + 1] - 1];
            const chain = h.chains.auth_asym_id.value(cI);
            for (let r = firstRes; r <= lastRes; r++) {
                const a0 = h.residueAtomSegments.offsets[r];
                const a1 = h.residueAtomSegments.offsets[r + 1];
                if (a1 - a0 <= 0) continue;
                residues.push({
                    a0, a1,
                    chain,
                    seq: h.residues.auth_seq_id.value(r),
                    comp: h.atoms.label_comp_id.value(a0),
                });
            }
        }
        const byChain = new Map();
        for (const res of residues) {
            if (!byChain.has(res.chain)) byChain.set(res.chain, []);
            byChain.get(res.chain).push(res);
        }

        const chains = [...byChain.keys()];
        const pairs = [];
        for (let i = 0; i < chains.length; i++) {
            for (let j = i + 1; j < chains.length; j++) {
                const sideA = byChain.get(chains[i]);
                const sideB = byChain.get(chains[j]);
                const stats = new Map(); // `${chain}/${seq}` → { chain, seq, comp, contacts, min }
                const bump = (res, contacts, min) => {
                    const key = `${res.chain}/${res.seq}`;
                    const cur = stats.get(key) || { chain: res.chain, seq: res.seq, comp: res.comp, contacts: 0, min: Infinity };
                    cur.contacts += contacts;
                    if (min < cur.min) cur.min = min;
                    stats.set(key, cur);
                };
                const closest = []; // per residue pair with min distance < polarCutoff
                for (const ra of sideA) {
                    for (const rb of sideB) {
                        let contacts = 0;
                        let min = Infinity;
                        for (let ai = ra.a0; ai < ra.a1; ai++) {
                            const ax = pos.x[ai], ay = pos.y[ai], az = pos.z[ai];
                            for (let bi = rb.a0; bi < rb.a1; bi++) {
                                const dx = ax - pos.x[bi], dy = ay - pos.y[bi], dz = az - pos.z[bi];
                                const d2 = dx * dx + dy * dy + dz * dz;
                                if (d2 < c2) contacts++;
                                if (d2 < min) min = d2;
                            }
                        }
                        if (contacts > 0) {
                            bump(ra, contacts, Math.sqrt(min));
                            bump(rb, contacts, Math.sqrt(min));
                            if (min < p2) closest.push({ a: ra, b: rb, dist: Math.sqrt(min) });
                        }
                    }
                }
                if (stats.size === 0) continue;
                const list = [...stats.values()].sort((l, r) => r.contacts - l.contacts);
                pairs.push({
                    a: chains[i],
                    b: chains[j],
                    residues: list.slice(0, 80).map(({ chain, seq, comp, contacts, min }) =>
                        ({ chain, seq, comp, contacts, minDist: Number(min.toFixed(2)) })),
                    polar: closest
                        .sort((l, r) => l.dist - r.dist)
                        .slice(0, 14)
                        .map(({ a, b, dist }) => ({ a: { chain: a.chain, seq: a.seq }, b: { chain: b.chain, seq: b.seq }, dist: Number(dist.toFixed(2)) })),
                });
            }
        }
        pairs.sort((l, r) => r.residues.length - l.residues.length);
        return { mode: 'interfaces', cutoff, polarCutoff, pairs };
    },

    /** Capture the WebGL canvas; the host saves the PNG and returns a path. */
    async screenshot(ctx) {
        const helper = ctx.plugin.helpers.viewportScreenshot;
        if (!helper) throw new Error('screenshot helper unavailable');
        // Hidden sidebar tab ⇒ the iframe layout collapses and the WebGL
        // drawing buffer drops to 0×0; Mol* then throws "empty textures are
        // not allowed" creating the capture render target (or toDataURL gives
        // a 1×1 PNG). Loan the buffer a fixed offscreen size for the capture;
        // the CSS layout restores the real size once the tab is visible again.
        const c3d = ctx.plugin.canvas3d;
        const gl = c3d.webgl.gl;
        const resized = (gl.drawingBufferWidth || 0) < 32 || (gl.drawingBufferHeight || 0) < 32;
        if (resized) {
            const ratio = c3d.webgl.pixelRatio || 1;
            gl.canvas.width = Math.round(1600 * ratio);
            gl.canvas.height = Math.round(1000 * ratio);
        }
        try {
            // Background tabs freeze rAF: requestDraw only sets a flag for the rAF
            // loop, so force one synchronous frame before reading the canvas.
            // Use the raw tick — the instance wrapper skips ticks on a 0×0
            // (hidden-tab) canvas, but we just loaned it an offscreen size.
            const tick = c3d.__rawTick ?? c3d.tick.bind(c3d);
            try { tick(performance.now(), { isSynchronous: true }); } catch { /* already drawing */ }
            await new Promise((r) => setTimeout(r, 120));
            const dataUrl = await helper.getImageDataUri();
            if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) {
                throw new Error('canvas capture failed');
            }
            return { __screenshotDataUrl: dataUrl };
        } finally {
            if (resized) {
                gl.canvas.width = 1;
                gl.canvas.height = 1;
                try { c3d.requestDraw(); } catch { /* pane hidden; layout will fix */ }
            }
        }
    },

    /**
     * Add a styled representation for a selection on the CURRENT structure
     * without rebuilding the scene (Mol* component + representation path).
     * Selection: chain + optional seqs, optional comp (ligand id); a previous
     * agent-style layer with the same tag is replaced.
     */
    async style(ctx, args) {
        const structure = requireStructure(ctx);
        const { chain, seqs, comp } = args;
        if (chain === undefined && comp === undefined) {
            throw new Error('style needs chain and/or comp (e.g. {chain:"A", seqs:[61]} or {comp:"MG"})');
        }
        const tests = {};
        if (chain !== undefined) tests['chain-test'] = chainTest(chain);
        if (comp !== undefined) {
            tests['residue-test'] = MS.core.set.has([MS.set(comp), AMP.label_comp_id()]);
        } else if (Array.isArray(seqs) && seqs.length) {
            tests['residue-test'] = seqs.length === 1
                ? MS.core.rel.eq([AMP.auth_seq_id(), seqs[0]])
                : MS.core.set.has([MS.set(...seqs), AMP.auth_seq_id()]);
        }
        const expr = MS.struct.generator.atomGroups(tests);
        const tag = typeof args.tag === 'string' && args.tag ? args.tag : 'agent-style';
        await removeTagged(ctx, tag);
        const structureCellRef = structureCell(ctx);
        const label = args.label || `style ${comp ?? ''}${chain ?? ''}`.trim();
        const component = await ctx.plugin.builders.structure.tryCreateComponentFromExpression(
            structureCellRef, expr, tag, { label },
        );
        if (!component) throw new Error('empty selection — nothing to style');
        const repr = REPRS.includes(args.repr) ? args.repr : 'cartoon';
        const color = hexOrNull(args.color) ?? '#3E97DE';
        const typeParams = { quality: 'high' };
        const so = await ctx.plugin.builders.structure.representation.addRepresentation(component, {
            type: repr,
            type_params: typeParams,
            color: 'uniform',
            colorParams: { value: Color.fromHexStyle(color) },
        }, { tag });
        if (typeof args.alpha === 'number') {
            // SO data = { repr, sourceData } — alphaFactor lives on repr.state.
            const repr = so?.data?.repr ?? so?.data;
            repr?.setState?.({ alphaFactor: Math.max(0.01, Math.min(1, args.alpha)) });
        }
        let focused = null;
        if (args.focus) {
            const loci = await residueLociOf(ctx, chain, seqs?.[0] ?? 0);
            ctx.plugin.managers.structure.focus.setFromLoci(loci);
            focused = true;
        }
        return { ok: true, tag, repr, color, focused, note: 'layer replaces any previous one with the same tag' };
    },

    /** Focus manager: ball-and-stick close-up + non-covalent interaction circles. */
    async focus(ctx, args) {
        if (args.clear) {
            ctx.plugin.managers.structure.focus.clear();
            return { ok: true, cleared: true };
        }
        const chain = args.chain;
        if (chain === undefined) throw new Error('focus needs {chain, seq} (or clear: true)');
        const loci = await residueLociOf(ctx, chain, args.seq ?? 0);
        if (lociIsEmpty(loci)) throw new Error(`residue ${chain}/${args.seq ?? 0} not found`);
        ctx.plugin.managers.structure.focus.setFromLoci(loci);
        return { ok: true, focus: { chain, seq: args.seq ?? 0 }, ...describeElementLoci(loci, 5) };
    },

    /** Least-squares superposition of chain B onto chain A (Cα, ordinal pairing). */
    async align(ctx, args) {
        if (!args?.a?.chain || !args?.b?.chain) throw new Error('align needs a:{chain} and b:{chain}');
        const { MinimizeRmsd } = await import('molstar/lib/mol-math/linear-algebra/3d/minimize-rmsd.js');
        const { a, b, n } = caTablesOfChains(ctx, args.a.chain, args.b.chain);
        const result = MinimizeRmsd.compute({ a, b });
        const matrix = Mat4.toArray(result.bTransform, new Array(16), 0);
        let applied = false;
        if (args.apply) {
            const { TransformStructureConformation } = await import('molstar/lib/mol-plugin-state/transforms/model.js');
            const cell = structureCell(ctx);
            const build = ctx.plugin.state.data.build();
            build.to(cell).insert(TransformStructureConformation, {
                transform: { name: 'matrix', params: { matrix: result.bTransform } },
            });
            await build.commit();
            applied = true;
        }
        return {
            ok: true,
            a: args.a.chain, b: args.b.chain,
            aligned: n,
            rmsd: Number(result.rmsd.toFixed(3)),
            matrix,
            applied,
            note: applied
                ? 'chain B transformed onto chain A in the scene'
                : 'matrix maps chain B onto chain A (apply: true to transform the scene)',
        };
    },

    /** wwPDB struct_conn records (mmCIF): list deposited connections, show one. */
    async structconn(ctx, args = {}) {
        const { wwPDBStructConnExtensionFunctions: ext } =
            await import('molstar/lib/extensions/wwpdb/struct-conn/index.js');
        if (args.action === 'clear') {
            await ext.clearStructConnInspections(ctx.plugin, undefined);
            return { ok: true, cleared: true };
        }
        if (args.action === 'show') {
            if (!args.id) throw new Error('show needs the struct_conn id (see action=list)');
            const atoms = await ext.inspectStructConn(ctx.plugin, undefined, args.id);
            return { ok: true, id: args.id, atomsShown: atoms };
        }
        const conns = ext.getStructConns(ctx.plugin, undefined);
        // Mol* StructConnRecord: { id, distance, partner1, partner2 } where each
        // partner is { asymId, seqId, authSeqId, insCode, compId, atomId, altId }.
        const partnerInfo = (p, i) => ({
            role: `partner${i + 1}`,
            chain: p?.asymId ?? undefined,
            authSeq: p?.authSeqId ?? undefined,
            seq: p?.seqId ?? undefined,
            comp: p?.compId ?? undefined,
            atom: p?.atomId ?? undefined,
            insCode: p?.insCode || undefined,
        });
        const list = Object.entries(conns).map(([id, info]) => ({
            id,
            distance: info?.distance !== undefined ? Number(info.distance.toFixed(2)) : undefined,
            partners: [partnerInfo(info?.partner1, 0), partnerInfo(info?.partner2, 1)],
        }));
        return { ok: true, count: list.length, connections: list };
    },

    /** Canvas3D settings (PluginCommands path): background colour for now. */
    async canvas(ctx, args = {}) {
        const { PluginCommands } = await import('molstar/lib/mol-plugin/commands.js');
        const applied = {};
        if (args.backgroundColor !== undefined) {
            const named = { white: '#ffffff', black: '#000000', gray: '#808080', grey: '#808080', light: '#f4f4f4', dark: '#101014' };
            const hex = hexOrNull(args.backgroundColor) ?? hexOrNull(named[String(args.backgroundColor).toLowerCase()]);
            if (hex === null) throw new Error('backgroundColor must be a hex colour or white/black/gray/light/dark');
            await PluginCommands.Canvas3D.SetSettings(ctx.plugin, {
                settings: { renderer: { backgroundColor: Color.fromHexStyle(hex) } },
            });
            applied.backgroundColor = hex;
        }
        if (!Object.keys(applied).length) {
            throw new Error('nothing to do — pass backgroundColor: "#RRGGBB"');
        }
        ctx.plugin.canvas3d.requestDraw();
        return { ok: true, ...applied };
    },

    /** Show a toast in the viewer viewport (agent-visible messaging surface). */
    async toast(ctx, args = {}) {
        const { PluginCommands } = await import('molstar/lib/mol-plugin/commands.js');
        if (!args.message && !args.title) throw new Error('toast needs message (and/or title)');
        const key = typeof args.key === 'string' && args.key ? args.key : `agent-toast-${Date.now()}`;
        await PluginCommands.Toast.Show(ctx.plugin, {
            title: args.title ?? 'Agent',
            message: String(args.message),
            key,
            timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : 8000,
        });
        return { ok: true, key };
    },

    /** Serializable full state snapshot (save) / restore (load). */
    async stateSave(ctx) {
        const snapshot = ctx.plugin.state.data.getSnapshot();
        return { ok: true, snapshot };
    },

    async stateLoad(ctx, args) {
        if (!args?.snapshot || typeof args.snapshot !== 'object') throw new Error('snapshot required');
        await ctx.plugin.state.data.setSnapshot(args.snapshot);
        // Rebind the generic-op structure after the tree was replaced. The
        // hierarchy manager settles asynchronously after setSnapshot — retry.
        let rebound = false;
        for (let i = 0; i < 10 && !rebound; i++) {
            await new Promise((r) => setTimeout(r, 150));
            const structures = ctx.plugin.managers?.structure?.hierarchy?.current?.structures ?? [];
            const cell = structures[0]?.cell;
            if (cell?.obj?.data) { ctx.setStructure(cell, null); rebound = true; }
        }
        ctx.currentFigure = null;
        ctx.labels.set([]);
        ctx.reportStatus({ figure: '已恢复状态快照', panel: null });
        return { ok: true, structure: rebound ? 'restored' : null, status: ctx.status() };
    },

    /** Export the loaded structure as mmCIF text (host saves to a file). */
    async export(ctx) {
        const structure = requireStructure(ctx);
        const { CifWriter } = await import('molstar/lib/mol-io/writer/cif.js');
        const { encode_mmCIF_categories } = await import('molstar/lib/mol-model/structure/export/mmcif.js');
        const encoder = CifWriter.createEncoder();
        encoder.startDataBlock('molstar_export');
        encode_mmCIF_categories(encoder, [structure.obj.data], {});
        const text = encoder.getData();
        if (typeof text !== 'string' || text.length < 20) throw new Error('mmCIF export produced no data');
        return { __cifText: text, atoms: structure.obj.data.elementCount };
    },

    /** Switch the viewer page between simple (agent-driven) and full Mol* mode. */
    async mode(ctx, args = {}) {
        const full = Boolean(args.full);
        if (ctx.isFullMode() === full) return { ok: true, full, reloading: false };
        ctx.setFullMode(full);
        return { ok: true, full, reloading: true };
    },
};

/** Camera application shared by the camera op and panel macros. */
async function applyCamera(ctx, args = {}) {
    const { focus, rotateByDeg } = args;
    const { yaw, pitch, zoom, roll, target } = args.view ?? args;
    let focusInfo;
    if (args.focus && args.focus.chain !== undefined) {
        const target = await residueCentroid(ctx, args.focus.chain, args.focus.seq ?? 0);
        focusOn(ctx, target, args.focus.radius);
        // Mol* re-frames the camera when representations settle — a close-up
        // issued right after a scene build must be re-asserted, or it silently
        // falls back to the whole-structure view (pitfall #14).
        setTimeout(() => { if (!ctx.sceneBuilding) { try { focusOn(ctx, target, args.focus.radius); } catch { /* gone */ } } }, 500);
        setTimeout(() => { if (!ctx.sceneBuilding) { try { focusOn(ctx, target, args.focus.radius); } catch { /* gone */ } } }, 1100);
        focusInfo = { focus: args.focus };
    } else if (yaw !== undefined && pitch !== undefined) {
        ctx.applyView({ yaw, pitch, zoom: zoom ?? 1, roll: roll ?? 0, target }, null);
        focusInfo = { view: { yaw, pitch, zoom, roll, target } };
    }
    if (rotateByDeg !== undefined) {
        ctx.rotateBy(rotateByDeg);
        focusInfo = { ...focusInfo, rotatedByDeg: rotateByDeg };
    }
    if (focusInfo === undefined) throw new Error('nothing to do — pass focus {chain, seq} or view {yaw, pitch, …} or rotateByDeg');
    // Report where the camera actually ended up (debugging camera-apply issues).
    const camState = ctx.plugin.canvas3d.camera.state;
    return {
        ok: true, ...focusInfo,
        camera: {
            target: [camState.target[0], camState.target[1], camState.target[2]].map((v) => Number(v.toFixed(2))),
            radius: Number((camState.radius ?? 0).toFixed(2)),
            baseRadius: Number(structureRadius(ctx).toFixed(2)),
            build: 'cam-2',
        },
    };
}

/** Label application shared by the labels op and panel macros (anchor resolution included). */
async function applyLabels(ctx, list) {
    const spec = [];
    for (const l of list) {
        if (!l || !l.text) throw new Error('each label needs at least a text');
        let anchor = null;
        if (l.xyz) anchor = l.xyz;
        else if (l.anchorKey && ctx.anchors && ctx.anchors[l.anchorKey]) anchor = ctx.anchors[l.anchorKey];
        else if (l.chain !== undefined) anchor = await residueCentroid(ctx, l.chain, l.seq ?? 0);
        else throw new Error(`label "${l.text}" needs anchorKey, chain+seq, or xyz`);
        spec.push({
            anchor,
            kind: l.kind || 'text',
            text: String(l.text),
            bg: l.bg || '#111',
            color: l.color || '#fff',
            dx: l.dx || 0,
            dy: l.dy || 0,
            size: l.size,
        });
    }
    ctx.labels.set(spec);
    return { ok: true, labels: spec.length };
}

/**
 * A custom panel is a macro over the existing ops — the same ingredients the
 * built-in paper figures are made of, registered at runtime. Sequence: scene
 * (reusing the loaded structure unless a URL is given) → camera pose or
 * residue focus (with the same delayed re-apply the paper views use, since
 * Mol* re-frames the camera when representations settle) → labels → H-bonds.
 */
async function applyPanelSpec(ctx, spec) {
    if (!spec || typeof spec !== 'object') throw new Error('panel spec required');
    await ops.scene(ctx, { structureUrl: spec.structureUrl, groups: spec.groups });
    const cameraInfo = (spec.view || spec.focus)
        ? await applyCamera(ctx, spec.view ? { ...spec.view } : { focus: spec.focus })
        : { note: 'camera unchanged' };
    if (spec.view) {
        const pose = { yaw: spec.view.yaw, pitch: spec.view.pitch, zoom: spec.view.zoom ?? 1, roll: spec.view.roll ?? 0 };
        // Mol* auto-focuses after new representations settle; re-assert the pose
        setTimeout(() => { try { ctx.applyView(pose, null); } catch { /* best effort */ } }, 400);
        setTimeout(() => { try { ctx.applyView(pose, null); } catch { /* best effort */ } }, 800);
    }
    if (spec.labels) await applyLabels(ctx, spec.labels);
    else ctx.labels.set([]);
    if (spec.hbonds) await ops.hbonds(ctx, { pairs: spec.hbonds });
    ctx.currentFigure = null;
    ctx.reportStatus({ figure: `${spec.title || spec.id}（自定义视图）`, panel: spec.id ?? null });
    return { ok: true, panel: spec.id ?? null, figure: `${spec.title || spec.id}（自定义视图）`, ...cameraInfo, status: ctx.status() };
}

/** Map op name → handler; unknown ops answer an error so the agent can adapt. */
export function createCommandHandlers(ctx) {
    return {
        async dispatch(op, args) {
            const fn = ops[op];
            if (!fn) throw new Error(`unknown op "${op}" — one of: ${Object.keys(ops).join(', ')}`);
            const result = await fn(ctx, args || {});
            ctx.reportStatus({ busy: false });
            return result;
        },
    };
}

export { describeElementLoci, lociIsEmpty, residueLociOf, residueCentroid };
