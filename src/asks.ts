// Headless asks, and the subagent sessions a run starts.
//
// Nobody can answer OpenCode's prompts from a chat turn. Measured on 1.18.32
// against a real server and model (REFS "Read-only turns"):
//   - `opencode run` creates its sessions with question, plan_enter and
//     plan_exit DENIED. POST /session — how the bridge made them — does not,
//     and the built-in plan agent allows `question`: a plan turn that asked
//     one waited until aborted (45s probe). With the rules, the tool is not
//     even offered and the model asks in its reply.
//   - an `ask` rule (plan's: external_directory, *.env reads, doom_loop) makes
//     the server wait for a reply: a plan turn reading /etc/hostname hung until
//     aborted. A reject WITH a message is fed back and the model carries on
//     (PermissionCorrectedError, 30s); a bare reject ends the turn, unanswered.
//   - the attached CLI answers permission asks itself (`--auto`: once; without:
//     reject) but not questions.
//   - `permission.updated` is the same ask in the pre-1.1 shape (the event's own
//     properties), answered at /session/:id/permissions/:permissionID with
//     { response } (docs and SDK types; not measured here). A reply to an ask
//     that is not pending still answers 200/true (#15386, closed unfixed), so
//     only the server's own `permission.replied` says a reply landed.
import { logChannel, stamp, truncate } from "./core";
import { mark, prompt as promptText } from "./followups";
import { connectSse, httpRequestJson, sessionIdFromEvent, withDirectory } from "./net";
import { safeSessionId, sessionPath } from "./server-session";
import { stepDetail } from "./run-steps";
import { SubagentStep, toolFilePath } from "./metrics";

export interface FamilyHooks {
    /** Any event of a subagent session: the run is not idle while its subagent works. */
    onActivity?: () => void;
    /** A subagent's tool call, running or done, with the parent `task` call it runs under. */
    onSubagent?: (sub: SubagentStep) => void;
}

// OpenCode titles a child session `<description> (@<agent> subagent)`.
const AGENT_IN_TITLE = /\(@([\w./-]+) subagent\)\s*$/;

export interface AskPolicy {
    /** Answer permission asks (the server path); the attached CLI answers its own. */
    permissions: boolean;
    autoApprove: boolean;
}

// Answers a permission or question ask for THIS session — never one the demux
// passed along unattributed. Bounded and fire-and-forget: the run is what waits.
// `sent` hears of a permission reply with a way to send it again.
export function answerAsk(
    base: string,
    cwd: string,
    sessionId: string,
    ev: Record<string, unknown>,
    opts: AskPolicy,
    sent?: (id: string, again: () => void) => void
): void {
    const type = ev.type as string | undefined;
    const props = (ev.properties as Record<string, unknown> | undefined) ?? {};
    const id = typeof props.id === "string" ? props.id : "";
    if (!id || props.sessionID !== sessionId) {
        return;
    }
    let url: string;
    let body: Record<string, unknown>;
    let said: string;
    let permission = false;
    if ((type === "permission.asked" || type === "permission.updated") && opts.permissions) {
        // Pre-1.1: no message to feed back, a bare `reject`.
        const legacy = type === "permission.updated";
        url = legacy ? sessionPath(sessionId, `permissions/${safeSessionId(id)}`) : `/permission/${safeSessionId(id)}/reply`;
        body = legacy
            ? { response: opts.autoApprove ? "once" : "reject" }
            : opts.autoApprove ? { reply: "once" } : { reply: "reject", message: promptText("READ_ONLY") };
        const patterns = [props.patterns, props.pattern].flat().filter((p): p is string => typeof p === "string").join(", ");
        said = `permission ${String(props.permission ?? props.type ?? "?")} (${truncate(patterns, 120)}) → ${opts.autoApprove ? "approved once" : "rejected: read-only turn"}${legacy ? " [pre-1.1 event]" : ""}`;
        permission = true;
    } else if (type === "question.asked") {
        const questions = Array.isArray(props.questions) ? props.questions : [];
        url = `/question/${safeSessionId(id)}/reply`;
        body = { answers: (questions.length ? questions : [undefined]).map(() => [promptText("NO_QUESTIONS")]) };
        said = `question → answered "ask in your reply" (${questions.length} asked)`;
    } else {
        return;
    }
    logChannel.appendLine(`[${stamp()}] ${mark("warn")} ${said}`);
    const post = (): void =>
        void httpRequestJson("POST", withDirectory(`${base}${url}`, cwd), body, 5000).catch((error) =>
            logChannel.appendLine(`[${stamp()}] could not answer ${type} ${id}: ${error}`)
        );
    post();
    if (permission) {
        sent?.(id, post);
    }
}

// A permission reply the server did not confirm with `permission.replied` is
// sent once more, then given up on (the run's idle cap is the backstop).
export const REPLY_CONFIRM_MS = 3000;
let replyConfirmMs = REPLY_CONFIRM_MS;

/** For the suite: a short confirmation wait (undefined restores 3 s). */
export function setReplyConfirmWait(ms?: number): void {
    replyConfirmMs = ms ?? REPLY_CONFIRM_MS;
}

export interface FamilyWatch {
    close: () => void;
    /** Subagent sessions seen so far (not the root). */
    children: () => string[];
    /** What those sessions' assistant messages cost: task results carry no metrics. */
    childCost: () => number;
}

// A session's asks AND those of the subagent sessions it spawns (the task
// tool): a child's ask carries the child's id, which the per-session demux never
// hands to the run. `opencode run` tracks the same family, from session.created
// events whose parentID is already in it. The same events give each child's
// spend: an assistant message's `cost` is cumulative, so the last value per
// message id counts.
export function watchFamily(base: string, cwd: string, root: string, opts: AskPolicy, hooks: FamilyHooks = {}): FamilyWatch {
    const family = new Set([root]);
    const costs = new Map<string, number>();
    const agents = new Map<string, string>();
    const tasks = new Map<string, string>();
    // One reply per permission request, whichever event names it (a server may
    // send both shapes); and the replies still waiting for `permission.replied`.
    const answered = new Set<string>();
    const awaiting = new Map<string, NodeJS.Timeout>();
    const confirm = (id: string, again: () => void): void => {
        let resent = false;
        const wait = (): void => {
            const timer = setTimeout(() => {
                if (resent) {
                    awaiting.delete(id);
                    logChannel.appendLine(`[${stamp()}] permission ${id}: still no permission.replied; the run may be waiting on it`);
                    return;
                }
                resent = true;
                logChannel.appendLine(`[${stamp()}] ${mark("warn")} permission ${id}: no permission.replied after ${Math.round(replyConfirmMs / 100) / 10}s — replying once more`);
                again();
                wait();
            }, replyConfirmMs);
            timer.unref?.();
            awaiting.set(id, timer);
        };
        wait();
    };
    const sse = connectSse(
        base,
        (ev) => {
            const props = (ev.properties as Record<string, unknown> | undefined) ?? {};
            // Any event of a subagent's session is the run's activity, not only its parts.
            const evSession = sessionIdFromEvent(ev);
            if (evSession && evSession !== root && family.has(evSession)) {
                hooks.onActivity?.();
            }
            if (ev.type === "session.created" || ev.type === "session.updated") {
                const info = props.info as { id?: unknown; parentID?: unknown; title?: unknown } | undefined;
                if (typeof info?.id === "string" && typeof info.parentID === "string" && family.has(info.parentID)) {
                    family.add(info.id);
                    const named = typeof info.title === "string" ? info.title.match(AGENT_IN_TITLE)?.[1] : undefined;
                    if (named && !agents.has(info.id)) {
                        agents.set(info.id, named);
                    }
                }
                return;
            }
            const part = props.part as Record<string, unknown> | undefined;
            const partSession = typeof part?.sessionID === "string" ? part.sessionID : undefined;
            if (part && partSession && family.has(partSession)) {
                const state = part.state as Record<string, unknown> | undefined;
                const input = state?.input as Record<string, unknown> | undefined;
                // The parent's task call names which agent runs in which child,
                // and its detail is the row the child's calls nest under.
                const child = (state?.metadata as Record<string, unknown> | undefined)?.sessionId;
                if (part.tool === "task" && typeof child === "string" && typeof input?.subagent_type === "string") {
                    agents.set(child, input.subagent_type);
                    tasks.set(child, truncate(stepDetail(input)));
                }
                if (partSession !== root && part.type === "tool" && hooks.onSubagent) {
                    const time = state?.time as { start?: number; end?: number } | undefined;
                    const durationMs = typeof time?.start === "number" && typeof time.end === "number" ? time.end - time.start : undefined;
                    const done = durationMs !== undefined || state?.status === "completed" || state?.status === "error";
                    hooks.onSubagent({
                        agent: agents.get(partSession) ?? "subagent",
                        task: tasks.get(partSession),
                        step: {
                            tool: String(part.tool ?? "tool"),
                            detail: truncate(stepDetail(input, "")),
                            durationMs,
                            status: done ? "done" : "running",
                            filePath: toolFilePath(input)
                        }
                    });
                }
            }
            if (ev.type === "message.updated") {
                const info = props.info as { id?: unknown; sessionID?: unknown; role?: unknown; cost?: unknown } | undefined;
                if (
                    info?.role === "assistant" &&
                    typeof info.id === "string" &&
                    typeof info.sessionID === "string" &&
                    info.sessionID !== root &&
                    family.has(info.sessionID) &&
                    typeof info.cost === "number"
                ) {
                    costs.set(info.id, info.cost);
                }
                return;
            }
            if (typeof props.sessionID === "string" && family.has(props.sessionID)) {
                if (ev.type === "permission.replied") {
                    // Named by request id (1.1+) or permission id (before).
                    const replied = typeof props.requestID === "string" ? props.requestID : typeof props.permissionID === "string" ? props.permissionID : "";
                    clearTimeout(awaiting.get(replied));
                    awaiting.delete(replied);
                    return;
                }
                const permissionAsk = ev.type === "permission.asked" || ev.type === "permission.updated";
                if (permissionAsk && typeof props.id === "string" && answered.has(props.id)) {
                    return;
                }
                answerAsk(base, cwd, props.sessionID, ev, opts, (id, again) => {
                    answered.add(id);
                    confirm(id, again);
                });
            }
        },
        () => undefined
    );
    return {
        close: () => {
            for (const timer of awaiting.values()) {
                clearTimeout(timer);
            }
            awaiting.clear();
            sse.close();
        },
        children: () => [...family].filter((id) => id !== root),
        childCost: () => [...costs.values()].reduce((n, c) => n + c, 0)
    };
}
