"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestFollowups = suggestFollowups;
exports.rememberFollowups = rememberFollowups;
exports.recalledFollowups = recalledFollowups;
exports.outcomeOf = outcomeOf;
exports.followupsFor = followupsFor;
const core_1 = require("./core");
const followups_1 = require("./followups");
const natural_1 = require("./natural");
const lanes_1 = require("./lanes");
function suggestFollowups(input) {
    try {
        const lanes = (0, core_1.config)().get("autoParallel", "offer") !== "off";
        return (0, natural_1.naturalFollowups)(input, 3, lanes ? lanes_1.splitLanes : undefined);
    }
    catch (error) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] follow-up chips left out: ${error}`);
        return [];
    }
}
const followupStore = new Map();
const FOLLOWUP_STORE_CAP = 64;
function rememberFollowups(sessionId, turns, chips) {
    const key = `${sessionId}#${turns}`;
    followupStore.delete(key);
    followupStore.set(key, chips);
    while (followupStore.size > FOLLOWUP_STORE_CAP) {
        followupStore.delete(followupStore.keys().next().value);
    }
}
function recalledFollowups(sessionId, turns) {
    return sessionId ? followupStore.get(`${sessionId}#${turns}`) ?? [] : [];
}
const stripKind = (text) => text.replace(/^\/(?:dev|plan)\b\s*/i, "");
const UNREACHABLE = /ENOENT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|not found on PATH|could not be started|unreachable|socket hang up|fetch failed/i;
function outcomeOf(metadata) {
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
            return metadata.lanesMissing ? "lanesMissing" : "parallel";
        case "composed":
            return "composed";
    }
    const turns = typeof metadata.turns === "number" ? metadata.turns : 0;
    const error = typeof metadata.error === "string" ? metadata.error : "";
    switch (true) {
        case Boolean(error) && UNREACHABLE.test(error):
            return "failedNet";
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
function followupsFor(metadata) {
    const outcome = outcomeOf(metadata);
    const kind = metadata.agent === "dev" || metadata.kind === "dev" ? "dev" : "plan";
    const own = typeof metadata.prompt === "string" ? metadata.prompt : undefined;
    const chips = (keys, text = {}) => keys.flatMap((k) => {
        const chip = (0, followups_1.chipOf)(k, kind, text[k]);
        if (!chip) {
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] follow-up chip ${k} left out: it has no text to send`);
        }
        return chip ? [chip] : [];
    });
    switch (outcome) {
        case "clarify":
            return own === undefined ? [] : chips(followups_1.CASES.clarify, { RUN_ANYWAY: own });
        case "failed":
        case "failedLong":
        case "failedNet": {
            const again = own ? stripKind(own) : "";
            return chips(followups_1.CASES[outcome], again ? { RETRY: again } : {});
        }
        case "composed":
            return typeof metadata.composedLanes === "string" && metadata.composedLanes
                ? chips(followups_1.CASES.composed, { RUN_LANES: metadata.composedLanes })
                : [];
        case "parallel": {
            const runId = typeof metadata.laneRunId === "string" ? metadata.laneRunId : "";
            const stored = runId ? (0, lanes_1.recallLanes)(runId) ?? [] : [];
            if (!runId || metadata.cancelled) {
                return [];
            }
            const answered = typeof metadata.laneAnswers === "number" ? metadata.laneAnswers : 0;
            const retries = typeof metadata.laneRetries === "number" ? metadata.laneRetries : 0;
            const failed = (0, lanes_1.failedLanes)(stored);
            const keys = [];
            const text = {};
            if (answered >= 2) {
                keys.push("MERGE_LANES");
                text.MERGE_LANES = (0, followups_1.fillPrompt)("MERGE_LANES", { run: runId });
            }
            if (retries && failed.length) {
                keys.push("RETRY_LANES");
                text.RETRY_LANES = (0, lanes_1.retryLanesPrompt)(failed);
            }
            const retryKind = metadata.laneWrite ? "dev" : "plan";
            return keys.flatMap((k) => {
                const chip = (0, followups_1.chipOf)(k, retryKind, text[k]);
                if (chip && k === "RETRY_LANES" && failed.length < 2) {
                    chip.command = retryKind;
                }
                return chip ? [chip] : [];
            });
        }
        case "done": {
            const sessionId = typeof metadata.sessionId === "string" ? metadata.sessionId : undefined;
            const turns = typeof metadata.turns === "number" ? metadata.turns : 0;
            const seen = new Set();
            return [...stateChips(metadata, kind), ...recalledFollowups(sessionId, turns)]
                .filter((f) => !seen.has(`${f.command}|${f.prompt}`) && Boolean(seen.add(`${f.command}|${f.prompt}`)))
                .slice(0, 3);
        }
        default:
            return chips(followups_1.CASES[outcome]);
    }
}
function stateChips(metadata, kind) {
    const out = [];
    const task = metadata.failedTask;
    if (task && typeof task.agent === "string" && task.agent) {
        const description = typeof task.description === "string" && task.description ? task.description : task.agent;
        const taskId = typeof task.taskId === "string" ? task.taskId : "";
        const text = (0, followups_1.fillPrompt)(taskId ? "RESUME_TASK" : "RERUN_TASK", { agent: task.agent, description, task: taskId });
        const chip = (0, followups_1.chipOf)("RESUME_TASK", kind, text);
        if (chip) {
            chip.label = `${(0, followups_1.chipLabel)("RESUME_TASK")} ${task.agent}`;
            out.push(chip);
        }
    }
    if (typeof metadata.compact === "string" && metadata.compact) {
        const chip = (0, followups_1.chipOf)("COMPACT", kind);
        if (chip) {
            chip.label = `${(0, followups_1.chipLabel)("COMPACT")} · ${metadata.compact}`;
            out.push(chip);
        }
    }
    return out;
}
//# sourceMappingURL=chips.js.map