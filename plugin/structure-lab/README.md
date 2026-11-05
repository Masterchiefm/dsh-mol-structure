# structure-lab

Structural biology analysis & display lab for ZCode.

## Requirements

| Dependency | Used for | Check |
|---|---|---|
| Python ≥ 3.8 | MCP analysis server (`mcp/structure_server.py`, stdlib only) + label-anchor generation | `python --version` (or `py -3`, `python3`) |
| Node ≥ 20 | figure-repro viewer app (vite + molstar npm in the dsh-mol-structure workspace) | `node --version` |

If Python is missing, the skills/commands will tell you and ask whether to
install it (with a proposed platform default), use a user-provided interpreter
path (patch `.zcode-plugin/plugin.json` `mcpServers.command`, bump the version,
refresh market + update), or skip the dependent step.

## Components

- **MCP server** `mcp/structure_server.py` — 10 analysis tools over newline-delimited
  JSON-RPC stdio: `cif_overview`, `cif_sequences`, `cif_ss`, `cif_contacts`,
  `interface_map` (domain×region matrix, basic-vs-phosphate, mutagenesis
  candidates), `cif_hbonds`, `cif_pi_stacking`, `superpose`, `region_centroids`,
  `figure_scaffold`. Pure stdlib; PDB ids are downloaded from RCSB and cached.
- **Skill** `structure-analysis` — the papers' analysis repertoire as a workflow
  (IscB Kato-2022 / Cas12i Zhang-2020 method repertoire: chain inventory, domain
  maps, interface mapping, H-bonds, stacking, alanine-scan candidates, superposition).
- **Skill** `figure-repro` — reproduce publication structure figures with the local
  dsh-mol-structure Mol* v5 viewer (points at the dsh-mol-structure workspace SOP).
- **Commands** `/structure-analyze`, `/figure-repro` — entry points with the
  prerequisite checks built in.
- **Reference** `references/paper-methods.md` — analysis-method ↔ tool mapping
  table from the two source papers.
