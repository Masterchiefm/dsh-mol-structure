---
name: figure-repro
description: Reproduce publication structure figures (ribbon/surface overviews, domain-colored panels, interaction close-ups with labels, H-bond lines) from a paper + its deposited PDB, using the local dsh-mol-structure Mol* v5 web app. Use when the user asks to reproduce/redraw a paper's structure figures, make publication-style molecular figures, or add panels to the dsh-mol-structure viewer.
---

# Figure reproduction workflow (local Mol* viewer)

## Prerequisites (check FIRST, before step 4/3)

- **Python 3.8+** (label-anchor generation): probe `python --version` → `py -3
  --version` → `python3 --version`. If all fail, tell the user plainly that
  anchor generation needs Python, then **ask**: (a) 我帮你安装 — propose the
  platform default (`winget install Python.Python.3.12` on Windows, `brew
  install python3` on macOS, `apt install python3` on Linux) and re-probe after;
  (b) 用户提供 Python 路径 — use it for the `python -I tools/make_anchors.py
  <paper>` calls directly, and optionally patch
  `plugins/structure-lab/.zcode-plugin/plugin.json` `mcpServers.command` if the
  analysis MCP server also needs it; (c) 跳过锚点生成 — only viable when a
  `label-anchors-<paper>.json` for the structure already exists (say so honestly).
- **Node ≥ 20** (vite/molstar npm): probe `node --version`. If missing, ask the
  user the same way (install vs provide path vs skip) before touching the app.

Target app: the **dsh-mol-structure** workspace at `C:\Users\moqiq\PycharmProjects\dsh-mol-structure`
(vite + molstar@5 npm, runs at http://localhost:5173, fully offline). It already hosts
two reproduced papers: IscB–ωRNA (7XHT, Kato 2022) and Cas12i (6W5C, Zhang 2020).
Its architecture: `src/papers/<paper>.js` (panel definitions) + `src/config.js`
(paper registry) + `src/scenes.js` (generic group renderer) + `src/labels.js`
(HTML label overlay) + `tools/make_anchors.py` (label anchors). **Full SOP:
`C:\Users\moqiq\PycharmProjects\dsh-mol-structure\SOP.md` — read it first.** Pitfall
list: `C:\Users\moqiq\PycharmProjects\dsh-mol-structure\AGENTS.md`.

## Workflow (per paper, ~½ day)

1. **Read the paper**: identify the structure figure panels, the PDB id
   (Data availability), the linear domain map (Fig. 1a-style bar with residue
   boundaries), domain/stem colors, labeled residues and nucleotide numbers.
2. **Structure**: download `<pdb>.cif` into `dsh-mol-structure/public/structures/`;
   parse chains (auth_asym_id, types, ranges) and verify against the paper's
   numbering (they can be offset — Cas12i's PAM dT(−2*) is auth 1–10).
3. **Annotate**: use the `structure-lab` MCP tools (`cif_ss`, `region_centroids`)
   to get SS runs and label-anchor centroids. Generate
   `public/structures/label-anchors-<paper>.json` via `tools/make_anchors.py`
   (add a PAPERS entry) or the `region_centroids` tool output.
4. **Panels**: create `src/papers/<paper>.js` — each panel = `{ title, scene:
   { structureUrl, groups }, view: { yaw, pitch, zoom, roll, targetKey?, radius? },
   labels: [...], hbonds?: [[anchorA, anchorB], …] }`. Use `helpers.js`
   constructors (`dom/stick/mg/pill/text/marker/num`). Colors sampled from the
   paper's panels; stick colors follow the paper's legend, not always element-black.
5. **Register & UI**: add to `src/config.js` `PAPERS`; add a grouped
   `<div class="btn-row" data-figures="…">` block in `index.html`.
6. **Calibrate**: run `npm run dev`, open localhost:5173 with browser automation,
   click each button, screenshot (page-level screenshot fails in some hosts —
   use `window.__viewer.plugin.canvas3d.webgl.gl.canvas.toDataURL('image/png')`
   via evaluate; it excludes HTML labels), compare against the paper crop, and
   iterate yaw/pitch/roll/radius. Close-ups: `targetKey` + `radius` (24–48 Å),
   and re-apply the view twice after building (Mol* auto-focus overrides it).
7. **Verify**: every panel's `.label-layer > div` visible count equals its
   `labels` length; `window.__lastLabelError` is null; layout matches the paper
   crop. Record screenshots in `docs/screenshots/`.

## Mol* v5 pitfalls (abbreviated — full list in AGENTS.md)

- `Color.fromHexStyle()` not `fromHexString` (v5 = parseInt → NaN for '#…' → black scene).
- No `canvas3d.requestRender()` — it's `requestDraw()`.
- `illumination: false` for classic rendering.
- Build camera snapshots manually (getFocus flips unpredictably); viewport is
  device pixels; `Vec3.fromArray(out, arr, offset)` needs the offset.
- `plugin.clear(false)` between panels (also clears measurement H-bond lines).

## Honesty rules

- Canvas exports exclude the HTML label layer — say so when delivering images.
- Program-matched poses approximate (never pixel-perfect) the authors' hand-tuned
  views; state this.
- Paper numbering vs auth numbering mismatches get documented in the panel config.
