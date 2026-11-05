/*
 * dsh-mol-structure — browser half ("client" bundle).
 *
 * A hand-written ModuleLoader bundle (no build step): the loader executes
 * this file once to register the factory, and the factory runs on first
 * import, exporting the cordis plugin (named exports: name / inject / apply).
 *
 * The plugin contributes a "Structure" page type to the right Sidebar —
 * the same two registrations the built-in browser tab makes — whose body is
 * an iframe over the Host half's static viewer route. An SSE listener on the
 * plugin's /events stream opens the tab when an agent tool calls mol_panel.
 *
 * The viewer page itself (Mol*) talks to the Host JSON/SSE routes directly;
 * this half only hosts the iframe and relays the open request.
 */
window.__ModuleLoader__.load({ id: 'dsh-mol-structure', factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    'use strict';

    var react = require('react');
    var createElement = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;

    var PLUGIN_ID = 'dsh-mol-structure'; // tab implementation id (package name)
    var TAB_KIND = 'mol';
    var API_BASE = '/api/mol-structure';
    var VIEWER_URL = API_BASE + '/viewer/index.html';
    var SETTINGS_NS = 'mol-structure';

    // --- guide entry glyph: a small atom mark -------------------------------
    function AtomIcon(props) {
        var s = (props && props.size) || 16;
        return createElement(
            'svg',
            { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
            createElement('ellipse', {
                cx: 12, cy: 12, rx: 9.5, ry: 4.2, stroke: 'currentColor',
                'stroke-width': 1.5, transform: 'rotate(-25 12 12)',
            }),
            createElement('ellipse', {
                cx: 12, cy: 12, rx: 9.5, ry: 4.2, stroke: 'currentColor',
                'stroke-width': 1.5, transform: 'rotate(40 12 12)',
            }),
            createElement('circle', { cx: 12, cy: 12, r: 1.9, fill: 'currentColor' }),
        );
    }

    // --- inline styles (theme-neutral) ---------------------------------------
    var styles = {
        root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
        bar: {
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '4px 10px', fontSize: 12, opacity: 0.9,
            borderBottom: '1px solid rgba(128,128,128,0.25)',
        },
        title: { fontWeight: 600, whiteSpace: 'nowrap' },
        meta: { opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
        dot: { width: 8, height: 8, borderRadius: 8, flex: 'none' },
        tool: {
            font: 'inherit', fontSize: 12, border: '1px solid rgba(128,128,128,0.4)',
            background: 'transparent', color: 'inherit', borderRadius: 5,
            padding: '2px 8px', cursor: 'pointer', flex: 'none',
        },
        frameWrap: { position: 'relative', flex: 1, minHeight: 0 },
        frame: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: '0', background: '#fff' },
        hint: { padding: 16, fontSize: 12, opacity: 0.7 },
    };

    function absoluteUrl(pathname) {
        try { return new URL(pathname, document.baseURI).href; } catch (e) { return pathname; }
    }

    // --- settings (Settings → General, 结构视图 row) --------------------------
    var CC_MODES = ['auto', 'show', 'hide'];

    function createSnapshotStore(initial) {
        var value = initial;
        var listeners = new Set();
        return {
            getSnapshot: function () { return value; },
            subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
            set: function (next) {
                if (next === value) return;
                value = next;
                listeners.forEach(function (fn) { try { fn(); } catch (e) { /* listener bug */ } });
            },
        };
    }

    var controlCardStore = createSnapshotStore('auto');
    var defaultModeStore = createSnapshotStore('simple');
    var MODE_KEYS = ['simple', 'full'];

    function SegGroup(props) {
        var value = props.value;
        var setValue = props.setValue;
        var keys = props.keys;
        var labels = props.labels || {};
        var seg = { display: 'flex', gap: 0, flex: 'none' };
        var segBtn = function (active) {
            return {
                font: 'inherit', fontSize: 12, padding: '4px 10px', cursor: 'pointer',
                border: '1px solid rgba(128,128,128,0.45)', background: active ? 'rgba(128,128,128,0.25)' : 'transparent',
                color: 'inherit',
            };
        };
        return createElement('div', { style: seg, role: 'group' },
            keys.map(function (m, i) {
                return createElement('button', {
                    key: m,
                    style: Object.assign(segBtn(value === m), i > 0 ? { borderLeft: '0' } : {}, i === 0 ? { borderRadius: '5px 0 0 5px' } : {}, i === keys.length - 1 ? { borderRadius: '0 5px 5px 0' } : {}),
                    onClick: function () { setValue(m); },
                    title: labels[m] || m,
                }, labels[m] || m);
            }),
        );
    }

    function SettingsRow(props) {
        var t = props.t;
        var useStore = function (store) {
            return react.useSyncExternalStore ? react.useSyncExternalStore(store.subscribe, store.getSnapshot) : store.getSnapshot();
        };
        var controlCard = useStore(props.controlCard);
        var defaultMode = useStore(props.defaultMode);
        var row = { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', fontSize: 13 };
        var textWrap = { flex: 1, minWidth: 0 };
        var title = { fontWeight: 600, marginBottom: 2 };
        var desc = { opacity: 0.65, fontSize: 12 };
        return createElement('div', null,
            createElement('div', { style: row },
                createElement('div', { style: textWrap },
                    createElement('div', { style: title }, t('settings.controlcard.title')),
                    createElement('div', { style: desc }, t('settings.controlcard.description')),
                ),
                SegGroup({
                    value: controlCard, setValue: props.setControlCard,
                    keys: CC_MODES,
                    labels: { auto: t('settings.controlcard.auto'), show: t('settings.controlcard.show'), hide: t('settings.controlcard.hide') },
                }),
            ),
            createElement('div', { style: row },
                createElement('div', { style: textWrap },
                    createElement('div', { style: title }, t('settings.mode.title')),
                    createElement('div', { style: desc }, t('settings.mode.description')),
                ),
                SegGroup({
                    value: defaultMode, setValue: props.setDefaultMode,
                    keys: MODE_KEYS,
                    labels: { simple: t('settings.mode.simple'), full: t('settings.mode.full') },
                }),
            ),
        );
    }

    function saveSettings(patch) {
        return fetch(absoluteUrl(API_BASE + '/settings'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
        }).then(function (r) { return r.json(); });
    }

    // --- tab body: toolbar + iframe over the Host's static viewer -----------
    function MolBody() {
        var epochState = useState(0);
        var epoch = epochState[0];
        var setEpoch = epochState[1];
        var liveState = useState(null); // null unknown, true/false viewer liveness
        var live = liveState[0];
        var setLive = liveState[1];
        var figureState = useState(null);
        var figure = figureState[0];
        var setFigure = figureState[1];

        useEffect(function () {
            var stopped = false;
            var lastLiveAt = Date.now();
            var lastReloadAt = 0;
            var knownAppRev = null; // viewer build the iframe currently runs
            function poll() {
                // Same-origin probe of the iframe: its document state beats a
                // blank-looking frame with no clue (shown in the toolbar meta).
                var probe = '';
                try {
                    var iframe = document.querySelector('iframe[title="Mol* structure viewer"]');
                    var doc = iframe && iframe.contentDocument;
                    if (doc) {
                        var st = doc.getElementById('status');
                        probe = (doc.title || '?') + ' | ' + (st ? st.textContent : (doc.body ? 'no #status' : 'no body'));
                    } else if (iframe) {
                        probe = 'iframe: no same-origin doc';
                    } else {
                        probe = 'iframe: not mounted';
                    }
                } catch (e) { probe = 'probe failed: ' + e; }
                setFigure(probe);
                fetch(absoluteUrl(API_BASE + '/state'))
                    .then(function (r) { return r.json(); })
                    .then(function (j) {
                        if (stopped) return;
                        var live = Boolean(j.connected);
                        if (live) lastLiveAt = Date.now();
                        setLive(live);
                        // Auto-refresh on a rebuilt viewer: the host reports the
                        // dist fingerprint; when it changes, rebuild the iframe.
                        if (j && j.appRev) {
                            if (knownAppRev === null) knownAppRev = j.appRev;
                            else if (j.appRev !== knownAppRev) {
                                knownAppRev = j.appRev;
                                setEpoch(function (e) { return e + 1; });
                                return;
                            }
                        }
                        // Self-heal: when the viewer page stays dead (e.g. it
                        // 404'd on assets replaced by a rebuild), rebuild the
                        // iframe instead of waiting for a manual refresh.
                        if (!live && Date.now() - lastLiveAt > 12000 && Date.now() - lastReloadAt > 20000) {
                            lastReloadAt = Date.now();
                            lastLiveAt = Date.now();
                            setEpoch(function (e) { return e + 1; });
                        }
                    })
                    .catch(function () { if (!stopped) setLive(false); });
            }
            poll();
            var timer = setInterval(poll, 5000);
            return function () { stopped = true; clearInterval(timer); };
        }, []);

        function refresh() { setEpoch(function (e) { return e + 1; }); }

        var dotColor = live === null ? 'rgba(128,128,128,0.6)' : live ? '#2FA96B' : '#D05353';
        return createElement(
            'div',
            { style: styles.root },
            createElement(
                'div',
                { style: styles.bar },
                createElement('span', { style: styles.title }, '结构视图'),
                createElement('span', {
                    style: Object.assign({}, styles.dot, { background: dotColor }),
                    title: live === null ? '检查连接中…' : live ? 'viewer 已连接' : 'viewer 未连接（等待页面加载）',
                }),
                createElement('span', { style: styles.meta }, figure || ''),
                createElement('button', { style: styles.tool, onClick: refresh, title: '重新加载 viewer 页面' }, '刷新'),
                createElement('button', {
                    style: styles.tool,
                    onClick: function () { window.open(absoluteUrl(VIEWER_URL), '_blank', 'noopener,noreferrer'); },
                    title: '在独立标签页打开',
                }, '新窗口'),
            ),
            createElement(
                'div',
                { style: styles.frameWrap },
                createElement('iframe', {
                    key: epoch,
                    src: absoluteUrl(VIEWER_URL),
                    style: styles.frame,
                    title: 'Mol* structure viewer',
                    referrerPolicy: 'no-referrer',
                }),
            ),
        );
    }

    // --- cordis plugin --------------------------------------------------------
    exports.name = 'dsh-mol-structure';
    exports.inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'];

    exports.apply = function apply(ctx) {
        // 0. Settings → General row: 面板按钮卡（controlCard）偏好，写回宿主半身
        ctx.effect(function () {
            return ctx.locale.register(SETTINGS_NS, {
                zh: {
                    'settings.controlcard.title': '结构视图：面板按钮卡',
                    'settings.controlcard.description': '论文复现面板按钮区的显示方式。auto = 内嵌时收起；show/hide 强制展开/隐藏。',
                    'settings.controlcard.auto': '自动',
                    'settings.controlcard.show': '展开',
                    'settings.controlcard.hide': '隐藏',
                    'settings.mode.title': '结构视图：默认查看模式',
                    'settings.mode.description': '打开查看器时的界面。simple = agent 驱动的简洁画布；full = 完整 Mol* 界面（左侧控制树 / 序列 / 工具栏）。',
                    'settings.mode.simple': '简洁',
                    'settings.mode.full': '完整 Mol*',
                },
                en: {
                    'settings.controlcard.title': 'Structure view: panel card',
                    'settings.controlcard.description': 'Paper-panel button card visibility. auto = collapsed when embedded; show/hide to force.',
                    'settings.controlcard.auto': 'Auto',
                    'settings.controlcard.show': 'Show',
                    'settings.controlcard.hide': 'Hide',
                    'settings.mode.title': 'Structure view: default viewer mode',
                    'settings.mode.description': 'UI on open. simple = agent-driven minimal canvas; full = complete Mol* app (control tree / sequence / toolbar).',
                    'settings.mode.simple': 'Simple',
                    'settings.mode.full': 'Full Mol*',
                },
            });
        }, 'mol-structure: settings dictionaries');

        ctx.effect(function () {
            // Seed the stores from the Host's persisted values before first render.
            fetch(absoluteUrl(API_BASE + '/settings'))
                .then(function (r) { return r.json(); })
                .then(function (j) {
                    if (j && CC_MODES.indexOf(j.controlCard) >= 0) controlCardStore.set(j.controlCard);
                    if (j && MODE_KEYS.indexOf(j.defaultMode) >= 0) defaultModeStore.set(j.defaultMode);
                })
                .catch(function () { /* host unreachable — keep default */ });
            return ctx.slots.inject('settings.general.item', function () {
                return ctx.slots.register({
                    name: 'settings.general.item',
                    id: 'mol-structure-control-card',
                    order: 40,
                    locale: SETTINGS_NS,
                    inject: function () {
                        return {
                            controlCard: controlCardStore,
                            setControlCard: function (mode) {
                                controlCardStore.set(mode);
                                saveSettings({ controlCard: mode }).catch(function () { /* keep optimistic value */ });
                            },
                            defaultMode: defaultModeStore,
                            setDefaultMode: function (mode) {
                                defaultModeStore.set(mode);
                                saveSettings({ defaultMode: mode }).catch(function () { /* keep optimistic value */ });
                            },
                        };
                    },
                }, SettingsRow);
            });
        }, 'mol-structure: settings row');

        // 1. the tab type (page kind) + its guide entry card
        ctx.effect(function () {
            return ctx.sidebarRightTabs.register({
                id: PLUGIN_ID,
                kind: TAB_KIND,
                keepMounted: true, // the Mol* scene is expensive to rebuild on hide
                title: function () { return '结构视图'; },
                guide: [{
                    id: 'structure',
                    order: 50,
                    title: function () { return '结构视图'; },
                    description: function () { return 'Mol* 结构生物学查看器（论文复现面板 + agent 渲染控制）'; },
                    icon: AtomIcon,
                }],
            });
        }, 'mol-structure: tab type');

        // 2. the body keyed by the definition id
        ctx.effect(function () {
            return ctx.slots.inject('sidebar.right.pane.tab', function () {
                return ctx.slots.register(
                    { name: 'sidebar.right.pane.tab', key: PLUGIN_ID },
                    MolBody,
                );
            });
        }, 'mol-structure: tab body');

        // 3. open the panel on demand: mol_panel (and the reload flow) emits
        //    `panel` on the plugin's SSE stream
        ctx.effect(function () {
            var source;
            try { source = new EventSource(absoluteUrl(API_BASE + '/events')); } catch (e) { return; }
            source.addEventListener('panel', function () {
                try { ctx.sidebarRight.openTab(TAB_KIND, {}); } catch (e) {
                    console.warn('mol-structure: openTab failed', e);
                }
            });
            return function () { try { source.close(); } catch (e) { /* already gone */ } };
        }, 'mol-structure: panel-open stream');
    };

    return module.exports;
} });
