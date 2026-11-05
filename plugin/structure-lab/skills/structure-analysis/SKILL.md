---
name: structure-analysis
description: Analyze a deposited cryo-EM/X-ray structure the way the IscB (Kato 2022 Nat Commun) and Cas12i (Zhang 2020 NSMB) papers did — chain inventory, domain/SS map, protein–nucleic interface mapping, basic-residue-vs-phosphate recognition, H-bond/polar interactions, aromatic stacking, alanine-mutagenesis candidates, and global superposition. Use when the user asks to analyze a structure/PDB/mmCIF, find interactions between chains, map interfaces, or identify functional residues.
---

# Structure analysis workflow (papers' method repertoire)

## Prerequisite: Python check (do this FIRST, before any tool call)

The `structure-lab` MCP server runs on Python 3.8+. If its tools fail to connect or
report `command not found`/`python not found`, or when running this skill standalone:

1. Probe for an interpreter, in order: `python --version`, `py -3 --version`,
   `python3 --version`.
2. If none works — **tell the user plainly**: "本插件的 MCP 分析工具需要 Python 3.8+，
   但没有在系统中找到 Python。" Then **ask which option**:
   - **a) 我帮你安装** — propose the platform default (Windows: `winget install
     Python.Python.3.12` or the python.org installer; macOS: `brew install python3`;
     Linux: `apt install python3`), and after install re-probe.
   - **b) 用户提供已有 Python 路径** — then patch the plugin manifest: edit
     `.zcode-plugin/plugin.json` → `mcpServers["structure-lab"].command` to the
     provided interpreter path, bump the manifest `version` (patch), sync the
     marketplace entry, and instruct the user to refresh the market + update the
     plugin (MCP config is read at install time).
   - **c) 暂时跳过** — no analysis; say what will be unavailable.
3. Never silently skip the check; never install anything without the user's choice.

Use the `structure-lab` MCP tools. `source` accepts a 4-char PDB id (downloads from
RCSB, cached) or a local mmCIF path. All tools are distance-based approximations of
the papers' published analyses — state this when reporting.

## Workflow (follow in order)

1. **Inventory** — `cif_overview`: chains (protein/nucleic), residue ranges, atom
   counts, SS totals (mirror of the papers' Table 1 "model composition").
   Then `cif_sequences` for per-chain sequences (seed/guide segments, PAM content).

2. **Domain & SS map** — `cif_ss` returns deposited HELIX/SHEET runs. Combine with
   the paper's linear domain map (Fig. 1a-style bar) if available; otherwise report
   SS runs per chain. IscB-style papers number α-helices (red) and β-strands (blue)
   within each domain from these records.

3. **Interface mapping** — `interface_map` with the protein chain and each nucleic
   chain. Provide `domains` (name → [[lo,hi],…]) and `regions` (name → [[lo,hi],…])
   from the paper's domain map to get the **domain × region contact matrix**
   (e.g. "the PAM duplex is recognized by PI/WED/REC1" or "the heteroduplex is
   clamped by WED/REC1/REC2/RuvC" — these statements are reproduced numerically).

4. **Recognition chemistry**:
   - `interface_map` output already classifies **basic residues vs phosphate
     contacts** (the papers' recurring "positively charged residues contact the
     phosphate groups").
   - `cif_hbonds` (N/O ≤ 3.2 Å, waters excluded) — the dashed-line polar
     interactions; filter with `chains` to the interface of interest and report
     the shortest ones with residue names.
   - `cif_pi_stacking` — aromatic stacking (the W511–U(−22)/A(−23) style
     observations). If 0 results, retry with `max_dist` 6.0 before concluding.

5. **Mutagenesis candidates** — `interface_map` ranks interface residues by contact
   count and flags basic residues. The papers validate these by alanine scanning
   (wet lab); present the ranked list as "candidates the papers' mutagenesis would
   target" and cross-check against residues the paper actually mutated.

6. **Comparison** — `superpose` for global CA Kabsch RMSD between homologous
   chains (papers used DALI; ours is sequence-agnostic global alignment — say so,
   and only compare matching domains/folds).

## Reporting conventions

- Always name chains by their biological role once identified (e.g. chain B = crRNA).
- Quote distances in Å and cutoffs used.
- Round-trip: every numerical claim should cite the tool that produced it.
- Limitations: H-bonds are heavy-atom distance approximations (no H positions);
  superposition is global, not DALI; electrostatics not computed.

## Display

For visual output, the companion skill `figure-repro` renders these findings as
paper-style figures in the local dsh-mol-structure Mol* viewer (labels, colored domains,
close-ups, H-bond lines). Interface/H-bond tool outputs feed directly into its
`labels` and `hbonds` panel configs.
