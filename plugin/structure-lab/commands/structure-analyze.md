---
description: Analyze a deposited structure (chain inventory, domains, interfaces, H-bonds, stacking, mutagenesis candidates) like the IscB/Cas12i papers
argument-hint: [PDB id or mmCIF path]
---

Analyze the structure "$ARGUMENTS" using the `structure-lab` MCP tools, following the
`structure-analysis` skill workflow in order.

**Python check first**: the MCP server needs Python 3.8+. If its tools are
unavailable, probe `python --version` → `py -3 --version` → `python3 --version`;
if none works, tell the user plainly, then ask whether to (a) let you install
Python (propose the platform default and confirm before running), (b) use a
Python path the user provides (patch
`plugins/structure-lab/.zcode-plugin/plugin.json` `mcpServers.command`, bump the
manifest version, and have the user refresh the market + update the plugin), or
(c) skip this analysis. Never install without the user's choice.

1. `cif_overview` + `cif_sequences` — chain inventory and sequences.
2. `cif_ss` — secondary-structure runs (domain map support).
3. For each protein–nucleic (or protein–protein) chain pair: `interface_map`
   (with `domains`/`regions` if the paper's domain map is known) and `cif_contacts`.
4. `cif_hbonds` and `cif_pi_stacking` filtered to the interface chains.
5. `superpose` only if a homologous chain comparison was requested or is obvious.

Report: chain inventory table; domain/SS summary; per-interface contact matrix with
basic-vs-phosphate classification; ranked alanine-mutagenesis candidates with
cross-check against any residues the paper mutated; H-bond and stacking tables with
distances; limitations (distance-approximation, global superposition, no electrostatics).
Offer to render the findings with the `figure-repro` skill.
