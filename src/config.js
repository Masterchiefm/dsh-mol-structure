/**
 * Multi-paper figure registry.
 *
 * Each paper module exports `figures` (panel definitions) and `paper`
 * (metadata incl. structure/anchors URLs). scenes.js renders the
 * `scene.groups` specs; see papers/*.js and tools/make_anchors.py.
 */
import { paper as iscb } from './papers/iscb.js';
import { paper as cas12i } from './papers/cas12i.js';

export const PAPERS = [iscb, cas12i];

/** Flat figure lookup with paper back-reference. */
export const FIGURES = {};
for (const p of PAPERS) {
    for (const [id, fig] of Object.entries(p.figures)) {
        if (FIGURES[id]) throw new Error('duplicate figure id: ' + id);
        FIGURES[id] = { ...fig, paperId: p.id };
    }
}
