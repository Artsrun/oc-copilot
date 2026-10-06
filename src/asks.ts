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
import { logChannel, stamp, truncate } from "./core";
import { mark, prompt as promptText } from "./followups";
import { connectSse, httpRequestJson, withDirectory } from "./net";
import { safeSessionId } from "./server-session";
import { stepDetail } from "./run-steps";

export interface FamilyHooks {
    /** Any event of a subagent session: the run is not idle while its subagent works. */
    onActivity?: () => void;
    /** A subagent's tool starting: `explore › grep redirect`. */
    onSubagent?: (text: string) => void;
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
export function answerAsk(base: string, cwd: string, sessionId: string, ev: Record<string, unknown>, opts: AskPolicy): void {
    const type = ev.type as string | undefined;
    const props = (ev.properties as Record<string, unknown> | undefined) ?? {};
    const id = typeof props.id === "string" ? props.id : "";
    if (!id || props.sessionID !== sessionId) {
        return;
    }
    let url: string;
    let body: Record<string, unknown>;
    let said: string;
    if (type === "permission.asked" && opts.permissions) {
        url = `/permission/${safeSessionId(id)}/reply`;
        body = opts.autoApprove ? { reply: "once" } : { reply: "reject", message: promptText("READ_ONLY") };
        const patterns = Array.isArray(props.patterns) ? props.patterns.join(", ") : "";
        said = `permission ${String(props.permission ?? "?")} (${truncate(patterns, 120)}) → ${opts.autoApprove ? "approved once" : "rejected: read-only turn"}`;
    } else if (type === "question.asked") {
        const questions = Array.isArray(props.questions) ? props.questions : [];
        url = `/question/${safeSessionId(id)}/reply`;
        body = { answers: (questions.length ? questions : [undefined]).map(() => [promptText("NO_QUESTIONS")]) };
        said = `question → answered "ask in your reply" (${questions.length} asked)`;
    } else {
        return;
    }
    logChannel.appendLine(`[${stamp()}] ${mark("warn")} ${said}`);
    void httpRequestJson("POST", withDirectory(`${base}${url}`, cwd), body, 5000).catch((error) =>
        logChannel.appendLine(`[${stamp()}] could not answer ${type} ${id}: ${error}`)
    );
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
    const sse = connectSse(
        base,
        (ev) => {
            const props = (ev.properties as Record<string, unknown> | undefined) ?? {};
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
                // The parent's task call names which agent runs in which child.
                const child = (state?.metadata as Record<string, unknown> | undefined)?.sessionId;
                if (part.tool === "task" && typeof child === "string" && typeof input?.subagent_type === "string") {
                    agents.set(child, input.subagent_type);
                }
                if (partSession !== root) {
                    hooks.onActivity?.();
                    if (part.type === "tool" && state?.status === "running" && hooks.onSubagent) {
                        const tool = String(part.tool ?? "tool");
                        const detail = truncate(stepDetail(input, ""), 60);
                        hooks.onSubagent(`${agents.get(partSession) ?? "subagent"} › ${tool}${detail && detail !== "{}" ? ` ${detail}` : ""}`);
                    }
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
                answerAsk(base, cwd, props.sessionID, ev, opts);
            }
        },
        () => undefined
    );
    return {
        close: sse.close,
        children: () => [...family].filter((id) => id !== root),
        childCost: () => [...costs.values()].reduce((n, c) => n + c, 0)
    };
}
