"""structure-lab MCP server — structural biology analysis tools (pure stdlib).

Mirrors the analysis repertoire of the IscB (Kato 2022, Nat Commun) and
Cas12i (Zhang 2020, NSMB) cryo-EM papers:

  chain inventory / model composition      -> cif_overview, cif_sequences
  linear domain map + SS annotation        -> cif_ss
  protein–nucleic interface mapping        -> interface_map, cif_contacts
  basic-residue vs phosphate recognition   -> interface_map (classified)
  polar interactions / H-bonds (dashed)    -> cif_hbonds
  aromatic stacking (W511–U/A style)       -> cif_pi_stacking
  mutagenesis candidates (alanine scans)   -> interface_map (ranked output)
  structural comparison (DALI-like)        -> superpose (global CA Kabsch)
  figure label anchors                     -> region_centroids, figure_scaffold

MCP transport: newline-delimited JSON-RPC over stdio. Python 3.8+, stdlib only.
"""

import json
import math
import os
import sys
import tempfile
import urllib.request

SERVER_NAME = "structure-lab"
SERVER_VERSION = "0.2.0"
CACHE_DIR = os.path.join(tempfile.gettempdir(), "structure-lab-cache")

# 'A','U','G','C' for RNA; 'DA'…'DC' for DNA; also I, DT etc.
NUCL_COMPS = {"A", "U", "G", "C", "I", "DA", "DT", "DG", "DC", "DI"}
BACKBONE_NUCL = {"P", "OP1", "OP2", "O5'", "C5'", "O3'", "C4'", "C3'", "C2'", "O2'", "C1'"}
BB_NUCL = BACKBONE_NUCL
AROMATIC = {
    "PHE": [("CG", "CD1", "CD2", "CE1", "CE2", "CZ")],
    "TYR": [("CG", "CD1", "CD2", "CE1", "CE2", "CZ")],
    "TRP": [("CD2", "CE2", "CE3", "CZ2", "CZ3", "CH2")],
    "HIS": [("CG", "ND1", "CD2", "CE1", "NE2")],
    # nucleobases: three-letter (DNA) and one-letter (RNA) variants
    "ADE": [("C4", "C5", "N7", "C8", "N9", "N6")],
    "GUA": [("C4", "C5", "N7", "C8", "N9", "O6")],
    "CYT": [("N1", "C2", "N3", "C4", "C5", "C6")],
    "URA": [("N1", "C2", "N3", "C4", "C5", "C6")],
    "DT": [("N1", "C2", "N3", "C4", "C5", "C6")],
    "DA": [("C4", "C5", "N7", "C8", "N9", "N6")],
    "DG": [("C4", "C5", "N7", "C8", "N9", "O6")],
    "DC": [("N1", "C2", "N3", "C4", "C5", "C6")],
    "DI": [("C4", "C5", "N7", "C8", "N9", "O6")],
    "A": [("C4", "C5", "N7", "C8", "N9", "N6")],
    "G": [("C4", "C5", "N7", "C8", "N9", "O6")],
    "C": [("N1", "C2", "N3", "C4", "C5", "C6")],
    "U": [("N1", "C2", "N3", "C4", "C5", "C6")],
}
BASIC_SIDE = {"ARG": ["NE", "NH1", "NH2"], "LYS": ["NZ"], "HIS": ["ND1", "NE2"]}
ACIDIC = {"ASP", "GLU"}

# ---------------------------------------------------------------- mmCIF parsing


def _parse_loop(lines, start, prefix):
    cols, rows = [], []
    j = start + 1
    while j < len(lines) and lines[j].startswith(prefix):
        cols.append(lines[j].strip())
        j += 1
    idx = {c: k for k, c in enumerate(cols)}
    while j < len(lines) and not lines[j].startswith("#"):
        p = lines[j].split()
        if len(p) == len(cols):
            rows.append(p)
        j += 1
    return idx, rows, j


def parse_mmcif(path):
    lines = open(path, encoding="utf-8").read().splitlines()
    atoms, ss = [], []
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("loop_"):
            nxt = lines[i + 1] if i + 1 < len(lines) else ""
            if nxt.startswith("_atom_site."):
                idx, rows, i2 = _parse_loop(lines, i, "_atom_site.")
                gp = idx.get("_atom_site.group_PDB")
                for r in rows:
                    # keep polymer atoms only: ions/waters ride on the polymer's
                    # auth_asym_id and would pollute chain ranges & interfaces
                    # (ligands like MSE-as-HETATM are outside this tool's scope)
                    if gp is not None and r[gp] != "ATOM":
                        continue
                    try:
                        atoms.append({
                            "chain": r[idx["_atom_site.auth_asym_id"]],
                            "seq": int(r[idx["_atom_site.auth_seq_id"]]),
                            "comp": r[idx["_atom_site.label_comp_id"]],
                            "atom": r[idx["_atom_site.label_atom_id"]],
                            "el": r[idx["_atom_site.type_symbol"]],
                            "x": float(r[idx["_atom_site.Cartn_x"]]),
                            "y": float(r[idx["_atom_site.Cartn_y"]]),
                            "z": float(r[idx["_atom_site.Cartn_z"]]),
                        })
                    except (KeyError, ValueError):
                        continue
                i = i2
                continue
            for prefix, kind in (("_struct_conf.", "helix"), ("_struct_sheet_range.", "sheet")):
                if nxt.startswith(prefix):
                    idx, rows, i2 = _parse_loop(lines, i, prefix)
                    tc = idx.get(prefix + "conf_type_id")
                    for r in rows:
                        try:
                            ss.append({
                                "kind": kind,
                                "chain": r[idx[prefix + "beg_auth_asym_id"]],
                                "beg": int(r[idx[prefix + "beg_auth_seq_id"]]),
                                "end": int(r[idx[prefix + "end_auth_seq_id"]]),
                                "type": (r[tc] if tc is not None and tc < len(r) else ""),
                            })
                        except (KeyError, ValueError, IndexError):
                            continue
                    i = i2
                    break
        i += 1
    return {"atoms": atoms, "ss": ss}


def resolve_source(source):
    """'6W5C' -> RCSB download (cached); 'C:/…/x.cif' -> local path."""
    src = str(source)
    if os.path.isfile(src):
        return src, os.path.splitext(os.path.basename(src))[0]
    pdb = src.strip().upper()
    if len(pdb) == 4 and pdb.isalnum():
        os.makedirs(CACHE_DIR, exist_ok=True)
        path = os.path.join(CACHE_DIR, pdb + ".cif")
        if not os.path.isfile(path):
            url = f"https://files.rcsb.org/download/{pdb}.cif"
            urllib.request.urlretrieve(url, path)
        return path, pdb
    raise ValueError(f"source not found and not a 4-char PDB id: {src}")


def load(source):
    path, entry = resolve_source(source)
    key = os.path.abspath(path) + os.path.getmtime(path).__str__()
    data = parse_mmcif(path)
    return path, entry, data


def chain_stats(atoms):
    from collections import OrderedDict
    ch = OrderedDict()
    for a in atoms:
        e = ch.setdefault(a["chain"], {"kind": None, "first": a["seq"], "last": a["seq"],
                                       "atoms": 0, "prot_res": set(), "nucl_res": set()})
        e["atoms"] += 1
        e["last"] = max(e["last"], a["seq"])
        e["first"] = min(e["first"], a["seq"])
        if a["comp"] in NUCL_COMPS:
            e["nucl_res"].add((a["seq"], a["comp"]))
        elif a["comp"] not in ("HOH", "MG", "NA", "CL", "ZN", "K", "SO4", "PO4"):
            e["prot_res"].add((a["seq"], a["comp"]))
    out = []
    for c, e in ch.items():
        kind = "protein" if len(e["prot_res"]) >= len(e["nucl_res"]) else "nucleic"
        out.append({
            "chain": c, "kind": kind,
            "seq_range": [e["first"], e["last"]],
            "residues": len(e["prot_res"]) if kind == "protein" else len(e["nucl_res"]),
            "atoms": e["atoms"],
        })
    return out


# ---------------------------------------------------------------- geometry


def dist(a, b):
    return math.sqrt((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2 + (a["z"] - b["z"]) ** 2)


def grid_index(atoms, cell):
    g = {}
    for i, a in enumerate(atoms):
        k = (int(a["x"] // cell), int(a["y"] // cell), int(a["z"] // cell))
        g.setdefault(k, []).append(i)
    return g


def neighbors(grid, a, cell):
    cx, cy, cz = int(a["x"] // cell), int(a["y"] // cell), int(a["z"] // cell)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for i in grid.get((cx + dx, cy + dy, cz + dz), ()):
                    yield i


def t_cif_overview(args):
    path, entry, d = load(args.get("source"))
    chains = chain_stats(d["atoms"])
    ss = d["ss"]
    return {
        "entry": entry,
        "path": path,
        "atoms": len(d["atoms"]),
        "chains": chains,
        "secondary_structure": {"helices": sum(1 for s in ss if s["kind"] == "helix"),
                                 "sheets": sum(1 for s in ss if s["kind"] == "sheet")},
        "note": "kind=protein|nucleic by majority residue type; ions/waters excluded from residue counts",
    }


def t_cif_sequences(args):
    path, entry, d = load(args.get("source"))
    from collections import OrderedDict
    seqs = OrderedDict()
    three2one = {"ALA": "A", "ARG": "R", "ASN": "N", "ASP": "D", "CYS": "C", "GLN": "Q", "GLU": "E",
                 "GLY": "G", "HIS": "H", "ILE": "I", "LEU": "L", "LYS": "K", "MET": "M", "PHE": "F",
                 "PRO": "P", "SER": "S", "THR": "T", "TRP": "W", "TYR": "Y", "VAL": "V",
                 "DA": "A", "DT": "T", "DG": "G", "DC": "C", "A": "A", "U": "U", "G": "G", "C": "C"}
    for a in d["atoms"]:
        seqs.setdefault(a["chain"], {})
        seqs[a["chain"]].setdefault(a["seq"], a["comp"])
    out = {}
    for ch, res in seqs.items():
        runs = sorted(res.items())
        kind = "protein" if res[runs[0][0]] not in NUCL_COMPS else "nucleic"
        s = "".join(three2one.get(c, "X") for _, c in runs)
        out[ch] = {"kind": kind, "range": [runs[0][0], runs[-1][0]], "length": len(runs), "sequence": s}
    return {"entry": entry, "sequences": out}


def t_cif_ss(args):
    path, entry, d = load(args.get("source"))
    helices = [s for s in d["ss"] if s["kind"] == "helix"]
    sheets = [s for s in d["ss"] if s["kind"] == "sheet"]
    return {"entry": entry, "helices": helices, "sheets": sheets,
            "note": "from deposited _struct_conf / _struct_sheet_range records (author annotation)"}


def _contact_analysis(d, args):
    ca, cb = args["chain_a"], args["chain_b"]
    cutoff = float(args.get("cutoff", 4.5))
    A = [a for a in d["atoms"] if a["chain"] == ca]
    B = [a for a in d["atoms"] if a["chain"] == cb]
    if not A or not B:
        raise ValueError(f"chain {ca} or {cb} not found")
    grid = grid_index(B, cutoff)
    pairs = {}
    for a in A:
        for j in neighbors(grid, a, cutoff):
            b = B[j]
            if dist(a, b) <= cutoff:
                ra = (a["chain"], a["seq"], a["comp"])
                rb = (b["chain"], b["seq"], b["comp"])
                key = (ra, rb)
                pairs.setdefault(key, []).append((a["atom"], b["atom"], round(dist(a, b), 2)))
    return A, B, pairs, cutoff


def t_cif_contacts(args):
    path, entry, d = load(args.get("source"))
    A, B, pairs, cutoff = _contact_analysis(d, args)
    res_a = sorted({(p[0][1], p[0][2]) for p in pairs})
    res_b = sorted({(p[1][1], p[1][2]) for p in pairs})
    sample = [{"a": f"{pa[2]}{pa[1]}.{p1}", "b": f"{pb[2]}{pb[1]}.{p2}", "d": dd}
              for (pa, pb), lst in sorted(pairs.items())[:80] for p1, p2, dd in lst[:1]]
    return {"entry": entry, "cutoff": cutoff,
            "interface_residues": {"a": len(res_a), "b": len(res_b)},
            "contact_pairs": len(pairs),
            "a_residues": [{"seq": s, "comp": c} for s, c in res_a],
            "b_residues": [{"seq": s, "comp": c} for s, c in res_b],
            "sample_contacts": sample}


def t_interface_map(args):
    """Domain × nucleic-region contact matrix, basic-vs-phosphate classes,
    mutagenesis candidates — the papers' core protein–nucleic analysis."""
    path, entry, d = load(args.get("source"))
    prot = args.get("protein_chain", "A")
    nucl = args.get("nucleic_chain", "B")
    cutoff = float(args.get("cutoff", 4.5))
    domains = args.get("domains") or {}       # name -> [[lo,hi],…]
    regions = args.get("regions") or {}       # name -> [[lo,hi],…]

    A = [a for a in d["atoms"] if a["chain"] == prot]
    N = [a for a in d["atoms"] if a["chain"] == nucl]
    grid = grid_index(N, cutoff)

    def in_ranges(s, ranges):
        return any(lo <= s <= hi for lo, hi in ranges)

    # residue-level contacts
    res_contacts = {}
    for a in A:
        for j in neighbors(grid, a, cutoff):
            b = N[j]
            if dist(a, b) <= cutoff:
                key = (a["seq"], a["comp"], a["atom"])
                res_contacts.setdefault((a["seq"], a["comp"]), {"contacts": 0, "backbone": 0, "atoms": set()})
                res_contacts[(a["seq"], a["comp"])]["contacts"] += 1
                if b["atom"] in ("P", "OP1", "OP2"):
                    res_contacts[(a["seq"], a["comp"])]["backbone"] += 1
                res_contacts[(a["seq"], a["comp"])]["atoms"].add(a["atom"])

    def domain_of(seq):
        for name, ranges in domains.items():
            if in_ranges(seq, ranges):
                return name
        return None

    matrix = {}
    contact_res = sorted(res_contacts)
    for (seq, comp) in contact_res:
        dname = domain_of(seq) if domains else "all"
        rname = None
        if regions:
            for rn, ranges in regions.items():
                # nucleic side: check which region this residue contacts
                pass
        info = res_contacts[(seq, comp)]
        matrix.setdefault(dname, []).append({
            "seq": seq, "comp": comp,
            "contacts": info["contacts"], "phosphate_contacts": info["backbone"],
            "basic": comp in BASIC_SIDE,
            "acidic": comp in ACIDIC,
        })

    mut_candidates = []
    for dname, lst in matrix.items():
        for m in sorted(lst, key=lambda x: (-x["contacts"], -x["phosphate_contacts"])):
            if m["basic"] or m["contacts"] >= 8:
                mut_candidates.append({"domain": dname, **m})
    mut_candidates = mut_candidates[:30]

    # per-region contact counts (nucleic side)
    region_counts = {}
    if regions:
        for rn, ranges in regions.items():
            atoms_in = [b for b in N if in_ranges(b["seq"], ranges)]
            g2 = grid_index(atoms_in, cutoff)
            cnt = 0
            for a in A:
                for j in neighbors(g2, a, cutoff):
                    b = atoms_in[j]
                    if dist(a, b) <= cutoff:
                        cnt += 1
                        break
            region_counts[rn] = {"protein_residues_contacting": cnt}
        # assign each contacting protein residue to regions it touches
        for rn, ranges in regions.items():
            atoms_in = [b for b in N if in_ranges(b["seq"], ranges)]
            g2 = grid_index(atoms_in, cutoff)
            touching = set()
            for a in A:
                for j in neighbors(g2, a, cutoff):
                    if dist(a, atoms_in[j]) <= cutoff:
                        touching.add((a["seq"], a["comp"]))
                        break
            region_counts[rn]["residues"] = sorted(t[0] for t in touching)

    return {"entry": entry, "protein_chain": prot, "nucleic_chain": nucl, "cutoff": cutoff,
            "domain_contact_matrix": {k: sorted(v, key=lambda x: -x["contacts"]) for k, v in matrix.items()},
            "region_counts": region_counts,
            "mutagenesis_candidates": mut_candidates,
            "note": "basic=residue has Arg/Lys/His sidechain; phosphate_contacts counts contacts to P/OP1/OP2. "
                    "Mutagenesis candidates ranked by contact count — mirror of the papers' alanine scans."}


def t_cif_hbonds(args):
    """Distance-approximated H-bonds: N/O donor-acceptor pairs <= cutoff (default 3.2 Å).
    The dashed-line figures of the papers use this level of annotation."""
    path, entry, d = load(args.get("source"))
    cutoff = float(args.get("cutoff", 3.2))
    chains = args.get("chains")
    atoms = [a for a in d["atoms"] if a["el"] in ("N", "O") and a["comp"] != "HOH"]
    if chains:
        atoms = [a for a in atoms if a["chain"] in chains]
    grid = grid_index(atoms, cutoff)
    seen, out = set(), []
    for a in atoms:
        for j in neighbors(grid, a, cutoff):
            b = atoms[j]
            if b is a:
                continue
            # skip intra-residue pairs (His ring N…N, Asp/Glu carboxyl O…O are
            # inherent geometry, not H-bonds)
            if (a["chain"], a["seq"], a["comp"]) == (b["chain"], b["seq"], b["comp"]):
                continue
            dd = dist(a, b)
            if dd <= cutoff:
                key = tuple(sorted([(a["chain"], a["seq"], a["atom"]), (b["chain"], b["seq"], b["atom"])]))
                if key in seen:
                    continue
                seen.add(key)
                out.append({"a": f"{a['comp']}{a['seq']}#{a['chain']}.{a['atom']}",
                            "b": f"{b['comp']}{b['seq']}#{b['chain']}.{b['atom']}",
                            "d": round(dd, 2)})
    out.sort(key=lambda x: x["d"])
    if len(out) > int(args.get("max_results", 200)):
        out = out[: int(args.get("max_results", 200))]
    return {"entry": entry, "cutoff": cutoff, "n": len(out), "hbonds": out,
            "note": "heavy-atom distance approximation (no H positions); water excluded"}


def t_cif_pi_stacking(args):
    """Aromatic ring stacking between protein residues and nucleobases (papers: W511–U/A)."""
    path, entry, d = load(args.get("source"))
    max_d = float(args.get("max_dist", 5.5))
    chains = args.get("chains")
    idx = {}
    for a in d["atoms"]:
        idx.setdefault((a["comp"], a["seq"], a["chain"]), {})[a["atom"]] = a
    rings = []
    for (comp, seq, ch), amap in idx.items():
        if comp in AROMATIC and (not chains or ch in chains):
            for names in AROMATIC[comp]:
                pts = [amap[n] for n in names if n in amap]
                if len(pts) >= 4:
                    rings.append({"comp": comp, "seq": seq, "chain": ch,
                                  "c": (sum(p["x"] for p in pts) / len(pts),
                                        sum(p["y"] for p in pts) / len(pts),
                                        sum(p["z"] for p in pts) / len(pts)),
                                  "prot": comp in ("PHE", "TYR", "TRP", "HIS")})
    prot_r = [r for r in rings if r["prot"]]
    nucl_r = [r for r in rings if not r["prot"]]
    out = []
    for p in prot_r:
        best = None
        for n in nucl_r:
            dd = math.sqrt((p["c"][0] - n["c"][0]) ** 2 + (p["c"][1] - n["c"][1]) ** 2 + (p["c"][2] - n["c"][2]) ** 2)
            if dd <= max_d and (best is None or dd < best["d"]):
                best = {"residue": f"{p['comp']}{p['seq']}#{p['chain']}",
                        "base": f"{n['comp']}{n['seq']}#{n['chain']}", "d": round(dd, 2)}
        if best:
            out.append(best)
    out.sort(key=lambda x: x["d"])
    return {"entry": entry, "max_dist": max_d, "n": len(out), "stacking": out,
            "note": "ring-centroid distance approximation; papers report e.g. W511 stacks with U(−22)/A(−23)"}


def t_superpose(args):
    """Global CA Kabsch superposition of one chain of two structures."""
    import random

    def ca_coords(src, chain):
        path, entry, d = load(src)
        pts = [(a["x"], a["y"], a["z"]) for a in d["atoms"]
               if a["chain"] == chain and a["atom"] == "CA"]
        return entry, pts

    e1, P = ca_coords(args["source1"], args["chain1"])
    e2, Q = ca_coords(args["source2"], args["chain2"])
    n = min(len(P), len(Q))
    if n < 3:
        raise ValueError(f"too few CA atoms: {len(P)} / {len(Q)}")
    P, Q = P[:n], Q[:n]
    cp = [sum(p[0] for p in P) / n, sum(p[1] for p in P) / n, sum(p[2] for p in P) / n]
    cq = [sum(p[0] for p in Q) / n, sum(p[1] for p in Q) / n, sum(p[2] for p in Q) / n]
    # covariance H = P'ᵀ Q' (3x3)
    H = [[0.0] * 3 for _ in range(3)]
    for p, q in zip(P, Q):
        pv = (p[0] - cp[0], p[1] - cp[1], p[2] - cp[2])
        qv = (q[0] - cq[0], q[1] - cq[1], q[2] - cq[2])
        for i in range(3):
            for j in range(3):
                H[i][j] += pv[i] * qv[j]
    # naive eigen via power iteration on HᵀH — sufficient for RMSD reporting
    M = [[sum(H[i][k] * H[j][k] for k in range(3)) for j in range(3)] for i in range(3)]
    evals = []
    for _ in range(3):
        v = [random.random() + 0.1 for _ in range(3)]
        for _ in range(64):
            nv = [
                M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
                M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
                M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
            ]
            nn = math.sqrt(nv[0] ** 2 + nv[1] ** 2 + nv[2] ** 2) or 1.0
            v = [x / nn for x in nv]
        val = (M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2]) / v[0] if v[0] else 0.0
        evals.append(val)
        # deflate
        for i in range(3):
            for j in range(3):
                M[i][j] -= val * v[i] * v[j]
    # optimal rotation R aligns P onto Q; RMSD via Kabsch eigenvalues:
    # RMSD² = (Σ|p|² + Σ|q|² - 2·Σσ)/n with σ = singular values
    sig = sorted(math.sqrt(max(ev, 0.0)) for ev in evals)
    sp = math.sqrt(sum((p[0] - cp[0]) ** 2 + (p[1] - cp[1]) ** 2 + (p[2] - cp[2]) ** 2 for p in P))
    sq = math.sqrt(sum((q[0] - cq[0]) ** 2 + (q[1] - cq[1]) ** 2 + (q[2] - cq[2]) ** 2 for q in Q))
    e0 = sp * sp + sq * sq - 2 * sum(sig)
    rmsd = math.sqrt(max(e0, 0.0) / n)
    return {"entry1": e1, "chain1": args["chain1"], "entry2": e2, "chain2": args["chain2"],
            "aligned_ca": n, "rmsd_ca": round(rmsd, 2),
            "note": "global sequence-agnostic CA Kabsch superposition (no DALI fold alignment); "
                    "best for same-domain comparisons"}


def t_region_centroids(args):
    """Batch label anchors: centroids of named residue ranges — feeds the
    figure-reproduction label system (label-anchors JSON)."""
    path, entry, d = load(args.get("source"))
    spec = args.get("spec") or {}   # key -> {chain, ranges, element?}
    out = {}
    for key, s in spec.items():
        xs = ys = zs = n = 0.0
        for a in d["atoms"]:
            if a["chain"] != s["chain"]:
                continue
            if s.get("element") and a["el"] != s["element"]:
                continue
            if any(lo <= a["seq"] <= hi for lo, hi in s["ranges"]):
                xs += a["x"]; ys += a["y"]; zs += a["z"]; n += 1
        if n:
            out[key] = [round(xs / n, 2), round(ys / n, 2), round(zs / n, 2)]
    return {"entry": entry, "anchors": out, "count": len(out)}


def t_figure_scaffold(args):
    """Draft a papers/<paper>.js skeleton for the dsh-mol-structure figure workflow:
    chain inventory -> default component groups + label placeholder list."""
    path, entry, d = load(args.get("source"))
    chains = chain_stats(d["atoms"])
    prot = args.get("protein_chain") or next((c["chain"] for c in chains if c["kind"] == "protein"), "A")
    groups = [dom for c in chains if c["kind"] == "nucleic"
              for dom in [{"id": "nuc-" + c["chain"], "chain": c["chain"], "kind": "ranges",
                           "ranges": [c["seq_range"]], "color": "#808080", "repr": "cartoon"}]]
    scaffold = {
        "entry": entry,
        "paperModule": {
            "id": args.get("paper_id") or entry.lower(),
            "title": args.get("title") or f"{entry} figures",
            "cifUrl": f"./structures/{entry.lower()}.cif",
            "anchorsUrl": f"./structures/label-anchors-{(args.get('paper_id') or entry.lower())}.json",
            "figures": {
                "ov": {
                    "title": "Overview",
                    "scene": {"structureUrl": f"./structures/{entry.lower()}.cif",
                              "groups": [{"id": "prot", "chain": prot, "kind": "ranges",
                                          "ranges": [next(c["seq_range"] for c in chains if c["chain"] == prot)],
                                          "color": "#B3B3DC", "repr": "cartoon"}] + groups},
                    "view": {"yaw": 0, "pitch": 0, "zoom": 1.1, "roll": 0},
                    "labels": [],
                },
            },
        },
        "chains": chains,
        "note": "Fill in per-domain ranges from the paper's linear domain map, split the protein "
                "group into colored domains, add stick groups for labeled residues, then set views.",
    }
    return scaffold


TOOLS = [
    {"name": "cif_overview", "description": "Chain inventory of an mmCIF (protein/nucleic, residue ranges, atom counts, SS totals). source = 4-char PDB id (downloads & caches from RCSB) or local file path.", "inputSchema": {"type": "object", "properties": {"source": {"type": "string"}}, "required": ["source"]}},
    {"name": "cif_sequences", "description": "Per-chain sequences with ranges (protein one-letter / nucleic ACGT).", "inputSchema": {"type": "object", "properties": {"source": {"type": "string"}}, "required": ["source"]}},
    {"name": "cif_ss", "description": "Secondary-structure runs from deposited HELIX/SHEET records — the papers' linear domain maps.", "inputSchema": {"type": "object", "properties": {"source": {"type": "string"}}, "required": ["source"]}},
    {"name": "cif_contacts", "description": "All residue-level contacts between two chains within a distance cutoff.", "inputSchema": {"type": "object", "properties": {"source": {"type": "string"}, "chain_a": {"type": "string"}, "chain_b": {"type": "string"}, "cutoff": {"type": "number"}}, "required": ["source", "chain_a", "chain_b"]}},
    {"name": "interface_map", "description": "Protein–nucleic interface analysis in the style of the Cas12i/IscB papers: domain×region contact matrix, basic-residue vs phosphate classification, ranked alanine-mutagenesis candidates. Optional domains={name:[[lo,hi]…]} and regions={name:[[lo,hi]…]}.", "inputSchema": {"type": "object", "properties": {"source": {"type": "string"}, "protein_chain": {"type": "string"}, "nucleic_chain": {"type": "string"}, "cutoff": {"type": "number"}, "domains": {"type": "object"}, "regions": {"type": "object"}}, "required": ["source", "protein_chain", "nucleic_chain"]}},
    {"name": "cif_hbonds", "description": "Distance-approximated H-bonds (N/O ≤ 3.2 Å, waters excluded) — the papers' dashed-line polar interactions. Optional chains filter.", "inputSchema": {"type": "object", "properties": {"source": {"type": "string"}, "cutoff": {"type": "number"}, "chains": {"type": "array", "items": {"type": "string"}}, "max_results": {"type": "number"}}, "required": ["source"]}},
    {"name": "cif_pi_stacking", "description": "Aromatic stacking between protein rings (PHE/TYR/TRP/HIS) and nucleobases ≤ max_dist (papers: W511 stacks with U/A).", "inputSchema": {"type": "object", "properties": {"source": {"type": "string"}, "max_dist": {"type": "number"}, "chains": {"type": "array", "items": {"type": "string"}}}, "required": ["source"]}},
    {"name": "superpose", "description": "Global CA Kabsch superposition between one chain of two structures; returns CA RMSD (DALI-like fold alignment NOT included).", "inputSchema": {"type": "object", "properties": {"source1": {"type": "string"}, "chain1": {"type": "string"}, "source2": {"type": "string"}, "chain2": {"type": "string"}}, "required": ["source1", "chain1", "source2", "chain2"]}},
    {"name": "region_centroids", "description": "Batch label anchors: centroids of named chain/ranges specs — feeds the figure-reproduction label system. spec = {key:{chain, ranges:[[lo,hi]…], element?}}.", "inputSchema": {"type": "object", "properties": {"source": {"type": "string"}, "spec": {"type": "object"}}, "required": ["source", "spec"]}},
    {"name": "figure_scaffold", "description": "Draft a dsh-mol-structure papers/<paper>.js skeleton (chain inventory + default component groups) for the figure-reproduction workflow.", "inputSchema": {"type": "object", "properties": {"source": {"type": "string"}, "paper_id": {"type": "string"}, "title": {"type": "string"}, "protein_chain": {"type": "string"}}, "required": ["source"]}},
]

TOOL_IMPL = {
    "cif_overview": t_cif_overview,
    "cif_sequences": t_cif_sequences,
    "cif_ss": t_cif_ss,
    "cif_contacts": t_cif_contacts,
    "interface_map": t_interface_map,
    "cif_hbonds": t_cif_hbonds,
    "cif_pi_stacking": t_cif_pi_stacking,
    "superpose": t_superpose,
    "region_centroids": t_region_centroids,
    "figure_scaffold": t_figure_scaffold,
}

# ---------------------------------------------------------------- MCP stdio


def reply(msg_id, result=None, error=None):
    resp = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        resp["error"] = error
    else:
        resp["result"] = result
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()


def main():
    # JSON-RPC lines are UTF-8; Windows stdio defaults to the ANSI codepage
    # (GBK on zh-CN boxes), which mangled non-ASCII tool arguments (paper
    # titles with dashes etc.) into mojibake before JSON parsing.
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = msg.get("method", "")
        msg_id = msg.get("id")
        is_notification = "id" not in msg
        try:
            if method == "initialize":
                reply(msg_id, {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                })
            elif method == "notifications/initialized":
                continue
            elif method == "ping":
                reply(msg_id, {})
            elif method == "tools/list":
                reply(msg_id, {"tools": TOOLS})
            elif method == "tools/call":
                name = msg["params"]["name"]
                args = msg["params"].get("arguments", {}) or {}
                impl = TOOL_IMPL.get(name)
                if not impl:
                    reply(msg_id, error={"code": -32602, "message": f"unknown tool: {name}"})
                    continue
                result = impl(args)
                reply(msg_id, {"content": [{"type": "text", "text": json.dumps(result, indent=1)}]})
            elif method == "resources/list":
                reply(msg_id, {"resources": []})
            elif method == "prompts/list":
                reply(msg_id, {"prompts": []})
            elif is_notification:
                continue
            else:
                if not is_notification:
                    reply(msg_id, error={"code": -32601, "message": f"method not found: {method}"})
        except Exception as e:  # surface tool errors as tool errors, not crashes
            if msg_id is not None:
                reply(msg_id, {"content": [{"type": "text", "text": f"error: {e}"}], "isError": True})
            print(f"structure-lab: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
