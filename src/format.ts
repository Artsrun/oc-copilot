// Turning a run's raw metrics into human-readable chat text. Every function
// here is a pure transform over RunMetrics/StepRecord plus the string helpers
// in `core` — nothing reaches into VS Code state, so this whole module lives
// above `metrics` and `core` and below the chat runner.

import { normLine, stamp } from "./core";
import { RunMetrics } from "./metrics";
import { CONTEXT_END, CONTEXT_EXCERPTS, CONTEXT_FILES, CONTEXT_HOLD_BYTES, CONTEXT_INLINE, CONTEXT_PROBLEMS, CONTEXT_RULE, CONTEXT_SELECTION } from "./context-markers";

export function scrubLeakedContext(text: string): string {
    const gate = leakGate(true);
    const scrubbed = gate.push(text) + gate.flush();
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

const WORKSPACE_OPEN = "<workspace-context>";
const WORKSPACE_CLOSE = "</workspace-context>";
const PREAMBLE_OPENERS = [
    CONTEXT_FILES,
    CONTEXT_EXCERPTS,
    CONTEXT_PROBLEMS,
    `\n${CONTEXT_EXCERPTS}`,
    `\n${CONTEXT_PROBLEMS}`,
    CONTEXT_END,
    `\n${CONTEXT_SELECTION}`,
    `\n${CONTEXT_INLINE}`
].map((head) => CONTEXT_RULE + head);
// A whole echoed context block stays hidden: 64 KB let a full excerpt + problems
// block (~110 KB) through (0.0.218, measured). The editor selection is unbounded
// and can still exceed it: the deliberate fail-open below.
const HOLD_CAP = CONTEXT_HOLD_BYTES;

/** scrubLeakedContext over a stream: text from an opener on is held until its
 * close arrives, and a tail that could still become an opener waits one chunk.
 * A full opener still held at the end is an incomplete block, not answer text. */
export function createLeakGate(): { push: (chunk: string) => string; flush: () => string } {
    return leakGate(false);
}

function leakGate(keepUnclosed: boolean): { push: (chunk: string) => string; flush: () => string } {
    let pending = "";
    let hidden = "";
    let depth = 0;
    let preamble = false;
    let ending = false;
    let released = false;
    let scrubbed = false;
    let trimAfterScrub = false;
    let inline = 0;
    let fence = "";
    let fenceLength = 0;
    let closingFence = false;
    let lineStart = true;
    let blankLine = false;
    let indent = 0;
    let escaped = false;
    let lastWhitespace = true;
    const visible = (text: string, out: string[]): void => {
        if (!text) return;
        out.push(text);
        lastWhitespace = /\s/.test(text[text.length - 1]);
    };
    const finishBlock = (): void => {
        hidden = "";
        if (!released) scrubbed = true;
        trimAfterScrub = !released && lastWhitespace;
        released = false;
    };
    const scan = (chunk: string, final = false): string => {
        const text = pending + chunk;
        pending = "";
        const out: string[] = [];
        let at = 0;
        while (at < text.length) {
            const inBlock = depth > 0 || preamble;
            if (inBlock && released) {
                const next = text.indexOf(depth > 0 ? "<" : ending ? ")" : "(", at);
                const end = next < 0 ? text.length : next;
                if (end > at) {
                    visible(text.slice(at, end), out);
                    at = end;
                    continue;
                }
            }
            const tokens = depth > 0 ? [WORKSPACE_OPEN, WORKSPACE_CLOSE] : preamble ? (ending ? [] : [CONTEXT_END])
                : inline || fence ? [] : [WORKSPACE_OPEN, ...(lineStart ? PREAMBLE_OPENERS : []), ...(scrubbed ? [WORKSPACE_CLOSE] : [])];
            const rest = text.slice(at, at + 64);
            if (!final && tokens.some((token) => token.startsWith(rest) && rest.length < token.length)) {
                pending = text.slice(at);
                break;
            }
            const token = tokens.find((value) => text.startsWith(value, at));
            if (token) {
                if (!inBlock && token === WORKSPACE_CLOSE) {
                    at += token.length;
                    continue;
                }
                if (released) visible(token, out);
                else hidden += token;
                at += token.length;
                if (token === WORKSPACE_OPEN) depth += 1;
                else if (token === WORKSPACE_CLOSE) depth -= 1;
                else if (preamble) ending = true;
                else preamble = true;
                if (!depth && !preamble) {
                    finishBlock();
                } else if (hidden.length > HOLD_CAP) {
                    visible(hidden, out);
                    hidden = "";
                    released = true;
                }
                continue;
            }
            const ch = text[at];
            if (inBlock) {
                if (released) visible(ch, out);
                else hidden += ch;
                at += 1;
                if (preamble && ending && ch === ")") {
                    preamble = false;
                    ending = false;
                    finishBlock();
                } else if (hidden.length > HOLD_CAP) {
                    // Deliberate fail-open limit: an arbitrary marker cannot retain an unbounded answer.
                    visible(hidden, out);
                    hidden = "";
                    released = true;
                }
                continue;
            }
            if (trimAfterScrub && /\s/.test(ch)) {
                if (ch === "\n") { lineStart = true; indent = 0; blankLine = true; }
                at += 1;
                continue;
            }
            trimAfterScrub = false;
            if ((ch === "`" || ch === "~") && !escaped) {
                let end = at + 1;
                while (text[end] === ch) end += 1;
                if (end === text.length && !final) {
                    pending = text.slice(at);
                    break;
                }
                const n = end - at;
                closingFence = false;
                if (indent <= 3 && n >= 3 && !inline) {
                    if (!fence) { fence = ch; fenceLength = n; }
                    else if (fence === ch && n >= fenceLength) closingFence = true;
                } else if (!fence && ch === "`") {
                    if (!inline) inline = n;
                    else if (inline === n) inline = 0;
                }
                visible(text.slice(at, end), out);
                lineStart = false;
                blankLine = false;
                indent = 4;
                escaped = false;
                at = end;
                continue;
            }
            if (closingFence && ch !== " " && ch !== "\t" && ch !== "\r") {
                if (ch === "\n") { fence = ""; fenceLength = 0; }
                closingFence = false;
            }
            if (ch === "\n") {
                if (blankLine) inline = 0;
                blankLine = true;
            } else if (ch !== " " && ch !== "\t" && ch !== "\r") blankLine = false;
            visible(ch, out);
            lineStart = ch === "\n";
            indent = ch === "\n" ? 0 : ch === " " && indent <= 3 ? indent + 1 : 4;
            escaped = ch === "\\" && !escaped;
            at += 1;
        }
        return out.join("");
    };
    return {
        push: (chunk) => scan(chunk),
        flush: (): string => {
            const text = scan("", true) + (keepUnclosed ? hidden : "");
            hidden = "";
            depth = 0;
            preamble = false;
            return text;
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
