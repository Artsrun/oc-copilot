// OpenCode events → what a run records: tool calls as `StepRecord`s, text and
// reasoning as keyed deltas, the model that answered. Shared by both runners so
// the CLI and the server give identical steps. Pure over its arguments.
import { truncate } from "./core";
import { RunMetrics, RunOptions, StepRecord, emptyTokens, stepOutput, toolFilePath } from "./metrics";

// One label per tool call, on every path (CLI, server, running and done). A
// subagent call (the `task` tool) is labelled by who does it: "explore: find
// the auth handlers", not only the 3-5 word description.
export const stepDetail = (input: Record<string, unknown> | undefined, fallback?: string): string => {
    const agent = typeof input?.subagent_type === "string" ? input.subagent_type : "";
    const description = input?.description as string | undefined;
    if (agent) {
        return description ? `${agent}: ${description}` : agent;
    }
    return (
        (input?.command as string) ??
        (input?.filePath as string) ??
        (input?.pattern as string) ??
        description ??
        fallback ??
        JSON.stringify(input ?? {})
    );
};

/** A fresh, empty record for one run. */
export const blankMetrics = (sessionId: string | undefined): RunMetrics => ({
    firstByteMs: undefined,
    totalMs: 0,
    timedOut: false,
    steps: [],
    tokens: emptyTokens(),
    cost: 0,
    hadOutput: false,
    sessionId,
    reasoning: ""
});

// The model that answered, as `provider/model`: the assistant message names it
// (1.18.32: info.providerID / info.modelID). The CLI's JSON stream never does.
export function noteModel(ev: Record<string, unknown>, metrics: RunMetrics): void {
    if (ev.type !== "message.updated") {
        return;
    }
    const info = ((ev.properties as Record<string, unknown> | undefined)?.info ?? {}) as Record<string, unknown>;
    if (info.role === "assistant" && typeof info.providerID === "string" && typeof info.modelID === "string") {
        metrics.model = `${info.providerID}/${info.modelID}`;
    }
}

/** Subagent spend joins the run's cost; the run's own context is left alone
 * (a child has its own window and only its summary comes back). */
export function addSubagents(metrics: RunMetrics, children: readonly string[], cost: number): void {
    if (!children.length) {
        return;
    }
    metrics.subagents = { count: children.length, cost };
    metrics.cost += cost;
}

/** A `task` call that failed or was interrupted: kept so a chip can resume it, until a call completes it. */
export function noteTask(part: Record<string, unknown>, metrics: RunMetrics): void {
    if (part.tool !== "task") {
        return;
    }
    const state = part.state as Record<string, unknown> | undefined;
    const meta = state?.metadata as Record<string, unknown> | undefined;
    const input = state?.input as Record<string, unknown> | undefined;
    const agent = typeof input?.subagent_type === "string" ? input.subagent_type : "";
    if (!agent) {
        return;
    }
    const description = typeof input?.description === "string" ? input.description : "";
    const sessionId = typeof meta?.sessionId === "string" ? meta.sessionId : undefined;
    if (state?.status !== "error" && meta?.interrupted !== true) {
        // The model retried or resumed it and it finished: nothing is left to resume.
        if (state?.status === "completed" && metrics.failedTasks) {
            metrics.failedTasks = metrics.failedTasks.filter(
                (t) => !(sessionId && t.sessionId === sessionId) && !(t.agent === agent && t.description === description)
            );
        }
        return;
    }
    const list = (metrics.failedTasks ??= []);
    if (!list.some((t) => t.agent === agent && t.description === description)) {
        list.push({ agent, description, sessionId });
    }
}

export function markFirstByte(metrics: RunMetrics, started: number): void {
    if (metrics.firstByteMs === undefined) {
        metrics.firstByteMs = Date.now() - started;
    }
}

export interface EmitCursor {
    n: number;
    last: { t?: string; r?: string };
}

export function emitKeyedDelta(
    kind: "t" | "r",
    text: string,
    part: Record<string, unknown>,
    emitted: Map<string, number>,
    cursor: EmitCursor,
    index?: number
): string | undefined {
    const rawId = part.id;
    let key = typeof rawId === "string" && rawId ? `${kind}:${rawId}` : undefined;
    if (!key && index !== undefined) {
        key = `${kind}:i${index}`;
        cursor.last[kind] = key;
    }
    if (!key) {
        const last = cursor.last[kind];
        const prev = last ? (emitted.get(last) ?? 0) : 0;
        if (last && text.length >= prev) {
            key = last;
        } else {
            cursor.n += 1;
            key = `${kind}:i${cursor.n}`;
            cursor.last[kind] = key;
        }
    } else {
        cursor.last[kind] = key;
    }
    const prev = emitted.get(key) ?? 0;
    if (text.length <= prev) {
        return undefined;
    }
    emitted.set(key, text.length);
    return text.slice(prev);
}

export function applyServerPart(
    part: Record<string, unknown>,
    metrics: RunMetrics,
    options: RunOptions,
    started: number,
    emitted: Map<string, number>,
    tools: Map<string, StepRecord>,
    cursor: EmitCursor = { n: 0, last: {} },
    index?: number
): void {
    const type = part.type as string | undefined;
    if (type === "reasoning") {
        const text = (part.text as string) ?? "";
        if (!text) {
            return;
        }
        const delta = emitKeyedDelta("r", text, part, emitted, cursor, index);
        if (!delta) {
            return;
        }
        markFirstByte(metrics, started);
        metrics.reasoning += (metrics.reasoning && !metrics.reasoning.endsWith("\n") ? "\n" : "") + delta;
        options.onReasoning?.(delta);
        return;
    }
    if (type === "text") {
        const text = (part.text as string) ?? "";
        if (!text) {
            return;
        }
        const delta = emitKeyedDelta("t", text, part, emitted, cursor, index);
        if (!delta) {
            return;
        }
        markFirstByte(metrics, started);
        metrics.hadOutput = true;
        options.onText?.(delta);
        return;
    }
    if (type === "tool" || type === "tool_use") {
        const tool = (part.tool as string) ?? "tool";
        const state = part.state as Record<string, unknown> | undefined;
        const input = state?.input as Record<string, unknown> | undefined;
        const time = state?.time as { start?: number; end?: number } | undefined;
        const durationMs =
            time?.start !== undefined && time?.end !== undefined ? time.end - time.start : undefined;
        const key = String(part.id ?? `${tool}:${JSON.stringify(input ?? {})}`);
        const detail = truncate(stepDetail(input));
        markFirstByte(metrics, started);
        const output = stepOutput(state);
        const filePath = toolFilePath(input);
        noteTask(part, metrics);
        const existing = tools.get(key);
        if (existing) {
            if (durationMs !== undefined) {
                existing.durationMs = durationMs;
                existing.status = "done";
            }
            if (detail && existing.detail !== detail) {
                existing.detail = detail;
            }
            if (output) {
                existing.output = output;
            }
            existing.filePath = existing.filePath ?? filePath;
            options.onStep?.(existing);
            return;
        }
        const step: StepRecord = {
            tool,
            detail,
            durationMs,
            output: output || undefined,
            status: durationMs !== undefined ? "done" : "running",
            filePath
        };
        tools.set(key, step);
        metrics.steps.push(step);
        options.onStep?.(step);
    }
}
