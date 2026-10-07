// `/parallel`: splitting a message into lanes, running them at once, and the
// lane answers the Merge and Retry chips need (kept in this window only).
import * as vscode from "vscode";
import { logChannel, secs, stamp, truncate } from "./core";
import { RunMetrics, emptyTokens, finalizeStepStatuses } from "./metrics";
import { scrubLeakedContext, stepsLine } from "./format";
import { abortServerRun, createServerSession, runOpenCode } from "./runs";
import { mark } from "./followups";
import { cachedModelInfo, effortFor } from "./models";

// ---------------------------------------------------------------------------
// parallel lanes
// ---------------------------------------------------------------------------
//
// N independent sessions at once: OpenCode's own subagents run one at a time
// (sst/opencode #14195). Lanes are read-only (`planAgent`); concurrent writers
// in one checkout overwrite each other, so write lanes need parallelAllowWrite.

/** One lane: its task, the model it runs on, or why it cannot run. */
export interface LaneSpec {
    task: string;
    model?: string;
    /** `a:<agent>`: confirmed against OpenCode's list (chat.ts), else `error`. */
    agent?: string;
    error?: string;
}

interface LaneResult {
    lane: string;
    answer: string;
    metrics: RunMetrics;
}

/** What a finished lane left behind, for the Merge and Retry chips. */
export interface LaneOutcome {
    task: string;
    model?: string;
    agent?: string;
    answer: string;
    error?: string;
    timedOut: boolean;
    /** False when the model never resolved: that lane is never retried. */
    ran: boolean;
}

// Lanes split on `|`, `;;` or a `---` line; `||` (a shell OR) is text. Inside
// backticks or a table row they are text too: with no lane cap, a stray split
// is a paid run. An unclosed backtick guards to the end. Line endings are
// normalised first: a CRLF prompt (a Windows paste) never matched a `---` line
// (reproduced: 4 lanes with LF, 1 with CRLF).
const LANE_MASK: Record<string, string> = { "|": "\u0001", ";": "\u0002", "-": "\u0003" };
const LANE_UNMASK: Record<string, string> = { "\u0001": "|", "\u0002": ";", "\u0003": "-" };
const maskLane = (s: string) => s.replace(/[|;-]/g, (c) => LANE_MASK[c]);

export function splitLanes(task: string): string[] {
    return task
        .replace(/\r\n?/g, "\n")
        .replace(/(`+)(?:[\s\S]*?\1|[\s\S]*$)/g, maskLane)
        .replace(/^[ \t]*\|.*$/gm, maskLane)
        .replace(/\|{2,}/g, maskLane)
        .split(/\s*(?:\||;;|\n[ \t]*-{2,}[ \t]*\n)\s*/)
        .map((part) => part.replace(/[\u0001-\u0003]/g, (c) => LANE_UNMASK[c]).trim())
        .filter(Boolean);
}

export async function runParallelLanes(opts: {
    response: vscode.ChatResponseStream;
    token: vscode.CancellationToken;
    cwd: string;
    executable: string;
    timeoutMs: number;
    model?: string;
    pure: boolean;
    lanes: LaneSpec[];
    write: boolean;
    devAgent?: string;
    /** `planAgent` as OpenCode confirmed it (see ./agents). */
    planAgent?: string;
    attachUrl?: string;
    /** Attachments, appended to every lane's task (titles stay the task). */
    preamble?: string;
    /** `effort:` or the `effort` setting, checked per lane against its model. */
    effort?: string;
}): Promise<LaneOutcome[]> {
    const specs = opts.lanes;
    const lanes = specs.map((s) => s.task);
    const laneAgent = opts.write ? opts.devAgent ?? "build" : opts.planAgent ?? "plan";
    const names = cachedModelInfo();
    const modelName = (id: string): string => names[id]?.name ?? id;
    // One task on several models (`models:`): lanes are told apart by model.
    const sameTask = specs.length > 1 && specs.every((s) => s.task === specs[0].task);

    opts.response.markdown(
        `Running **${lanes.length} lanes** in parallel` +
        (opts.write
            ? " with the editing agent"
            : laneAgent === "plan"
                ? " with the read-only plan agent"
                : ` with the read-only \`${laneAgent}\` agent`) +
        (sameTask ? ` on ${specs.length} models` : "") +
        (opts.timeoutMs > 0 ? `, ${Math.round(opts.timeoutMs / 1000)}s cap each.` : ", no wall-clock cap.") +
        // An `a:` lane is only as read-only as that agent's own permissions.
        (specs.some((s) => s.agent && !s.error) ? " An `a:` lane runs with its agent's own permissions." : "") +
        "\n"
    );

    const done: boolean[] = specs.map((s) => Boolean(s.error));
    const tickLabel = (i: number): string =>
        sameTask && specs[i].model ? truncate(modelName(specs[i].model as string).split(/[\s(]/)[0], 22) : truncate(lanes[i], 22);
    const tick = (): void => {
        opts.response.progress(
            specs.map((s, i) => `${s.error ? mark("warn") : done[i] ? mark("ok") : "•"} ${tickLabel(i)}`).join("   ")
        );
    };
    tick();

    // A level a lane's model lacks is dropped for that lane, never refused:
    // the other lanes are worth running (OpenCode would ignore it silently).
    const variants = specs.map((s) => {
        const choice = effortFor(s.model ?? opts.model, opts.effort, false, names);
        if (choice.problem && !s.error) {
            opts.response.markdown(`> ${mark("warn")} ${truncate(s.task, 40)}: ${choice.problem}\n`);
        }
        return choice.variant;
    });

    // Sessions up front, so Stop can abort an attached lane on the server.
    const attachUrl = opts.attachUrl;
    const laneSessions: (string | undefined)[] = attachUrl
        ? await Promise.all(specs.map((s) => (s.error ? undefined : createServerSession(attachUrl, opts.cwd, s.task, !opts.write).catch(() => undefined))))
        : specs.map(() => undefined);

    const results = await Promise.all(
        lanes.map(async (lane, i): Promise<LaneResult> => {
            let answer = "";
            const laneStarted = Date.now();
            // A lane that threw reports what it spent, not the cap.
            const blank: RunMetrics = {
                firstByteMs: undefined,
                totalMs: 0,
                timedOut: false,
                steps: [],
                tokens: emptyTokens(),
                cost: 0,
                hadOutput: false,
                sessionId: undefined,
                reasoning: ""
            };
            if (specs[i].error) {
                blank.error = specs[i].error;
                return { lane, answer, metrics: blank };
            }
            const agent = specs[i].agent ?? laneAgent;
            try {
                const metrics = await runOpenCode({
                    executable: opts.executable,
                    task: `${lane}${opts.preamble ?? ""}`,
                    cwd: opts.cwd,
                    // A fresh session per lane: no shared context.
                    agent,
                    // N lanes attached to one warm server: no N cold boots.
                    attachUrl,
                    sessionId: laneSessions[i],
                    model: specs[i].model ?? opts.model,
                    pure: opts.pure,
                    // `--auto` for write lanes and the built-in plan only.
                    autoApprove: opts.write || agent === "plan",
                    readOnly: !opts.write,
                    json: true,
                    thinking: false,
                    variant: variants[i],
                    timeoutMs: opts.timeoutMs,
                    token: opts.token,
                    onText: (text) => {
                        answer += text;
                    },
                    onStep: () => tick()
                });
                done[i] = true;
                tick();
                const laneSession = laneSessions[i] ?? metrics.sessionId;
                if (attachUrl && laneSession && (opts.token.isCancellationRequested || metrics.timedOut)) {
                    // Not awaited: after Stop the host allows the handler one second.
                    void abortServerRun(attachUrl, laneSession, opts.cwd, opts.token.isCancellationRequested ? "lane cancelled" : "lane timed out");
                }
                return { lane, answer, metrics };
            } catch (error) {
                done[i] = true;
                tick();
                logChannel.appendLine(`[${stamp()}] lane "${truncate(lane, 60)}" failed: ${error}`);
                blank.totalMs = Date.now() - laneStarted;
                blank.error = error instanceof Error ? error.message : String(error);
                return { lane, answer, metrics: blank };
            }
        })
    );

    for (const [i, result] of results.entries()) {
        finalizeStepStatuses(result.metrics);
        const body = scrubLeakedContext(result.answer.trim()) || "_(no output)_";
        const steps = stepsLine(result.metrics);
        // A failed lane shows its error; "partial" is for a real timeout only.
        const fail = result.metrics.error
            ? ` · ${mark("warn")} ${truncate(String(result.metrics.error), 120)}`
            : "";
        const laneModel = specs[i].model ?? opts.model;
        const title =
            (sameTask && laneModel ? modelName(laneModel) : truncate(result.lane, 80) + (laneModel ? ` · ${modelName(laneModel)}` : "")) +
            (specs[i].agent ? ` · ${specs[i].agent}` : "");
        opts.response.markdown(
            `\n\n### ${i + 1}. ${title}\n\n${specs[i].error ? "_(not run)_" : body}\n\n` +
            `> ${steps ? steps + " · " : ""}${secs(result.metrics.totalMs)}` +
            (result.metrics.cost > 0 ? ` · $${result.metrics.cost.toFixed(4)}` : "") +
            (result.metrics.timedOut ? " · " + mark("quiet") + " partial" : fail)
        );
    }

    const ok = results.filter((r) => !r.metrics.timedOut && r.answer.trim()).length;
    const totalMs = Math.max(...results.map((r) => r.metrics.totalMs), 0);
    const serialMs = results.reduce((n, r) => n + r.metrics.totalMs, 0);
    const cost = results.reduce((n, r) => n + r.metrics.cost, 0);
    opts.response.markdown(
        `\n\n---\n\n**${ok}/${results.length} lanes returned.** ` +
        `Wall clock ${secs(totalMs)} vs ${secs(serialMs)} sequential` +
        (cost > 0 ? ` · $${cost.toFixed(4)}` : "") +
        ".\n\nLanes ran in isolated sessions, so nothing above is in your ongoing " +
        // The Merge and Compare chips need two answers (followupsFor); name them only then.
        (results.filter((r, i) => !specs[i].error && r.answer.trim()).length >= 2
            ? `conversation. ${sameTask ? "**Compare** or **Merge lanes**" : "**Merge lanes**"} below brings their answers into it.`
            : "conversation. Paste the parts you want to keep into a normal `@opencode` turn.")
    );

    return results.map((r, i) => ({
        task: specs[i].task,
        model: specs[i].model ?? opts.model,
        agent: specs[i].agent,
        answer: r.answer.trim(),
        error: r.metrics.error,
        timedOut: r.metrics.timedOut,
        ran: !specs[i].error
    }));
}


// ---------------------------------------------------------------------------
// The lane answers a Merge-lanes chip needs. A chip carries only a prompt and a
// command, and the turn metadata is persisted by the host, so neither may hold
// the answers: they stay here, behind an id, bounded like followupStore above.
// A window reload empties this, and the merge turn says so (./chat).

export const LANE_STORE_CAP = 8;
export const LANE_ANSWER_CAP = 20_000;
const LANE_COUNT_CAP = 8;
const laneStore = new Map<string, LaneOutcome[]>();
let laneRunSeq = 0;

export const newLaneRunId = (): string => `L${Date.now().toString(36)}${(laneRunSeq += 1).toString(36)}`;

export function rememberLanes(id: string, lanes: readonly LaneOutcome[]): void {
    laneStore.delete(id);
    laneStore.set(
        id,
        lanes.slice(0, LANE_COUNT_CAP).map((l) => ({ ...l, answer: cutAt(l.answer, LANE_ANSWER_CAP) }))
    );
    while (laneStore.size > LANE_STORE_CAP) {
        laneStore.delete(laneStore.keys().next().value as string);
    }
}

export const recallLanes = (id: string): LaneOutcome[] | undefined => laneStore.get(id);

/** One runaway lane must not crowd out the rest: cut at the last line break. */
function cutAt(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    const cut = text.slice(0, max);
    const nl = cut.lastIndexOf("\n");
    return cut.slice(0, nl > max / 2 ? nl : cut.length);
}

/** The lanes that ran and did not answer — never one whose model never resolved. */
export const failedLanes = (lanes: readonly LaneOutcome[]): LaneOutcome[] =>
    lanes.filter((l) => l.ran && (Boolean(l.error) || l.timedOut));

export const answeredLanes = (lanes: readonly LaneOutcome[]): LaneOutcome[] => lanes.filter((l) => l.ran && Boolean(l.answer));

/**
 * The failed lanes as a message that re-runs them. Two or more are lanes again
 * (`m:` each, split on `---`, as the composer writes them); one is a plain turn,
 * because /parallel refuses a single lane — its model moves to an inline
 * `model:` prefix, which parseChatPrompt reads the same way; its `a:` agent
 * has no one-turn form and is dropped (the turn runs as its kind's agent).
 */
export function retryLanesPrompt(failed: readonly LaneOutcome[]): string {
    const lanes = failed.slice(0, LANE_COUNT_CAP);
    return lanes.length > 1
        ? lanes.map((l) => (l.agent ? `a:${l.agent} ` : "") + (l.model ? `m:${l.model} ` : "") + l.task).join("\n---\n")
        : lanes.map((l) => (l.model ? `model:${l.model} ` : "") + l.task).join("");
}

const MERGE_CONTEXT_CAP = 60_000;

/** The answered lanes as one context block, folded in like an attachment. */
export function laneMergeContext(lanes: readonly LaneOutcome[]): string {
    const blocks = answeredLanes(lanes).map((l, i) => `\n\n## Lane ${i + 1}${l.model ? ` (${l.model})` : ""}: ${truncate(l.task, 120)}\n\n${l.answer}`);
    return cutAt(`\n\n---${blocks.join("")}`, MERGE_CONTEXT_CAP);
}


