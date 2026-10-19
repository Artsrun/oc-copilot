// A session on the managed server: ids made safe for URLs and argv, the
// permission rules a bridge session carries, busy checks and aborts (with the
// subagent sessions under it), creation, its model, and compaction. Below the
// two runners; imports no runner.
import { config, delay, logChannel, stamp, truncate } from "./core";
import { ensureServer } from "./net";
import { api, safeSessionId, sessionPath, sessionRoot } from "./oc-api";
import { ReadOnlyEnforcement, RunMetrics } from "./metrics";
import { PermissionRule, isPermissionRule, listAgents } from "./agents";
import { coldEnforcement, enforcedConfigContent, judgeReadOnly, readOnlySubagents } from "./enforce";

// Session ids are made safe where every route is built (./oc-api).
export { safeSessionId, sessionPath, sessionRoot };

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
// parent's (OpenCode docs, agents; `general` has every tool and edits, and the
// built-in `explore` has `bash * allow`: it wrote a file on a read-only turn,
// 1.19.0 measured). So a read-only turn's session allows `task` only for the
// read-only subagents (`readOnlySubagents`), which every process the bridge
// starts makes read-only by permission (./enforce); last match wins, and a
// denied subagent is left out of the task tool's description entirely.
// Under enforceReadOnly a subagent is allowed only where it is read-only by
// permission: a server keeps the overrides it was started with, so one you
// started (or one started before `readOnlySubagents` changed) may lack them.
// Such a session gets no `bash`/`edit` denies instead: a task child inherits its
// parent's session deny rules (allows dropped, 1.19.0 measured), so they would
// outlive the turn and stop every later /dev subagent of that session.
export function turnPermission(readOnly: boolean, allowed: readonly string[] = readOnlySubagents()): Array<{ permission: string; action: string; pattern: string }> {
    if (!readOnly) {
        return HEADLESS_PERMISSION;
    }
    return [
        ...HEADLESS_PERMISSION,
        { permission: "task", action: "deny", pattern: "*" },
        ...allowed.map((a) => ({ permission: "task", action: "allow", pattern: a }))
    ];
}

const withheldLogged = new Set<string>();

const isBuiltinReadOnly = (agent: string): boolean => agent === "plan" || readOnlySubagents().includes(agent);

/** Effective rules, not spawn intent (judgeReadOnly): the marker, nothing allowed
 * beyond the overrides' reach, writers withheld. A subagent may not delegate:
 * no session rule follows its own `task` rules. */
async function overriddenOn(base: string, cwd: string): Promise<readonly string[]> {
    return ((await listAgents(cwd, base, "plan")) ?? [])
        .filter((a) => judgeReadOnly(a.permission, a.name, {
            builtin: true,
            subagents: a.name === "plan" ? readOnlySubagents() : [],
            sessionTask: a.name === "plan"
        }).kind === "enforced")
        .map((a) => a.name);
}

/** What a read-only turn on `base` may delegate to, and whether its `plan` is
 * read-only by permission there. enforceReadOnly off: every readOnlySubagent (0.0.214). */
export async function readOnlyReach(base: string, cwd: string): Promise<{ allowed: string[]; planEnforced: boolean }> {
    const wanted = readOnlySubagents();
    if (!config().get<boolean>("enforceReadOnly", true)) {
        return { allowed: wanted, planEnforced: false };
    }
    const overridden = await overriddenOn(base, cwd);
    return { allowed: wanted.filter((a) => overridden.includes(a)), planEnforced: overridden.includes("plan") };
}

/**
 * What this turn's agent is allowed, from its EFFECTIVE rules where it runs:
 * `GET /agent` on a server (`base`), `opencode agent list` for a cold run (the
 * loader `opencode run` uses, same folder and OPENCODE_CONFIG_CONTENT). The
 * injected config alone proves nothing: config files merge into it (REFS).
 * A cold run has no session rules, so it cannot withhold a subagent: a
 * reopened readOnlySubagent refuses the turn there.
 */
export async function readOnlyEvidence(base: string | undefined, cwd: string, agent: string): Promise<ReadOnlyEnforcement> {
    if (!config().get<boolean>("enforceReadOnly", true)) {
        return { kind: "disabled" };
    }
    const builtin = isBuiltinReadOnly(agent);
    if (!base && builtin) {
        const injected = coldEnforcement(enforcedConfigContent(), agent);
        if (injected.kind !== "enforced") {
            return injected;
        }
    }
    const agents = await listAgents(cwd, base, agent);
    const subagents = readOnlySubagents();
    const judge = (name: string, isBuiltin: boolean): ReadOnlyEnforcement =>
        judgeReadOnly(agents?.find((a) => a.name === name)?.permission, name, {
            base,
            builtin: isBuiltin,
            subagents: name === "plan" || !isBuiltin ? subagents : [],
            sessionTask: Boolean(base)
        });
    const own = judge(agent, builtin);
    if (base || agent !== "plan" || own.kind !== "enforced") {
        return own;
    }
    return subagents.map((s) => judge(s, true)).find((e) => e.kind === "reopened") ?? own;
}

/** Evidence belongs to this endpoint and the selected agent, including fallbacks. */
export const serverEnforcement = (base: string, cwd: string, agent: string): Promise<ReadOnlyEnforcement> =>
    readOnlyEvidence(base, cwd, agent);

/** A reopened agent stops the turn before anything is sent (a send barrier,
 * like permission preparation): no CLI fallback, Retry offered. */
export function assertReadOnly(evidence: ReadOnlyEnforcement | undefined): void {
    if (evidence?.kind !== "reopened") {
        return;
    }
    const shown = evidence.leaks.slice(0, 5).map((l) => `\`${l}\``).join(", ") + (evidence.leaks.length > 5 ? ` and ${evidence.leaks.length - 5} more` : "");
    logChannel.appendLine(`[${stamp()}] ${evidence.agent}: read-only rules reopened by config on ${evidence.base ?? "the CLI"} — ${evidence.leaks.join("; ")} — not sent`);
    throw Object.assign(
        new Error(
            `Nothing was sent: OpenCode's configuration gives \`${evidence.agent}\` back what the bridge's read-only rules deny — ${shown}. ` +
            `Such keys under \`agent.${evidence.agent}.permission\` (\`opencode.json\`, or \`.opencode/agents/${evidence.agent}.md\`, in the project or your global config) ` +
            "outlast the bridge's rules. Remove them, or ask with `/dev`; `enforceReadOnly: false` turns read-only by permission off."
        ),
        { code: "ETURNPERMISSION" }
    );
}

/** The rules a read-only (or dev) session on `base` gets now. */
export async function sessionRules(base: string, cwd: string, readOnly: boolean): Promise<Array<{ permission: string; action: string; pattern: string }>> {
    if (!readOnly) {
        return HEADLESS_PERMISSION;
    }
    const reach = await readOnlyReach(base, cwd);
    if (config().get<boolean>("enforceReadOnly", true)) {
        const left = readOnlySubagents().filter((a) => !reach.allowed.includes(a));
        const key = `${base}\0${left.join(",")}\0${reach.planEnforced}`;
        if (left.length && !withheldLogged.has(key)) {
            withheldLogged.add(key);
            logChannel.appendLine(`[${stamp()}] ${left.join(", ")}: not read-only by permission on ${base}${reach.planEnforced ? " (it started before readOnlySubagents changed: restart it)" : ""} — left out of read-only turns`);
        }
    }
    return turnPermission(true, reach.allowed);
}

// What each session was last given, so a run of plan turns PATCHes once. A
// session not seen in this window is PATCHed on its first turn: an earlier
// window may have left the read-only rules on it.
const appliedRules = new Map<string, { rules: string; restoredAgent?: string }>();

// OpenCode APPENDS a PATCH's rules, and the LAST rule that matches decides,
// session rules after the agent's (1.19.0, measured; REFS). So a read-only
// turn's `task` rules outlive it unless a dev turn puts the dev agent's own
// back after them: its rules that name `task` (a `*` permission included —
// every agent's list starts `* * allow`), with `task allow *` first for any
// pattern they leave open. Then the agent decides again, as on a new session.
const TASK_ALLOW_ALL: PermissionRule = { permission: "task", action: "allow", pattern: "*" };
const glob = (pattern: string): RegExp =>
    new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");

async function devTaskRules(base: string, cwd: string, agent: string): Promise<PermissionRule[]> {
    const listed = (await listAgents(cwd, base, agent))?.find((a) => a.name === agent)?.permission;
    if (!listed) {
        throw new Error(`Cannot restore task permissions for agent ${agent}: authoritative permission rules are unavailable.`);
    }
    const own = listed.filter((r) => glob(r.permission).test("task")).map((r) => ({ permission: "task", action: r.action, pattern: r.pattern }));
    return own.some((r) => r.pattern === "*") ? own : [TASK_ALLOW_ALL, ...own];
}

// Only a read-only turn puts `task` rules on a session; one this window has
// not seen is read first (2 s). Unread, the agent's own rules go back anyway.
async function carriesTaskRules(base: string, cwd: string, sessionId: string): Promise<boolean> {
    try {
        const session = await api(base).sessionGet(cwd, sessionId, 2000);
        return Array.isArray(session?.permission) && session.permission.some((r) => isPermissionRule(r) && r.permission === "task");
    } catch (error) {
        if (isMissingSessionError(error)) {
            throw error;
        }
        return true;
    }
}

export const isTurnPermissionError = (error: unknown): boolean =>
    (error as { code?: unknown } | undefined)?.code === "ETURNPERMISSION";

/** Permission preparation is a send barrier, including transport fallback. */
export async function applyTurnPermission(base: string, cwd: string, sessionId: string, readOnly: boolean, agent = "build"): Promise<void> {
    const rules = await sessionRules(base, cwd, readOnly);
    const key = `${base}\0${cwd}\0${sessionId}`;
    const want = JSON.stringify(rules);
    const had = appliedRules.get(key);
    if (had?.rules === want && (readOnly || !had.restoredAgent || had.restoredAgent === agent)) {
        return;
    }
    try {
        const restore = !readOnly && (
            had?.restoredAgent !== undefined ||
            (had !== undefined && had.rules !== want) ||
            await carriesTaskRules(base, cwd, sessionId)
        );
        const sent = restore ? [...rules, ...(await devTaskRules(base, cwd, agent))] : rules;
        await api(base).sessionPatch(cwd, sessionId, { permission: sent }, 3000);
        appliedRules.set(key, { rules: want, restoredAgent: restore ? agent : undefined });
        const none = readOnly && !rules.some((r) => r.permission === "task" && r.action === "allow");
        logChannel.appendLine(
            `[${stamp()}] ${sessionId}: ${readOnly ? (none ? "no subagents" : "read-only subagents only") : restore ? `headless rules; subagents as \`${agent}\` allows them` : "headless rules"}`
        );
    } catch (error) {
        logChannel.appendLine(`[${stamp()}] could not set the turn's rules on ${sessionId}: ${error}`);
        // A deleted session needs the existing fresh-session recovery; no
        // prompt is sent to it, and the replacement gets rules at creation.
        if (isMissingSessionError(error)) {
            throw error;
        }
        const why = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").replace(/`/g, "'");
        throw Object.assign(
            new Error(
                `Nothing was sent: this turn's permission rules could not be set on its OpenCode session (${truncate(why, 160)}). ` +
                "Retry; if it fails again, `/new` starts a session that gets them at creation."
            ),
            { code: "ETURNPERMISSION" }
        );
    }
}

/** Record the rules a session was created with (no PATCH needed on its first turn). */
export function noteTurnPermission(base: string, sessionId: string, rules: ReadonlyArray<{ permission: string }>, cwd = ""): void {
    appliedRules.set(`${base}\0${cwd}\0${sessionId}`, { rules: JSON.stringify(rules) });
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
        const all = await api(base).sessionStatus(cwd, 3000);
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
                const kids = (await api(base).sessionChildren(cwd, id, 3000)) as Array<{ id?: unknown }>;
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
        ids.map((id) => api(base).sessionAbort(cwd, id, 3000).catch(() => undefined))
    );
    if (ids.length) {
        logChannel.appendLine(`[${stamp()}] aborted ${ids.length} subagent session(s) under ${sessionId}`);
    }
    return ids;
}

export async function abortServerRun(base: string, sessionId: string, cwd: string, why: string): Promise<boolean> {
    try {
        await api(base).sessionAbort(cwd, sessionId, 5000);
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
    const permission = await sessionRules(base, cwd, readOnly);
    const created = await api(base).sessionCreate(cwd, { title: truncate(title, 60), permission }, 5000);
    noteTurnPermission(base, created.id, permission, cwd);
    return created.id;
}

// The model a session last ran on, read from the session: the newest assistant
// message names it, a user message carries the model it was sent with
// (1.18.32: info.providerID/modelID; info.model on a user message).
async function sessionModel(base: string, cwd: string, sessionId: string): Promise<string | undefined> {
    try {
        const messages = (await api(base).sessionMessages(cwd, sessionId, 6, 5000)) as Array<{ info?: Record<string, unknown> }>;
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
// one waits this long (each failed start costs up to 45 s and a process).
const COMPACT_BACKOFF_MS = 5 * 60000;
let compactServerFailedAt = 0;

// One summary per session at a time, and the next turn of that session waits
// for it (chat-turn prepareRun) instead of aborting it as an unwatched run:
// the summary is a prompt loop, so the session reads busy (1.18.32 prompt.ts).
const compactions = new Map<string, Promise<boolean>>();

/** This window's summary of `sessionId` while it runs, else undefined. */
export function compactionInFlight(sessionId: string): Promise<boolean> | undefined {
    return compactions.get(sessionId);
}

// `asked`: a `/compact` the user typed is never held back by the backoff.
export function compactSession(sessionId: string, cwd: string, model?: string, asked = false): Promise<boolean> {
    const running = compactions.get(sessionId);
    if (running) {
        return running;
    }
    const work = summarize(sessionId, cwd, model, asked);
    compactions.set(sessionId, work);
    const done = (): void => {
        if (compactions.get(sessionId) === work) {
            compactions.delete(sessionId);
        }
    };
    work.then(done, done);
    return work;
}

async function summarize(sessionId: string, cwd: string, model: string | undefined, asked: boolean): Promise<boolean> {
    if (!asked && Date.now() - compactServerFailedAt < COMPACT_BACKOFF_MS) {
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
        // `auto: false`, as OpenCode's own /compact sends it. An auto compaction
        // (1.18.32 compaction.ts) ends by adding a synthetic "Continue if you have
        // next steps" message, and the loop runs one more agent turn that no chat
        // shows — keeping the session busy into the user's next message.
        const status = await api(base).sessionSummarize(cwd, sessionId, { providerID: parts.providerID, modelID: parts.modelID, auto: false }, COMPACT_TIMEOUT_MS);
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
