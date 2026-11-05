#!/usr/bin/env python3
"""Protein–nucleic-acid contact analysis for SpCas9 ternary complexes (4UN3).

Computes, from heavy atoms only:
  * every protein residue with any heavy atom within CUTOFF of an RNA/DNA atom
  * per-residue contact counts and minimum distances, split by partner chain
Outputs JSON (docs/cas9/cas9-contacts.json) + Markdown table snippet.

Usage: python -I tools/cas9_contacts.py [cif_path] [--cutoff 4.5]
"""
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

CUTOFF = 4.5
AA3 = {
    'ALA': 'A', 'ARG': 'R', 'ASN': 'N', 'ASP': 'D', 'CYS': 'C', 'GLN': 'Q',
    'GLU': 'E', 'GLY': 'G', 'HIS': 'H', 'ILE': 'I', 'LEU': 'L', 'LYS': 'K',
    'MET': 'M', 'PHE': 'F', 'PRO': 'P', 'SER': 'S', 'THR': 'T', 'TRP': 'W',
    'TYR': 'Y', 'VAL': 'V',
}


def parse_atoms(path):
    """Yield (chain, seq, comp, atom, elem, x, y, z) from _atom_site loop."""
    lines = Path(path).read_text(encoding='utf-8', errors='replace').splitlines()
    cols, in_loop, rows = None, False, []
    for ln in lines:
        s = ln.strip()
        if s.startswith('loop_'):
            in_loop, cols = True, []
            continue
        if s.startswith('_atom_site.'):
            if in_loop:
                cols.append(s.split()[0])
            continue
        if cols and s and not s.startswith(('_', '#')) and in_loop:
            parts = s.split()
            if len(parts) == len(cols):
                rows.append(dict(zip(cols, parts)))
                continue
        elif cols and in_loop and rows and (not s or s.startswith('_') or s.startswith('loop_')):
            in_loop, cols = False, None
    out = []
    for r in rows:
        group = r.get('_atom_site.group_PDB', 'ATOM')
        if group not in ('ATOM', 'HETATM'):
            continue
        alt = r.get('_atom_site.label_alt_id', '.')
        if alt not in ('.', '?', 'A'):
            continue
        elem = r.get('_atom_site.type_symbol', '?').upper()
        if elem == 'H':
            continue
        out.append((
            r['_atom_site.auth_asym_id'],
            int(r['_atom_site.auth_seq_id']),
            r['_atom_site.label_comp_id'],
            r['_atom_site.label_atom_id'],
            elem,
            float(r['_atom_site.Cartn_x']),
            float(r['_atom_site.Cartn_y']),
            float(r['_atom_site.Cartn_z']),
        ))
    return out


def is_nucleic(comp):
    return re.fullmatch(r'[DTUAGC]|U\d+|A\d+', comp) is not None or comp in (
        'DA', 'DT', 'DG', 'DC', 'A', 'U', 'G', 'C', 'T')


def main():
    cif = sys.argv[1] if len(sys.argv) > 1 else 'public/structures/4un3.cif'
    atoms = parse_atoms(cif)
    protein = [a for a in atoms if a[0] == 'B' and a[2] in AA3]
    nucleic = [a for a in atoms if a[0] in ('A', 'C', 'D') and is_nucleic(a[2])]
    print(f'protein atoms: {len(protein)}, nucleic atoms: {len(nucleic)}')

    contacts = defaultdict(lambda: {'n': 0, 'min': 99.0, 'partners': defaultdict(lambda: [0, 99.0])})
    for pi, p in enumerate(protein):
        px = (p[5], p[6], p[7])
        for n in nucleic:
            dx, dy, dz = p[5] - n[5], p[6] - n[6], p[7] - n[7]
            d2 = dx * dx + dy * dy + dz * dz
            if d2 <= CUTOFF * CUTOFF:
                d = math.sqrt(d2)
                key = (p[0], p[1], p[2])
                c = contacts[key]
                c['n'] += 1
                c['min'] = min(c['min'], d)
                part = {'A': 'sgRNA', 'C': 'TS-DNA', 'D': 'NTS-DNA'}[n[0]]
                c['partners'][part][0] += 1
                c['partners'][part][1] = min(c['partners'][part][1], d)

    rows = []
    for (chain, seq, comp), c in contacts.items():
        rows.append({
            'residue': f'{comp}{seq}',
            'aa': AA3[comp],
            'n': c['n'],
            'minDist': round(c['min'], 2),
            'partners': {k: {'n': v[0], 'minDist': round(v[1], 2)} for k, v in c['partners'].items()},
        })
    rows.sort(key=lambda r: (-r['n'], r['minDist']))

    outdir = Path('docs/cas9')
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / 'cas9-contacts.json').write_text(json.dumps(rows, indent=2), encoding='utf-8')

    md = ['# SpCas9 protein–nucleic-acid contacts (4UN3, heavy-atom ≤4.5 Å)', '',
          '| Rank | Residue | Contacts | Min dist (Å) | Touches |', '|---|---|---|---|---|']
    for i, r in enumerate(rows[:40], 1):
        md.append(f"| {i} | {r['residue']} ({r['aa']}) | {r['n']} | {r['minDist']} | "
                  + ', '.join(f"{k}({v['n']},≥{v['minDist']}Å)" for k, v in r['partners'].items()) + ' |')
    (outdir / 'cas9-contacts-top40.md').write_text('\n'.join(md) + '\n', encoding='utf-8')
    print(f'{len(rows)} contacting residues; top 10:')
    for r in rows[:10]:
        print(f"  {r['residue']:>8}  n={r['n']:4d}  min={r['minDist']:5.2f}  {list(r['partners'])}")


if __name__ == '__main__':
    main()
