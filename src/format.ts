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

// Streamed answers arrive in deltas, so the two whole-text tests above need
// gates: a leaked block or an echoed prompt split across deltas is never whole
// in any one of them.

const LEAK_OPENERS = ["<workspace-context>", "---\nFiles the user attached:", "---\n(Context only."];
const LEAK_CLOSE = /<\/workspace-context>|\(Context only\.[^)]*\)/;
const LEAK_TAIL = Math.max(...LEAK_OPENERS.map((o) => o.length));

/** scrubLeakedContext over a stream: text from an opener on is held until its
 * close arrives, and a tail that could still become an opener waits one chunk. */
export function createLeakGate(): { push: (chunk: string) => string; flush: () => string } {
    let held = "";
    return {
        push: (chunk: string): string => {
            const text = held + chunk;
            held = "";
            const open = LEAK_OPENERS.map((o) => text.indexOf(o))
                .filter((at) => at >= 0 && !LEAK_CLOSE.test(text.slice(at)))
                .sort((a, b) => a - b)[0];
            if (open !== undefined) {
                held = text.slice(open);
                return scrubLeakedContext(text.slice(0, open));
            }
            for (let n = Math.min(text.length, LEAK_TAIL); n > 0; n -= 1) {
                const tail = text.slice(-n);
                if (LEAK_OPENERS.some((o) => o.startsWith(tail))) {
                    held = tail;
                    return scrubLeakedContext(text.slice(0, -n));
                }
            }
            return scrubLeakedContext(text);
        },
        flush: (): string => {
            const text = held;
            held = "";
            return scrubLeakedContext(text);
        }
    };
}

/** isPromptEcho over a stream, part by part: the answer's first text is held
 * while it could still be one of `prompts` said back; a part that is one is
 * dropped, anything else is released. Text with one `part` id is one part; text
 * without an id is a whole part. Once real text has gone out, all passes. */
export function createEchoGate(prompts: readonly string[]): { push: (text: string, part?: string) => string; flush: () => string } {
    const said = prompts.map(normLine).filter(Boolean);
    const isEcho = (t: string): boolean => prompts.some((p) => isPromptEcho(t, p));
    const mayBe = (t: string): boolean => {
        const a = normLine(t);
        return !a || said.some((b) => b.startsWith(a) || a === `${b}.`);
    };
    let open = true;
    let id: string | undefined;
    let held = "";
    const release = (t: string): string => {
        if (t.trim()) {
            open = false;
        }
        return t;
    };
    const settle = (): string => {
        const t = held;
        held = "";
        return !t || isEcho(t) ? "" : release(t);
    };
    return {
        push: (text: string, part?: string): string => {
            if (!open) {
                return text;
            }
            if (part === undefined) {
                const before = settle();
                id = undefined;
                if (!open) {
                    return before + text;
                }
                return isEcho(text) ? before : before + release(text);
            }
            const before = part === id ? "" : settle();
            id = part;
            if (!open) {
                return before + text;
            }
            held += text;
            if (mayBe(held)) {
                return before;
            }
            const out = held;
            held = "";
            return before + release(out);
        },
        flush: settle
    };
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
