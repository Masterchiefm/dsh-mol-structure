/**
 * Scene construction from figure configs (src/config.js).
 *
 * A figure's `scene.groups` lists generic component specs; every colored unit
 * in the paper (protein domain, RNA stem, DNA strand, stick accent) is one
 * component with a uniform color — the same strategy a figure artist uses,
 * expressed through Mol* builders.
 *
 * group spec:
 *   { chain, kind: 'ranges' | 'residues' | 'het',
 *     ranges: [[lo,hi],…] | residues: [n,…] | comp: 'MG',
 *     color, repr: 'cartoon' | 'molecular-surface' | 'ball-and-stick',
 *     alpha?, id, label? }
 */
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder.js';
import { Color } from 'molstar/lib/mol-util/color/index.js';
import { StructureElement } from 'molstar/lib/mol-model/structure/structure/element.js';

const AMP = MS.struct.atomProperty.macromolecular;

const chainTest = (chain) => MS.core.set.has([MS.set(chain), AMP.auth_asym_id()]);

function rangesExpr(chain, ranges) {
    const tests = ranges.map(([lo, hi]) => MS.core.rel.inRange([AMP.auth_seq_id(), lo, hi]));
    return MS.struct.generator.atomGroups({
        'chain-test': chainTest(chain),
        'residue-test': tests.length === 1 ? tests[0] : MS.core.logic.or(tests),
    });
}

function residuesExpr(chain, residues) {
    return MS.struct.generator.atomGroups({
        'chain-test': chainTest(chain),
        'residue-test': MS.core.set.has([MS.set(...residues), AMP.auth_seq_id()]),
    });
}

function hetExpr(comp) {
    return MS.struct.generator.atomGroups({
        'residue-test': MS.core.set.has([MS.set(comp), AMP.label_comp_id()]),
    });
}

function groupExpr(g) {
    if (g.kind === 'ranges') return rangesExpr(g.chain, g.ranges);
    if (g.kind === 'residues') return residuesExpr(g.chain, g.residues);
    if (g.kind === 'het') return hetExpr(g.comp);
    throw new Error('unknown group kind: ' + g.kind);
}

async function addRep(plugin, comp, g) {
    if (!g.color) {
        // fromHexStyle(undefined) would throw an opaque TypeError deep in Color
        throw new Error(`group "${g.id}" has no color (palette key typo?)`);
    }
    const alpha = g.alpha !== undefined ? Math.max(0.01, Math.min(1, g.alpha)) : undefined;
    const props = {
        type: g.repr || 'cartoon',
        // Official path (mol-plugin-state representation-preset.js): visual
        // params carry `alpha` — e.g. { type: 'ball-and-stick', typeParams: { alpha: 0.3 } }.
        type_params: { quality: 'high', ...(alpha !== undefined ? { alpha } : {}) },
        color: 'uniform',
        colorParams: { value: Color.fromHexStyle(g.color) },
    };
    const so = await plugin.builders.structure.representation.addRepresentation(
        comp, props, { tag: g.tag || g.id },
    );
    if (alpha !== undefined) {
        // The SO data is { repr, sourceData }: transparency lives on the
        // Representation object's state (alphaFactor), NOT on the SO itself.
        const repr = so?.data?.repr ?? so?.data;
        repr?.setState?.({ alphaFactor: alpha });
    }
    return so;
}

/**
 * Pick the trajectory format for one data cell. Token URLs (/load/fN) carry
 * no extension, so sniff the payload: PDB starts with ATOM/HETATM/CRYST1,
 * mmCIF with "data_". Falls back to the URL extension, else mmcif.
 */
export function trajectoryFormat(url, dataCell) {
    if (/\.pdb(\?|$)/i.test(url) || /\.ent(\?|$)/i.test(url)) return 'pdb';
    if (/\.cif|\.mmcif(\?|$)/i.test(url)) return 'mmcif';
    const raw = dataCell?.obj?.data;
    // Start-of-file only (/m would match ATOM rows inside mmCIF atom_site loops)
    if (typeof raw === 'string' && /^\s*(ATOM |HETATM|MODEL |CRYST1|HEADER|ENDMDL)/.test(raw.slice(0, 200))) return 'pdb';
    return 'mmcif';
}

/**
 * Build the complete scene for one figure panel.
 * cfg: { structureUrl, groups: [groupSpec,…] }
 */
export async function buildScene(viewer, cfg) {
    const plugin = viewer.plugin;
    await plugin.clear(false);

    const step = (name) => { window.__sceneStep = name; };
    try {
        step('download');
        const data = await plugin.builders.data.download(
            { url: cfg.structureUrl, isBinary: false },
            { key: 'structure' },
        );
        const fmt = trajectoryFormat(cfg.structureUrl, data);
        step(`parseTrajectory:${fmt}`);
        const trajectory = await plugin.builders.structure.parseTrajectory(data, fmt);
        step('createModel');
        const model = await plugin.builders.structure.createModel(trajectory);
        step('createStructure');
        const structure = await plugin.builders.structure.createStructure(model, { name: 'model', params: {} });
        step('groups');
        for (const g of cfg.groups || []) {
            const comp = await plugin.builders.structure.tryCreateComponentFromExpression(
                structure, groupExpr(g), g.id, { label: g.label || g.id },
            );
            if (comp) await addRep(plugin, comp, g);
        }
        step('done');
        return structure;
    } catch (e) {
        const err = new Error(`buildScene failed at "${window.__sceneStep}": ${e?.message || e}`);
        err.stack = `${err.message}\n${e?.stack || '(no stack)'}`;
        throw err;
    }
}

// --- selection → Loci helpers (used for H-bond lines) -------------------------

/**
 * Map query-produced Loci elements back onto the structure's canonical units.
 *
 * StructureSelection.toLociWithCurrentUnits keeps the query's union units in
 * the elements while the indices are positions in the CANONICAL unit — so
 * property reads through StructureProperties (unit.chainIndex[element] etc.)
 * index the wrong unit's arrays and answer garbage (measured: whole-file CIF
 * text for an auth chain id). Swapping in the canonical unit makes element
 * indices consistent with the property getters again.
 */
export function canonicalLoci(loci) {
    const out = loci.elements.map((e) => {
        const canonical = loci.structure.unitMap.get(e.unit.id);
        return canonical && canonical !== e.unit ? { unit: canonical, indices: e.indices } : e;
    });
    return StructureElement.Loci(loci.structure, out);
}

export async function residueLoci(plugin, structure, chain, seq) {
    const { compile } = await import('molstar/lib/mol-script/runtime/query/base.js');
    const { QueryContext } = await import('molstar/lib/mol-model/structure/query/context.js');
    const { StructureSelection } = await import('molstar/lib/mol-model/structure/query/selection.js');
    const expr = residuesExpr(chain, [seq]);
    const query = compile(expr);
    const sel = query(new QueryContext(structure.obj.data));
    return canonicalLoci(StructureSelection.toLociWithCurrentUnits(sel));
}

