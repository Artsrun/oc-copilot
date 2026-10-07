// OpenCode events → what a run records: tool calls as `StepRecord`s, text and
// reasoning as keyed deltas, the model that answered. Shared by both runners so
// the CLI and the server give identical steps. Pure over its arguments.
import { truncate } from "./core";
import { ProviderRetry, RunMetrics, RunOptions, StepRecord, emptyTokens, stepOutput, toolFilePath } from "./metrics";

// ---------------------------------------------------------------------------
// Streaming. 1.18.32 sends text and reasoning as `message.part.delta`
// { sessionID, messageID, partID, field: "text", delta } — no `part` — and the
// whole part once, in `message.part.updated`, at its end (processor.ts
// text-delta / text-end; reasoning the same). The part's type is known only
// from the `part.updated` that opened it (empty text), so it is remembered.

/** Remember what type each part id is, from any event that carries the part. */
export function notePartKind(part: Record<string, unknown> | undefined, kinds: Map<string, string>): void {
    if (part && typeof part.id === "string" && typeof part.type === "string" && !kinds.has(part.id)) {
        kinds.set(part.id, part.type);
    }
}

export interface PartDelta {
    /** `t:<partID>` or `r:<partID>`: the key `emitKeyedDelta` uses for the same part. */
    key: string;
    part: string;
    kind: "text" | "reasoning";
    delta: string;
}

/** A `message.part.delta` of `sessionId` that extends a text or reasoning part, else undefined. */
export function partDeltaOf(ev: Record<string, unknown>, sessionId: string, kinds: ReadonlyMap<string, string>): PartDelta | undefined {
    if (ev.type !== "message.part.delta") {
        return undefined;
    }
    const p = (ev.properties as Record<string, unknown> | undefined) ?? {};
    const part = typeof p.partID === "string" ? p.partID : "";
    const kind = kinds.get(part);
    if (p.sessionID !== sessionId || p.field !== "text" || typeof p.delta !== "string" || !p.delta || (kind !== "text" && kind !== "reasoning")) {
        return undefined;
    }
    return { key: `${kind === "text" ? "t" : "r"}:${part}`, part, kind, delta: p.delta };
}

/** A delta into the run: counted under its part's key, so the whole part —
 * when it arrives — adds only what the deltas did not; a key in `closed` (its
 * whole part already arrived by another channel) takes no more. */
export function applyPartDelta(
    d: PartDelta,
    metrics: RunMetrics,
    options: RunOptions,
    started: number,
    emitted: Map<string, number>,
    closed?: ReadonlySet<string>
): void {
    if (closed?.has(d.key)) {
        return;
    }
    const before = emitted.get(d.key) ?? 0;
    emitted.set(d.key, before + d.delta.length);
    markFirstByte(metrics, started);
    if (d.kind === "text") {
        metrics.hadOutput = true;
        options.onText?.(d.delta, d.part);
        return;
    }
    if (!before && metrics.reasoning && !metrics.reasoning.endsWith("\n")) {
        metrics.reasoning += "\n";
    }
    metrics.reasoning += d.delta;
    options.onReasoning?.(d.delta);
}

/** `session.status` `{ type: "retry", attempt, message, next }` of `sessionId` (`next` is a timestamp). */
export function providerRetryOf(ev: Record<string, unknown>, sessionId: string, now = Date.now()): ProviderRetry | undefined {
    if (ev.type !== "session.status") {
        return undefined;
    }
    const p = (ev.properties as Record<string, unknown> | undefined) ?? {};
    const status = p.status as { type?: unknown; attempt?: unknown; message?: unknown; next?: unknown } | undefined;
    if (p.sessionID !== sessionId || status?.type !== "retry") {
        return undefined;
    }
    const next = typeof status.next === "number" && status.next > now ? status.next - now : undefined;
    return {
        attempt: typeof status.attempt === "number" ? status.attempt : 0,
        message: typeof status.message === "string" ? truncate(status.message.replace(/\s+/g, " ").trim(), 80) : "",
        ...(next !== undefined ? { nextMs: next } : {})
    };
}

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
        options.onText?.(delta, typeof part.id === "string" && part.id ? part.id : undefined);
        return;
    }
    if (type === "step-finish" || type === "step_finish") {
        if (typeof part.reason === "string" && part.reason) {
            metrics.finishReason = part.reason;
        }
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
