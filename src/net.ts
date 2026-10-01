// HTTP, SSE, and the managed `opencode serve` lifecycle. Every helper here is
// bounded: a port that accepts and never answers must fail, not hang.
import * as vscode from "vscode";
import { ChildProcess } from "node:child_process";
import * as http from "node:http";

import { config, delay, logChannel, resolveFolder, stamp, truncate } from "./core";
import { killTree, spawnOpenCode } from "./proc";

// `opencode serve` is a MULTI-DIRECTORY server: every /session endpoint roots
// the session wherever `?directory=` points, and falls back to its OWN cwd when
// the parameter is omitted. Since ensureServer() reuses any healthy listener on
// the port, two VS Code windows share one server — so without this the second
// window's prompts read, edit and run commands in the FIRST window's checkout.
// Measured against opencode 1.18.27 (REFS.md): it must be the query string,
// body fields named `directory` or `cwd` are ignored.
export function withDirectory(url: string, cwd: string | undefined): string {
    if (!cwd) {
        return url;
    }
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}directory=${encodeURIComponent(cwd)}`;
}

// Generic JSON HTTP request with optional timeout and cancellation. On timeout it
// destroys the socket and rejects with a marker code so the caller can treat it
// as a run timeout (mirroring the CLI path's kill-on-timeout behaviour).
export function httpRequestJson<T>(
    method: string,
    url: string,
    body?: unknown,
    timeoutMs?: number,
    token?: vscode.CancellationToken
): Promise<T> {
    return new Promise((resolve, reject) => {
        const data = body !== undefined ? Buffer.from(JSON.stringify(body), "utf8") : undefined;
        const headers = data ? { "content-type": "application/json", "content-length": data.length } : {};
        const req = http.request(url, { method, headers }, (res) => {
            let raw = "";
            // Decode as utf8 here, not per chunk: a multi-byte character split
            // across two TCP chunks becomes U+FFFD when each Buffer is stringified
            // on its own, and that lands in the user's answer.
            res.setEncoding("utf8");
            res.on("data", (c) => (raw += c));
            // A socket that drops AFTER the headers arrive emits on the response,
            // not on the request — the same asymmetry openSharedSse handles below.
            // Unhandled, an "error" on a stream is an uncaught exception in the
            // extension host, and this promise never settles either way.
            res.on("error", reject);
            res.on("end", () => {
                const code = res.statusCode ?? 0;
                if (code >= 200 && code < 300) {
                    try {
                        resolve((raw ? JSON.parse(raw) : {}) as T);
                    } catch (error) {
                        reject(error);
                    }
                } else {
                    reject(new Error(`HTTP ${code}: ${truncate(raw, 200)}`));
                }
            });
        });
        let timer: NodeJS.Timeout | undefined;
        if (timeoutMs && timeoutMs > 0) {
            timer = setTimeout(() => {
                req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT_BRIDGE" }));
            }, timeoutMs);
        }
        const cancel = token?.onCancellationRequested(() => {
            req.destroy(Object.assign(new Error("cancelled"), { code: "ECANCELLED_BRIDGE" }));
        });
        req.on("error", (err) => {
            if (timer) {
                clearTimeout(timer);
            }
            cancel?.dispose();
            reject(err);
        });
        req.on("close", () => {
            if (timer) {
                clearTimeout(timer);
            }
            cancel?.dispose();
        });
        if (data) {
            req.write(data);
        }
        req.end();
    });
}

// A health probe against a port that is open but never answers (a hung server, a
// firewall that blackholes, another process squatting the port) leaves this
// promise pending forever, and `ensureServer` / `diagnose` await it. Always bound.
export function httpGetJson<T>(url: string, timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
        const request = http.get(url, (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (data += chunk));
            res.on("error", reject);
            res.on("end", () => {
                try {
                    resolve(JSON.parse(data) as T);
                } catch (error) {
                    reject(error);
                }
            });
        });
        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(`GET ${url} timed out after ${timeoutMs} ms`));
        });
        request.on("error", reject);
    });
}

// Bounded for the same reason httpGetJson is: a port that accepts and never
// answers leaves this pending forever, and compactSession awaits it — so every
// autoCompactEveryTurns turn would hang the turn that triggered it.
export function httpPostJson(url: string, body: unknown, timeoutMs = 30000): Promise<number> {
    return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body ?? {}), "utf8");
        const request = http.request(
            url,
            {
                method: "POST",
                headers: { "content-type": "application/json", "content-length": data.length }
            },
            (res) => {
                res.on("data", () => undefined);
                res.on("error", reject);
                res.on("end", () => resolve(res.statusCode ?? 0));
            }
        );
        if (timeoutMs > 0) {
            request.setTimeout(timeoutMs, () => {
                request.destroy(new Error(`POST ${url} timed out after ${timeoutMs} ms`));
            });
        }
        request.on("error", reject);
        request.write(data);
        request.end();
    });
}

// ---------------------------------------------------------------------------
// managed server
// ---------------------------------------------------------------------------

let serveProcess: ChildProcess | undefined;

// An asynchronous spawn failure leaves exitCode = -errno (-2 for ENOENT on
// POSIX, -4058 on Windows). That number is what the poll loop below has to
// report, and it is unreadable. Keep the message the "error" event carried
// so the thrown Error says what actually went wrong.
let serveSpawnError: string | undefined;

// A reused server is safe now that every session call carries `?directory=`,
// but which server we adopted still matters when something goes wrong — a run
// rooted in the wrong repo used to be invisible. Log the adoption once per
// endpoint so `/ping` and the output channel can show it.
const adoptedServers = new Set<string>();

export function stopServer(): void {
    if (serveProcess && serveProcess.exitCode === null) {
        killTree(serveProcess);
    }
    serveProcess = undefined;
}

export async function ensureServer(cwd?: string): Promise<string> {
    const settings = config();
    const executable = settings.get<string>("executable", "opencode");
    const host = settings.get<string>("serverHostname", "127.0.0.1");
    const port = settings.get<number>("serverPort", 4096);
    const base = `http://${host}:${port}`;

    const healthy = async (): Promise<boolean> => {
        try {
            const health = await httpGetJson<{ healthy?: boolean }>(`${base}/global/health`);
            return health.healthy === true;
        } catch {
            return false;
        }
    };

    if (await healthy()) {
        // A server we can reach means no start is pending, so any message left
        // over from an earlier failed spawn is now history. Clearing here and
        // before the spawn below means the poll loop can only ever read a
        // message belonging to the process it is actually waiting on.
        serveSpawnError = undefined;
        const startedHere = Boolean(serveProcess && serveProcess.exitCode === null);
        if (!startedHere && !adoptedServers.has(base)) {
            adoptedServers.add(base);
            logChannel.appendLine(
                `[${stamp()}] adopted an OpenCode server already listening on ${base}. ` +
                `Requests are scoped to ${cwd ?? "this workspace"} via ?directory=.`
            );
        }
        return base;
    }

    if (!serveProcess || serveProcess.exitCode !== null) {
        const serveCwd = cwd ?? resolveFolder()?.folder.uri.fsPath;
        serveSpawnError = undefined;
        serveProcess = spawnOpenCode(
            executable,
            ["serve", "--port", String(port), "--hostname", host],
            serveCwd
        );
        // setEncoding on the stream, not toString per chunk: OpenCode's banner is
        // box-drawing, and a character split across two chunks logs as U+FFFD.
        serveProcess.stdout?.setEncoding("utf8");
        serveProcess.stderr?.setEncoding("utf8");
        serveProcess.stdout?.on("data", (d: string) => logChannel.appendLine(`[serve] ${d.trim()}`));
        serveProcess.stderr?.on("data", (d: string) => logChannel.appendLine(`[serve] ${d.trim()}`));
        // spawn failures that are not ENOENT (EACCES, EAGAIN, EMFILE) surface
        // ASYNCHRONOUSLY here, not as a throw from spawnOpenCode. With no listener
        // that is an uncaught exception in the extension host; with one, the poll
        // loop below sees exitCode !== null and reports it as a failed start.
        serveProcess.on("error", (error) => {
            serveSpawnError = error.message;
            logChannel.appendLine(`[${stamp()}] serve failed to start: ${error.message}`);
        });
        serveProcess.on("close", (code) => logChannel.appendLine(`[${stamp()}] serve exited (${code})`));
    }

    // serverStartupPollMs is the CAP. The first poll comes at 50ms and
    // doubles, so a server that is up in 120ms is seen at ~150ms, not 350ms.
    const pollMs = Math.max(50, settings.get<number>("serverStartupPollMs", 350));
    let waitMs = 50;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        await delay(waitMs);
        waitMs = Math.min(pollMs, waitMs * 2);
        // Bail out early if the server process died instead of polling for 20s.
        if (serveProcess && serveProcess.exitCode !== null) {
            throw new Error(
                serveSpawnError
                    ? `OpenCode server could not be started: ${serveSpawnError}`
                    : `OpenCode server process exited (code ${serveProcess.exitCode}).`
            );
        }
        if (await healthy()) {
            return base;
        }
    }
    throw new Error(`OpenCode server did not become healthy on ${base}.`);
}

// ---------------------------------------------------------------------------
// one SSE subscription per server, shared and refcounted
// ---------------------------------------------------------------------------
//
// /global/event is server-wide, so a socket per run means N concurrent chats
// each parse every frame belonging to every session — N × N JSON.parse per
// event. Each frame is parsed once here and demultiplexed to the subscribers
// entitled to it.

export function sessionIdFromEvent(ev: Record<string, unknown>): string | undefined {
    const props = ev.properties as Record<string, unknown> | undefined;
    const info = props?.info as Record<string, unknown> | undefined;
    const part = (props?.part ?? ev.part) as Record<string, unknown> | undefined;
    return (
        (part?.sessionID as string | undefined) ??
        // sessionID only — never `info.id`. On message.updated that is the
        // MESSAGE id, so reading it makes every such event look like another
        // session's and silently drops its token and cost accounting.
        (info?.sessionID as string | undefined) ??
        (props?.sessionID as string | undefined) ??
        (ev.sessionID as string | undefined) ??
        (ev.sessionId as string | undefined)
    );
}

// Only text and reasoning reach the user's reply, so only they must be positively
// attributed before delivery. Metrics-only events may pass unattributed — losing
// a token count is cheaper than streaming another chat's answer into this one.
function carriesContent(ev: Record<string, unknown>): boolean {
    const props = ev.properties as Record<string, unknown> | undefined;
    const part = (props?.part ?? ev.part) as Record<string, unknown> | undefined;
    return part?.type === "text" || part?.type === "reasoning";
}

interface SseSubscriber {
    // undefined means "every event" — the Live View is deliberately unfiltered.
    sessionId?: string;
    onEvent: (payload: Record<string, unknown>) => void;
    onStatus: (text: string) => void;
}

interface SharedSse {
    subscribers: Set<SseSubscriber>;
    lastStatus: string;
    close: () => void;
}

const sseConnections = new Map<string, SharedSse>();

function openSharedSse(base: string): SharedSse {
    const subscribers = new Set<SseSubscriber>();
    let request: http.ClientRequest | undefined;
    let retryTimer: NodeJS.Timeout | undefined;
    let closed = false;
    let backoffMs = 1500;

    const shared: SharedSse = {
        subscribers,
        lastStatus: "",
        close: () => {
            closed = true;
            if (retryTimer) {
                clearTimeout(retryTimer);
            }
            request?.destroy();
        }
    };

    const status = (text: string): void => {
        shared.lastStatus = text;
        for (const sub of [...subscribers]) {
            sub.onStatus(text);
        }
    };

    const dispatch = (payload: Record<string, unknown>): void => {
        const sid = sessionIdFromEvent(payload);
        const contentful = carriesContent(payload);
        for (const sub of [...subscribers]) {
            if (!sub.sessionId || sid === sub.sessionId || (sid === undefined && !contentful)) {
                sub.onEvent(payload);
            }
        }
    };

    const scheduleRetry = (): void => {
        if (closed || retryTimer) {
            // A stream that errors AND ends schedules twice; without this guard
            // both timers fire and the server ends up with two live sockets for
            // one shared subscription, which is the duplication this file exists
            // to prevent.
            return;
        }
        status(`reconnecting in ${Math.round(backoffMs / 1000)}s…`);
        retryTimer = setTimeout(() => {
            retryTimer = undefined;
            connect();
        }, backoffMs);
        // Capped exponential backoff so a down server isn't hammered every 1.5s.
        backoffMs = Math.min(backoffMs * 2, 10000);
    };

    const connect = (): void => {
        request = http.get(`${base}/global/event`, (res) => {
            if (res.statusCode !== 200) {
                status(`SSE HTTP ${res.statusCode}`);
                res.resume();
                scheduleRetry();
                return;
            }
            backoffMs = 1500;
            status("connected");
            res.setEncoding("utf8");
            let buffer = "";
            res.on("data", (chunk: string) => {
                buffer += chunk;
                // Walk a start offset instead of reslicing the buffer per frame:
                // `buffer = buffer.slice(index + 2)` copied the leftover tail once
                // per frame, so a chunk carrying N frames cost O(N^2) characters.
                let start = 0;
                let index = buffer.indexOf("\n\n", start);
                while (index >= 0) {
                    const frame = buffer.slice(start, index);
                    const data = frame
                        .split("\n")
                        .filter((line) => line.startsWith("data:"))
                        .map((line) => line.slice(5).trim())
                        .join("");
                    if (data) {
                        try {
                            const parsed = JSON.parse(data) as { payload?: Record<string, unknown> };
                            dispatch(parsed.payload ?? (parsed as Record<string, unknown>));
                        } catch {
                            // ignore malformed frames
                        }
                    }
                    start = index + 2;
                    index = buffer.indexOf("\n\n", start);
                }
                buffer = buffer.slice(start);
            });
            res.on("end", () => scheduleRetry());
            // A socket that drops after the headers arrive emits on the RESPONSE,
            // not on the request. Unhandled, that is an uncaught exception in the
            // extension host — the whole window, not just this turn.
            res.on("error", (error) => {
                status(`stream error: ${error.message}`);
                scheduleRetry();
            });
        });
        request.on("error", (error) => {
            status(`error: ${error.message}`);
            scheduleRetry();
        });
    };

    connect();
    return shared;
}

export function connectSse(
    base: string,
    onEvent: (payload: Record<string, unknown>) => void,
    onStatus: (text: string) => void,
    sessionId?: string
): { close: () => void } {
    const subscriber: SseSubscriber = { sessionId, onEvent, onStatus };
    let shared = sseConnections.get(base);
    if (!shared) {
        shared = openSharedSse(base);
        sseConnections.set(base, shared);
    }
    shared.subscribers.add(subscriber);
    // A subscriber joining an established socket never sees the "connected" that
    // already fired, and runOpenCodeServer waits on exactly that signal.
    if (shared.lastStatus) {
        onStatus(shared.lastStatus);
    }
    let released = false;
    return {
        close: () => {
            if (released) {
                return;
            }
            released = true;
            const conn = sseConnections.get(base);
            if (!conn) {
                return;
            }
            conn.subscribers.delete(subscriber);
            if (conn.subscribers.size === 0) {
                sseConnections.delete(base);
                conn.close();
            }
        }
    };
}
