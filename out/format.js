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
const LEAKED_CONTEXT = /<workspace-context>[\s\S]*?<\/workspace-context>|(?:^|\n)---\n(?:Files the user attached:[\s\S]*?)?\(Context only\.[^)]*\)/g;
function scrubLeakedContext(text) {
    const scrubbed = text.replace(LEAKED_CONTEXT, "");
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
const LEAK_OPENERS = ["<workspace-context>", "---\nFiles the user attached:", "---\n(Context only."];
const LEAK_CLOSE = /<\/workspace-context>|\(Context only\.[^)]*\)/;
const LEAK_TAIL = Math.max(...LEAK_OPENERS.map((o) => o.length));
function createLeakGate() {
    let held = "";
    return {
        push: (chunk) => {
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
        flush: () => {
            const text = held;
            held = "";
            return scrubLeakedContext(text);
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