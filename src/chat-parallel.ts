// `/parallel` as a chat turn: split the message into lanes, check each lane's
// model and agent, then run them at once (./lanes). ./chat hands the turn over
// once it knows it is one.
import * as vscode from "vscode";
import { logChannel, relTo, stamp, untilStop } from "./core";
import { mark } from "./followups";
import { buildChatContext, contextNotice, emitReferences, parseChatPrompt, referenceLogLine, splitLanePrefixes, splitModelsFanout } from "./context";
import { ensureCliIdentity, openCode1Refusal, warmServer } from "./net";
import { laneAgentProblem, listAgents, planAgentNotice, resolvePlanAgent } from "./agents";
import { modelRefProblem, modelResolver } from "./models";
import { LaneSpec, answeredLanes, failedLanes, newLaneRunId, rememberLanes, runParallelLanes, splitLanes } from "./chat-boot";
import { chatQuery, composeLanes, composeParallel, insertIntoChat } from "./compose";
import { assertReadOnly, readOnlyEvidence } from "./runs";

/** What the router had worked out before it knew this was a `/parallel` turn. */
export interface ParallelTurn {
    request: vscode.ChatRequest;
    response: vscode.ChatResponseStream;
    token: vscode.CancellationToken;
    settings: vscode.WorkspaceConfiguration;
    cwd: string;
    inline: boolean | undefined;
    /** The listed steps of an `autoParallel: auto` message. */
    autoLanes: string[] | undefined;
    parsed: ReturnType<typeof parseChatPrompt>;
    resolveModel: ReturnType<typeof modelResolver>;
    transport: string;
    attachDev: boolean;
    settingPin: string | undefined;
    executable: string;
    timeoutMs: number;
    pure: boolean;
    devAgent: string;
    effortAsked: string | undefined;
}

export async function runParallelTurn(p: ParallelTurn): Promise<vscode.ChatResult> {
    const { request, response, token, settings, cwd, autoLanes, parsed, resolveModel, transport, attachDev, settingPin, executable, timeoutMs, pure, devAgent, effortAsked } = p;
    // `models:a,b,c <task>`: one task per model. Otherwise each lane may
    // carry `m:<model>`; a leading `m:` belongs to lane 1. No lane cap.
    const laneText = autoLanes
        ? autoLanes.map((l) => (parsed.model ? `m:${parsed.model} ${l}` : l)).join("\n---\n")
        : parsed.model
            ? `m:${parsed.model} ${parsed.task}`
            : parsed.task;
    if (autoLanes) {
        response.markdown(
            `> ${mark("step")} \`autoParallel\`: your ${autoLanes.length} listed steps run as ${autoLanes.length} lanes. ` +
            "Start with `plan:` to keep them in one turn.\n\n"
        );
    }
    // A bare `/parallel`: compose the lanes step by step, then put the
    // command in the chat input — nothing runs until it is sent.
    if (!laneText.trim()) {
        const composed = await composeParallel(token, cwd);
        if (!composed) {
            response.markdown("No lanes composed. `/parallel` alone opens the composer; or type lanes separated by `|`, `;;` or a `---` line.");
            return { metadata: { kind: "idle" } };
        }
        const query = chatQuery(composed);
        const inserted = await insertIntoChat(query);
        response.markdown(
            `${inserted ? "Inserted into the chat input — press Enter to run" : "Copy this into the chat to run"} **${composed.length} lanes**:\n\n\`\`\`text\n${query}\n\`\`\``
        );
        return { metadata: { kind: "composed", composedLanes: composeLanes(composed) } };
    }
    const fan = splitModelsFanout(laneText);
    if (fan && (splitLanes(fan.task).length > 1 || fan.models.length < 2 || !fan.task)) {
        response.markdown(
            splitLanes(fan.task).length > 1
                ? "`models:` runs **one** task on each model, so it takes no `|`. For different tasks, put `m:<model>` in front of each lane:\n\n" +
                "`@opencode /parallel m:tundra review auth | m:oasis read the logs`"
                : "Name at least two models and the task: `@opencode /parallel models:tundra,oasis review the auth flow`"
        );
        return { metadata: { kind: "parallel" } };
    }
    const specsRaw = fan
        ? fan.models.map((ref) => ({ task: fan.task, ref }))
        : splitLanes(laneText).map((lane) => {
            const { model: ref, agent, task: laneTask } = splitLanePrefixes(lane);
            return { task: laneTask, ref, agent };
        });
    if (specsRaw.length < 2) {
        response.markdown(
            "Give me at least two lanes separated by `|`, `;;` or a `---` line (not inside backticks).\n\n" +
            "Example: `@opencode /parallel audit error handling | list unused deps | " +
            "review the auth flow`"
        );
        return { metadata: { kind: "parallel", lanesMissing: true } };
    }
    const lanes: LaneSpec[] = [];
    for (const raw of specsRaw) {
        const { task: laneTask, ref } = raw;
        const agent = "agent" in raw ? raw.agent : undefined;
        if (!ref) {
            lanes.push({ task: laneTask, agent });
            continue;
        }
        const r = await resolveModel(ref);
        lanes.push("id" in r ? { task: laneTask, model: r.id, agent } : { task: laneTask, agent, error: modelRefProblem(ref, r) });
    }
    if (token.isCancellationRequested) {
        return { metadata: { kind: "parallel", lanes: lanes.length, cancelled: true } };
    }
    const write = settings.get<boolean>("parallelAllowWrite", false);
    const refusedResult = (message: string): vscode.ChatResult => ({
        metadata: { kind: "parallel", lanes: lanes.length, error: message, notSent: true, prompt: autoLanes ? laneText : request.prompt, laneWrite: write }
    });
    if (write) {
        response.markdown(
            "> " + mark("warn") + " `parallelAllowWrite` is on. Concurrent editing agents in one checkout can " +
            "overwrite each other — prefer the git-worktree scripts for parallel edits.\n"
        );
    }
    // `transport: server` attaches lanes too (cold lanes serialise on one
    // opencode.db); `auto` keeps the attachDevToServer opt-out. Raced
    // against Stop: a cold server boot takes tens of seconds.
    const laneUrl = transport === "server" || attachDev ? await untilStop(warmServer(cwd, (text) => response.progress(text)), token) : undefined;
    // Not OpenCode 1: no lane runs (each is an `opencode run`).
    const refused = openCode1Refusal(executable);
    if (refused) {
        response.markdown(`> ${mark("fail")} ${refused.message}`);
        return refusedResult(refused.message);
    }
    // Every lane awaits the same identity check: confirmed once here, so its
    // refusal is said once and whole, not cut to a line under every lane.
    let identityError: unknown;
    const identity = await untilStop(ensureCliIdentity(executable, cwd).then(() => true, (error: unknown) => {
        identityError = error;
        return false;
    }), token);
    if (identity === false) {
        const message = identityError instanceof Error ? identityError.message : String(identityError);
        response.markdown(`> ${mark("fail")} ${message}`);
        return refusedResult(message);
    }
    if (token.isCancellationRequested) {
        return { metadata: { kind: "parallel", lanes: lanes.length, cancelled: true } };
    }
    // Read-only lanes run as `planAgent` too, checked once for all.
    const lanePlan = write ? undefined : await untilStop(resolvePlanAgent(cwd, laneUrl), token);
    // `a:<agent>` per lane: confirmed against OpenCode's own list first.
    for (const name of [...new Set(lanes.filter((l) => l.agent && !l.error).map((l) => l.agent as string))]) {
        if (token.isCancellationRequested) {
            break;
        }
        const problem = laneAgentProblem(name, await untilStop(listAgents(cwd, laneUrl, name), token));
        for (const l of lanes) {
            if (problem && l.agent === name && !l.error) {
                l.error = problem;
            }
        }
    }
    if (token.isCancellationRequested) {
        return { metadata: { kind: "parallel", lanes: lanes.length, cancelled: true } };
    }
    if (!write) {
        const defaultAgent = lanePlan?.agent ?? "plan";
        for (const agent of [...new Set(lanes.filter((l) => !l.error).map((l) => l.agent || defaultAgent))]) {
            const evidence = await untilStop(readOnlyEvidence(laneUrl, cwd, agent), token);
            if (token.isCancellationRequested) {
                return { metadata: { kind: "parallel", lanes: lanes.length, cancelled: true } };
            }
            try {
                assertReadOnly(evidence);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                response.markdown(`> ${mark("fail")} ${message}`);
                return refusedResult(message);
            }
        }
    }
    // Attachments go to every lane, as to a plan or dev turn.
    const laneCtx = buildChatContext(request, cwd, { inline: p.inline, readOnly: !write });
    emitReferences(response, laneCtx.uris);
    if (laneCtx.uris.length) {
        logChannel.appendLine(`[${stamp()}] context for ${lanes.length} lanes: ${laneCtx.uris.map((u) => relTo(cwd, u)).join(", ")}`);
    }
    const laneReferences = referenceLogLine(laneCtx.notes);
    if (laneReferences) {
        logChannel.appendLine(`[${stamp()}] ${laneReferences}`);
    }
    const laneContextNote = contextNotice(laneCtx.notes, !write);
    if (laneContextNote) {
        response.markdown(`> ${mark("warn")} ${laneContextNote}\n\n`);
    }
    const laneNote = planAgentNotice(lanePlan, cwd);
    if (laneNote) {
        response.markdown(`> ${mark("warn")} ${laneNote}\n\n`);
    }
    const outcomes = await runParallelLanes({
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
    // The id travels in the metadata; the answers never leave this window.
    const laneRunId = newLaneRunId();
    rememberLanes(laneRunId, outcomes);
    return {
        metadata: {
            kind: "parallel",
            lanes: lanes.length,
            laneRunId,
            laneAnswers: answeredLanes(outcomes).length,
            laneRetries: failedLanes(outcomes).length,
            laneWrite: write,
            // One task on several models (`models:`, or the same task in every
            // lane) — and the lanes can answer differently (model or agent):
            // two lanes that would run identically have nothing to compare.
            ...(lanes.every((l) => l.task === lanes[0].task) && new Set(lanes.map((l) => `${l.model ?? ""}|${l.agent ?? ""}`)).size > 1
                ? { laneSameTask: true }
                : {}),
            ...(autoLanes ? { autoLanes: true } : {})
        }
    };
}
