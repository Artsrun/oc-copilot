// Follow-up chips: the answer-derived ones kept per turn, and the chips a
// finished turn gets, a pure function of its metadata (./followups.json).
import * as vscode from "vscode";
import { config, logChannel, stamp } from "./core";
import { StepRecord } from "./metrics";
import { CASES, ChipKey, Outcome, chipLabel, chipOf, fillPrompt } from "./followups";
import { naturalFollowups } from "./natural";
import { failedLanes, recallLanes, retryLanesPrompt, splitLanes } from "./lanes";

// ---------------------------------------------------------------------------
// smart follow-ups
// ---------------------------------------------------------------------------
//
// Chips read from the finished answer (./natural), kept in memory, not in
// metadata: a chip only matters right after its turn.

export interface Followup {
    label: string;
    prompt: string;
    /** Set on every chip: Copilot keeps the last command sticky, so the kind
     * lives here and the prompt is only the sentence. */
    command: "dev" | "plan" | "parallel";
}

// Runs inside the turn's try: a throw here would report a finished answer as
// "OpenCode failed to start". A bug costs the chips, never the turn.
export function suggestFollowups(input: { agent: string; answer: string; steps: StepRecord[]; nextEffort?: string }): Followup[] {
    try {
        // `autoParallel: off` takes the "Run N as lanes" chip away too.
        const lanes = config().get<string>("autoParallel", "offer") !== "off";
        return naturalFollowups(input, 3, lanes ? splitLanes : undefined);
    } catch (error) {
        logChannel.appendLine(`[${stamp()}] follow-up chips left out: ${error}`);
        return [];
    }
}

const followupStore = new Map<string, Followup[]>();
const FOLLOWUP_STORE_CAP = 64;

export function rememberFollowups(sessionId: string, turns: number, chips: Followup[]): void {
    const key = `${sessionId}#${turns}`;
    followupStore.delete(key);
    followupStore.set(key, chips);
    while (followupStore.size > FOLLOWUP_STORE_CAP) {
        followupStore.delete(followupStore.keys().next().value as string);
    }
}

export function recalledFollowups(sessionId: string | undefined, turns: number): Followup[] {
    return sessionId ? followupStore.get(`${sessionId}#${turns}`) ?? [] : [];
}


// ---------------------------------------------------------------------------
// Follow-up chips, a pure function of the turn's metadata: the one channel for
// "the next message". Words and cases live in ./followups.json. At most three:
// a fourth wraps in the ~320px Chat view.

// A replayed prompt carries its kind in front; a chip keeps it in `command`.
const stripKind = (text: string): string => text.replace(/^\/(?:dev|plan)\b\s*/i, "");

// A failure that looks like the bridge could not reach OpenCode at all gets
// Ping (check the connection) instead of Continue.
const UNREACHABLE = /ENOENT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|not found on PATH|could not be started|unreachable|socket hang up|fetch failed/i;

export function outcomeOf(metadata: Record<string, unknown>): Outcome {
    switch (metadata.kind) {
        case "new":
        case "help":
        case "idle":
        case "model":
        case "stop":
        case "worktree":
        case "compact":
            return "silent";
        case "clarify":
            return "clarify";
        case "parallel":
            // Lanes ran in isolated sessions that are already closed; a turn
            // that ran none offers the composer.
            return metadata.lanesMissing ? "lanesMissing" : "parallel";
        case "composed":
            return "composed";
    }
    const turns = typeof metadata.turns === "number" ? metadata.turns : 0;
    const error = typeof metadata.error === "string" ? metadata.error : "";
    switch (true) {
        case Boolean(error) && UNREACHABLE.test(error):
            return "failedNet";
        // A continuing session that timed out is usually carrying a huge tool
        // output; a fresh session is the fix.
        case Boolean(metadata.timedOut) && turns > 1:
            return "failedLong";
        case Boolean(metadata.timedOut) || Boolean(error):
            return "failed";
        case Boolean(metadata.cancelled):
            return "cancelled";
        default:
            return "done";
    }
}

export function followupsFor(metadata: Record<string, unknown>): vscode.ChatFollowup[] {
    const outcome = outcomeOf(metadata);
    const kind: "dev" | "plan" = metadata.agent === "dev" || metadata.kind === "dev" ? "dev" : "plan";
    const own = typeof metadata.prompt === "string" ? metadata.prompt : undefined;
    const chips = (keys: readonly ChipKey[], text: Partial<Record<ChipKey, string>> = {}): vscode.ChatFollowup[] =>
        keys.flatMap((k) => {
            const chip = chipOf(k, kind, text[k]);
            if (!chip) {
                logChannel.appendLine(`[${stamp()}] follow-up chip ${k} left out: it has no text to send`);
            }
            return chip ? [chip] : [];
        });

    switch (outcome) {
        case "clarify":
            // The only honest follow-up to "I did not act on this" is the
            // original text, unchanged, under the kind the user was in.
            return own === undefined ? [] : chips(CASES.clarify, { RUN_ANYWAY: own });
        case "failed":
        case "failedLong":
        case "failedNet": {
            // A launch failure carries the user's words, and there may be no
            // session to "try again" in — so Retry resends them.
            const again = own ? stripKind(own) : "";
            return chips(CASES[outcome], again ? { RETRY: again } : {});
        }
        case "composed":
            // The composed lanes are the next message: a chip, not a button.
            // `composedLanes` is text; `lanes` stays a count on the run path.
            return typeof metadata.composedLanes === "string" && metadata.composedLanes
                ? chips(CASES.composed, { RUN_LANES: metadata.composedLanes })
                : [];
        case "parallel": {
            // Merge needs two answers to have anything to merge; Retry needs a
            // lane that ran and failed. A cancelled turn stored no run.
            const runId = typeof metadata.laneRunId === "string" ? metadata.laneRunId : "";
            const stored = runId ? recallLanes(runId) ?? [] : [];
            if (!runId || metadata.cancelled) {
                return [];
            }
            const answered = typeof metadata.laneAnswers === "number" ? metadata.laneAnswers : 0;
            const retries = typeof metadata.laneRetries === "number" ? metadata.laneRetries : 0;
            const failed = failedLanes(stored);
            const keys: ChipKey[] = [];
            const text: Partial<Record<ChipKey, string>> = {};
            if (answered >= 2) {
                keys.push("MERGE_LANES");
                text.MERGE_LANES = fillPrompt("MERGE_LANES", { run: runId });
            }
            if (retries && failed.length) {
                keys.push("RETRY_LANES");
                text.RETRY_LANES = retryLanesPrompt(failed);
            }
            // One failed lane cannot be a /parallel turn: it is refused under two
            // lanes, so it is resent as a single turn under this run's own kind.
            const retryKind: "dev" | "plan" = metadata.laneWrite ? "dev" : "plan";
            return keys.flatMap((k) => {
                const chip = chipOf(k, retryKind, text[k]);
                if (chip && k === "RETRY_LANES" && failed.length < 2) {
                    chip.command = retryKind;
                }
                return chip ? [chip] : [];
            });
        }
        case "done": {
            // What the run left unfinished first (a subagent that stopped, a
            // context near its window), then what this answer points at
            // (./natural), else nothing.
            const sessionId = typeof metadata.sessionId === "string" ? metadata.sessionId : undefined;
            const turns = typeof metadata.turns === "number" ? metadata.turns : 0;
            const seen = new Set<string>();
            return [...stateChips(metadata, kind), ...recalledFollowups(sessionId, turns)]
                .filter((f) => !seen.has(`${f.command}|${f.prompt}`) && Boolean(seen.add(`${f.command}|${f.prompt}`)))
                .slice(0, 3);
        }
        default:
            return chips(CASES[outcome]);
    }
}


// Chips from what the run recorded, not from its words: structured, so they
// outrank the answer-derived ones. Metadata only carries the few fields they
// need (history replays it on every later turn).
function stateChips(metadata: Record<string, unknown>, kind: "dev" | "plan"): vscode.ChatFollowup[] {
    const out: vscode.ChatFollowup[] = [];
    const task = metadata.failedTask as { agent?: unknown; description?: unknown; taskId?: unknown } | undefined;
    if (task && typeof task.agent === "string" && task.agent) {
        const description = typeof task.description === "string" && task.description ? task.description : task.agent;
        const taskId = typeof task.taskId === "string" ? task.taskId : "";
        const text = fillPrompt(taskId ? "RESUME_TASK" : "RERUN_TASK", { agent: task.agent, description, task: taskId });
        const chip = chipOf("RESUME_TASK", kind, text);
        if (chip) {
            chip.label = `${chipLabel("RESUME_TASK")} ${task.agent}`;
            out.push(chip);
        }
    }
    if (typeof metadata.compact === "string" && metadata.compact) {
        const chip = chipOf("COMPACT", kind);
        if (chip) {
            chip.label = `${chipLabel("COMPACT")} · ${metadata.compact}`;
            out.push(chip);
        }
    }
    return out;
}
