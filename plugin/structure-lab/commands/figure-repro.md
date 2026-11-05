---
description: Reproduce a paper's structure figures as publication-style panels in the local dsh-mol-structure Mol* viewer
argument-hint: [paper reference or PDB id, optional figure list]
---

Reproduce the structure figures of "$ARGUMENTS" with the dsh-mol-structure viewer,
following the `figure-repro` skill end-to-end.

**Prerequisite check first** (per that skill): probe `python --version` /
`py -3 --version` / `python3 --version` and `node --version`. If Python or Node
is missing, tell the user plainly which is missing and why it is needed
(Python = label anchors; Node = the viewer app), then ask whether to
(a) let you install it (propose the platform default and confirm first),
(b) use a path the user provides, or (c) skip the dependent step. Never
install without the user's choice.

1. Read the referenced paper (or fetch the PDB entry) to identify panels, PDB id,
   domain map, colors and labeled residues. The two already-reproduced papers
   (IscB 7XHT, Cas12i 6W5C) live in `src/papers/` as worked examples.
2. Download the mmCIF into `dsh-mol-structure/dist/structures/`, verify chains/numbering.
3. Generate label anchors (`tools/make_anchors.py` PAPERS entry or
   `structure-lab` MCP `region_centroids`).
4. Write `src/papers/<paper>.js`, register in `src/config.js`, add UI groups in
   `index.html`.
5. Run `npm run dev` in `C:\Users\moqiq\PycharmProjects\dsh-mol-structure`, then verify
   each panel by browser automation (click → screenshot via
   `window.__viewer.plugin.canvas3d.webgl.gl.canvas.toDataURL` → compare to paper
   crop → iterate camera pose). Check `.label-layer` counts and
   `window.__lastLabelError`.
6. Update `AGENTS.md`/`SOP.md` tables and save screenshots to `docs/screenshots/`.

Follow the pitfalls in `dsh-mol-structure/AGENTS.md` strictly (color NaN trap, manual
camera snapshots, double-apply view after build, viewport device pixels).
Be explicit when a figure is out of scope for single-structure reproduction
(multi-PDB superpositions, cryo-EM maps) and record that decision.
