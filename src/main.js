/**
 * dsh-mol-structure — publication-figure reproduction of Kato et al., Nat Commun 13,
 * 6719 (2022) "Structure of the IscB–ωRNA ribonucleoprotein complex" (PDB 7XHT)
 * with a locally installed Mol* v5 viewer.
 *
 * All figure definitions live in src/config.js; scene construction in
 * src/scenes.js; HTML label overlays in src/labels.js.
 *
 * When served by the dsh plugin (/api/mol-structure/viewer/), src/bridge.js
 * connects to the plugin host: the agent's tools submit commands (figure
 * panels, camera, labels, H-bonds, queries…), and user selections / clicks in
 * Mol* are reported back so the agent can see what the user is looking at.
 */
import { Viewer } from 'molstar/lib/apps/viewer/app.js';
import { IlluminationPass } from 'molstar/lib/mol-canvas3d/passes/illumination.js';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra/3d/vec3.js';
import { Color } from 'molstar/lib/mol-util/color/index.js';
import { StructureElement } from 'molstar/lib/mol-model/structure/structure/element.js';

import { FIGURES, PAPERS } from './config.js';
import { buildScene, residueLoci } from './scenes.js';
import { createLabelManager } from './labels.js';
import { createBridge } from './bridge.js';
import { createCommandHandlers, describeElementLoci, lociIsEmpty } from './commands.js';

// ---------------------------------------------------------------------------
// camera helpers
// ---------------------------------------------------------------------------

function orbitSnapshot(viewer, pose, anchors) {
    const bs = viewer.plugin.canvas3d.boundingSphere;
    const defCenter = bs && bs.center ? Vec3.clone(bs.center) : Vec3.clone(viewer.plugin.canvas3d.camera.state.target);
    const defRadius = bs && bs.radius ? bs.radius : 100;

    const target = pose.target && pose.target.length >= 3
        ? Vec3.fromArray(Vec3(), pose.target, 0)
        : (pose.targetKey && anchors && anchors[pose.targetKey])
            ? Vec3.fromArray(Vec3(), anchors[pose.targetKey], 0)
            : defCenter;
    const radius = pose.radius || defRadius;

    const yaw = pose.yaw * Math.PI / 180;
    const pitch = pose.pitch * Math.PI / 180;
    const dir = Vec3.create(
        Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch),
    );
    let up = Vec3.create(0, 1, 0);
    const dot = Vec3.dot(dir, up);
    up = Vec3.normalize(Vec3(), Vec3.create(-dir[0] * dot, 1 - dot * dot, -dir[2] * dot));
    const rollDeg = pose.roll || 0;
    if (rollDeg !== 0) {
        const r = rollDeg * Math.PI / 180;
        const kxv = Vec3.cross(Vec3(), dir, up);
        const kdv = Vec3.dot(dir, up);
        const cr = Math.cos(r), sr = Math.sin(r);
        up = Vec3.normalize(Vec3(), Vec3.create(
            up[0] * cr + kxv[0] * sr + dir[0] * kdv * (1 - cr),
            up[1] * cr + kxv[1] * sr + dir[1] * kdv * (1 - cr),
            up[2] * cr + kxv[2] * sr + dir[2] * kdv * (1 - cr),
        ));
    }
    const cam = viewer.plugin.canvas3d.camera;
    const dist = cam.getTargetDistance(radius / pose.zoom);
    return {
        target: Vec3.clone(target),
        position: Vec3.create(target[0] + dir[0] * dist, target[1] + dir[1] * dist, target[2] + dir[2] * dist),
        up,
        radius: radius / pose.zoom,
    };
}

function applyView(viewer, pose, anchors) {
    viewer.plugin.canvas3d.camera.setState(orbitSnapshot(viewer, pose, anchors), 0);
    viewer.plugin.canvas3d.requestDraw();
}

function rotateBy(viewer, deltaDeg, anchors) {
    const cam = viewer.plugin.canvas3d.camera;
    const st = cam.state;
    const dir = Vec3.sub(Vec3(), st.position, st.target);
    const len = Vec3.norm(dir);
    const yaw = Math.atan2(dir[0], dir[2]) + deltaDeg * Math.PI / 180;
    const pitch = Math.asin(Math.min(1, Math.max(-1, dir[1] / len)));
    const snapshot = orbitSnapshot(viewer, { yaw: yaw * 180 / Math.PI, pitch: pitch * 180 / Math.PI, zoom: 1 }, anchors);
    cam.setState({ ...snapshot, target: Vec3.clone(st.target) }, 0);
    viewer.plugin.canvas3d.requestDraw();
}

// ---------------------------------------------------------------------------
// H-bond lines (Fig. 4c–e) via the measurement manager.
// Mol* lines are solid; the paper draws dashed cyan — same color, noted in SOP.
// ---------------------------------------------------------------------------

function parseAnchorKey(k) {
    const mRes = k.match(/^res([A-Z])_(-?\d+)$/); // resA_D61 → chain A 61; resB_C93 → chain B 93
    if (mRes) return { chain: mRes[1], seq: Number(mRes[2]) };
    const mNum = k.match(/^num_([A-Z])(-?\d+)$/); // num_B-7 → chain B -7
    if (mNum) return { chain: mNum[1], seq: Number(mNum[2]) };
    return null;
}

async function addHbonds(viewer, structure, pairs) {
    for (const [keyA, keyB] of pairs) {
        const a = parseAnchorKey(keyA);
        const b = parseAnchorKey(keyB);
        if (!a || !b) { console.warn('hbond: bad key', keyA, keyB); continue; }
        const lociA = await residueLoci(viewer.plugin, structure, a.chain, a.seq);
        const lociB = await residueLoci(viewer.plugin, structure, b.chain, b.seq);
        try {
            await viewer.plugin.managers.structure.measurement.addDistance(lociA, lociB, {
                customText: ' ',
                visualParams: {
                    visuals: ['lines'],
                    textColor: Color.fromHexStyle('#4FC3F7'),
                    textSize: 0.01,
                    borderWidth: 0,
                    unitLabel: '',
                },
                lineParams: { lineSize: 1.5 },
            });
        } catch (e) {
            console.warn('hbond line failed', keyA, keyB, e);
        }
    }
}

// ---------------------------------------------------------------------------
// app bootstrap
// ---------------------------------------------------------------------------

async function main() {
    const status = document.getElementById('status');
    const setStatus = (s) => { status.textContent = s; };

    // --- simple vs full viewer mode ------------------------------------------
    // simple: agent-driven canvas (paper card, no native panels) — the default;
    // full: the complete Mol* app (left controls, sequence, log, viewport
    // toolbar) like molstar.org/viewer. The choice lives in localStorage so it
    // survives reloads; the host's default (Settings → defaultMode) applies
    // when the user has never chosen explicitly.
    const MODE_KEY = 'mol-structure:mode';
    let fullMode = false;
    try { fullMode = localStorage.getItem(MODE_KEY) === 'full'; } catch { /* storage off */ }

    // Memory fix (2026-11): Mol*'s IlluminationPass allocates its GPU tracing
    // cubemaps + render targets at canvas×pixelScale² (~1.4 GB on a 1400×900
    // pane with pixelScale 2) in setSize() — *even when illumination.enabled
    // is false*, which is how this viewer always runs (classic pipeline).
    // The pass lives inside the Canvas3D closure, so patch the prototype here,
    // before Viewer.create: while the pass stays disabled, pin its private
    // targets to 1×1 (drawPass sizing preserved).
    try {
        const proto = IlluminationPass.prototype;
        if (proto.setSize && !proto.__molStructurePatched) {
            proto.__molStructurePatched = true;
            proto.setSize = function (width, height) {
                if (!this._supported) return;
                if (this.tracing?.composeTarget?.getWidth?.() !== 1) {
                    this.tracing.setSize(1, 1);
                    this.transparentTarget.setSize(1, 1);
                    this.outputTarget.setSize(1, 1);
                    this.multiSampleComposeTarget.setSize(1, 1);
                    this.multiSampleHoldTarget.setSize(1, 1);
                    this.multiSampleAccumulateTarget.setSize(1, 1);
                }
                return this.drawPass.setSize(width, height);
            };
        }
    } catch { /* older Mol* without the illumination pass — nothing to pin */ }

    const viewer = await Viewer.create(document.getElementById('app'), {
        layoutIsExpanded: false,
        layoutShowControls: fullMode,
        layoutShowRemoteState: false,
        layoutShowSequence: fullMode,
        layoutShowLog: fullMode,
        layoutShowLeftPanel: fullMode,
        viewportShowExpand: fullMode,
        viewportShowControls: fullMode,
        viewportShowSelectionMode: true, // bridge select ops + user click-selection
        viewportShowAnimation: fullMode,
        viewportShowTrajectoryControls: fullMode,
        viewportShowScreenshotControls: fullMode,
        viewportShowReset: fullMode,
        viewportBackgroundColor: 'white',
        pixelScale: 1.5, // host Settings can override (hello ui.pixelScale); 2 was very GPU-hungry
        illumination: false,
    });
    const plugin = viewer.plugin;
    window.__viewer = viewer; // debugging hook (used by SOP verification steps)

    // Guard: a hidden sidebar tab collapses the canvas to 0×0 CSS px. Mol*'s
    // tick → updateSize → setSize then throws "empty textures are not allowed"
    // (red banner the moment the user switches back to the tab). Skip every
    // tick — including internal rAF-loop ones that go through this method —
    // while the canvas has no layout size; it self-heals on visibility.
    const c3d = plugin.canvas3d;
    const rawTick = c3d.tick.bind(c3d);
    c3d.tick = (now, opts) => {
        const c = c3d.webgl?.gl?.canvas;
        if (!c || c.clientWidth === 0 || c.clientHeight === 0) return;
        return rawTick(now, opts);
    };
    // Escape hatch for mol_screenshot: it loans the hidden canvas a fixed
    // offscreen size first, so it must bypass the 0×0 guard.
    c3d.__rawTick = rawTick;

    const anchorsAll = {};
    for (const p of PAPERS) {
        anchorsAll[p.id] = await (await fetch(p.anchorsUrl)).json();
    }
    const anchorsFor = (fig) => anchorsAll[FIGURES[fig].paperId];
    window.__anchorsAll = anchorsAll;

    const canvas = plugin.canvas3d.webgl.gl.canvas;
    const labels = createLabelManager(viewer, canvas);
    window.__labels = labels; // debugging hook
    let labelsVisible = true;
    viewer.subscribe(plugin.canvas3d.camera.stateChanged, () => labels.refresh());
    window.addEventListener('resize', () => labels.refresh());

    let currentStructure = null;
    let currentStructureUrl = null;
    let currentFigure = null;
    let bridge = null;
    let sceneBuilds = 0; // in-progress buildSceneGeneric calls (camera timers must yield)
    let lastRender = null; // last figure/scene request, replayed by 「重载视图」

    async function applyFigure(id) {
        const fig = FIGURES[id];
        if (!fig) return;
        const anchors = anchorsFor(id);
        setActive(id);
        setStatus(`building ${id}…`);
        currentStructure = await buildScene(viewer, fig.scene);
        currentStructureUrl = new URL(fig.scene.structureUrl, location.href).href;
        applyView(viewer, fig.view, anchors);
        // Mol* auto-focuses the camera when new representations settle; re-apply
        // our calibrated pose after it has finished so close-up views survive.
        await new Promise((r) => setTimeout(r, 400));
        applyView(viewer, fig.view, anchors);
        await new Promise((r) => setTimeout(r, 800));
        applyView(viewer, fig.view, anchors);
        currentFigure = id;
        lastRender = { kind: 'figure', id };
        updatePaperVisibility();
        // labels
        const spec = (fig.labels || []).map((l) => {
            let anchor = null;
            if (l.anchorMid) {
                const a = anchors[l.anchorMid[0]], b = anchors[l.anchorMid[1]];
                if (a && b) anchor = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
            } else if (l.anchorKey && anchors[l.anchorKey]) {
                anchor = anchors[l.anchorKey];
            }
            // calibrated paper marks stay centered (leader style is for live annotation)
            return anchor ? { ...l, anchor, centered: true } : null;
        }).filter(Boolean);
        labels.set(spec);
        // H-bond lines
        if (fig.hbonds && fig.hbonds.length) {
            await addHbonds(viewer, currentStructure, fig.hbonds);
        }
        setStatus('ready');
        if (bridge) bridge.reportStatus({ figure: id });
    }

    // --- bridge API --------------------------------------------------------
    // The context the command dispatcher and selection reporter share.
    const paperIdOfUrl = (url) => (url && /6w5c/i.test(url) ? 'cas12i' : 'iscb');
    let agentSelectAt = 0; // selections the agent just made; the changed-event echo is theirs
    const customPanels = new Map(); // id → spec, mirrored from the host registry over SSE

    // declared before the api object that captures it (and before first use by
    // applyFigure); matches built-in `btn-<id>` and custom `btn-custom-<id>`
    function setActive(id) {
        for (const b of document.querySelectorAll('.control-card button')) {
            b.classList.toggle('active', b.id === `btn-${id}` || b.id === `btn-custom-${id}`);
        }
    }

    const api = {
        plugin,
        viewer,
        labels,
        FIGURES,
        customPanels,
        get anchors() { return anchorsAll[currentFigure ? FIGURES[currentFigure].paperId : paperIdOfUrl(currentStructureUrl)]; },
        get currentFigure() { return currentFigure; },
        set currentFigure(v) { currentFigure = v; },
        get structure() { return currentStructure; },
        get sceneBuilding() { return sceneBuilds > 0; },
        get structureUrl() { return currentStructureUrl; },
        setStructure(s, url) {
            currentStructure = s;
            if (url) currentStructureUrl = url;
            updatePaperVisibility();
        },
        applyFigure,
        applyView: (pose, anchors) => {
            applyView(viewer, pose, anchors ?? (currentFigure ? anchorsFor(currentFigure) : null));
            try { api.setCameraPin(camera.state.target); } catch { /* camera not ready */ }
        },
        rotateBy: (deltaDeg) => rotateBy(viewer, deltaDeg, currentFigure ? anchorsFor(currentFigure) : null),
        buildSceneGeneric: (cfg) => {
            sceneBuilds++;
            return buildScene(viewer, cfg).finally(() => { sceneBuilds--; });
        },
        reportStatus: (patch) => { if (bridge) bridge.reportStatus(patch); },
        reportSelection: (patch) => { if (bridge) bridge.reportSelection(patch); },
        markAgentSelection: () => { agentSelectAt = Date.now(); },
        setActive,
        status: () => ({
            status: status.textContent,
            figure: currentFigure,
            structure: currentStructureUrl ? currentStructureUrl.split('/').pop() : null,
        }),
        readSelection: () => {
            const out = { atoms: 0, residues: [], truncated: false };
            try {
                for (const entry of plugin.managers.structure.selection.entries.values()) {
                    const d = describeElementLoci(entry.selection);
                    out.atoms += d.atoms;
                    for (const r of d.residues) {
                        if (!out.residues.some((x) => x.chain === r.chain && x.seq === r.seq)) out.residues.push(r);
                    }
                    out.truncated = out.truncated || d.truncated;
                }
            } catch { /* selection read is best-effort */ }
            return out;
        },
        isFullMode: () => fullMode,
        setFullMode: (target) => {
            const want = Boolean(target);
            if (want === fullMode) return { full: fullMode, reloading: false };
            try { localStorage.setItem(MODE_KEY, want ? 'full' : 'simple'); } catch { /* storage off */ }
            setStatus(want ? '切换到完整 Mol* 模式…' : '切换到简洁模式…');
            setTimeout(() => { location.reload(); }, 800); // let the op result POST first
            return { full: want, reloading: true };
        },
    };

    function setModeButton() {
        const b = document.getElementById('btn-mode');
        if (!b) return;
        b.textContent = fullMode ? '完整 Mol*：开' : '完整 Mol*：关';
        b.classList.toggle('active', fullMode);
        b.title = fullMode
            ? '已开启完整 Mol* 界面（左侧控制树 / 序列 / 工具栏）。点击切回简洁 agent 模式。'
            : '开启完整 Mol* 界面：左侧控制树、序列、截图/动画工具栏（类似 molstar.org/viewer）';
    }
    document.getElementById('btn-mode')?.addEventListener('click', () => {
        api.setFullMode(!fullMode);
        setModeButton();
    });
    setModeButton();

    // --- selection / click reporting ---------------------------------------
    // The user's picks flow to the host (POST /selection) so the agent can see
    // what the user is looking at; the Mol* selection service state is also
    // readable on demand via the mol_select tool.
    //
    // Camera-center control: an empty click in Mol* resets the view to the
    // structure's default center, which silently throws away an interface
    // close-up. We remember the camera state on pointer-down and restore it on
    // empty clicks; Shift+click re-centers on a residue, and 「点击定中心」
    // makes the next click re-center without resetting zoom.
    const camera = plugin.canvas3d.camera;
    let pinnedTarget = null;      // center an empty click falls back to
    let preClickState = null;     // camera snapshot taken on pointer-down
    let pickCenterMode = false;
    let restoringCamera = false;
    canvas.addEventListener('pointerdown', () => {
        const st = camera.state;
        preClickState = { position: [...st.position], target: [...st.target], up: [...st.up], radius: st.radius };
    });
    function applyCameraState(st) {
        restoringCamera = true;
        try {
            camera.setState({ position: [...st.position], target: [...st.target], up: [...st.up], radius: st.radius }, 0);
        } finally {
            setTimeout(() => { restoringCamera = false; }, 60);
        }
        try { plugin.canvas3d.requestDraw(); } catch { /* drawing already */ }
    }
    function recenterOn(point) {
        const st = camera.state;
        const d = [st.position[0] - st.target[0], st.position[1] - st.target[1], st.position[2] - st.target[2]];
        const target = [point[0], point[1], point[2]];
        pinnedTarget = target;
        applyCameraState({
            position: [target[0] + d[0], target[1] + d[1], target[2] + d[2]],
            target, up: [...st.up], radius: st.radius,
        });
        return target;
    }
    function lociCenter(loci) {
        try {
            const sphere = StructureElement.Loci.getBoundary(loci).sphere;
            return sphere && sphere.center ? [sphere.center[0], sphere.center[1], sphere.center[2]] : null;
        } catch { return null; }
    }
    api.setCameraPin = (target) => { if (target && target.length >= 3) pinnedTarget = [target[0], target[1], target[2]]; };
    api.recenterOn = recenterOn;
    api.setPickCenter = (on) => { pickCenterMode = on !== false; };
    api.cameraCenter = () => (pinnedTarget ? [...pinnedTarget] : null);
    function setPickCenterButton(on) {
        const b = document.getElementById('btn-pick-center');
        if (!b) return;
        b.classList.toggle('active', Boolean(on));
        b.textContent = on ? '点击定中心（点一个残基）' : '点击定中心';
    }

    plugin.canvas3d.interaction.click.subscribe((evt) => {
        const loci = evt?.current?.loci;
        const list = Array.isArray(loci) ? loci : loci ? [loci] : [];
        const el = list.find((l) => StructureElement.Loci.is(l));
        const hit = Boolean(el && !lociIsEmpty(el));
        const modifiers = evt?.current?.modifiers ?? [];
        if (pickCenterMode) {
            pickCenterMode = false;
            setPickCenterButton(false);
            if (hit) {
                const center = lociCenter(el);
                if (center) { recenterOn(center); setStatus('中心已重设（保持当前缩放）'); return; }
            }
            setStatus('拾取中心：请点击一个残基');
            return;
        }
        if (hit && modifiers.includes('shift')) {
            const center = lociCenter(el);
            if (center) { recenterOn(center); setStatus('中心已重设（保持当前缩放）'); }
        } else if (!hit && !fullMode && pinnedTarget && preClickState) {
            // Empty click: Mol* re-focuses the whole structure (animated), which
            // silently discards a close-up. Full Mol* mode keeps the native
            // behaviour instead of overriding it.
            // its ~250ms camera animation has landed.
            const snapshot = preClickState;
            applyCameraState(snapshot);
            setTimeout(() => applyCameraState(snapshot), 120);
            setTimeout(() => applyCameraState(snapshot), 380);
        }
        if (hit) {
            const d = describeElementLoci(el, 10);
            const text = d.residues.map((r) => `${r.chain}/${r.seq} ${r.comp}`).join(', ') || `${d.atoms} atoms`;
            bridge?.reportSelection({ source: 'user', kind: 'click', text, ...d });
        }
    });
    plugin.managers.structure.selection.events.changed.subscribe(() => {
        const source = Date.now() - agentSelectAt < 500 ? 'agent' : 'user';
        const d = api.readSelection();
        const text = d.residues.map((r) => `${r.chain}/${r.seq} ${r.comp}`).join(', ')
            || (d.atoms ? `${d.atoms} atoms` : 'empty');
        bridge?.reportSelection({ source, kind: 'select', text, ...d });
    });

    // --- bridge (no-op unless served by the plugin host) --------------------
    const dispatcher = createCommandHandlers(api);
    api.dispatch = dispatcher.dispatch; // debugging hook (window.__molApi.dispatch)

    // Custom panels: the host registry is the source of truth; it pushes the
    // full list on SSE hello and on every define/remove. Each entry becomes a
    // button in the control card's 自定义视图 group, applied like a figure.
    function setCustomPanels(list) {
        customPanels.clear();
        for (const p of list || []) customPanels.set(p.id, p);
        renderCustomPanelButtons();
    }
    /** Action panels (kind=action) render as quick-command buttons, not views. */
    function renderActionButtons() {
        const row = document.getElementById('action-row');
        if (!row) return;
        row.innerHTML = '';
        const actions = [...customPanels.values()].filter((p) => p.kind === 'action');
        if (actions.length === 0) {
            const hint = document.createElement('span');
            hint.style.color = '#888';
            hint.textContent = '尚未注册 — 对话里说“注册一组操作按钮”即可';
            row.appendChild(hint);
            return;
        }
        for (const spec of actions) {
            const b = document.createElement('button');
            b.id = `btn-action-${spec.id}`;
            b.textContent = spec.title || spec.id;
            b.title = (spec.actions || []).map((a) => `${a.label || a.op}`).join(' → ');
            b.onclick = () => {
                setStatus(`运行 ${spec.title || spec.id}…`);
                dispatcher.dispatch('figure', { id: spec.id })
                    .then(() => setStatus('done'))
                    .catch((e) => setStatus(`error (${spec.id}): ${e?.message || e}`));
            };
            row.appendChild(b);
        }
    }
    function renderCustomPanelButtons() {
        const row = document.getElementById('custom-row');
        if (!row) return;
        row.innerHTML = '';
        const views = [...customPanels.values()].filter((p) => p.kind !== 'action');
        if (views.length === 0) {
            const hint = document.createElement('span');
            hint.style.color = '#888';
            hint.textContent = '尚未注册 — 对话里说“注册一个视图”即可（mol_panel_define）';
            row.appendChild(hint);
            renderActionButtons();
            return;
        }
        for (const spec of views) {
            const b = document.createElement('button');
            b.id = `btn-custom-${spec.id}`;
            b.textContent = spec.title || spec.id;
            b.title = `${spec.title || spec.id}（${spec.id}）`;
            b.onclick = () => {
                setStatus(`building ${spec.title || spec.id}…`);
                dispatcher.dispatch('figure', { id: spec.id })
                    .then((r) => rememberRender('figure', { id: spec.id }, r))
                    .catch((e) => setStatus(`error (${spec.id}): ${e?.message || e}`));
            };
            row.appendChild(b);
        }
        renderActionButtons();
    }
    // Control card: in embedded mode start collapsed (the viewer is agent-
    // driven; the chip brings the paper-panel buttons back), standalone keeps
    // it open. Host config `controlCard: 'show'|'hide'` overrides 'auto'.
    const controlCard = document.querySelector('.control-card');
    const cardToggle = document.getElementById('btn-card-toggle');
    function applyControlCardMode(mode) {
        if (!controlCard) return;
        if (mode === 'hide') {
            controlCard.classList.add('collapsed');
            cardToggle.classList.add('hidden');
        } else if (mode === 'show') {
            controlCard.classList.remove('collapsed');
        } else { // 'auto'
            controlCard.classList.toggle('collapsed', Boolean(bridge?.enabled));
        }
    }
    cardToggle?.addEventListener('click', () => {
        controlCard.classList.toggle('collapsed');
        setStatus('ready');
    });
    // --- render resolution (GPU memory knob) ---------------------------------
    // pixelScale² drives every render target's memory; the host sends its
    // Settings → pixelScale (default 1.5) over hello/settings. Applied live.
    let pixelScaleApplied = null;
    function applyPixelScale(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0.5 || n > 3 || n === pixelScaleApplied) return;
        pixelScaleApplied = n;
        try {
            plugin.canvas3d.setProps({ pixelScale: n });
        } catch (e) {
            console.warn('pixelScale apply failed', e);
        }
    }
    // --- render recovery: reload button + return-to-foreground redraw --------
    // A minimized/backgrounded window can lose its WebGL frames (Chromium may
    // discard the context, and rAF stops), so returning to the app can show an
    // empty canvas. 「重载视图」rebuilds the last figure/scene (persisted in
    // sessionStorage so it survives a page reload); coming back to the
    // foreground forces one synchronous frame immediately.
    try {
        const saved = sessionStorage.getItem('mol-structure:lastRender');
        if (saved) lastRender = JSON.parse(saved);
    } catch { /* storage unavailable */ }
    function rememberRender(op, args, result) {
        const structureUrl = api.structureUrl || lastRender?.structureUrl || null;
        // Keep the real filename from the load call: api.status().structure is a
        // token id (fN) after replay, and the loader uses it for format hints.
        const structureName = lastRender?.structureName || null;
        if (op === 'figure') {
            lastRender = { kind: 'figure', id: result?.figure ?? args?.id ?? args?.figure, structureUrl, structureName };
        } else if (op === 'scene') {
            lastRender = { kind: 'scene', cfg: { structureUrl: args?.structureUrl ?? structureUrl, groups: args?.groups }, structureUrl, structureName };
        } else if (op === 'load') {
            lastRender = {
                kind: 'load',
                cfg: { url: args?.url, name: args?.name },
                structureUrl: args?.url ?? structureUrl,
                structureName: args?.name ?? structureName,
            };
        }
        try { sessionStorage.setItem('mol-structure:lastRender', JSON.stringify(lastRender)); } catch { /* quota */ }
    }
    function forceDraw() {
        try { plugin.canvas3d.tick(performance.now(), { isSynchronous: true }); } catch { /* drawing */ }
        try { plugin.canvas3d.requestDraw(); } catch { /* drawing */ }
    }
    async function reloadRenderView() {
        setStatus('重载视图…');
        if (!lastRender) {
            forceDraw();
            setStatus('已重绘：当前会话没有记录到视图；请用「刷新」重开页签');
            return;
        }
        try {
            // A page reload loses the loaded structure while the recorded view
            // survives — reload the structure from the persisted token first so
            // figure/scene replay has something to build on.
            if (!currentStructure && lastRender.structureUrl) {
                setStatus('恢复结构…');
                await dispatcher.dispatch('load', {
                    url: lastRender.structureUrl,
                    name: lastRender.structureName || 'structure',
                });
            }
            if (lastRender.kind === 'figure' && lastRender.id) {
                await dispatcher.dispatch('figure', { id: lastRender.id });
            } else if (lastRender.kind === 'scene' && lastRender.cfg?.groups) {
                const cfg = { ...lastRender.cfg };
                if (!cfg.structureUrl) cfg.structureUrl = lastRender.structureUrl;
                await dispatcher.dispatch('scene', cfg);
            } else if (lastRender.kind === 'load' && lastRender.cfg?.url) {
                await dispatcher.dispatch('load', lastRender.cfg);
            }
            // Re-assert the pinned close-up after the rebuild settled.
            if (pinnedTarget) {
                setTimeout(() => { try { recenterOn(pinnedTarget); } catch { /* gone */ } }, 700);
            }
            forceDraw();
            setStatus('视图已重载');
        } catch (error) {
            setStatus(`重载失败（可能宿主已重启，结构 token 失效）: ${error?.message || error}`);
        }
    }
    document.getElementById('btn-reload-view').onclick = () => { reloadRenderView(); };

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        // Back in the foreground: draw a fresh frame right away.
        forceDraw();
        setTimeout(forceDraw, 300);
    });
    canvas.addEventListener('webglcontextrestored', () => {
        setTimeout(() => { forceDraw(); reloadRenderView(); }, 200);
    });
    document.getElementById('btn-card-close')?.addEventListener('click', () => {
        // Close via the card's own × (same state as the chip toggle) so the
        // panel and its opener live in one corner.
        controlCard.classList.add('collapsed');
        setStatus('ready');
    });
    api.applyControlCardMode = applyControlCardMode;

    // --- generic preset views (work on ANY loaded structure) ---------------
    // Poses are computed from the live bounding sphere, so "总览/背面/俯视/
    // 中心特写" stay correct for whatever the agent loads — no hardcoded scenes.
    function presetView({ yaw = 250, pitch = 12, zoom = 1, radiusScale = 1 }) {
        const bs = plugin.canvas3d.boundingSphere;
        const pose = { yaw, pitch, zoom };
        if (bs && bs.radius) pose.radius = bs.radius * radiusScale;
        applyView(viewer, pose, null);
        // Mol* re-focuses after representation updates; re-assert like figures do
        setTimeout(() => { if (!sceneBuilds) { try { applyView(viewer, pose, null); } catch { /* replaced */ } } }, 400);
    }
    const presetDefs = [
        { label: '总览', pose: { yaw: 250, pitch: 12 } },
        { label: '背面', pose: { yaw: 70, pitch: 12 } },
        { label: '俯视', pose: { yaw: 250, pitch: 75 } },
        { label: '中心特写', pose: { yaw: 250, pitch: 12, zoom: 1.1, radiusScale: 0.35 } },
        { label: '自动适配', pose: { yaw: 250, pitch: 12, zoom: 1, radiusScale: 1.15 } },
    ];
    const viewRow = document.getElementById('view-buttons');
    for (const def of presetDefs) {
        const b = document.createElement('button');
        b.id = `btn-view-${def.label}`;
        b.textContent = def.label;
        b.title = `通用视图：${def.label}`;
        b.onclick = () => presetView(def.pose);
        viewRow?.appendChild(b);
    }

    // --- paper panels only appear when their structure is on screen --------
    function updatePaperVisibility() {
        const box = document.getElementById('paper-panels');
        if (!box) return;
        const onPaper = Boolean(currentFigure) || /7xht|6w5c/i.test(currentStructureUrl || '');
        box.hidden = !onPaper;
    }
    api.updatePaperVisibility = updatePaperVisibility;

    bridge = createBridge(async (op, args) => {
        // reflect agent-driven scene work in the UI status line
        setStatus(`agent: ${op}…`);
        try {
            const result = await dispatcher.dispatch(op, args);
            rememberRender(op, args, result);
            return result;
        } finally {
            setStatus('ready');
        }
    }, {
        onHello: (data) => {
            setCustomPanels(data?.panels);
            applyControlCardMode(data?.ui?.controlCard);
            applyPixelScale(data?.ui?.pixelScale);
            // Host-persisted default mode applies when the user never chose
            // explicitly (no localStorage record). Writing the choice keeps the
            // flow idempotent — the second hello sees fullMode already equal.
            const wanted = data?.ui?.mode;
            if ((wanted === 'full' || wanted === 'simple') && wanted !== (fullMode ? 'full' : 'simple')) {
                let explicit = null;
                try { explicit = localStorage.getItem(MODE_KEY); } catch { /* storage off */ }
                if (!explicit) {
                    try { localStorage.setItem(MODE_KEY, wanted); } catch { /* storage off */ }
                    setStatus('应用宿主默认查看模式…');
                    setTimeout(() => location.reload(), 600);
                }
            }
        },
        onPanels: setCustomPanels,
        onSettings: (data) => {
            applyControlCardMode(data?.ui?.controlCard);
            applyPixelScale(data?.ui?.pixelScale);
        },
    });
    if (bridge.enabled) applyControlCardMode('auto'); // before hello arrives
    window.__molApi = api; // debugging hook

    // --- UI --------------------------------------------------------------
    for (const group of document.querySelectorAll('[data-figures]')) {
        for (const id of group.getAttribute('data-figures').split(',')) {
            const fig = FIGURES[id];
            if (!fig) { console.warn('no such figure:', id); continue; }
            const b = document.createElement('button');
            b.id = `btn-${id}`;
            b.textContent = fig.title;
            b.title = fig.title;
            b.onclick = () => applyFigure(id).catch((e) => {
                console.error(e);
                setStatus(`error (${id}): ${e?.message || e}`);
            });
            group.appendChild(b);
        }
    }
    document.getElementById('btn-rotate').onclick = () => rotateBy(viewer, 45, currentFigure ? anchorsFor(currentFigure) : null);
    // 标注开关：观察结构时一键隐藏引线标签
    const btnLabels = document.getElementById('btn-labels');
    btnLabels.onclick = () => {
        labelsVisible = !labelsVisible;
        labels.setVisible(labelsVisible);
        btnLabels.textContent = labelsVisible ? '标签：开' : '标签：关';
    };
    // 视角中心：拾取模式（点残基重设中心）与回到结构中心
    document.getElementById('btn-pick-center').onclick = () => {
        pickCenterMode = true;
        setPickCenterButton(true);
        setStatus('拾取中心：点击一个残基（保持当前缩放）');
    };
    document.getElementById('btn-center-structure').onclick = () => {
        const bs = plugin.canvas3d.boundingSphere;
        if (bs && bs.center) { recenterOn(bs.center); setStatus('中心已回到结构中心'); }
    };
    document.getElementById('btn-export').onclick = async () => {
        try {
            const helper = plugin.helpers.viewportScreenshot;
            if (!helper) throw new Error('screenshot helper unavailable');
            await helper.download(`${currentFigure}.png`);
            setStatus('PNG exported (canvas only, no HTML labels)');
        } catch (e) {
            setStatus(`export failed: ${e}`);
        }
    };

    // Background rendering: a hidden iframe freezes rAF, so Mol* never redraws
    // and the agent's screenshots would read a stale frame. `requestDraw` only
    // sets a flag consumed by the rAF loop, so render synchronously instead.
    setInterval(() => {
        try { plugin.canvas3d.tick(performance.now(), { isSynchronous: true }); } catch { /* disposed */ }
    }, 1000);
    updatePaperVisibility();
    setStatus('ready');
    // A page reload (dist rebuild, tab recovery) starts with an empty canvas.
    // If sessionStorage remembers the last view, restore it automatically so
    // switching back to the app never lands on a blank viewer.
    if (lastRender && bridge?.enabled) {
        setTimeout(() => {
            if (!currentStructure) {
                const kind = lastRender.kind === 'figure' ? `面板 ${lastRender.id}` : '上次的视图';
                setStatus(`正在恢复${kind}…`);
                reloadRenderView().catch(() => { /* status already reports */ });
            }
        }, 1500);
    }
}

main().catch((e) => {
    console.error(e);
    const status = document.getElementById('status');
    if (status) status.textContent = `error: ${e}`;
});
// Boot failures must be visible even when the status bar never mounts:
// surface any uncaught error as a red banner + document.title.
window.addEventListener('error', (ev) => {
    const msg = `BOOT ERROR: ${ev?.message || ev?.type}`;
    document.title = msg;
    let banner = document.getElementById('boot-error');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'boot-error';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99;background:#B3261E;color:#fff;' +
            'font:12px monospace;padding:8px 10px;white-space:pre-wrap;max-height:40%;overflow:auto;';
        document.body.appendChild(banner);
    }
    banner.textContent += `${msg}\n${ev?.error?.stack || ''}\n`;
});
window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev?.reason?.stack || ev?.reason?.message || String(ev?.reason);
    // Transient WebGL noise while the sidebar tab is hidden (0×0 canvas):
    // self-heals on visibility, never warrants a banner.
    if (reason.includes('empty textures are not allowed')) {
        ev.preventDefault?.();
        return;
    }
    document.title = `BOOT REJECTION: ${reason.slice(0, 80)}`;
    let banner = document.getElementById('boot-error');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'boot-error';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99;background:#B3261E;color:#fff;' +
            'font:12px monospace;padding:8px 10px;white-space:pre-wrap;max-height:40%;overflow:auto;';
        document.body.appendChild(banner);
    }
    banner.textContent += `REJECTION: ${reason}\n`;
});
