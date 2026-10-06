// Turning a run's raw metrics into human-readable chat text. Every function
// here is a pure transform over RunMetrics/StepRecord plus the string helpers
// in `core` — nothing reaches into VS Code state, so this whole module lives
// above `metrics` and `core` and below the chat runner.

import { normLine, stamp } from "./core";
import { RunMetrics } from "./metrics";

const LEAKED_CONTEXT =
    /<workspace-context>[\s\S]*?<\/workspace-context>|(?:^|\n)---\n(?:Files the user attached:[\s\S]*?)?\(Context only\.[^)]*\)/g;

export function scrubLeakedContext(text: string): string {
    // Single pass: one replace, no pre-test. A stateful `.test` on a /g regex
    // also advances lastIndex between calls, which is a hazard if this is ever
    // called twice on the same string shape.
    const scrubbed = text.replace(LEAKED_CONTEXT, "");
    return scrubbed === text ? text : scrubbed.replace(/^\s+/, "");
}

export function isPromptEcho(text: string, prompt: string): boolean {
    const a = normLine(text);
    const b = normLine(prompt);
    if (!a || !b) {
        return false;
    }
    return a === b || a === `${b}.` || (b.startsWith(a) && a.length < 64);
}

// A compact one-line step summary: read → read → read reads as "read ×3".
export function stepsLine(metrics: RunMetrics, max = 6): string {
    if (metrics.steps.length === 0) {
        return "";
    }
    const names: string[] = [];
    for (const step of metrics.steps) {
        const last = names[names.length - 1];
        if (last && last.replace(/ ×\d+$/, "") === step.tool) {
            const n = Number(last.match(/ ×(\d+)$/)?.[1] ?? 1) + 1;
            names[names.length - 1] = `${step.tool} ×${n}`;
        } else {
            names.push(step.tool);
        }
    }
    const shown = names.slice(0, max);
    const rest = names.length - shown.length;
    return shown.join(" → ") + (rest > 0 ? ` → +${rest}` : "");
}

// The answer is whatever OpenCode actually said. Only the timeout explanation
// is synthesized, because a silent reply after a cap is unreadable.
export function composeVisibleAnswer(prompt: string, raw: string, metrics: RunMetrics): string {
    let text = raw.trim();
    if (isPromptEcho(text, prompt)) {
        text = "";
    }
    if (text) {
        return text;
    }
    if (metrics.timedOut) {
        if (metrics.idleTimeout) {
            return (
                `Sorry — OpenCode went quiet for the whole idle window and was stopped after ${(
                    metrics.totalMs / 1000
                ).toFixed(1)}s. Nothing was streamed back. See the debug log for the last event received.`
            );
        }
        // With `timeoutMs` at its 0 default there is no wall clock to name, so
        // do not invent one out of totalMs — that reads as a cap the user
        // configured and sends them to raise a setting that was not involved.
        const applied = metrics.appliedTimeoutMs ?? 0;
        return applied > 0
            ? `Sorry — the run hit the ${(applied / 1000).toFixed(0)}s wall-clock cap and produced no ` +
            "assistant text yet. Set `timeoutMs` to 0 to remove the cap entirely and let " +
            "`idleTimeoutMs` stop only a genuinely hung run."
            : `Sorry — the run was stopped after ${(metrics.totalMs / 1000).toFixed(1)}s and produced ` +
            "no assistant text yet. See the debug log for the last event received.";
    }
    return "";
}

// One-liner metrics summary for the "OpenCode" output channel.
export function metricsLogLine(metrics: RunMetrics): string {
    const firstByte = metrics.firstByteMs === undefined ? "n/a" : `${metrics.firstByteMs} ms`;
    const t = metrics.tokens;
    const cost = metrics.cost > 0 ? `$${metrics.cost.toFixed(4)}` : "$0";
    return (
        `[${stamp()}] metrics first byte: ${firstByte} · total: ${metrics.totalMs} ms · ` +
        `steps: ${metrics.steps.length} · tokens in/out: ${t.input}/${t.output} · ` +
        `cache read: ${t.cache.read} · context: ${metrics.context ?? "n/a"} · cost: ${cost}` +
        (metrics.subagents ? ` (subagents ${metrics.subagents.count}: $${metrics.subagents.cost.toFixed(4)})` : "") +
        (metrics.timedOut ? " · timed out (partial)" : "")
    );
}
