"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runParallelTurn = runParallelTurn;
const core_1 = require("./core");
const followups_1 = require("./followups");
const context_1 = require("./context");
const net_1 = require("./net");
const agents_1 = require("./agents");
const models_1 = require("./models");
const chat_boot_1 = require("./chat-boot");
const compose_1 = require("./compose");
async function runParallelTurn(p) {
    const { request, response, token, settings, cwd, autoLanes, parsed, resolveModel, transport, attachDev, settingPin, executable, timeoutMs, pure, devAgent, effortAsked } = p;
    const laneText = autoLanes
        ? autoLanes.map((l) => (parsed.model ? `m:${parsed.model} ${l}` : l)).join("\n---\n")
        : parsed.model
            ? `m:${parsed.model} ${parsed.task}`
            : parsed.task;
    if (autoLanes) {
        response.markdown(`> ${(0, followups_1.mark)("step")} \`autoParallel\`: your ${autoLanes.length} listed steps run as ${autoLanes.length} lanes. ` +
            "Start with `plan:` to keep them in one turn.\n\n");
    }
    if (!laneText.trim()) {
        const composed = await (0, compose_1.composeParallel)(token, cwd);
        if (!composed) {
            response.markdown("No lanes composed. `/parallel` alone opens the composer; or type lanes separated by `|`, `;;` or a `---` line.");
            return { metadata: { kind: "idle" } };
        }
        const query = (0, compose_1.chatQuery)(composed);
        const inserted = await (0, compose_1.insertIntoChat)(query);
        response.markdown(`${inserted ? "Inserted into the chat input — press Enter to run" : "Copy this into the chat to run"} **${composed.length} lanes**:\n\n\`\`\`text\n${query}\n\`\`\``);
        return { metadata: { kind: "composed", composedLanes: (0, compose_1.composeLanes)(composed) } };
    }
    const fan = (0, context_1.splitModelsFanout)(laneText);
    if (fan && ((0, chat_boot_1.splitLanes)(fan.task).length > 1 || fan.models.length < 2 || !fan.task)) {
        response.markdown((0, chat_boot_1.splitLanes)(fan.task).length > 1
            ? "`models:` runs **one** task on each model, so it takes no `|`. For different tasks, put `m:<model>` in front of each lane:\n\n" +
                "`@opencode /parallel m:tundra review auth | m:oasis read the logs`"
            : "Name at least two models and the task: `@opencode /parallel models:tundra,oasis review the auth flow`");
        return { metadata: { kind: "parallel" } };
    }
    const specsRaw = fan
        ? fan.models.map((ref) => ({ task: fan.task, ref }))
        : (0, chat_boot_1.splitLanes)(laneText).map((lane) => {
            const { model: ref, agent, task: laneTask } = (0, context_1.splitLanePrefixes)(lane);
            return { task: laneTask, ref, agent };
        });
    if (specsRaw.length < 2) {
        response.markdown("Give me at least two lanes separated by `|`, `;;` or a `---` line (not inside backticks).\n\n" +
            "Example: `@opencode /parallel audit error handling | list unused deps | " +
            "review the auth flow`");
        return { metadata: { kind: "parallel", lanesMissing: true } };
    }
    const lanes = [];
    for (const raw of specsRaw) {
        const { task: laneTask, ref } = raw;
        const agent = "agent" in raw ? raw.agent : undefined;
        if (!ref) {
            lanes.push({ task: laneTask, agent });
            continue;
        }
        const r = await resolveModel(ref);
        lanes.push("id" in r ? { task: laneTask, model: r.id, agent } : { task: laneTask, agent, error: (0, models_1.modelRefProblem)(ref, r) });
    }
    if (token.isCancellationRequested) {
        return { metadata: { kind: "parallel", lanes: lanes.length, cancelled: true } };
    }
    const write = settings.get("parallelAllowWrite", false);
    if (write) {
        response.markdown("> " + (0, followups_1.mark)("warn") + " `parallelAllowWrite` is on. Concurrent editing agents in one checkout can " +
            "overwrite each other — prefer the git-worktree scripts for parallel edits.\n");
    }
    const laneUrl = transport === "server" || attachDev ? await (0, core_1.untilStop)((0, net_1.warmServer)(cwd, (text) => response.progress(text)), token) : undefined;
    const lanePlan = write ? undefined : await (0, core_1.untilStop)((0, agents_1.resolvePlanAgent)(cwd, laneUrl), token);
    for (const name of [...new Set(lanes.filter((l) => l.agent && !l.error).map((l) => l.agent))]) {
        if (token.isCancellationRequested) {
            break;
        }
        const problem = (0, agents_1.laneAgentProblem)(name, await (0, core_1.untilStop)((0, agents_1.listAgents)(cwd, laneUrl, name), token));
        for (const l of lanes) {
            if (problem && l.agent === name && !l.error) {
                l.error = problem;
            }
        }
    }
    if (token.isCancellationRequested) {
        return { metadata: { kind: "parallel", lanes: lanes.length, cancelled: true } };
    }
    const laneCtx = (0, context_1.buildChatContext)(request, cwd, { inline: p.inline });
    (0, context_1.emitReferences)(response, laneCtx.uris);
    if (laneCtx.uris.length) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] context for ${lanes.length} lanes: ${laneCtx.uris.map((u) => (0, core_1.relTo)(cwd, u)).join(", ")}`);
    }
    const laneNote = (0, agents_1.planAgentNotice)(lanePlan, cwd);
    if (laneNote) {
        response.markdown(`> ${(0, followups_1.mark)("warn")} ${laneNote}\n\n`);
    }
    const outcomes = await (0, chat_boot_1.runParallelLanes)({
        response,
        token,
        cwd,
        executable,
        timeoutMs,
        model: settingPin,
        pure,
        lanes,
        write,
        devAgent,
        planAgent: lanePlan?.agent,
        attachUrl: laneUrl,
        preamble: laneCtx.preamble,
        effort: effortAsked
    });
    const laneRunId = (0, chat_boot_1.newLaneRunId)();
    (0, chat_boot_1.rememberLanes)(laneRunId, outcomes);
    return {
        metadata: {
            kind: "parallel",
            lanes: lanes.length,
            laneRunId,
            laneAnswers: (0, chat_boot_1.answeredLanes)(outcomes).length,
            laneRetries: (0, chat_boot_1.failedLanes)(outcomes).length,
            laneWrite: write,
            ...(lanes.every((l) => l.task === lanes[0].task) && new Set(lanes.map((l) => `${l.model ?? ""}|${l.agent ?? ""}`)).size > 1
                ? { laneSameTask: true }
                : {}),
            ...(autoLanes ? { autoLanes: true } : {})
        }
    };
}
//# sourceMappingURL=chat-parallel.js.map