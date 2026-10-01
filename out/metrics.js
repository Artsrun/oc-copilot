"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyTokens = emptyTokens;
exports.stepOutput = stepOutput;
exports.toolFilePath = toolFilePath;
exports.toolOutputBytes = toolOutputBytes;
exports.finalizeStepStatuses = finalizeStepStatuses;
function emptyTokens() {
    return { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}
function stepOutput(state) {
    const raw = state?.output;
    if (typeof raw === "string") {
        return raw;
    }
    if (raw && typeof raw === "object") {
        try {
            return JSON.stringify(raw, null, 2);
        }
        catch {
            return String(raw);
        }
    }
    return "";
}
function toolFilePath(input) {
    const candidate = input?.filePath ??
        input?.file_path ??
        input?.path ??
        input?.file;
    if (typeof candidate !== "string") {
        return undefined;
    }
    const value = candidate.trim();
    if (!value || value.length > 400 || value.includes("\n")) {
        return undefined;
    }
    return value;
}
function toolOutputBytes(metrics) {
    return metrics.steps.reduce((sum, step) => sum + (step.output?.length ?? 0), 0);
}
function finalizeStepStatuses(metrics) {
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
//# sourceMappingURL=metrics.js.map