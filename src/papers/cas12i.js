/**
 * Paper 2: Zhang et al., Nat Struct Mol Biol 27, 1069–1076 (2020)
 * "Mechanisms for target recognition and cleavage by the Cas12i RNA-guided
 * endonuclease" — PDB 6W5C (Cas12i E894A–crRNA–dsDNA, 2.9 Å).
 *
 * Chains: A Cas12i (8–1093) · B crRNA (−22…27) · C TS (1–36) ·
 *         D NTS (1–10, PAM-proximal) · E substrate DNA (28–36, RuvC site).
 * Domains (Fig. 1a): WED 1-23+473-636 (lavender) · REC1 23-181+278-473 (gray) ·
 * PI 181-278 (yellow) · RuvC 636-685+942-1072 (green) · REC2 685-942 (dark gray) ·
 * Nuc 1072-1093 (pink).
 * Nucleic colors (legend): crRNA orange · TS magenta · NTS sky blue ·
 * substrate DNA sky blue · PAM red.
 */
import { dom, stick, pill, text, marker, num, seqr } from '../helpers.js';

export const COLORS = {
    wed: '#B3B3DC',      // lavender
    rec1: '#BFBFBF',     // light gray
    rec2: '#6E6E6E',     // dark gray
    pi: '#F0E24C',       // yellow
    ruvc: '#1E8A43',     // dark green
    nuc: '#F0AEC8',      // pink
    crna: '#E8791D',     // orange
    ts: '#D95FC0',       // magenta
    nts: '#7EC8E3',      // sky blue
    sub: '#7EC8E3',      // sky blue
    pam: '#E23B3B',      // red
};

const C = COLORS;
const cifUrl = './structures/6w5c.cif';

// protein domain groups (two renderings: overview surface / close-up cartoon)
const proteinGroups = (repr = 'cartoon') => [
    dom('WED', 'A', [[1, 23], [473, 636]], C.wed, repr),
    dom('REC1', 'A', [[23, 181], [278, 473]], C.rec1, repr),
    dom('PI', 'A', [[181, 278]], C.pi, repr),
    dom('RuvC', 'A', [[636, 685], [942, 1072]], C.ruvc, repr),
    dom('REC2', 'A', [[685, 942]], C.rec2, repr),
    dom('Nuc', 'A', [[1072, 1093]], C.nuc, repr),
];
const nucleicGroups = () => [
    dom('crRNA', 'B', [[-22, 27]], C.crna),
    dom('TS', 'C', [[1, 36]], C.ts),
    dom('NTS', 'D', [[1, 10]], C.nts),
    dom('sub', 'E', [[28, 36]], C.sub),
];

export const figures = {
    // Fig. 1b/c style — domain-colored surface + orange/red/blue nucleics
    c1ov: {
        title: 'Fig 1b · map',
        scene: { structureUrl: cifUrl, groups: [
            ...proteinGroups('molecular-surface'), ...nucleicGroups(),
        ] },
        view: { yaw: 250, pitch: 10, zoom: 1.1, roll: 130 },
        labels: [
            pill('TS', 'rna_TS', C.pi, '#3A3A3A'),
            pill('PI', 'dom_PI', C.pi, '#3A3A3A'),
            pill('NTS', 'rna_NTS', C.nts, '#3A3A3A'),
            pill('WED', 'dom_WED', C.wed, '#3A3A3A'),
            pill('RuvC', 'dom_RuvCall', C.ruvc),
            pill('crRNA', 'rna_crRNA', C.crna),
            pill('Substrate DNA', 'rna_sub', C.sub, '#3A3A3A'),
            pill('Nuc', 'dom_Nuc', C.nuc, '#3A3A3A'),
            pill('REC2', 'dom_REC2', C.rec2),
        ],
    },

    c1ovBack: {
        title: 'Fig 1c · 180°',
        scene: { structureUrl: cifUrl, groups: [
            ...proteinGroups('molecular-surface'), ...nucleicGroups(),
        ] },
        view: { yaw: 70, pitch: 10, zoom: 1.1, roll: -130 },
        labels: [
            pill('TS', 'rna_TS', C.ts, '#3A3A3A'),
            pill('PI', 'dom_PI', C.pi, '#3A3A3A'),
            pill('WED', 'dom_WED', C.wed, '#3A3A3A'),
            pill('crRNA', 'rna_crRNA', C.crna),
            pill('REC1', 'dom_REC1', C.rec1, '#3A3A3A'),
            pill('REC2', 'dom_REC2', C.rec2),
            pill('Nuc', 'dom_Nuc', C.nuc, '#3A3A3A'),
        ],
    },

    // Fig. 1d/e style — cartoon with domain pills
    c1d: {
        title: 'Fig 1d · cartoon',
        scene: { structureUrl: cifUrl, groups: [
            ...proteinGroups('cartoon'), ...nucleicGroups(),
        ] },
        view: { yaw: 250, pitch: 10, zoom: 1.1, roll: 130 },
        labels: [
            pill('crRNA', 'rna_crRNA', C.crna),
            pill('PAM duplex', 'rna_NTS', C.pam),
            pill('TS', 'rna_TS', C.ts, '#3A3A3A'),
            pill('NTS', 'rna_NTS', C.nts, '#3A3A3A'),
            pill('PI', 'dom_PI', C.pi, '#3A3A3A'),
            pill('WED', 'dom_WED', C.wed, '#3A3A3A'),
            pill('REC1', 'dom_REC1', C.rec1, '#3A3A3A'),
            pill('RuvC', 'dom_RuvCall', C.ruvc),
            pill('REC2', 'dom_REC2', C.rec2),
            pill('Nuc', 'dom_Nuc', C.nuc, '#3A3A3A'),
            text('WED+α1', 'dom_WED', 11, -40, -30),
            text('U-rich loop', 'rna_repeat', 11, -30, 24),
            text('REC1 α16/α17', 'dom_REC1b', 11, 40, 30),
        ],
    },

    // Fig. 2a/b — crRNA 5′ end processing by the WED RNase site
    c2a: {
        title: 'Fig 2a · 5′ crRNA',
        scene: { structureUrl: cifUrl, groups: [
            dom('WED', 'A', [[473, 636]], C.wed, 'cartoon'),
            stick('crnastick', 'B', seqr(-22, -17), C.crna),
            stick('res5p', 'A', [22, 26, 497, 499, 500, 511, 513, 525, 526, 527, 528], C.wed),
        ] },
        view: { targetKey: 'num_B-21', yaw: 240, pitch: 8, zoom: 1.0, radius: 24, roll: 110 },
        labels: [
            pill('crRNA', 'rna_crRNA', C.crna, '#fff', -60, -40),
            pill('WED', 'dom_WED', C.wed, '#3A3A3A', 50, 50),
            text('R22', 'resA_R22', 11, 14, -10),
            text('R26', 'resA_R26', 11, 18, -14),
            text('H527', 'resA_H527', 11, 16, 4),
            text('H528', 'resA_H528', 11, 16, 12),
            text('W511', 'resA_W511', 11, -18, 8),
            text('H497', 'resA_H497', 11, -20, 16),
            text('K500', 'resA_K500', 11, -20, 24),
            text('D499', 'resA_D499', 11, -20, 32),
            text('E513', 'resA_E513', 11, -22, 40),
            text('E525', 'resA_E525', 11, 18, 22),
            text('K526', 'resA_K526', 11, 18, 30),
            ...seqr(-22, -19).map((s) => num(`U(−${-s})`, `num_B${s}`)),
            num('A(−23)', 'num_B-23'),
        ],
    },

    // Fig. 2d — PAM duplex recognition by PI / WED / REC1
    c2d: {
        title: 'Fig 2d · PAM',
        scene: { structureUrl: cifUrl, groups: [
            dom('PI', 'A', [[181, 278]], C.pi, 'cartoon'),
            dom('REC1', 'A', [[23, 181]], C.rec1, 'cartoon'),
            dom('WED', 'A', [[473, 636]], C.wed, 'cartoon'),
            stick('tsStick', 'C', [1, 2, 3, 34, 35, 36], C.ts),
            stick('ntsStick', 'D', [1, 2, 3], C.nts),
            stick('pamRed', 'D', [8, 9, 10], C.pam),
            stick('resPAM', 'A', [167, 168, 170, 171, 482], C.rec1),
        ] },
        view: { targetKey: 'num_D2', yaw: 240, pitch: 10, zoom: 1.0, radius: 26, roll: 100 },
        labels: [
            pill('PI', 'dom_PI', C.pi, '#3A3A3A', -50, -40),
            pill('REC1', 'dom_REC1', C.rec1, '#3A3A3A', 40, -60),
            pill('WED', 'dom_WED', C.wed, '#3A3A3A', 40, 50),
            text('S167', 'resA_S167', 11, 14, -10),
            text('T168', 'resA_T168', 11, 16, -16),
            text('H170', 'resA_H170', 11, 18, -6),
            text('Y171', 'resA_Y171', 11, -16, -12),
            text('S482', 'resA_S482', 11, 16, 14),
            ...[34, 35, 36].map((s) => num(`dG/C(${s}−30)`, `num_C${s}`)),
            ...[1, 2, 3].map((s) => num(`(${s})`, `num_D${s}`)),
        ],
    },

    // Fig. 2f — substrate DNA at the RuvC/Nuc active site
    c2f: {
        title: 'Fig 2f · cleavage',
        scene: { structureUrl: cifUrl, groups: [
            dom('RuvC', 'A', [[636, 685], [942, 1072]], C.ruvc, 'cartoon'),
            dom('Nuc', 'A', [[1072, 1093]], C.nuc, 'cartoon'),
            stick('subStick', 'E', seqr(28, 36), C.sub),
            stick('resRuvC', 'A', [647, 894, 1074, 849], C.ruvc),
            stick('resNuc', 'A', [915, 944, 912, 952], C.nuc),
        ] },
        view: { targetKey: 'rna_sub', yaw: 240, pitch: 8, zoom: 1.0, radius: 28, roll: 110 },
        labels: [
            pill('Substrate DNA', 'rna_sub', C.sub, '#3A3A3A', -60, -30),
            pill('RuvC', 'dom_RuvCall', C.ruvc, '#fff', 40, -50),
            pill('Nuc', 'dom_Nuc', C.nuc, '#3A3A3A', 40, 40),
            text('D647', 'resA_D647', 11, 16, -12),
            text('E894*', 'resA_E894', 11, 18, -4),
            text('D1074', 'resA_D1074', 11, 16, 8),
            text('N849', 'resA_N849', 11, -16, -14),
            text('W915', 'resA_W915', 11, -18, -4),
            text('T944', 'resA_T944', 11, -18, 8),
            text('L912', 'resA_L912', 11, -20, -12),
            text('R952', 'resA_R952', 11, 16, 16),
            ...seqr(4, 9).map((s) => num(`d${{ 4: 'G', 5: 'G', 6: 'A', 7: 'C', 8: 'T', 9: 'G' }[s]}(${s}*)`, `num_E${s}`)),
        ],
    },
};

export const paper = {
    id: 'cas12i',
    title: 'Cas12i–crRNA–DNA · Zhang 2020 · 6W5C',
    cifUrl,
    anchorsUrl: './structures/label-anchors-cas12i.json',
    figures,
};
