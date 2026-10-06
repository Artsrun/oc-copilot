// A session on the managed server: ids made safe for URLs and argv, the
// permission rules a bridge session carries, busy checks and aborts (with the
// subagent sessions under it), creation, its model, and compaction. Below the
// two runners; imports no runner.
import { config, delay, logChannel, stamp, truncate } from "./core";
import { ensureServer, httpGetJson, httpPostJson, httpRequestJson, withDirectory } from "./net";
import { RunMetrics } from "./metrics";

// A session id is untrusted (stdout, server, replayed metadata). In a URL path
// `..` walks to another endpoint; in argv a leading `-` is a flag. Every site
// uses sessionPath or safeSessionId (tripwire: MA); anything else is replaced.
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export function safeSessionId(sessionId: string): string {
    if (SAFE_ID.test(sessionId)) {
        return sessionId;
    }
    const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[.-]+/, "_").slice(0, 128);
    const safe = cleaned || "session";
    logChannel?.appendLine(`[${stamp()}] unsafe session id ${JSON.stringify(sessionId)} → ${safe}`);
    return safe;
}

export const sessionPath = (sessionId: string, tail: string): string => `/session/${safeSessionId(sessionId)}/${tail}`;
/** The session itself: GET, PATCH or DELETE `/session/<id>`. */
export const sessionRoot = (sessionId: string): string => `/session/${safeSessionId(sessionId)}`;

// ---------------------------------------------------------------------------
// permission rules
// ---------------------------------------------------------------------------
//
// Nobody can answer OpenCode's prompts from a chat turn (see ./asks): sessions
// the bridge creates deny the question tool and plan switches.
export const HEADLESS_PERMISSION = [
    { permission: "question", action: "deny", pattern: "*" },
    { permission: "plan_enter", action: "deny", pattern: "*" },
    { permission: "plan_exit", action: "deny", pattern: "*" }
];

// claim:read-only-subagents — a subagent runs with ITS OWN permissions, not a restricted copy of the
// parent's (OpenCode docs, agents; `general` has every tool and edits). So a
// read-only turn whose agent may call `task` could edit through `general`
// without a single ask. On a read-only turn the session's `task` rule allows
// only the read-only subagents (`readOnlySubagents`); last match wins, and a
// denied subagent is left out of the task tool's description entirely.
export function turnPermission(readOnly: boolean): Array<{ permission: string; action: string; pattern: string }> {
    if (!readOnly) {
        return HEADLESS_PERMISSION;
    }
    const allowed = config().get<string[]>("readOnlySubagents", ["explore"]) ?? [];
    return [
        ...HEADLESS_PERMISSION,
        { permission: "task", action: "deny", pattern: "*" },
        ...allowed.filter((a) => typeof a === "string" && a.trim()).map((a) => ({ permission: "task", action: "allow", pattern: a.trim() }))
    ];
}

// What each session was last given, so a run of plan turns PATCHes once. A
// session not seen in this window is PATCHed on its first turn: an earlier
// window may have left the read-only rules on it.
const appliedRules = new Map<string, string>();

/** Put this turn's rules on the session; logged and carried on when it fails. */
export async function applyTurnPermission(base: string, cwd: string, sessionId: string, readOnly: boolean): Promise<void> {
    const rules = turnPermission(readOnly);
    const key = `${base}\0${sessionId}`;
    const want = JSON.stringify(rules);
    if (appliedRules.get(key) === want) {
        return;
    }
    try {
        await httpRequestJson("PATCH", withDirectory(`${base}${sessionRoot(sessionId)}`, cwd), { permission: rules }, 3000);
        appliedRules.set(key, want);
        logChannel.appendLine(`[${stamp()}] ${sessionId}: ${readOnly ? "read-only subagents only" : "headless rules"}`);
    } catch (error) {
        logChannel.appendLine(`[${stamp()}] could not set the turn's rules on ${sessionId}: ${error}`);
    }
}

/** Record rules a session was created with (no PATCH needed on its first turn). */
export function noteTurnPermission(base: string, sessionId: string, readOnly: boolean): void {
    appliedRules.set(`${base}\0${sessionId}`, JSON.stringify(turnPermission(readOnly)));
}

// ---------------------------------------------------------------------------
// stale session recovery
// ---------------------------------------------------------------------------
//
// A session id outlives OpenCode's own storage — deleted from the TUI, cleared
// on reinstall, carried to another machine by settings sync. A stale id is fatal
// on BOTH transports and repeats every turn until something clears it.
//
// Measured against opencode 1.18.27:
//   server  POST /session/<stale>/message  → HTTP 404
//   cli     opencode run --session <stale> → exit 1, stderr "Error: Session not found"
export function isMissingSessionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /^HTTP 404\b/.test(message) || /session not found/i.test(message);
}

export function isMissingSessionRun(metrics: RunMetrics): boolean {
    if (metrics.exitCode === 0 || metrics.exitCode === undefined) {
        return false;
    }
    return /session not found/i.test(`${metrics.stderr ?? ""}${metrics.error ?? ""}`);
}

// An attach that could not reach the server fails fast and says so on stderr;
// the turn then runs cold rather than being lost.
export function isAttachFailure(metrics: RunMetrics): boolean {
    if (metrics.exitCode === 0 || metrics.exitCode === undefined || metrics.hadOutput || metrics.steps.length) {
        return false;
    }
    return /ECONNREFUSED|ECONNRESET|fetch failed|unable to connect|socket hang up/i.test(
        `${metrics.stderr ?? ""}${metrics.error ?? ""}`
    );
}

// ---------------------------------------------------------------------------
// server-side run control
// ---------------------------------------------------------------------------
//
// Measured on 1.18.32: killing a `run --attach` client does not stop the run,
// and a later prompt to that session is queued behind it. So every stop aborts
// on the server, and every send checks the session is not busy.

export async function sessionBusy(base: string, sessionId: string, cwd: string): Promise<boolean | undefined> {
    try {
        const all = await httpGetJson<Record<string, { type?: string }>>(withDirectory(`${base}/session/status`, cwd), 3000);
        const st = all?.[sessionId]?.type;
        return Boolean(st && st !== "idle");
    } catch {
        return undefined;
    }
}

// Whether aborting a parent stops the subagents it started is not documented
// for 1.18.x, so their sessions are aborted too: harmless on an idle one.
// Bounded: two levels, 16 sessions, 3 s per call; never awaited by Stop.
const TREE_DEPTH = 2;
const TREE_MAX = 16;

export async function abortChildren(base: string, sessionId: string, cwd: string, known: readonly string[] = []): Promise<string[]> {
    const seen = new Set<string>(known.filter((id) => id !== sessionId));
    let level = [sessionId];
    for (let depth = 0; depth < TREE_DEPTH && level.length && seen.size < TREE_MAX; depth += 1) {
        const next: string[] = [];
        for (const id of level) {
            try {
                const kids = await httpGetJson<Array<{ id?: unknown }>>(withDirectory(`${base}${sessionPath(id, "children")}`, cwd), 3000);
                for (const k of Array.isArray(kids) ? kids : []) {
                    if (typeof k?.id === "string" && !seen.has(k.id) && seen.size < TREE_MAX) {
                        seen.add(k.id);
                        next.push(k.id);
                    }
                }
            } catch {
                // an older server without /children: the ids the stream showed still go
            }
        }
        level = next;
    }
    const ids = [...seen];
    await Promise.all(
        ids.map((id) => httpRequestJson("POST", withDirectory(`${base}${sessionPath(id, "abort")}`, cwd), undefined, 3000).catch(() => undefined))
    );
    if (ids.length) {
        logChannel.appendLine(`[${stamp()}] aborted ${ids.length} subagent session(s) under ${sessionId}`);
    }
    return ids;
}

export async function abortServerRun(base: string, sessionId: string, cwd: string, why: string): Promise<boolean> {
    try {
        await httpRequestJson("POST", withDirectory(`${base}${sessionPath(sessionId, "abort")}`, cwd), undefined, 5000);
    } catch (error) {
        logChannel.appendLine(`[${stamp()}] abort ${sessionId} failed (${why}): ${error}`);
        return false;
    }
    void abortChildren(base, sessionId, cwd);
    for (let i = 0; i < 15; i++) {
        if ((await sessionBusy(base, sessionId, cwd)) === false) {
            logChannel.appendLine(`[${stamp()}] aborted server run ${sessionId} (${why})`);
            return true;
        }
        await delay(200);
    }
    logChannel.appendLine(`[${stamp()}] abort ${sessionId} sent but the session still reports busy (${why})`);
    return false;
}

export async function createServerSession(base: string, cwd: string, title: string, readOnly = false): Promise<string> {
    // Bounded: a server that accepts the socket and never answers must not
    // hold the turn (every caller falls back to letting the run create one).
    const created = await httpRequestJson<{ id: string }>("POST", withDirectory(`${base}/session`, cwd), {
        title: truncate(title, 60),
        permission: turnPermission(readOnly)
    }, 5000);
    noteTurnPermission(base, created.id, readOnly);
    return created.id;
}

// The model a session last ran on, read from the session: the newest assistant
// message names it, a user message carries the model it was sent with
// (1.18.32: info.providerID/modelID; info.model on a user message).
export async function sessionModel(base: string, cwd: string, sessionId: string): Promise<string | undefined> {
    try {
        const messages = await httpGetJson<Array<{ info?: Record<string, unknown> }>>(
            withDirectory(`${base}${sessionPath(sessionId, "message")}?limit=6`, cwd),
            5000
        );
        for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {
            const info = message?.info ?? {};
            if (info.role === "assistant" && typeof info.providerID === "string" && typeof info.modelID === "string") {
                return `${info.providerID}/${info.modelID}`;
            }
            const sent = info.model as { providerID?: string; modelID?: string; id?: string } | undefined;
            const id = sent?.modelID ?? sent?.id;
            if (info.role === "user" && sent?.providerID && id) {
                return `${sent.providerID}/${id}`;
            }
        }
    } catch (error) {
        logChannel.appendLine(`[${stamp()}] could not read the model of ${sessionId}: ${error}`);
    }
    return undefined;
}

// Compact (summarize) the persistent session via the managed server. The run CLI
// and the server share the same session store, so this shrinks the context that
// the next `opencode run` will load.
//
// Summarize with the model the session runs on (this turn's, the session's
// record, else the pin) and in the turn's folder — never the catalog's first.
const COMPACT_TIMEOUT_MS = 180000;
// A server that would not start is not retried by every compaction: the next
// one waits this long (each failed start costs up to 20 s and a process).
const COMPACT_BACKOFF_MS = 5 * 60000;
let compactServerFailedAt = 0;

export async function compactSession(sessionId: string, cwd: string, model?: string): Promise<boolean> {
    if (Date.now() - compactServerFailedAt < COMPACT_BACKOFF_MS) {
        logChannel.appendLine(`[${stamp()}] compact skipped: the server failed to start ${Math.round((Date.now() - compactServerFailedAt) / 1000)}s ago`);
        return false;
    }
    let base: string;
    try {
        base = await ensureServer(cwd);
    } catch (error) {
        compactServerFailedAt = Date.now();
        logChannel.appendLine(`[${stamp()}] compact failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
    compactServerFailedAt = 0;
    try {
        const spec =
            model ??
            (await sessionModel(base, cwd, sessionId)) ??
            (config().get<string>("model", "").trim() || undefined);
        const index = spec?.indexOf("/") ?? -1;
        if (!spec || index <= 0) {
            logChannel.appendLine(`[${stamp()}] compact skipped: the model of ${sessionId} is not known yet`);
            return false;
        }
        const parts = { providerID: spec.slice(0, index), modelID: spec.slice(index + 1) };
        // A full model pass over the context: 30s timed out on 66k tokens.
        const status = await httpPostJson(
            withDirectory(`${base}${sessionPath(sessionId, "summarize")}`, cwd),
            { providerID: parts.providerID, modelID: parts.modelID, auto: true },
            COMPACT_TIMEOUT_MS
        );
        logChannel.appendLine(
            `[${stamp()}] summarize ${sessionId} with ${parts.providerID}/${parts.modelID} → HTTP ${status}`
        );
        return status >= 200 && status < 300;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logChannel.appendLine(`[${stamp()}] compact failed: ${message}`);
        return false;
    }
}

/** For the suite: forget the compaction backoff. */
export function resetCompactBackoff(): void {
    compactServerFailedAt = 0;
}
