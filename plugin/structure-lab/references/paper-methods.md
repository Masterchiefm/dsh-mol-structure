# How the two source papers analyzed their structures

The plugin's tools mirror the analysis repertoire below, extracted from the two
papers reproduced in the dsh-mol-structure workspace. Cite these when explaining what a
tool corresponds to.

## IscB–ωRNA (Kato et al., Nat Commun 13:6719, 2022) — PDB 7XHT / EMD-33586

| Analysis | Where | Plugin tool |
|---|---|---|
| Chain/model composition (1,023 protein residues + 105 nucleotides etc.) | Table S1 "model composition" | `cif_overview` |
| Linear domain map (PLMP/RuvC/BH/REC/WED/TI with residue boundaries) | Fig. 1a | `cif_ss` + paper bar |
| α-helix (red) / β-strand (blue) numbering per domain | Fig. 2 | `cif_ss` (deposited HELIX/SHEET) |
| Protein–nucleic interface ("basic residues contact phosphate groups") | text + ED Fig. 4 | `interface_map` |
| Domain-level recognition statements ("PAM duplex recognized by PI/WED/REC1", "heteroduplex clamped by WED/REC1/REC2/RuvC") | text | `interface_map` with domains/regions |
| Polar interactions (dashed lines; e.g. T168↔dG(−1), H170+S482↔dA(−2)) | Fig. 2d, Fig. 4c–e | `cif_hbonds` |
| Aromatic stacking (W511↔U(−22)/A(−23) for pre-crRNA positioning) | Fig. 2b | `cif_pi_stacking` |
| Alanine scans (S167A/T168A/H170A/Y171A/S482A; K483A/R535A/R769A; H527A/H528A/R22A/W511A; H380A/G461P/Y469A/W479A) | Figs. 2e/2g/4b | `interface_map` mutagenesis_candidates |
| Structural homology (DALI → Cas12b closest; AlphaFold2 for deleted HNH) | text | `superpose` (global Kabsch only — noted limitation) |
| Electrostatic surface (Fig. 1f/g) | Fig. 1f/g | not implemented (needs APBS); report as limitation |
| Figure rendering | Cue-Mol/ChimeraX | dsh-mol-structure (`figure-repro` skill) |

## Cas12i (Zhang et al., Nat Struct Mol Biol 27:1069, 2020) — PDB 6W5C (ternary), 6W62 (crRNA), 6W64 (intermediate)

| Analysis | Where | Plugin tool |
|---|---|---|
| Three-state comparison (ternary vs crRNA-only vs intermediate) | Table 1, Fig. 3c | multi-`cif_overview` + `superpose` |
| Domain map (WED/REC1/PI/RuvC/REC2/Nuc with two-lobed architecture) | Fig. 1a | `cif_ss` + paper bar |
| Pre-crRNA processing site (H527/H528 catalytic pair, R22 stabilizer, W511 stacking, cleavage between A(−23)/A(−24)) | Fig. 2a–c | `interface_map` + `cif_pi_stacking` (R22 had 21 contacts with crRNA in our validation run) |
| PAM recognition by REC1/WED/PI loops (S167/T168/H170/Y171 in major groove; PI loop in minor groove) | Fig. 2d | `interface_map` (domains=…, regions=PAM) |
| Seed sequence (7-nt pre-ordered) and 14-bp/28-bp two-step activation | Fig. 3a, text | `cif_sequences` + interface comparison across states |
| Heteroduplex recognition (basic residues ↔ phosphates; K483/R535/R769) | ED Fig. 4/5 | `interface_map` |
| Substrate cleavage site (between dG(5)/dA(6); D647/E894/D1074 catalytic; W915/T944/N849/L912/R952 contacts) | Fig. 2f | `interface_map`/`cif_hbonds` around substrate chain |
| Conformational changes upon activation (REC1/REC2 outward movement; lid α1 90° rotation) | Fig. 3c, ED Fig. 8 | pair-wise `superpose` of states (global RMSD only) |

## Usage patterns for the agent

- Interface statements like "X is recognized by domains A/B/C" are testable:
  run `interface_map` with those domain ranges and check which domains have the
  most contacting residues — quote the counts.
- Mutagenesis tables are reproducible as ranked candidate lists; note agreements
  and disagreements with the paper's tested residues.
- The papers' wet-lab assays (cleavage/nicking, indel sequencing) are out of scope
  for this plugin — the in-silico part is interface/H-bond prediction only.
