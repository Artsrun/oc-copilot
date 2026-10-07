"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestFollowups = suggestFollowups;
exports.rememberFollowups = rememberFollowups;
exports.recalledFollowups = recalledFollowups;
exports.heldKinds = heldKinds;
exports.noteNextMessage = noteNextMessage;
exports.resetChipBackoff = resetChipBackoff;
exports.outcomeOf = outcomeOf;
exports.followupsFor = followupsFor;
const core_1 = require("./core");
const followups_1 = require("./followups");
const natural_1 = require("./natural");
const lanes_1 = require("./lanes");
function suggestFollowups(input) {
    try {
        const lanes = (0, core_1.config)().get("autoParallel", "offer") !== "off";
        return (0, natural_1.naturalFollowups)(input, 3, lanes ? lanes_1.splitLanes : undefined, heldKinds());
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
const BACKOFF_KEY = "opencodeCopilotBridge.chipBackoff";
const BACKOFF_AFTER = 3;
const BACKOFF_MAX_HOLD = 32;
const NEVER_HELD = new Set(["offer", "choice", "RESUME_TASK", "RERUN_TASK", "CUT_OFF"]);
const readBackoff = () => {
    const stored = core_1.extensionContext?.globalState?.get(BACKOFF_KEY);
    const message = typeof stored?.message === "number" && Number.isFinite(stored.message) ? stored.message : 0;
    const kinds = {};
    for (const [kind, k] of Object.entries(stored?.kinds ?? {})) {
        if (typeof k?.passed === "number" && typeof k.until === "number") {
            kinds[kind] = { passed: k.passed, until: k.until };
        }
    }
    return { message, kinds };
};
function heldKinds() {
    const b = readBackoff();
    return new Set(Object.entries(b.kinds).filter(([, k]) => b.message < k.until).map(([kind]) => kind));
}
const offeredStore = new Map();
function noteNextMessage(sessionId, turns, command, prompt, control) {
    const key = `${sessionId}#${turns}`;
    const offered = sessionId ? offeredStore.get(key) : undefined;
    const taken = offered?.find((c) => (c.command ?? "") === command && c.prompt.trim() === prompt.trim());
    if (control && !taken) {
        return;
    }
    offeredStore.delete(key);
    const b = readBackoff();
    b.message += 1;
    if (taken?.kind) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] chip taken: ${taken.kind}`);
        delete b.kinds[taken.kind];
    }
    else if (offered && !taken) {
        for (const kind of new Set(offered.map((c) => c.kind ?? ""))) {
            if (!kind || NEVER_HELD.has(kind)) {
                continue;
            }
            const k = Object.hasOwn(b.kinds, kind) ? b.kinds[kind] : { passed: 0, until: 0 };
            k.passed += 1;
            if (k.passed >= BACKOFF_AFTER) {
                const hold = Math.min(2 ** (k.passed - BACKOFF_AFTER + 1), BACKOFF_MAX_HOLD);
                k.until = b.message + hold;
                core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] chip "${kind}" passed over ${k.passed} times running: held back for ${hold} messages`);
            }
            b.kinds[kind] = k;
        }
    }
    void core_1.extensionContext?.globalState?.update(BACKOFF_KEY, b);
}
function resetChipBackoff() {
    offeredStore.clear();
    void core_1.extensionContext?.globalState?.update(BACKOFF_KEY, undefined);
}
const stripKind = (text) => text.replace(/^\/(?:dev|plan)\b\s*/i, "");
const UNREACHABLE = /ENOENT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|not found on PATH|could not be started|unreachable|socket hang up|fetch failed/i;
const MODEL_TROUBLE = /rate[ _-]?limit|too many requests|\b429\b|\bquota\b|insufficient[ _](?:quota|credits?|funds|balance)|credit balance|billing|overloaded|\bmodel\b[^.\n]{0,40}\bnot (?:found|supported|available)|unknown model|no such model|ModelNotFound|unauthori[sz]ed|\b401\b|invalid[ _-]?(?:api[ _-]?)?key|api[ _-]?key|ProviderAuth|authentication failed/i;
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
        case Boolean(error) && MODEL_TROUBLE.test(error):
            return "failedModel";
        case Boolean(metadata.timedOut) && typeof metadata.stuckTool === "string" && Boolean(metadata.stuckTool):
            return "failedStuck";
        case Boolean(metadata.timedOut) && turns > 1:
            return "failedLong";
        case Boolean(metadata.timedOut) || Boolean(error):
            return "failed";
        case Boolean(metadata.cancelled) && metadata.notSent === true && typeof metadata.prompt === "string":
            return "cancelledEarly";
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
        case "failedNet":
        case "failedModel":
        case "cancelledEarly": {
            const again = own ? stripKind(own) : "";
            return chips(followups_1.CASES[outcome], again ? { RETRY: again } : {});
        }
        case "failedStuck": {
            const tool = typeof metadata.stuckTool === "string" && metadata.stuckTool ? metadata.stuckTool : "tool";
            return chips(followups_1.CASES.failedStuck, { SKIP_STUCK: (0, followups_1.fillPrompt)("SKIP_STUCK", { tool }) });
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
            if (answered >= 2 && metadata.laneSameTask === true) {
                keys.push("COMPARE_LANES");
                text.COMPARE_LANES = (0, followups_1.fillPrompt)("COMPARE_LANES", { run: runId });
            }
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
            const held = heldKinds();
            const shown = [...stateChips(metadata, kind), ...recalledFollowups(sessionId, turns)]
                .filter((f) => !seen.has(`${f.command}|${f.prompt}`) && Boolean(seen.add(`${f.command}|${f.prompt}`)))
                .filter((f) => !f.kind || !held.has(f.kind))
                .slice(0, 3);
            if (shown.length && sessionId) {
                const key = `${sessionId}#${turns}`;
                offeredStore.delete(key);
                offeredStore.set(key, shown.map((f) => ({ kind: f.kind, prompt: f.prompt, command: f.command })));
                while (offeredStore.size > FOLLOWUP_STORE_CAP) {
                    offeredStore.delete(offeredStore.keys().next().value);
                }
                core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] chips offered: ${shown.map((f) => f.kind ?? "?").join(", ")}`);
            }
            return shown.map(({ label, prompt, command }) => ({ label, prompt, command }));
        }
        default:
            return chips(followups_1.CASES[outcome]);
    }
}
function stateChips(metadata, kind) {
    const out = [];
    if (metadata.truncated === true) {
        const chip = (0, followups_1.chipOf)("CUT_OFF", kind);
        if (chip) {
            out.push({ ...chip, kind: "CUT_OFF" });
        }
    }
    const task = metadata.failedTask;
    if (task && typeof task.agent === "string" && task.agent) {
        const description = typeof task.description === "string" && task.description ? task.description : task.agent;
        const taskId = typeof task.taskId === "string" ? task.taskId : "";
        const key = taskId ? "RESUME_TASK" : "RERUN_TASK";
        const text = (0, followups_1.fillPrompt)(key, { agent: task.agent, description, task: taskId });
        const chip = (0, followups_1.chipOf)(key, kind, text);
        if (chip) {
            chip.label = `${(0, followups_1.chipLabel)(key)} ${task.agent}`;
            out.push({ ...chip, kind: key });
        }
    }
    if (typeof metadata.compact === "string" && metadata.compact) {
        const chip = (0, followups_1.chipOf)("COMPACT", kind);
        if (chip) {
            chip.label = `${(0, followups_1.chipLabel)("COMPACT")} · ${metadata.compact}`;
            out.push({ ...chip, kind: "COMPACT" });
        }
    }
    return out;
}
//# sourceMappingURL=chips.js.map