"""Generate label-anchor coordinates from an mmCIF, for any paper.

Run:  python -I tools/make_anchors.py <paper>     (paper key from PAPERS below)
Out:  public/structures/label-anchors-<paper>.json

Anchors are per-residue-set centroids (all atoms of the listed residues),
used by src/labels.js to place publication-style HTML labels in 3D.
Secondary-structure (SS) centroids come from the deposited
_struct_conf / _struct_sheet_range records, numbered within each domain
(alpha = red numbers, beta = blue numbers, as in Fig. 2 of the IscB paper).

To add a new paper: fill in a PAPERS entry (structure file, domain/stem
ranges per chain, labeled residues, numbered nucleotides, chains whose
5'/3' ends get markers), then run this script with its key.
"""

import json
import sys

CIF_DIR = "public/structures/"

# ---------------------------------------------------------------- paper configs

PAPERS = {
    # Kato et al., Nat Commun 13, 6719 (2022) — IscB–ωRNA–target DNA (PDB 7XHT)
    "iscb": {
        "cif": "7xht.cif",
        "domains": {  # key -> (chain, ranges)
            "dom_PLMP": ("A", [[3, 55]]),
            "dom_RuvC_I": ("A", [[56, 86]]),
            "dom_BH": ("A", [[87, 122]]),
            "dom_REC": ("A", [[123, 164]]),
            "dom_RuvC_II": ("A", [[165, 194]]),
            "dom_RuvC_III": ("A", [[298, 370]]),
            "dom_WED": ("A", [[371, 444]]),
            "dom_TI": ("A", [[445, 496]]),
            "dom_linker": ("A", [[195, 198], [297, 298]]),
            "dom_RuvC": ("A", [[56, 86], [165, 194], [298, 370]]),
        },
        "regions": {  # nucleic-acid regions (chain B, ωRNA stems)
            "rna_Guide": ("B", [[-16, -1]]),
            "rna_GAH": ("B", [[1, 44]]),
            "rna_NS": ("B", [[45, 49], [148, 153]]),
            "rna_CS": ("B", [[50, 60], [111, 124]]),
            "rna_SL2": ("B", [[61, 76]]),
            "rna_NPKH": ("B", [[77, 112]]),
            "rna_NPKS": ("B", [[93, 96], [155, 158]]),
            "rna_SL3": ("B", [[125, 147]]),
            "rna_LNK": ("B", [[158, 163]]),
            "rna_TH2": ("B", [[164, 180]]),
            "rna_TH1": ("B", [[181, 206]]),
        },
        "residues": {  # key -> (chain, seq)
            "resA_D61": ("A", 61), "resA_E193": ("A", 193), "resA_H340": ("A", 340), "resA_D343": ("A", 343),
            "resA_N13": ("A", 13), "resA_P14": ("A", 14), "resA_L15": ("A", 15), "resA_M16": ("A", 16), "resA_P17": ("A", 17),
            "resA_198": ("A", 198), "resA_297": ("A", 297), "resA_496": ("A", 496),
            "resA_R102": ("A", 102), "resA_R106": ("A", 106), "resA_R107": ("A", 107), "resA_R108": ("A", 108),
            "resA_R110": ("A", 110), "resA_R111": ("A", 111), "resA_R115": ("A", 115), "resA_T166": ("A", 166),
            "resA_T142": ("A", 142), "resA_K144": ("A", 144), "resA_K149": ("A", 149),
            "resA_R152": ("A", 152), "resA_N154": ("A", 154), "resA_R156": ("A", 156),
            "resA_H380": ("A", 380), "resA_R439": ("A", 439), "resA_S459": ("A", 459), "resA_R462": ("A", 462),
            "resA_E460": ("A", 460), "resA_Y469": ("A", 469), "resA_W479": ("A", 479), "resA_G461": ("A", 461),
            "resB_U80": ("B", 80), "resB_G88": ("B", 88), "resB_U91": ("B", 91), "resB_U92": ("B", 92),
            "resB_C93": ("B", 93), "resB_G149": ("B", 149), "resB_C153": ("B", 153), "resB_C154": ("B", 154),
            "resB_G155": ("B", 155), "resB_G158": ("B", 158), "resB_G159": ("B", 159), "resB_A160": ("B", 160),
            "resD_0": ("D", 0), "resD_1": ("D", 1),
        },
        "nums": [("B", i) for i in range(-11, 0)] + [("B", 43)]
            + [("B", i) for i in range(95, 103)] + [("B", 150)]
            + [("C", i) for i in (1, 2, 3, 4, 5, 6, -6, -5, -4, -3, -2, -1)],
        "end_chains": ["B", "C", "D"],
        # SS numbering domain assignment (name, lo, hi) in sequence order
        "ss_domains": [("PLMP", 3, 55), ("RuvC", 56, 86), ("BH", 87, 122), ("REC", 123, 164),
                       ("RuvC", 165, 194), ("RuvC", 298, 370), ("WED", 371, 444), ("TI", 445, 496)],
        "ss_chains": ["A"],
    },

    # Zhang et al., Nat Struct Mol Biol 27, 1069–1076 (2020) — Cas12i–crRNA–dsDNA (PDB 6W5C)
    "cas12i": {
        "cif": "6w5c.cif",
        "domains": {  # per Fig. 1a domain bar
            "dom_WED_N": ("A", [[1, 23]]),
            "dom_REC1": ("A", [[23, 181]]),
            "dom_PI": ("A", [[181, 278]]),
            "dom_REC1b": ("A", [[278, 473]]),
            "dom_WED": ("A", [[473, 636]]),
            "dom_RuvC_I": ("A", [[636, 685]]),
            "dom_REC2": ("A", [[685, 942]]),
            "dom_RuvC": ("A", [[942, 1072]]),
            "dom_Nuc": ("A", [[1072, 1093]]),
            "dom_REC": ("A", [[23, 181], [278, 473], [685, 942]]),   # REC lobe for overview pills
            "dom_RuvCall": ("A", [[636, 685], [942, 1072]]),
        },
        "regions": {  # nucleic acids: crRNA / TS / NTS / substrate
            "rna_crRNA": ("B", [[-22, 27]]),
            "rna_TS": ("C", [[1, 36]]),
            "rna_NTS": ("D", [[1, 10]]),
            "rna_sub": ("E", [[28, 36]]),
            "rna_guide": ("B", [[1, 27]]),
            "rna_repeat": ("B", [[-22, -1]]),
        },
        "residues": {  # key -> (chain, seq); names per paper labels
            "resA_R22": ("A", 22), "resA_R26": ("A", 26), "resA_H497": ("A", 497),
            "resA_K500": ("A", 500), "resA_D499": ("A", 499), "resA_W511": ("A", 511),
            "resA_E513": ("A", 513), "resA_K526": ("A", 526), "resA_E525": ("A", 525),
            "resA_H527": ("A", 527), "resA_H528": ("A", 528),
            "resA_S167": ("A", 167), "resA_T168": ("A", 168), "resA_H170": ("A", 170),
            "resA_Y171": ("A", 171), "resA_S482": ("A", 482),
            "resA_D647": ("A", 647), "resA_E894": ("A", 894), "resA_D1074": ("A", 1074),
            "resA_N849": ("A", 849), "resA_W915": ("A", 915), "resA_T944": ("A", 944),
            "resA_L912": ("A", 912), "resA_R952": ("A", 952),
        },
        "nums": [("B", i) for i in range(-23, -18)]                     # U(−19)…A(−23)
            + [("C", i) for i in (34, 35, 36)] + [("D", i) for i in (1, 2, 3)]   # PAM ends of TS/NTS
            + [("E", i) for i in (4, 5, 6, 7, 8, 9)],                            # substrate DNA
        "end_chains": ["B", "C", "D"],
        "ss_domains": None,  # not used for Cas12i figures
        "ss_chains": [],
    },
}

# ---------------------------------------------------------------- parsing


def parse_atom_site(lines):
    cols, rows = [], []
    for i, ln in enumerate(lines):
        if ln.startswith("loop_") and i + 1 < len(lines) and lines[i + 1].startswith("_atom_site."):
            j = i + 1
            while lines[j].startswith("_atom_site."):
                cols.append(lines[j].strip())
                j += 1
            while j < len(lines) and not lines[j].startswith("#"):
                p = lines[j].split()
                if len(p) == len(cols):
                    rows.append(p)
                j += 1
            break
    idx = {c: k for k, c in enumerate(cols)}
    atoms = []

    def as_int(v):
        return int(v) if v.lstrip("-").isdigit() else -10**9

    for r in rows:
        atoms.append({
            "chain": r[idx["_atom_site.auth_asym_id"]],
            "seq": int(r[idx["_atom_site.auth_seq_id"]]),
            "comp": r[idx["_atom_site.label_comp_id"]],
            "element": r[idx["_atom_site.type_symbol"]],
            "x": float(r[idx["_atom_site.Cartn_x"]]),
            "y": float(r[idx["_atom_site.Cartn_y"]]),
            "z": float(r[idx["_atom_site.Cartn_z"]]),
            "lseq": as_int(r[idx["_atom_site.label_seq_id"]]),
        })
    return atoms


def parse_struct_conf(lines, kind):
    """kind: '_struct_conf.' or '_struct_sheet_range.'
    -> [(chain, beg, end, type_id)]"""
    out = []
    for i, ln in enumerate(lines):
        if ln.startswith("loop_") and i + 1 < len(lines) and lines[i + 1].startswith(kind):
            j = i + 1
            cols = []
            while lines[j].startswith(kind):
                cols.append(lines[j].strip())
                j += 1
            idx = {c: k for k, c in enumerate(cols)}
            type_col = kind + "conf_type_id"
            while j < len(lines) and not lines[j].startswith("#"):
                p = lines[j].split()
                if len(p) == len(cols):
                    ch = p[idx[kind + "beg_auth_asym_id"]]
                    beg = int(p[idx[kind + "beg_auth_seq_id"]])
                    end = int(p[idx[kind + "end_auth_seq_id"]])
                    tid = p[idx[type_col]] if type_col in idx else ""
                    out.append((ch, beg, end, tid))
                j += 1
            break
    return out


def centroid(atoms, chain, lo, hi, element=None):
    xs = ys = zs = n = 0.0
    for a in atoms:
        if a["chain"] == chain and lo <= a["seq"] <= hi:
            if element and a["element"] != element:
                continue
            xs += a["x"]; ys += a["y"]; zs += a["z"]; n += 1
    if n == 0:
        return None
    return [round(xs / n, 2), round(ys / n, 2), round(zs / n, 2)]


def centroid_residue(atoms, chain, seq):
    return centroid(atoms, chain, seq, seq)


def chain_ends(atoms, chain):
    """first/last residue of a chain in label_seq order (5' -> 3' for nucleics)."""
    seqs = sorted({a["lseq"] for a in atoms if a["chain"] == chain and a["lseq"] > -10**8})
    if not seqs:
        return None, None

    def c(lseq):
        xs = ys = zs = n = 0.0
        for a in atoms:
            if a["chain"] == chain and a["lseq"] == lseq:
                xs += a["x"]; ys += a["y"]; zs += a["z"]; n += 1
        return [round(xs / n, 2), round(ys / n, 2), round(zs / n, 2)]

    return c(seqs[0]), c(seqs[-1])


# ---------------------------------------------------------------- generation


def main(paper):
    cfg = PAPERS[paper]
    lines = open(CIF_DIR + cfg["cif"], encoding="utf-8").read().splitlines()
    atoms = parse_atom_site(lines)
    anchors = {}

    # domain centroids: centroid of per-range CA centroids weighted by range length
    for key, (chain, ranges) in cfg["domains"].items():
        xs = ys = zs = n = 0.0
        for lo, hi in ranges:
            c = centroid(atoms, chain, lo, hi, element="C")
            if c:
                w = len(range(lo, hi + 1))
                xs += c[0] * w; ys += c[1] * w; zs += c[2] * w
                n += w
        if n:
            anchors[key] = [round(xs / n, 2), round(ys / n, 2), round(zs / n, 2)]

    # nucleic-acid region centroids (all atoms)
    for key, (chain, ranges) in cfg["regions"].items():
        xs = ys = zs = n = 0.0
        for lo, hi in ranges:
            for a in atoms:
                if a["chain"] == chain and lo <= a["seq"] <= hi:
                    xs += a["x"]; ys += a["y"]; zs += a["z"]; n += 1
        if n:
            anchors[key] = [round(xs / n, 2), round(ys / n, 2), round(zs / n, 2)]

    # individual residues
    for key, (chain, seq) in cfg["residues"].items():
        c = centroid_residue(atoms, chain, seq)
        if c:
            anchors[key] = c

    # numbered nucleotides
    for ch, seq in cfg["nums"]:
        c = centroid_residue(atoms, ch, seq)
        if c:
            anchors[f"num_{ch}{seq}"] = c

    # chain termini (5' / 3')
    for ch in cfg["end_chains"]:
        first, last = chain_ends(atoms, ch)
        if first:
            anchors[f"end_{ch}_5p"] = first
        if last:
            anchors[f"end_{ch}_3p"] = last

    # secondary-structure runs from the deposition, numbered within each domain
    if cfg["ss_domains"] and cfg["ss_chains"]:
        def domain_of(seq):
            for name, lo, hi in cfg["ss_domains"]:
                if lo <= seq <= hi:
                    return name
            return None

        counters = {}
        for ch in cfg["ss_chains"]:
            runs = [(c2, b, e, t) for c2, b, e, t in parse_struct_conf(lines, "_struct_conf.")
                    if c2 == ch and t.startswith("HELX")]
            runs += [(c2, b, e, t) for c2, b, e, t in parse_struct_conf(lines, "_struct_sheet_range.") if c2 == ch]
            for _, b, e, t in sorted(runs, key=lambda r: r[1]):
                d = domain_of(b)
                if d is None:
                    continue
                kind = "alpha" if t.startswith("HELX") else "beta"
                counters.setdefault((d, kind), 0)
                counters[(d, kind)] += 1
                key = f"ss_{kind}_{d}{counters[(d, kind)]}"
                c = centroid(atoms, ch, b, e, element="C")
                if c:
                    anchors[key] = c

    out = CIF_DIR + f"label-anchors-{paper}.json"
    json.dump(anchors, open(out, "w"), indent=1)
    n_ss = sum(1 for k in anchors if k.startswith("ss_"))
    print(f"wrote {out}: {len(anchors)} anchors ({n_ss} secondary-structure labels)")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in PAPERS:
        print("usage: python -I tools/make_anchors.py <paper>")
        print("  papers:", ", ".join(PAPERS))
        sys.exit(1)
    main(sys.argv[1])
