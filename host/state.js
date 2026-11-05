/**
 * Host-side truth about the viewer page and its in-flight commands.
 *
 * The viewer page is a browser surface the host cannot reach directly — the
 * only path in is the SSE stream, the only path out is the viewer's POSTs.
 * This module owns both: liveness and the latest selection report are stored
 * here (from POST /status and POST /selection), and submitCommand() pairs a
 * submitted command id with the POST /result that resolves it, with a timeout
 * and caller cancellation on the way.
 *
 * @module host/state.js
 */

const VIEWER_FRESH_MS = 30000

export function createHostState({ logger = console, push, commandTimeoutMs = 90000 } = {}) {
    const viewer = {
        connected: false,
        lastSeen: 0,
        status: null,
        figure: null,
        structure: null,
        selection: null,
    }

    const pending = new Map() // id → {resolve, reject, timer, onAbort}
    let nextId = 1

    function noteStatus(patch = {}) {
        viewer.connected = true
        viewer.lastSeen = Date.now()
        if (patch.status !== undefined) viewer.status = patch.status
        if (patch.figure !== undefined) viewer.figure = patch.figure
        if (patch.structure !== undefined) viewer.structure = patch.structure
    }

    function noteSelection(selection) {
        viewer.connected = true
        viewer.lastSeen = Date.now()
        viewer.selection = selection
    }

    /** The viewer counts as connected while its heartbeats keep arriving. */
    function viewerLive() {
        return viewer.connected && (Date.now() - viewer.lastSeen) < VIEWER_FRESH_MS
    }

    /**
     * Submit one command to the viewer page over the SSE stream and wait for
     * its POST /result.
     *
     * @param {{op: string, args?: object, timeoutMs?: number, signal?: AbortSignal}} spec
     * @returns {Promise<unknown>} the command's canonical result
     */
    /** Resolve once the viewer reports a heartbeat, or after `ms`. */
    function waitViewer(ms) {
        if (viewerLive()) return Promise.resolve()
        return new Promise((resolve, reject) => {
            const started = Date.now()
            const timer = setInterval(() => {
                if (viewerLive()) {
                    clearInterval(timer)
                    resolve()
                } else if (Date.now() - started >= ms) {
                    clearInterval(timer)
                    reject(new Error(
                        'viewer not connected — open the Structure panel in the right sidebar first (mol_panel opens it)',
                    ))
                }
            }, 250)
        })
    }

    async function submitCommand({ op, args = {}, timeoutMs = commandTimeoutMs, signal, connectWaitMs = 8000 }) {
        // Grace: the tab may still be loading when the first command lands
        // (mol_load right after mol_panel); wait briefly instead of failing.
        await waitViewer(connectWaitMs)
        const id = nextId++
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => settle(new Error(
                `viewer did not answer "${op}" within ${Math.round(timeoutMs / 1000)}s (a large scene build can take a while; retry once if the panel is open)`,
            )), timeoutMs)
            const onAbort = () => settle(new Error(`"${op}" cancelled`))
            if (signal) {
                if (signal.aborted) return onAbort()
                signal.addEventListener('abort', onAbort, { once: true })
            }
            function settle(outcome) {
                if (!pending.has(id)) return
                clearTimeout(timer)
                if (signal) signal.removeEventListener('abort', onAbort)
                pending.delete(id)
                if (outcome instanceof Error) reject(outcome)
                else resolve(outcome)
            }
            pending.set(id, { resolve: settle, reject: settle, timer, onAbort })
            push.emit('command', { id, op, args })
        })
    }

    function resolveCommand(id, payload) {
        const entry = pending.get(id)
        if (!entry) return false
        entry.resolve(payload)
        return true
    }

    /** Drop every pending command — the old generation's SSE died with it. */
    function dispose() {
        for (const [, entry] of [...pending]) {
            clearTimeout(entry.timer)
        }
        pending.clear()
        viewer.connected = false
    }

    return { viewer, noteStatus, noteSelection, viewerLive, submitCommand, resolveCommand, pendingCount: () => pending.size, dispose }
}
