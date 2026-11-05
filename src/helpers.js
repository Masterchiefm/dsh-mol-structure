/** Shared helpers for paper figure configs (see papers/*.js). */

// component group builders (scenes.js group specs)
export const dom = (id, chain, ranges, color, repr = 'cartoon') =>
    ({ id, chain, kind: 'ranges', ranges, color, repr });
export const stick = (id, chain, residues, color = 'element') =>
    ({ id, chain, kind: 'residues', residues, color, repr: 'ball-and-stick' });
export const mg = () => ({ id: 'mg', kind: 'het', comp: 'MG', color: '#8A8A8A', repr: 'ball-and-stick' });
export const seqr = (a, b) => { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; };

// label builders
export const pill = (text, key, bg, color = '#fff', dx = 0, dy = 0) =>
    ({ kind: 'pill', text, anchorKey: key, bg, color, dx, dy });
export const text = (t, key, size = 12, dx = 0, dy = 0) =>
    ({ kind: 'text', text: t, anchorKey: key, size, dx, dy });
export const marker = (t, key, bg, color = '#fff') =>
    ({ kind: 'marker', text: t, anchorKey: key, bg, color });
export const num = (t, key) =>
    ({ kind: 'text', text: t, anchorKey: key, size: 11, dy: -9 });
