// HTTP, SSE, and the managed `opencode serve` lifecycle. Every helper here is
// bounded: a port that accepts and never answers must fail, not hang.
import * as vscode from "vscode";
import { ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as net from "node:net";

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

// serverPort 0 is "a port of our own": the bridge picks a free one for the
// server it starts and never adopts a listener it did not start. The default
// is the fixed 53200 (off the common 4096), which still adopts, because a
// fixed port is the user's to name. Measured by
// scripts/probe-server-adoption.js: any listener answering {"healthy":true}
// there received the prompt text and the workspace path.
let managedPort: number | undefined;

// A fixed port held by a listener that accepts and never answers /global/health
// (a hung `opencode serve` left by another window, another program): the server
// this window starts cannot bind there and exits 1 after its ~10 s boot, and
// every turn and compaction waited 20 s to learn it (log: `serve exited (1)`
// then `did not become healthy on …:53200`). That window starts its own server
// on a free port instead, and says so; it never sends that listener anything.
let fallbackPort: number | undefined;

// The last words of the server this window started: why it exited.
let serveTail = "";
// The port that server was told to listen on.
let servePort: number | undefined;

const serveAlive = (): boolean => Boolean(serveProcess && serveProcess.exitCode === null);

// Something accepts TCP on the port. Bounded: a dropped SYN is "not taken".
function portTaken(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (taken: boolean): void => {
            socket.destroy();
            resolve(taken);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
    });
}

// A health poll while a server boots: shorter than the first probe, so a
// listener that never answers costs the loop 3 s a poll, not 5. Not 1.5 s:
// a server busy loading plugins and MCP servers answers slowly, not never.
const POLL_HEALTH_MS = 3000;

// How long a server this window started may take to answer. Reported (0.0.203):
// `/sessions` → `did not become healthy on …:61930 within 20 s` with the process
// still alive: a first boot loads config, plugins and MCP servers, and a hung
// server elsewhere can hold OpenCode's database. A process that exits is
// reported at once, so the long wait only applies to one that is still alive.
const STARTUP_DEADLINE_MS = 45000;
let startupDeadlineMs = STARTUP_DEADLINE_MS;

/** For the suite: a short deadline (undefined restores 45 s). */
export function setStartupDeadline(ms?: number): void {
    startupDeadlineMs = ms ?? STARTUP_DEADLINE_MS;
}

// Past this, a caller waiting on a server this window is starting is told so
// (`/sessions` sat silent for the whole boot).
const SLOW_START_MS = 1500;

// What each server said it is (`/global/health` → `version`, 1.18.34). The
// bridge leans on behaviour measured on these versions only (REFS); outside
// them it still runs, and says so once per window and version.
export const TESTED_OPENCODE = { min: "1.18.27", max: "1.18.34" } as const;
const serverVersions = new Map<string, string>();
const versionsNoted = new Set<string>();

const semver = (v: string): number[] | undefined => {
    const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};
const below = (a: number[], b: number[]): boolean => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];

/** The one line a server outside the tested range earns, once per window and version. */
export function versionNotice(base: string): string | undefined {
    const version = serverVersions.get(base);
    const v = version ? semver(version) : undefined;
    if (!version || !v || versionsNoted.has(version)) {
        return undefined;
    }
    const lo = semver(TESTED_OPENCODE.min) as number[];
    const hi = semver(TESTED_OPENCODE.max) as number[];
    if (!below(v, lo) && !below(hi, v)) {
        return undefined;
    }
    versionsNoted.add(version);
    logChannel.appendLine(`[${stamp()}] OpenCode ${version} on ${base} is outside the tested ${TESTED_OPENCODE.min}–${TESTED_OPENCODE.max}`);
    return `OpenCode ${version} is outside the versions this bridge was tested with (${TESTED_OPENCODE.min}–${TESTED_OPENCODE.max}). It runs; if something misbehaves, the debug log and REFS.md name what each version was measured on.`;
}

async function freePort(host: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = http.createServer();
        probe.once("error", reject);
        probe.listen(0, host, () => {
            const port = (probe.address() as { port: number }).port;
            probe.close(() => resolve(port));
        });
    });
}

// Where the server is, without starting one: undefined while a port-0 setup
// has not started its own. `/ping`, diagnostics and the model picker read this.
export function knownServerBase(): string | undefined {
    const settings = config();
    const host = settings.get<string>("serverHostname", "127.0.0.1");
    const port = settings.get<number>("serverPort", 53200);
    if (port > 0) {
        return `http://${host}:${fallbackPort && serveAlive() ? fallbackPort : port}`;
    }
    return managedPort && serveProcess && serveProcess.exitCode === null ? `http://${host}:${managedPort}` : undefined;
}

export function stopServer(): void {
    if (serveProcess && serveProcess.exitCode === null) {
        killTree(serveProcess);
    }
    serveProcess = undefined;
    managedPort = undefined;
    fallbackPort = undefined;
    servePort = undefined;
}

export async function ensureServer(cwd?: string, onSlowStart?: (text: string) => void): Promise<string> {
    const settings = config();
    const executable = settings.get<string>("executable", "opencode");
    const host = settings.get<string>("serverHostname", "127.0.0.1");
    const configured = settings.get<number>("serverPort", 53200);
    const own = configured <= 0;
    if (!serveAlive()) {
        fallbackPort = undefined;
        if (own) {
            managedPort = await freePort(host);
        }
    } else if (servePort !== undefined) {
        // serverPort changed while this window's server runs: keep using it.
        if (own && managedPort === undefined) {
            managedPort = servePort;
        } else if (!own && servePort !== configured && fallbackPort === undefined) {
            fallbackPort = servePort;
        }
    }
    let port = own ? (managedPort as number) : fallbackPort ?? configured;
    let base = `http://${host}:${port}`;

    // What a listener says at /global/health. A real OpenCode server names its
    // version ({ healthy, version }, docs and 1.18.34); a program that only says
    // {"healthy":true} is not one, and must not be handed prompts and paths.
    const probe = async (timeoutMs?: number): Promise<{ healthy: boolean; version?: string }> => {
        try {
            const health = await httpGetJson<{ healthy?: boolean; version?: unknown }>(`${base}/global/health`, timeoutMs);
            const version = typeof health.version === "string" && health.version.trim() ? health.version.trim() : undefined;
            if (health.healthy === true && version) {
                serverVersions.set(base, version);
            }
            return { healthy: health.healthy === true, version };
        } catch {
            return { healthy: false };
        }
    };
    const healthy = async (timeoutMs?: number): Promise<boolean> => (await probe(timeoutMs)).healthy;

    // Healthy, but no version: not adopted unless this window started it.
    let foreign = false;
    if (!own && !fallbackPort) {
        const first = await probe();
        const startedHere = Boolean(serveProcess && serveProcess.exitCode === null);
        if (first.healthy && (startedHere || first.version)) {
            // A server we can reach means no start is pending, so any message left
            // over from an earlier failed spawn is now history. Clearing here and
            // before the spawn below means the poll loop can only ever read a
            // message belonging to the process it is actually waiting on.
            serveSpawnError = undefined;
            if (!startedHere && !adoptedServers.has(base)) {
                adoptedServers.add(base);
                logChannel.appendLine(
                    `[${stamp()}] adopted an OpenCode server already listening on ${base}. ` +
                    `Requests are scoped to ${cwd ?? "this workspace"} via ?directory=.`
                );
            }
            return base;
        }
        foreign = first.healthy;
    }

    if ((own || fallbackPort) && serveAlive() && (await healthy())) {
        return base;
    }

    if (!own && !serveAlive() && (foreign || (await portTaken(host, configured)))) {
        fallbackPort = await freePort(host);
        logChannel.appendLine(
            foreign
                ? `[${stamp()}] port ${configured} answers /global/health but names no OpenCode version (a real server sends { healthy, version }) — ` +
                `another program, or an OpenCode too old to say. This window starts its own server on port ${fallbackPort} ` +
                `and sends nothing to ${configured} but that health probe. serverPort 0 always does this.`
                : `[${stamp()}] port ${configured} accepts connections but did not answer /global/health — ` +
                `a hung server or another program. This window starts its own server on port ${fallbackPort} ` +
                `and sends nothing to ${configured}. serverPort 0 always does this.`
        );
        port = fallbackPort;
        base = `http://${host}:${port}`;
    }

    if (!serveAlive()) {
        const serveCwd = cwd ?? resolveFolder()?.folder.uri.fsPath;
        serveSpawnError = undefined;
        serveTail = "";
        servePort = port;
        serveProcess = spawnOpenCode(
            executable,
            ["serve", "--port", String(port), "--hostname", host],
            serveCwd
        );
        // setEncoding on the stream, not toString per chunk: OpenCode's banner is
        // box-drawing, and a character split across two chunks logs as U+FFFD.
        serveProcess.stdout?.setEncoding("utf8");
        serveProcess.stderr?.setEncoding("utf8");
        const keep = (d: string): void => {
            logChannel.appendLine(`[serve] ${d.trim()}`);
            serveTail = (serveTail + d).slice(-600);
        };
        serveProcess.stdout?.on("data", keep);
        serveProcess.stderr?.on("data", keep);
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
    const waitStarted = Date.now();
    const deadline = waitStarted + startupDeadlineMs;
    let told = false;
    // Bail out early if the server process died instead of polling to the deadline —
    // checked after every poll AND at the deadline: a poll that waited out its
    // timeout must not turn a dead server into "did not become healthy".
    const exited = (): Error | undefined => {
        if (!serveProcess || serveProcess.exitCode === null) {
            return undefined;
        }
        if (serveSpawnError) {
            return new Error(`OpenCode server could not be started: ${serveSpawnError}`);
        }
        const why = lastServeLine(serveTail);
        return new Error(`OpenCode server process exited (code ${serveProcess.exitCode})${why ? `: ${why}` : "."}`);
    };
    while (Date.now() < deadline) {
        await delay(waitMs);
        waitMs = Math.min(pollMs, waitMs * 2);
        const dead = exited();
        if (dead) {
            throw dead;
        }
        if (await healthy(POLL_HEALTH_MS)) {
            // Measured per start, so a slow first boot shows up in the log.
            logChannel.appendLine(`[${stamp()}] serve on ${base} answered after ${((Date.now() - waitStarted) / 1000).toFixed(1)}s`);
            return base;
        }
        if (!told && onSlowStart && Date.now() - waitStarted >= SLOW_START_MS) {
            told = true;
            try {
                onSlowStart("Starting the OpenCode server — a first start loads its config, plugins and MCP servers…");
            } catch {
                // a stream closed by Stop must not fail the start
            }
        }
    }
    throw exited() ?? new Error(stillStarting(base, configured));
}

// Start or adopt the managed `opencode serve` for an attached CLI run or the
// lanes. Never throws: a server that cannot start just means this turn runs cold.
export async function warmServer(cwd: string, onSlowStart?: (text: string) => void): Promise<string | undefined> {
    try {
        return await ensureServer(cwd, onSlowStart);
    } catch (error) {
        logChannel.appendLine(`[${stamp()}] server unavailable, dev runs cold: ${error}`);
        return undefined;
    }
}

/** A live server that never answered: what it last said, and what to do. */
function stillStarting(base: string, configured: number): string {
    const said = lastServeLine(serveTail);
    return (
        `OpenCode server did not become healthy on ${base} within ${Math.round(startupDeadlineMs / 1000)} s; the process is still running` +
        (said ? ` (it last printed: ${said})` : " and printed nothing") +
        "." +
        (fallbackPort
            ? ` Port ${configured} is held by a listener that does not answer — usually a hung \`opencode serve\` from another window, ` +
            "which can also hold OpenCode's database and keep a new server from starting. End that process and retry."
            : " A first start loads plugins and MCP servers; if it keeps failing, run `opencode serve` in a terminal to see why.")
    );
}

/** The line that says why a server stopped: the last error-looking one, else the last. */
export function lastServeLine(output: string): string {
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const err = [...lines].reverse().find((l) => /error|EADDRINUSE|failed|cannot|denied/i.test(l));
    return truncate(err ?? lines[lines.length - 1] ?? "", 200);
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
    // undefined means "every event": the ask watcher follows a session's
    // subagents, whose ids it learns from the stream itself.
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
