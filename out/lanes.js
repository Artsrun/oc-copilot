"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.answeredLanes = exports.failedLanes = exports.recallLanes = exports.newLaneRunId = exports.LANE_ANSWER_CAP = exports.LANE_STORE_CAP = void 0;
exports.splitLanes = splitLanes;
exports.runParallelLanes = runParallelLanes;
exports.rememberLanes = rememberLanes;
exports.retryLanesPrompt = retryLanesPrompt;
exports.laneMergeContext = laneMergeContext;
const core_1 = require("./core");
const metrics_1 = require("./metrics");
const format_1 = require("./format");
const runs_1 = require("./runs");
const followups_1 = require("./followups");
const models_1 = require("./models");
const LANE_MASK = { "|": "\u0001", ";": "\u0002", "-": "\u0003" };
const LANE_UNMASK = { "\u0001": "|", "\u0002": ";", "\u0003": "-" };
const maskLane = (s) => s.replace(/[|;-]/g, (c) => LANE_MASK[c]);
function splitLanes(task) {
    return task
        .replace(/\r\n?/g, "\n")
        .replace(/(`+)(?:[\s\S]*?\1|[\s\S]*$)/g, maskLane)
        .replace(/^[ \t]*\|.*$/gm, maskLane)
        .replace(/\|{2,}/g, maskLane)
        .split(/\s*(?:\||;;|\n[ \t]*-{2,}[ \t]*\n)\s*/)
        .map((part) => part.replace(/[\u0001-\u0003]/g, (c) => LANE_UNMASK[c]).trim())
        .filter(Boolean);
}
async function runParallelLanes(opts) {
    const specs = opts.lanes;
    const lanes = specs.map((s) => s.task);
    const laneAgent = opts.write ? opts.devAgent ?? "build" : opts.planAgent ?? "plan";
    const names = (0, models_1.cachedModelInfo)();
    const modelName = (id) => names[id]?.name ?? id;
    const sameTask = specs.length > 1 && specs.every((s) => s.task === specs[0].task);
    opts.response.markdown(`Running **${lanes.length} lanes** in parallel` +
        (opts.write
            ? " with the editing agent"
            : laneAgent === "plan"
                ? " with the read-only plan agent"
                : ` with the read-only \`${laneAgent}\` agent`) +
        (sameTask ? ` on ${specs.length} models` : "") +
        (opts.timeoutMs > 0 ? `, ${Math.round(opts.timeoutMs / 1000)}s cap each.` : ", no wall-clock cap.") +
        (specs.some((s) => s.agent && !s.error) ? " An `a:` lane runs with its agent's own permissions." : "") +
        "\n");
    const done = specs.map((s) => Boolean(s.error));
    const tickLabel = (i) => sameTask && specs[i].model ? (0, core_1.truncate)(modelName(specs[i].model).split(/[\s(]/)[0], 22) : (0, core_1.truncate)(lanes[i], 22);
    const tick = () => {
        opts.response.progress(specs.map((s, i) => `${s.error ? (0, followups_1.mark)("warn") : done[i] ? (0, followups_1.mark)("ok") : "•"} ${tickLabel(i)}`).join("   "));
    };
    tick();
    const variants = specs.map((s) => {
        const choice = (0, models_1.effortFor)(s.model ?? opts.model, opts.effort, false, names);
        if (choice.problem && !s.error) {
            opts.response.markdown(`> ${(0, followups_1.mark)("warn")} ${(0, core_1.truncate)(s.task, 40)}: ${choice.problem}\n`);
        }
        return choice.variant;
    });
    const attachUrl = opts.attachUrl;
    const laneSessions = attachUrl
        ? await Promise.all(specs.map((s) => (s.error ? undefined : (0, runs_1.createServerSession)(attachUrl, opts.cwd, s.task, !opts.write).catch(() => undefined))))
        : specs.map(() => undefined);
    const results = await Promise.all(lanes.map(async (lane, i) => {
        let answer = "";
        const laneStarted = Date.now();
        const blank = {
            firstByteMs: undefined,
            totalMs: 0,
            timedOut: false,
            steps: [],
            tokens: (0, metrics_1.emptyTokens)(),
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
            const metrics = await (0, runs_1.runOpenCode)({
                executable: opts.executable,
                task: `${lane}${opts.preamble ?? ""}`,
                cwd: opts.cwd,
                agent,
                attachUrl,
                sessionId: laneSessions[i],
                model: specs[i].model ?? opts.model,
                pure: opts.pure,
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
                void (0, runs_1.abortServerRun)(attachUrl, laneSession, opts.cwd, opts.token.isCancellationRequested ? "lane cancelled" : "lane timed out");
            }
            return { lane, answer, metrics };
        }
        catch (error) {
            done[i] = true;
            tick();
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] lane "${(0, core_1.truncate)(lane, 60)}" failed: ${error}`);
            blank.totalMs = Date.now() - laneStarted;
            blank.error = error instanceof Error ? error.message : String(error);
            return { lane, answer, metrics: blank };
        }
    }));
    for (const [i, result] of results.entries()) {
        (0, metrics_1.finalizeStepStatuses)(result.metrics);
        const body = (0, format_1.scrubLeakedContext)(result.answer.trim()) || "_(no output)_";
        const steps = (0, format_1.stepsLine)(result.metrics);
        const fail = result.metrics.error
            ? ` · ${(0, followups_1.mark)("warn")} ${(0, core_1.truncate)(String(result.metrics.error), 120)}`
            : "";
        const laneModel = specs[i].model ?? opts.model;
        const title = (sameTask && laneModel ? modelName(laneModel) : (0, core_1.truncate)(result.lane, 80) + (laneModel ? ` · ${modelName(laneModel)}` : "")) +
            (specs[i].agent ? ` · ${specs[i].agent}` : "");
        opts.response.markdown(`\n\n### ${i + 1}. ${title}\n\n${specs[i].error ? "_(not run)_" : body}\n\n` +
            `> ${steps ? steps + " · " : ""}${(0, core_1.secs)(result.metrics.totalMs)}` +
            (result.metrics.cost > 0 ? ` · $${result.metrics.cost.toFixed(4)}` : "") +
            (result.metrics.timedOut ? " · " + (0, followups_1.mark)("quiet") + " partial" : fail));
    }
    const ok = results.filter((r) => !r.metrics.timedOut && r.answer.trim()).length;
    const totalMs = Math.max(...results.map((r) => r.metrics.totalMs), 0);
    const serialMs = results.reduce((n, r) => n + r.metrics.totalMs, 0);
    const cost = results.reduce((n, r) => n + r.metrics.cost, 0);
    opts.response.markdown(`\n\n---\n\n**${ok}/${results.length} lanes returned.** ` +
        `Wall clock ${(0, core_1.secs)(totalMs)} vs ${(0, core_1.secs)(serialMs)} sequential` +
        (cost > 0 ? ` · $${cost.toFixed(4)}` : "") +
        ".\n\nLanes ran in isolated sessions, so nothing above is in your ongoing " +
        (results.filter((r, i) => !specs[i].error && r.answer.trim()).length >= 2
            ? `conversation. ${sameTask ? "**Compare lanes** or **Merge lanes**" : "**Merge lanes**"} below brings their answers into it.`
            : "conversation. Paste the parts you want to keep into a normal `@opencode` turn."));
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
exports.LANE_STORE_CAP = 8;
exports.LANE_ANSWER_CAP = 20_000;
const LANE_COUNT_CAP = 8;
const laneStore = new Map();
let laneRunSeq = 0;
const newLaneRunId = () => `L${Date.now().toString(36)}${(laneRunSeq += 1).toString(36)}`;
exports.newLaneRunId = newLaneRunId;
function rememberLanes(id, lanes) {
    laneStore.delete(id);
    laneStore.set(id, lanes.slice(0, LANE_COUNT_CAP).map((l) => ({ ...l, answer: cutAt(l.answer, exports.LANE_ANSWER_CAP) })));
    while (laneStore.size > exports.LANE_STORE_CAP) {
        laneStore.delete(laneStore.keys().next().value);
    }
}
const recallLanes = (id) => laneStore.get(id);
exports.recallLanes = recallLanes;
function cutAt(text, max) {
    if (text.length <= max) {
        return text;
    }
    const cut = text.slice(0, max);
    const nl = cut.lastIndexOf("\n");
    return cut.slice(0, nl > max / 2 ? nl : cut.length);
}
const failedLanes = (lanes) => lanes.filter((l) => l.ran && (Boolean(l.error) || l.timedOut));
exports.failedLanes = failedLanes;
const answeredLanes = (lanes) => lanes.filter((l) => l.ran && Boolean(l.answer));
exports.answeredLanes = answeredLanes;
function retryLanesPrompt(failed) {
    const lanes = failed.slice(0, LANE_COUNT_CAP);
    return lanes.length > 1
        ? lanes.map((l) => (l.agent ? `a:${l.agent} ` : "") + (l.model ? `m:${l.model} ` : "") + l.task).join("\n---\n")
        : lanes.map((l) => (l.model ? `model:${l.model} ` : "") + l.task).join("");
}
const MERGE_CONTEXT_CAP = 60_000;
function laneMergeContext(lanes) {
    const blocks = (0, exports.answeredLanes)(lanes).map((l, i) => `\n\n## Lane ${i + 1}${l.model ? ` (${l.model})` : ""}: ${(0, core_1.truncate)(l.task, 120)}\n\n${l.answer}`);
    return cutAt(`\n\n---${blocks.join("")}`, MERGE_CONTEXT_CAP);
}
//# sourceMappingURL=lanes.js.map