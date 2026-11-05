/**
 * SSE push hub for the plugin's two client surfaces:
 * the embedded viewer page (commands, reloads) and the client half
 * (panel-open requests). Both connect to GET /api/mol-structure/events after
 * the trust fence; attach() adopts the socket, emit() fans out.
 *
 * @module host/push.js
 */

export function createPush({ logger = console, heartbeatMs = 15000 } = {}) {
    const clients = new Set()

    function attach(req, res, hello) {
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
        })
        res.write(`retry: 3000\n\n`)
        send(res, 'hello', hello)
        clients.add(res)
        req.on('close', () => { clients.delete(res) })
    }

    function send(res, event, data) {
        try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        } catch (error) {
            clients.delete(res)
            logger.warn?.(`mol-structure: SSE write failed (${error?.message ?? error})`)
        }
    }

    /** Fan one event out to every live client; a failed write drops that client. */
    function emit(event, data) {
        for (const res of [...clients]) send(res, event, data)
    }

    // Comment frames keep idle connections through proxies; the timer never
    // holds the process open.
    const timer = setInterval(() => {
        for (const res of clients) {
            try { res.write(`: ping\n\n`) } catch { clients.delete(res) }
        }
    }, heartbeatMs)
    timer.unref?.()

    return {
        attach,
        emit,
        count: () => clients.size,
        dispose() {
            clearInterval(timer)
            for (const res of clients) {
                try { res.end() } catch { /* already gone */ }
            }
            clients.clear()
        },
    }
}
