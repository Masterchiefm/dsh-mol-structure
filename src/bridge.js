/**
 * Bridge between the embedded viewer page and the dsh plugin host.
 *
 * The viewer page is served by the plugin at /api/mol-structure/viewer/, so it
 * shares the dsh web app's origin and can reach the plugin's JSON/SSE routes
 * directly with fetch and EventSource — no postMessage relay through the
 * client half.
 *
 * Host → viewer: SSE `command` events carry {id, op, args}; the dispatcher
 * below runs the matching handler and POSTs the outcome to /result.
 * Viewer → host: debounced POSTs on /status (liveness + current figure) and
 * /selection (what the user clicked or selected in Mol*).
 *
 * Standalone (npm run dev, file://): `createBridge` returns a no-op — every
 * network call is guarded and the EventSource only opens when the page was
 * actually served under the plugin route (or ?bridge is in the query).
 */

const BASE = new URL('../', location.href).href; // …/api/mol-structure/

function embedded() {
    if (location.search.includes('bridge')) return true;
    try {
        return new URL(BASE).pathname.startsWith('/api/mol-structure/');
    } catch {
        return false;
    }
}

/** Message plus one stack frame - enough for the agent to tell which layer failed. */
function describeError(error) {
    const msg = String(error?.message || error);
    const frames = String(error?.stack || '').split('\n');
    const frame = frames.find((l) => l.trim().startsWith('at '));
    return frame ? msg + '\n    ' + frame.trim() : msg;
}

async function post(path, body) {
    const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
    return res.json().catch(() => ({}));
}

export function createBridge(dispatch, hooks = {}) {
    const onHello = hooks.onHello ?? (() => {});
    const onPanels = hooks.onPanels ?? (() => {});
    const onSettings = hooks.onSettings ?? (() => {});
    if (!embedded()) {
        return {
            enabled: false,
            reportStatus: () => {},
            reportSelection: () => {},
            dispose: () => {},
        };
    }

    let es = null;
    let retryTimer = 0;
    let closed = false;
    let generation = null; // host generation; a change means the plugin hot-reloaded
    let appRev = null;     // dist fingerprint; a change means the viewer was rebuilt

    // --- status / selection reporters (debounced, error-tolerant) ------------

    let statusPatch = {};
    let statusTimer = 0;
    function reportStatus(patch) {
        Object.assign(statusPatch, patch);
        clearTimeout(statusTimer);
        statusTimer = setTimeout(flushStatus, 200);
    }
    async function flushStatus() {
        const body = statusPatch;
        statusPatch = {};
        try {
            const state = await post('status', body);
            // The hello on (re)connect also carries these; poll answers keep a
            // rebuilt dist and a hot-reloaded host visible without a manual refresh.
            if (state && typeof state === 'object') {
                if (generation !== null && state.gen !== generation) {
                    location.reload();
                    return;
                }
                generation = state.gen;
                if (appRev !== null && state.appRev !== appRev) {
                    location.reload();
                    return;
                }
                appRev = state.appRev;
            }
        } catch {
            /* host unreachable — viewer keeps working standalone */
        }
    }

    let selectionLatest = null;
    let selectionTimer = 0;
    function reportSelection(selection) {
        selectionLatest = { ...selection, at: Date.now() };
        clearTimeout(selectionTimer);
        selectionTimer = setTimeout(() => {
            const body = selectionLatest;
            selectionLatest = null;
            if (body) post('selection', { selection: body }).catch(() => {});
        }, 250);
    }

    // --- SSE: commands in, hello/reload notifications ------------------------

    function connect() {
        if (closed) return;
        es = new EventSource(BASE + 'events');
        es.addEventListener('open', () => { reportStatus({}); });
        es.addEventListener('hello', (ev) => {
            try {
                const data = JSON.parse(ev.data);
                const genChanged = generation !== null && data.gen !== generation;
                generation = data.gen;
                appRev = data.appRev;
                try { onHello(data); } catch (e) { console.warn('onHello hook failed', e); }
                reportStatus({ connected: true });
                // The old generation's SSE died during its teardown, so a
                // different gen on reconnect is a completed host hot reload:
                // the page re-fetches state fresh from the new plugin.
                if (genChanged) location.reload();
            } catch { /* malformed hello — ignore */ }
        });
        es.addEventListener('panels', (ev) => {
            try { onPanels(JSON.parse(ev.data)?.panels ?? []); } catch (e) { console.warn('panels event failed', e); }
        });
        es.addEventListener('settings', (ev) => {
            try { onSettings(JSON.parse(ev.data) ?? {}); } catch (e) { console.warn('settings event failed', e); }
        });
        // Host-side dist watcher: reload the page as soon as the viewer build
        // changes, without waiting for the throttled appRev poll.
        es.addEventListener('reload', () => {
            try { location.reload(); } catch { /* ignore */ }
        });
        es.addEventListener('command', (ev) => {
            let id = null;
            try {
                const { id: cmdId, op, args } = JSON.parse(ev.data);
                id = cmdId;
                Promise.resolve(dispatch(op, args ?? {})).then(
                    (result) => post('result', { id, ok: true, result: result ?? null }),
                    (error) => post('result', { id, ok: false, error: describeError(error) }),
                ).catch(() => {});
            } catch (error) {
                if (id !== null) post('result', { id, ok: false, error: `dispatch failed: ${error}` }).catch(() => {});
            }
        });
        es.addEventListener('error', () => {
            // EventSource retries on its own for transient drops; a full host
            // hot reload closes the stream for good (old generation teardown),
            // so also fall back to slow manual retries when it stays closed.
            if (closed) return;
            es.close();
            clearTimeout(retryTimer);
            retryTimer = setTimeout(connect, 4000);
        });
    }

    connect();

    // Liveness heartbeat keeps the host's "viewer connected" truth fresh even
    // when nothing else posts; also carries appRev/gen checks (flushStatus).
    const heartbeat = setInterval(() => {
        if (document.visibilityState === 'visible') reportStatus({});
    }, 10000);

    return {
        enabled: true,
        reportStatus,
        reportSelection,
        dispose() {
            closed = true;
            clearInterval(heartbeat);
            clearTimeout(statusTimer);
            clearTimeout(selectionTimer);
            clearTimeout(retryTimer);
            if (es) es.close();
        },
    };
}
