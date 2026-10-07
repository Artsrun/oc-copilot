// Shared run-metrics types and the tiny pure helpers over them. Sits at the
// bottom of the dependency graph (above only `core`) so the chat runner, the
// format layer and the reporting surfaces can each depend on it independently.

import * as vscode from "vscode";

export interface TokenUsage {
    total: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
}

export interface StepRecord {
    tool: string;
    detail: string;
    durationMs: number | undefined;
    output?: string;
    status?: "running" | "done" | "unknown" | "timeout";
    /** Workspace-relative or absolute path this tool touched, when its input
     * exposes one. Used to emit clickable chat references. */
    filePath?: string;
}

/** A subagent's tool call (server and attached runs), and the parent's `task` call it runs under. */
export interface SubagentStep {
    agent: string;
    /** The parent `task` step's detail (`explore: find auth handlers`), once that part named this child. */
    task?: string;
    step: StepRecord;
}

export interface RunMetrics {
    firstByteMs: number | undefined;
    totalMs: number;
    timedOut: boolean;
    steps: StepRecord[];
    tokens: TokenUsage;
    cost: number;
    hadOutput: boolean;
    sessionId: string | undefined;
    reasoning: string;
    toolOutputBytes?: number;
    /** Surfaced from `session.error` events and non-zero exits. */
    error?: string;
    cancelled?: boolean;
    /** Evidence for a run that produced no assistant text. */
    stderr?: string;
    exitCode?: number;
    /** Wall-clock cap applied to this run (0: none). */
    appliedTimeoutMs?: number;
    /** True when the run was killed for going quiet, not for exceeding the cap. */
    idleTimeout?: boolean;
    /** the server session showed work (tool/reasoning/text events) even if
     * the attached CLI printed nothing. A run that was working is not a model
     * stall, so it is never handed off to another model. */
    serverActivity?: boolean;
    /** the tool still running on the server when the run was stopped. */
    stuckTool?: string;
    /** `provider/model` that actually answered, when the run reported it:
     * the server's reply or a message.updated event (server transport and
     * attached runs). A cold CLI run never names it. */
    model?: string;
    /** Tokens the last step sent and got back — the session's context size as
     * OpenCode measures it for compaction (session/overflow.ts: total, else
     * input + output + cache read + cache write). Per-step sums overcount it. */
    context?: number;
    /** Subagent sessions the run started (the task tool) and what they cost,
     * already included in `cost`. Server and attached runs only: a cold CLI
     * run never shows a child session. */
    subagents?: { count: number; cost: number };
    /** `task` calls that ended in an error or were interrupted, with the child
     * session to resume (1.18.20: a failed subagent's task_id is resumable). */
    failedTasks?: Array<{ agent: string; description: string; sessionId?: string }>;
    /** The last step's finish reason (`stop`, `tool-calls`, `length` …): `length` means the answer was cut at the output limit. */
    finishReason?: string;
}

/** A provider backoff OpenCode reported (`session.status` → `{ type: "retry" }`, 1.18.32 processor.ts). */
export interface ProviderRetry {
    attempt: number;
    message: string;
    /** Milliseconds until the next attempt, when the server said. */
    nextMs?: number;
}

/** OpenCode's own context count for one step's tokens. */
export const contextOf = (t: Partial<TokenUsage> | undefined): number =>
    t ? t.total || (t.input ?? 0) + (t.output ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) : 0;

export interface RunOptions {
    executable: string;
    task: string;
    cwd: string;
    agent?: string;
    model?: string;
    pure: boolean;
    /** `--auto` on the CLI: approve every ask that is not explicitly denied. */
    autoApprove: boolean;
    /** a read-only turn. On the server path, where the bridge answers
     * OpenCode's asks itself, it refuses them with a note (the model carries
     * on); the CLI can only approve all (`autoApprove`) or end the turn. */
    readOnly?: boolean;
    json: boolean;
    timeoutMs: number;
    /** Kill the run if nothing at all arrives for this long. 0 disables. */
    idleTimeoutMs?: number;
    sessionId?: string;
    /** Warm `opencode serve` to attach to (`run --attach <url> --dir <cwd>`). */
    attachUrl?: string;
    /** the server handleChat already found healthy this turn, so the
     * server transport does not health-check it a second time. */
    serverUrl?: string;
    /** while a tool is RUNNING on the server, silence may last this long
     * before the run counts as hung (a Jira/MCP call is silent until it ends). */
    toolQuietMs?: number;
    thinking: boolean;
    /** OpenCode's model variant (reasoning effort): `--variant`, or `variant` in the prompt body. */
    variant?: string;
    /** Answer text: a whole part, or a delta of one. `part` is OpenCode's part id when known — text with one id is one part. */
    onText?: (text: string, part?: string) => void;
    onStep?: (step: StepRecord) => void;
    onReasoning?: (text: string) => void;
    /** The provider is being retried (rate limit, overload): the run is waiting, not hung. */
    onRetry?: (retry: ProviderRetry) => void;
    /** A subagent's tool call, running or done. */
    onSubagent?: (sub: SubagentStep) => void;
    token?: vscode.CancellationToken;
}

export type ChatKind = "plan" | "dev" | "parallel";

export function emptyTokens(): TokenUsage {
    return { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

export function stepOutput(state: Record<string, unknown> | undefined): string {
    const raw = state?.output;
    if (typeof raw === "string") {
        return raw;
    }
    if (raw && typeof raw === "object") {
        try {
            return JSON.stringify(raw, null, 2);
        } catch {
            return String(raw);
        }
    }
    return "";
}

// Tools name the file they touched under a handful of keys depending on the
// tool (read/edit/write/patch). Anything that is not a plausible path is
// dropped so no bogus reference chip is emitted.
export function toolFilePath(input: Record<string, unknown> | undefined): string | undefined {
    const candidate =
        (input?.filePath as string) ??
        (input?.file_path as string) ??
        (input?.path as string) ??
        (input?.file as string);
    if (typeof candidate !== "string") {
        return undefined;
    }
    const value = candidate.trim();
    if (!value || value.length > 400 || value.includes("\n")) {
        return undefined;
    }
    return value;
}

export function toolOutputBytes(metrics: RunMetrics): number {
    return metrics.steps.reduce((sum, step) => sum + (step.output?.length ?? 0), 0);
}

export function finalizeStepStatuses(metrics: RunMetrics): void {
    let lastOpen = -1;
    metrics.steps.forEach((step, index) => {
        const complete = step.status === "done" || step.durationMs !== undefined;
        if (!complete) {
            lastOpen = index;
        }
    });
    metrics.steps.forEach((step, index) => {
        if (step.status === "done" || step.durationMs !== undefined) {
            step.status = "done";
            return;
        }
        if (metrics.timedOut && index === lastOpen) {
            step.status = "timeout";
            return;
        }
        if (metrics.timedOut) {
            step.status = "unknown";
            return;
        }
        if (!step.status) {
            step.status = "unknown";
        }
    });
}