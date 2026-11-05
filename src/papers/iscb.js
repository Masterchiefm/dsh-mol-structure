/**
 * Paper 1: Kato et al., Nat Commun 13, 6719 (2022)
 * "Structure of the IscB–ωRNA ribonucleoprotein complex" — PDB 7XHT.
 *
 * Domains (chain A, Fig. 1a): PLMP 3-55 · RuvC 56-86/165-194/298-370 ·
 * BH 87-122 · REC 123-164 · WED 371-444 · TI 445-496 · GSGG linker 195-198+297-298.
 * Nucleics: B ωRNA (red) · C TS (charcoal) · D NTS (slate) · E n/a · TAM D 0-3.
 */
import { dom, stick, mg, pill, text, marker, num, seqr } from '../helpers.js';

export const COLORS = {
    plmp: '#5158D8', ruvc: '#3E97DE', bh: '#2FCC3B', rec: '#C0C0C0',
    wed: '#EDDE4C', ti: '#DBC79E', linker: '#7B4FD0',
    wrna: '#CF3A3A', ts: '#222426', nts: '#4A4E52', tam: '#9B4FD0',
    ssAlpha: '#E23B3B', ssBeta: '#2D6FD6',
    npks: '#E23B3B', // nexus pseudoknot stem red (Fig 3c close-up; matches STEMS.NPKS)
};

const C = COLORS;
const cifUrl = './structures/7xht.cif';

// ωRNA stems (Fig. 3a/b schematic, paper numbering)
const STEMS = [
    { id: 'Guide', ranges: [[-16, -1]], color: C.wrna },
    { id: 'GAH', ranges: [[1, 44]], color: '#F2C94C' },
    { id: 'NS', ranges: [[45, 49], [148, 153]], color: '#2E8FD8' },
    { id: 'CS', ranges: [[50, 60], [111, 124]], color: '#B9BEC6' },
    { id: 'SL2', ranges: [[61, 76]], color: '#D24B9E' },
    { id: 'NPKH', ranges: [[77, 112]], color: '#E76BB4' },
    { id: 'SL3', ranges: [[125, 147]], color: '#E8923D' },
    { id: 'NPKS', ranges: [[93, 96], [155, 158]], color: '#E23B3B' },
    { id: 'LNK', ranges: [[158, 163]], color: '#EFA83C' },
    { id: 'TH2', ranges: [[164, 180]], color: '#B9AEE4' },
    { id: 'TH1', ranges: [[181, 206]], color: '#5A6FD8' },
];
const stemGroups = () => STEMS.map((s) => dom('stem-' + s.id, 'B', s.ranges, s.color));
const stemPill = (id, colorOverride) => {
    const s = STEMS.find((x) => x.id === id);
    const bg = colorOverride || s.color;
    const dark = ['#F2C94C', '#B9BEC6', '#EFA83C', '#B9AEE4'].includes(bg);
    return pill(s.id, 'rna_' + s.id, bg, dark ? '#3A3A3A' : '#fff');
};

const proteinGroups = (repr = 'cartoon') => [
    dom('PLMP', 'A', [[3, 55]], C.plmp, repr),
    dom('RuvC', 'A', [[56, 86], [165, 194], [298, 370]], C.ruvc, repr),
    dom('BH', 'A', [[87, 122]], C.bh, repr),
    dom('REC', 'A', [[123, 164]], C.rec, repr),
    dom('WED', 'A', [[371, 444]], C.wed, repr),
    dom('TI', 'A', [[445, 496]], C.ti, repr),
    dom('linker', 'A', [[195, 198], [297, 298]], C.linker, repr),
];
const nuclGroups = (dnaColor) => [
    dom('wrna', 'B', [[-16, 206]], C.wrna),
    dom('ts', 'C', [[-11, 17]], dnaColor || C.ts),
    dom('nts', 'D', [[1, 10]], dnaColor ? '#3B3E44' : C.nts),
];

function ssList() {
    const out = [];
    const alpha = { PLMP: 1, RuvC: 5, BH: 2, REC: 1, WED: 2, TI: 1 };
    const beta = { PLMP: 3, RuvC: 6, REC: 2, WED: 5, TI: 6 };
    for (const [d, n] of Object.entries(alpha)) {
        for (let i = 1; i <= n; i++) {
            out.push({ kind: 'text', text: String(i), anchorKey: `ss_alpha_${d}${i}`, size: 11, color: C.ssAlpha });
        }
    }
    for (const [d, n] of Object.entries(beta)) {
        for (let i = 1; i <= n; i++) {
            out.push({ kind: 'text', text: String(i), anchorKey: `ss_beta_${d}${i}`, size: 11, color: C.ssBeta });
        }
    }
    return out;
}

export const figures = {
    fig1b: {
        title: 'Fig 1b · ribbon',
        scene: { structureUrl: cifUrl, groups: [
            ...proteinGroups('cartoon'), ...nuclGroups(), mg(),
        ] },
        view: { yaw: 255, pitch: 12, zoom: 1.15, roll: 135 },
        labels: [
            pill('ωRNA', 'rna_GAH', C.wrna),
            pill('TS', 'end_C_5p', C.ts, '#fff', 0, -30),
            pill('NTS', 'end_D_3p', C.nts, '#fff', 0, -28),
            pill('PLMP', 'dom_PLMP', C.plmp),
            pill('RuvC', 'dom_RuvC', C.ruvc),
            pill('BH', 'dom_BH', C.bh),
            pill('REC', 'dom_REC', C.rec),
            pill('WED', 'dom_WED', C.wed, '#3A3A3A'),
            pill('TI', 'dom_TI', C.ti, '#3A3A3A'),
            marker('3′', 'end_D_3p', '#33363B'),
            marker('5′', 'end_D_5p', '#33363B'),
            marker('5′', 'end_C_5p', '#33363B'),
            marker('3′', 'end_C_3p', '#33363B'),
            marker('5′', 'end_B_5p', C.wrna),
            marker('3′', 'end_B_3p', C.wrna),
        ],
    },

    fig1c: {
        title: 'Fig 1c · surface',
        scene: { structureUrl: cifUrl, groups: [
            ...proteinGroups('molecular-surface'), ...nuclGroups(),
            dom('TAM', 'D', [[0, 3]], C.tam, 'molecular-surface'),
        ] },
        view: { yaw: 255, pitch: 12, zoom: 1.15, roll: 135 },
        labels: [
            pill('ωRNA', 'rna_GAH', C.wrna),
            pill('REC', 'dom_REC', C.rec, '#3A3A3A'),
            pill('BH', 'dom_BH', C.bh),
            pill('WED', 'dom_WED', C.wed, '#3A3A3A'),
            pill('TI', 'dom_TI', C.ti, '#3A3A3A'),
            pill('RuvC', 'dom_RuvC', C.ruvc),
            pill('TAM', 'resD_0', C.tam),
            pill('TS', 'end_C_5p', C.ts),
            pill('NTS', 'end_D_3p', C.nts),
        ],
    },

    fig1cBack: {
        title: 'Fig 1c · 180°',
        scene: { structureUrl: cifUrl, groups: [
            ...proteinGroups('molecular-surface'), ...nuclGroups(),
            dom('TAM', 'D', [[0, 3]], C.tam, 'molecular-surface'),
        ] },
        view: { yaw: 75, pitch: 12, zoom: 1.15, roll: -135 },
        labels: [
            pill('ωRNA', 'rna_TH1', C.wrna),
            pill('PLMP', 'dom_PLMP', C.plmp),
            pill('RuvC', 'dom_RuvC', C.ruvc),
            pill('TAM', 'resD_0', C.tam),
            pill('TS', 'end_C_3p', C.ts),
            pill('NTS', 'end_D_5p', C.nts),
            pill('TI', 'dom_TI', C.ti, '#3A3A3A'),
            pill('WED', 'dom_WED', C.wed, '#3A3A3A'),
        ],
    },

    fig2: {
        title: 'Fig 2 · IscB',
        scene: { structureUrl: cifUrl, groups: [
            ...proteinGroups('cartoon'),
            stick('cat', 'A', [61, 193, 340, 343]),
            stick('plmp', 'A', [13, 14, 15, 16, 17]),
        ] },
        view: { yaw: 250, pitch: 5, zoom: 1.05, roll: 120 },
        labels: [
            pill('REC', 'dom_REC', C.rec, '#3A3A3A'),
            pill('BH', 'dom_BH', C.bh),
            pill('WED', 'dom_WED', C.wed, '#3A3A3A'),
            pill('TI', 'dom_TI', C.ti, '#3A3A3A'),
            pill('RuvC', 'dom_RuvC', C.ruvc),
            pill('PLMP', 'dom_PLMP', C.plmp),
            text('E193', 'resA_E193', 12, -22, -12),
            text('D61', 'resA_D61', 12, -20, 10),
            text('H340', 'resA_H340', 12, 20, -12),
            text('D343', 'resA_D343', 12, -18, 14),
            text('P14', 'resA_P14', 12, 14, -12),
            text('P17', 'resA_P17', 12, -18, -10),
            text('M16', 'resA_M16', 12, -20, 8),
            text('L15', 'resA_L15', 12, 8, 12),
            text('N', 'resA_N13', 11, -6, 8),
            text('198', 'resA_198', 12, -18, 0),
            text('297', 'resA_297', 12, 16, -6),
            text('C', 'resA_496', 12, 12, 10),
            { kind: 'circle', text: 'HNH', anchorMid: ['resA_198', 'resA_297'], bg: '#F5A9E8', color: '#fff', size: 120 },
            ...ssList(),
        ],
    },

    fig3bA: {
        title: 'Fig 3b · ωRNA',
        scene: { structureUrl: cifUrl, groups: stemGroups() },
        view: { yaw: 250, pitch: 8, zoom: 1.1, roll: 120 },
        labels: [
            stemPill('SL2'), stemPill('CS'), stemPill('GAH'), stemPill('NS'),
            stemPill('NPKH'), stemPill('NPKS'), stemPill('LNK'), stemPill('TH2'),
            stemPill('TH1'), stemPill('SL3'),
        ],
    },

    fig3bB: {
        title: 'Fig 3b · ωRNA 140°',
        scene: { structureUrl: cifUrl, groups: stemGroups() },
        view: { yaw: 110, pitch: 8, zoom: 1.1, roll: 120 },
        labels: [
            stemPill('SL2'), stemPill('CS'), stemPill('SL3'), stemPill('NS'),
            stemPill('NPKS'), stemPill('NPKH'), stemPill('LNK'), stemPill('TH2'),
            stemPill('TH1'),
        ],
    },

    fig3c: {
        title: 'Fig 3c · pseudoknot',
        scene: { structureUrl: cifUrl, groups: [
            ...stemGroups(),
            stick('npk', 'B', [...seqr(80, 98), ...seqr(149, 160)]),
            dom('npkCart', 'B', [[80, 98], [149, 160]], C.npks),
        ] },
        view: { targetKey: 'rna_NPKS', yaw: 240, pitch: 10, zoom: 1.0, radius: 48, roll: 100 },
        labels: [
            pill('Nexus pseudoknot stem', 'rna_NPKS', C.npks, '#fff', 40, 40),
            pill('Nexus stem', 'rna_NS', '#2E8FD8', '#fff', -40, -60),
            text('U80', 'resB_U80', 11, -16, -10),
            text('G88', 'resB_G88', 11, 14, -10),
            text('U91', 'resB_U91', 11, -18, 2),
            text('U92', 'resB_U92', 11, -14, 10),
            text('C93', 'resB_C93', 11, 12, 12),
            text('G149', 'resB_G149', 11, 14, -10),
            text('C153', 'resB_C153', 11, 12, -12),
            text('C154', 'resB_C154', 11, -14, -8),
            text('G155', 'resB_G155', 11, 14, 8),
            text('G158', 'resB_G158', 11, 16, 10),
            text('G159', 'resB_G159', 11, -16, 8),
            text('A160', 'resB_A160', 11, 14, 12),
        ],
    },

    fig4a: {
        title: 'Fig 4a · interactions',
        scene: { structureUrl: cifUrl, groups: [
            ...proteinGroups('molecular-surface'),
            dom('wrnaRed', 'B', [[-16, 206]], C.wrna),
            dom('tsDark', 'C', [[-11, 17]], '#3B3E44'),
            dom('ntsDark', 'D', [[1, 10]], '#3B3E44'),
        ] },
        view: { yaw: 255, pitch: 12, zoom: 1.15, roll: 135 },
        labels: [
            pill('SL2', 'rna_SL2', C.wrna),
            pill('CS', 'rna_CS', C.wrna),
            pill('GAH', 'rna_GAH', C.wrna),
            pill('Guide', 'rna_Guide', C.wrna),
            pill('REC', 'dom_REC', C.rec, '#3A3A3A'),
            pill('BH', 'dom_BH', C.bh),
            pill('WED', 'dom_WED', C.wed, '#3A3A3A'),
            pill('TI', 'dom_TI', C.ti, '#3A3A3A'),
            pill('RuvC', 'dom_RuvC', C.ruvc),
            pill('PLMP', 'dom_PLMP', C.plmp),
            pill('DNA', 'end_D_3p', '#3B3E44', '#fff', 0, -26),
            pill('NS', 'rna_NS', C.wrna),
            pill('NPKH', 'rna_NPKH', C.wrna),
            pill('NPKS', 'rna_NPKS', C.wrna),
            pill('LNK', 'rna_LNK', C.wrna),
            pill('TH1', 'rna_TH1', C.wrna),
            pill('TH2', 'rna_TH2', C.wrna),
        ],
    },

    fig4aBack: {
        title: 'Fig 4a · 180°',
        scene: { structureUrl: cifUrl, groups: [
            ...proteinGroups('molecular-surface'),
            dom('wrnaRed', 'B', [[-16, 206]], C.wrna),
            dom('tsDark', 'C', [[-11, 17]], '#3B3E44'),
            dom('ntsDark', 'D', [[1, 10]], '#3B3E44'),
        ] },
        view: { yaw: 75, pitch: 12, zoom: 1.15, roll: -135 },
        labels: [
            pill('REC', 'dom_REC', C.rec, '#3A3A3A'),
            pill('CS', 'rna_CS', C.wrna),
            pill('SL2', 'rna_SL2', C.wrna),
            pill('GAH', 'rna_GAH', C.wrna),
            pill('BH', 'dom_BH', C.bh),
            pill('WED', 'dom_WED', C.wed, '#3A3A3A'),
            pill('NS', 'rna_NS', C.wrna),
            pill('NPKH', 'rna_NPKH', C.wrna),
            pill('NPKS', 'rna_NPKS', C.wrna),
            pill('LNK', 'rna_LNK', C.wrna),
            pill('TI', 'dom_TI', C.ti, '#3A3A3A'),
            pill('TH1', 'rna_TH1', C.wrna),
            pill('TH2', 'rna_TH2', C.wrna),
            pill('RuvC', 'dom_RuvC', C.ruvc),
            pill('PLMP', 'dom_PLMP', C.plmp),
        ],
    },

    fig4c: {
        title: 'Fig 4c · seed',
        scene: { structureUrl: cifUrl, groups: [
            ...proteinGroups('cartoon'), ...stemGroups(),
            stick('guideSeed', 'B', [...seqr(-16, -1), 43, 44]),
            stick('argsC', 'A', [102, 106, 107, 108, 110, 111, 115, 166]),
        ] },
        view: { targetKey: 'rna_Guide', yaw: 250, pitch: 8, zoom: 1.0, radius: 45, roll: 110 },
        labels: [
            pill('Guide', 'rna_Guide', C.wrna, '#fff', -60, -20),
            pill('BH', 'dom_BH', C.bh, '#fff', 30, 30),
            pill('WED', 'dom_WED', C.wed, '#3A3A3A', 40, 60),
            pill('REC', 'dom_REC', C.rec, '#3A3A3A', 0, -40),
            text('R111', 'resA_R111', 11, 14, -8),
            text('R115', 'resA_R115', 11, 14, -12),
            text('R110', 'resA_R110', 11, 16, -6),
            text('R107', 'resA_R107', 11, 18, -8),
            text('R106', 'resA_R106', 11, 16, 8),
            text('R102', 'resA_R102', 11, 16, 12),
            text('R108', 'resA_R108', 11, 20, 4),
            text('T166', 'resA_T166', 11, -16, 14),
            ...seqr(-11, -1).map((s) => num(String(s), `num_B${s}`)),
            num('43', 'num_B43'),
        ],
        hbonds: [
            ['resA_R111', 'num_B-4'],
            ['resA_R110', 'num_B-3'],
            ['resA_R107', 'num_B-2'],
            ['resA_R106', 'num_B-1'],
            ['resA_R102', 'num_B-7'],
            ['resA_T166', 'num_B-11'],
        ],
    },

    fig4d: {
        title: 'Fig 4d · NPKH',
        scene: { structureUrl: cifUrl, groups: [
            ...proteinGroups('cartoon'), ...stemGroups(),
            stick('npkSeq', 'B', [...seqr(93, 102), 150]),
            stick('argsD', 'A', [142, 144, 149, 152, 154, 156]),
        ] },
        view: { targetKey: 'rna_NPKS', yaw: 230, pitch: 12, zoom: 1.0, radius: 48, roll: 110 },
        labels: [
            pill('NPKH', 'rna_NPKH', C.wrna, '#fff', -60, -30),
            pill('Guide', 'rna_Guide', C.wrna, '#fff', 60, 30),
            pill('REC', 'dom_REC', C.rec, '#3A3A3A', 0, -40),
            pill('BH', 'dom_BH', C.bh, '#fff', 40, 40),
            text('R152', 'resA_R152', 11, 16, -10),
            text('K149', 'resA_K149', 11, 14, 4),
            text('K144', 'resA_K144', 11, 18, -10),
            text('T142', 'resA_T142', 11, 14, 10),
            text('R156', 'resA_R156', 11, -18, -6),
            text('N154', 'resA_N154', 11, 16, 12),
            ...seqr(95, 102).map((s) => num(String(s), `num_B${s}`)),
            num('150', 'num_B150'),
        ],
        hbonds: [
            ['resA_K144', 'num_B-3'],
            ['resA_T142', 'num_B-2'],
            ['resA_R152', 'resB_C93'],
            ['resA_K149', 'num_B96'],
            ['resA_R156', 'num_B99'],
            ['resA_N154', 'num_B150'],
        ],
    },

    fig4e: {
        title: 'Fig 4e · TAM',
        scene: { structureUrl: cifUrl, groups: [
            ...proteinGroups('cartoon'),
            stick('duplex', 'C', [...seqr(-11, 17)]),
            stick('duplexN', 'D', [...seqr(1, 10)]),
            stick('tam', 'D', [0, 1, 2, 3], '#9B4FD0'),
        ] },
        view: { targetKey: 'resD_1', yaw: 60, pitch: 12, zoom: 1.0, radius: 42, roll: 100 },
        labels: [
            pill('WED', 'dom_WED', C.wed, '#3A3A3A', -40, -50),
            pill('TAM', 'resD_1', C.tam, '#fff', -50, -20),
            pill('TI', 'dom_TI', C.ti, '#3A3A3A', 40, 50),
            text('H380', 'resA_H380', 11, -16, -12),
            text('R439', 'resA_R439', 11, -18, -4),
            text('S459', 'resA_S459', 11, -18, 10),
            text('R462', 'resA_R462', 11, 12, -14),
            text('E460', 'resA_E460', 11, 16, 8),
            text('Y469', 'resA_Y469', 11, 14, 14),
            text('W479', 'resA_W479', 11, -10, 20),
            ...seqr(1, 6).map((s) => num(`${s}*`, `num_C${s}`)),
            ...seqr(-4, -1).map((s) => num(String(s), `num_C${s}`)),
        ],
        hbonds: [
            ['resA_R439', 'num_C1'],
            ['resA_R462', 'num_C-4'],
            ['resA_S459', 'num_C-5'],
            ['resA_G461', 'num_C4'],
            ['resA_Y469', 'num_C-6'],
            ['resA_W479', 'num_C-6'],
            ['resA_H380', 'num_C-1'],
        ],
    },
};

export const paper = {
    id: 'iscb',
    title: 'IscB–ωRNA–DNA · Kato 2022 · 7XHT',
    cifUrl,
    anchorsUrl: './structures/label-anchors-iscb.json',
    figures,
};
