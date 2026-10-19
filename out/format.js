"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scrubLeakedContext = scrubLeakedContext;
exports.isPromptEcho = isPromptEcho;
exports.createLeakGate = createLeakGate;
exports.createEchoGate = createEchoGate;
exports.stepsLine = stepsLine;
exports.composeVisibleAnswer = composeVisibleAnswer;
exports.metricsLogLine = metricsLogLine;
const core_1 = require("./core");
const context_markers_1 = require("./context-markers");
function scrubLeakedContext(text) {
    const gate = leakGate(true);
    const scrubbed = gate.push(text) + gate.flush();
    return scrubbed === text ? text : scrubbed.replace(/^\s+/, "");
}
function isPromptEcho(text, prompt) {
    const a = (0, core_1.normLine)(text);
    const b = (0, core_1.normLine)(prompt);
    if (!a || !b) {
        return false;
    }
    return a === b || a === `${b}.` || (b.startsWith(a) && a.length < 64);
}
const WORKSPACE_OPEN = "<workspace-context>";
const WORKSPACE_CLOSE = "</workspace-context>";
const PREAMBLE_OPENERS = [
    context_markers_1.CONTEXT_FILES,
    context_markers_1.CONTEXT_EXCERPTS,
    context_markers_1.CONTEXT_PROBLEMS,
    `\n${context_markers_1.CONTEXT_EXCERPTS}`,
    `\n${context_markers_1.CONTEXT_PROBLEMS}`,
    context_markers_1.CONTEXT_END,
    `\n${context_markers_1.CONTEXT_SELECTION}`,
    `\n${context_markers_1.CONTEXT_INLINE}`
].map((head) => context_markers_1.CONTEXT_RULE + head);
const HOLD_CAP = context_markers_1.CONTEXT_HOLD_BYTES;
function createLeakGate() {
    return leakGate(false);
}
function leakGate(keepUnclosed) {
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
    const visible = (text, out) => {
        if (!text)
            return;
        out.push(text);
        lastWhitespace = /\s/.test(text[text.length - 1]);
    };
    const finishBlock = () => {
        hidden = "";
        if (!released)
            scrubbed = true;
        trimAfterScrub = !released && lastWhitespace;
        released = false;
    };
    const scan = (chunk, final = false) => {
        const text = pending + chunk;
        pending = "";
        const out = [];
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
            const tokens = depth > 0 ? [WORKSPACE_OPEN, WORKSPACE_CLOSE] : preamble ? (ending ? [] : [context_markers_1.CONTEXT_END])
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
                if (released)
                    visible(token, out);
                else
                    hidden += token;
                at += token.length;
                if (token === WORKSPACE_OPEN)
                    depth += 1;
                else if (token === WORKSPACE_CLOSE)
                    depth -= 1;
                else if (preamble)
                    ending = true;
                else
                    preamble = true;
                if (!depth && !preamble) {
                    finishBlock();
                }
                else if (hidden.length > HOLD_CAP) {
                    visible(hidden, out);
                    hidden = "";
                    released = true;
                }
                continue;
            }
            const ch = text[at];
            if (inBlock) {
                if (released)
                    visible(ch, out);
                else
                    hidden += ch;
                at += 1;
                if (preamble && ending && ch === ")") {
                    preamble = false;
                    ending = false;
                    finishBlock();
                }
                else if (hidden.length > HOLD_CAP) {
                    visible(hidden, out);
                    hidden = "";
                    released = true;
                }
                continue;
            }
            if (trimAfterScrub && /\s/.test(ch)) {
                if (ch === "\n") {
                    lineStart = true;
                    indent = 0;
                    blankLine = true;
                }
                at += 1;
                continue;
            }
            trimAfterScrub = false;
            if ((ch === "`" || ch === "~") && !escaped) {
                let end = at + 1;
                while (text[end] === ch)
                    end += 1;
                if (end === text.length && !final) {
                    pending = text.slice(at);
                    break;
                }
                const n = end - at;
                closingFence = false;
                if (indent <= 3 && n >= 3 && !inline) {
                    if (!fence) {
                        fence = ch;
                        fenceLength = n;
                    }
                    else if (fence === ch && n >= fenceLength)
                        closingFence = true;
                }
                else if (!fence && ch === "`") {
                    if (!inline)
                        inline = n;
                    else if (inline === n)
                        inline = 0;
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
                if (ch === "\n") {
                    fence = "";
                    fenceLength = 0;
                }
                closingFence = false;
            }
            if (ch === "\n") {
                if (blankLine)
                    inline = 0;
                blankLine = true;
            }
            else if (ch !== " " && ch !== "\t" && ch !== "\r")
                blankLine = false;
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
        flush: () => {
            const text = scan("", true) + (keepUnclosed ? hidden : "");
            hidden = "";
            depth = 0;
            preamble = false;
            return text;
        }
    };
}
function createEchoGate(prompts) {
    const said = prompts.map(core_1.normLine).filter(Boolean);
    const isEcho = (t) => prompts.some((p) => isPromptEcho(t, p));
    const mayBe = (t) => {
        const a = (0, core_1.normLine)(t);
        return !a || said.some((b) => b.startsWith(a) || a === `${b}.`);
    };
    let open = true;
    let id;
    let held = "";
    const release = (t) => {
        if (t.trim()) {
            open = false;
        }
        return t;
    };
    const settle = () => {
        const t = held;
        held = "";
        return !t || isEcho(t) ? "" : release(t);
    };
    return {
        push: (text, part) => {
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
function stepsLine(metrics, max = 6) {
    if (metrics.steps.length === 0) {
        return "";
    }
    const names = [];
    for (const step of metrics.steps) {
        const last = names[names.length - 1];
        if (last && last.replace(/ ×\d+$/, "") === step.tool) {
            const n = Number(last.match(/ ×(\d+)$/)?.[1] ?? 1) + 1;
            names[names.length - 1] = `${step.tool} ×${n}`;
        }
        else {
            names.push(step.tool);
        }
    }
    const shown = names.slice(0, max);
    const rest = names.length - shown.length;
    return shown.join(" → ") + (rest > 0 ? ` → +${rest}` : "");
}
function composeVisibleAnswer(prompt, raw, metrics) {
    let text = raw.trim();
    if (isPromptEcho(text, prompt)) {
        text = "";
    }
    if (text) {
        return text;
    }
    if (metrics.timedOut) {
        if (metrics.idleTimeout) {
            return (`Sorry — OpenCode went quiet for the whole idle window and was stopped after ${(metrics.totalMs / 1000).toFixed(1)}s. Nothing was streamed back. See the debug log for the last event received.`);
        }
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
function metricsLogLine(metrics) {
    const firstByte = metrics.firstByteMs === undefined ? "n/a" : `${metrics.firstByteMs} ms`;
    const t = metrics.tokens;
    const cost = metrics.cost > 0 ? `$${metrics.cost.toFixed(4)}` : "$0";
    return (`[${(0, core_1.stamp)()}] metrics first byte: ${firstByte} · total: ${metrics.totalMs} ms · ` +
        `steps: ${metrics.steps.length} · tokens in/out: ${t.input}/${t.output} · ` +
        `cache read: ${t.cache.read} · context: ${metrics.context ?? "n/a"} · cost: ${cost}` +
        (metrics.subagents ? ` (subagents ${metrics.subagents.count}: $${metrics.subagents.cost.toFixed(4)})` : "") +
        (metrics.timedOut ? " · timed out (partial)" : ""));
}
//# sourceMappingURL=format.js.map