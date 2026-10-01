"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scrubLeakedContext = scrubLeakedContext;
exports.isPromptEcho = isPromptEcho;
exports.flowLine = flowLine;
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
function flowLine(metrics, max = 6) {
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
        `cache read: ${t.cache.read} · cost: ${cost}` +
        (metrics.timedOut ? " · timed out (partial)" : ""));
}
//# sourceMappingURL=format.js.map