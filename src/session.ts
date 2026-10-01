import * as vscode from "vscode";
import * as path from "node:path";
import { config, extensionContext, isMultiRoot, resolveFolder, secs, setStatus, truncate } from "./core";
import { RunMetrics } from "./metrics";

export interface SessionState {
    id?: string;
    turns: number;
    toolOutputBytes?: number;
    // Cumulative session totals — all optional, so older state loads unchanged.
    tokensIn?: number;
    tokensOut?: number;
    cost?: number;
    lastAgent?: string;
    lastModel?: string;
}

export const PARTICIPANT_ID = "opencodeCopilotBridge.chat";
// Inline chat is a separate participant: a host without chatParticipantAdditions
// SKIPS any participant that declares `locations` — the panel one must not.
export const INLINE_PARTICIPANT_ID = "opencodeCopilotBridge.inline";
export const OWN_PARTICIPANTS: ReadonlySet<string> = new Set([PARTICIPANT_ID, INLINE_PARTICIPANT_ID]);

function sessionStateKey(cwd: string): string {
    return `opencode.session:${cwd}`;
}

export function getActiveSession(cwd: string): SessionState {
    return extensionContext.workspaceState.get<SessionState>(sessionStateKey(cwd)) ?? { turns: 0 };
}

export function setActiveSession(cwd: string, value: SessionState): Thenable<void> {
    return extensionContext.workspaceState.update(sessionStateKey(cwd), value);
}

/**
 * Which sessions this window is still driving. Bounded, folder-scoped and
 * recency-aware: an entry counts as live only while it was last seen inside
 * the supplied grace window, the key is cwd\0sessionId so folder A cannot
 * protect a same-named session under folder B, and the least-recently-seen
 * entry is evicted at the cap so a long-lived window cannot grow it without
 * bound. The clock is injected so tests advance it without sleeping.
 * Membership is per window and deliberately not persisted.
 */
export class LiveSessionTracker {
    private readonly cap: number;
    private readonly now: () => number;
    // A Map iterates in insertion order and `mark` re-inserts, so the first key
    // is always the least recently seen — no separate ordinal, no scan to evict.
    private readonly entries = new Map<string, { lastSeenMs: number }>();

    constructor(cap = 200, now: () => number = () => Date.now()) {
        this.cap = cap;
        this.now = now;
    }

    private key(cwd: string, sessionId: string): string {
        return `${cwd}\0${sessionId}`;
    }

    mark(cwd: string, sessionId: string): void {
        const k = this.key(cwd, sessionId);
        this.entries.delete(k);
        this.entries.set(k, { lastSeenMs: this.now() });
        this.enforceCap();
    }

    /** `/new`: the user walked away from this thread's previous session. */
    drop(cwd: string, sessionId: string): void {
        this.entries.delete(this.key(cwd, sessionId));
    }

    isLive(cwd: string, sessionId: string, graceMs: number): boolean {
        const e = this.entries.get(this.key(cwd, sessionId));
        return !!e && this.now() - e.lastSeenMs <= graceMs;
    }

    get size(): number {
        return this.entries.size;
    }

    private enforceCap(): void {
        while (this.entries.size > this.cap) {
            const oldest = this.entries.keys().next();
            if (oldest.done) {
                break;
            }
            this.entries.delete(oldest.value);
        }
    }
}

export const liveSessions = new LiveSessionTracker();

/**
 * The metadata every turn returns. VS Code replays it in `ChatContext.history`,
 * so it is the wire format by which a chat thread describes its own session.
 */
export interface TurnMetadata {
    kind?: string;
    sessionId?: string;
    cwd?: string;
    turns?: number;
    tokensIn?: number;
    tokensOut?: number;
    cost?: number;
    toolOutputBytes?: number;
    agent?: string;
    model?: string;
    /** This turn's /flow trace id. */
    flow?: string;
}

/**
 * Which OpenCode session does THIS chat thread belong to?
 *
 * Every turn returns metadata and the host replays it in `context.history`, so
 * walking that history backwards recovers the thread's session with no extra
 * storage and no way for two chats to collide. A `/new` turn is a barrier — the
 * walk stops there, which is what scopes `/new` to one thread. Only turns from
 * our own participant are read, so another participant's metadata can never be
 * mistaken for a session id.
 */
export function threadSession(history: readonly unknown[], cwd: string): SessionState | undefined {
    for (let i = history.length - 1; i >= 0; i--) {
        const turn = history[i] as
            | { participant?: string; result?: { metadata?: TurnMetadata } }
            | undefined;
        // Request turns carry `participant` too but never a `result`.
        if (!turn || !OWN_PARTICIPANTS.has(turn.participant ?? "") || !turn.result) {
            continue;
        }
        const meta = turn.result.metadata ?? {};
        // A thread can move between roots in a multi-root workspace; a turn that
        // belonged to another folder says nothing about this folder's session.
        if (meta.cwd && meta.cwd !== cwd) {
            continue;
        }
        if (meta.kind === "new") {
            return undefined;
        }
        // Only a completed run may bind the thread. Control commands are
        // informational and carry an id but none of the counters; binding to
        // such a turn would silently reset the thread's turn count, spend and
        // context size to zero. A numeric `turns` is the signature of a real
        // run, so it is the gate.
        if (!meta.sessionId || typeof meta.turns !== "number") {
            continue;
        }
        return {
            id: meta.sessionId,
            turns: meta.turns ?? 0,
            toolOutputBytes: meta.toolOutputBytes,
            tokensIn: meta.tokensIn,
            tokensOut: meta.tokensOut,
            cost: meta.cost,
            lastAgent: meta.agent,
            lastModel: meta.model
        };
    }
    return undefined;
}

/** This chat's /flow trace ids, newest first, back to its last `/new`. */
export function threadFlows(history: readonly unknown[], cwd: string): string[] {
    const ids: string[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
        const turn = history[i] as { participant?: string; result?: { metadata?: TurnMetadata } } | undefined;
        if (!turn || !OWN_PARTICIPANTS.has(turn.participant ?? "") || !turn.result) {
            continue;
        }
        const meta = turn.result.metadata ?? {};
        if (meta.kind === "new" && (!meta.cwd || meta.cwd === cwd)) {
            break;
        }
        if (typeof meta.flow === "string") {
            ids.push(meta.flow);
        }
    }
    return ids;
}

/**
 * Thread scope is the default; two cases still read the folder-keyed pointer —
 * an explicit `sessionScope: "workspace"`, and a host that supplied no history
 * at all. Absent history is the one signal that thread identity cannot be
 * trusted; an EMPTY array is a real answer meaning "this chat is new".
 */
export function resolveSessionState(context: vscode.ChatContext | undefined, cwd: string): SessionState {
    if (!threadScopeActive(context)) {
        return getActiveSession(cwd);
    }
    const history = (context as { history: readonly unknown[] }).history;
    return threadSession(history, cwd) ?? { turns: 0 };
}

export function threadScopeActive(context: vscode.ChatContext | undefined): boolean {
    const history = (context as { history?: readonly unknown[] } | undefined)?.history;
    return config().get<string>("sessionScope", "thread") !== "workspace" && Array.isArray(history);
}

export function refreshStatus(cwd?: string): void {
    const folder = cwd ?? resolveFolder()?.folder.uri.fsPath;
    if (!folder) {
        return;
    }
    const state = getActiveSession(folder);
    const parts = ["$(code) OpenCode"];
    if (isMultiRoot()) {
        parts.push(path.basename(folder));
    }
    if (state.id) {
        parts.push(`${state.turns} turn${state.turns === 1 ? "" : "s"}`);
    }
    const head = state.id
        ? `Session \`${state.id}\` · ${state.turns} turn(s)`
        : "No active OpenCode session yet";
    setStatus(parts.join(" · "), `${head}\nClick for OpenCode actions`, false);
}

// The configured model (or OpenCode's default, as undefined) first, then each
// fallback. Deduped, order preserved, and CAPPED: every entry is a full run at
// the full timeout, so an unbounded `fallbackModels` list multiplies the
// worst-case turn length — six fallbacks under a 180s cap is a thirty-minute
// turn nobody asked for.
export function handoffChain(model: string | undefined, fallbacks: string[]): (string | undefined)[] {
    const max = Math.max(1, config().get<number>("maxHandoffAttempts", 3));
    const chain: (string | undefined)[] = [];
    const seen = new Set<string>();
    for (const candidate of [model, ...fallbacks]) {
        const key = candidate ?? "<default>";
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        chain.push(candidate);
        if (chain.length >= max) {
            break;
        }
    }
    return chain;
}

// OpenCode keeps a session on the model it was last sent (1.18.32), so an
// unpinned handoff would keep the fallback for good. The next same-agent turn
// sends the earlier model once.
const handoffReturns = new Map<string, { model: string; agent: string }>();
const HANDOFF_RETURNS_CAP = 200;

export function rememberHandoffReturn(sessionId: string, model: string, agent: string): void {
    handoffReturns.delete(sessionId);
    handoffReturns.set(sessionId, { model, agent });
    while (handoffReturns.size > HANDOFF_RETURNS_CAP) {
        const oldest = handoffReturns.keys().next();
        if (oldest.done) {
            break;
        }
        handoffReturns.delete(oldest.value);
    }
}

export function takeHandoffReturn(sessionId: string | undefined, agent: string, pinned: boolean): string | undefined {
    const back = sessionId ? handoffReturns.get(sessionId) : undefined;
    if (!back || !sessionId) {
        return undefined;
    }
    if (pinned) {
        handoffReturns.delete(sessionId);
        return undefined;
    }
    // Another agent may carry its own model (`model:` in its file); sending
    // this one would override it. Wait for a turn of the same agent.
    if (back.agent !== agent) {
        return undefined;
    }
    handoffReturns.delete(sessionId);
    return back.model;
}

// Completion notifications, mirroring VS Code's own
// chat.notifyWindowOnResponseReceived: a long run you tabbed away from should
// say so. Same rule as VS Code's — only when the window is not focused.
export function notifyIfSlow(metrics: RunMetrics, agentLabel: string, cwd: string): void {
    const settings = config();
    if (!settings.get<boolean>("notifyOnCompletion", true)) {
        return;
    }
    if (metrics.cancelled) {
        return;
    }
    const where = isMultiRoot() ? ` in ${path.basename(cwd)}` : "";

    // A timed-out or errored run is news even when the window IS focused — the
    // answer is partial or wrong — so failures skip the notifyAfterMs/focus gate
    // that keeps a normal "done" banner from nagging someone already looking.
    if (metrics.timedOut || metrics.error) {
        const text = metrics.timedOut
            ? `OpenCode ${agentLabel}${where} timed out after ${secs(metrics.totalMs)} — output may be partial.`
            : `OpenCode ${agentLabel}${where} reported an error after ${secs(metrics.totalMs)}${metrics.error ? `: ${truncate(String(metrics.error), 120)}` : ""
            }`;
        // The toast repeats neither chip nor button: unfocused, it offers Open Chat.
        const actions = vscode.window.state?.focused === false ? ["Open Chat"] : [];
        try {
            void (vscode.window.showErrorMessage(text, ...actions) as
                Promise<string | undefined> | undefined)
                ?.then?.((pick) => {
                    if (pick === "Open Chat") {
                        void vscode.commands.executeCommand("workbench.action.chat.open");
                    }
                });
        } catch {
            // never let a decorative notification break the turn
        }
        return;
    }

    // Slow-but-successful runs inform only when the window is not focused, so a
    // "done" toast never interrupts someone already looking at the answer.
    const minMs = Math.max(0, settings.get<number>("notifyAfterMs", 30000));
    if (minMs === 0 || metrics.totalMs < minMs) {
        return;
    }
    if (vscode.window.state?.focused !== false) {
        return;
    }
    // Same guard as the failure toast above: a host (and the headless stub) may
    // return no thenable, and a decorative notification must never break the turn.
    try {
        void (vscode.window.showInformationMessage(
            `OpenCode ${agentLabel}${where} finished in ${secs(metrics.totalMs)}.`,
            "Open Chat"
        ) as Promise<string | undefined> | undefined)?.then?.((pick) => {
            if (pick === "Open Chat") {
                void vscode.commands.executeCommand("workbench.action.chat.open");
            }
        });
    } catch {
        // never let a decorative notification break the turn
    }
}