"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SETTLE_MS = exports.CHILD_MAX_ROWS = exports.GROUP_MAX_ROWS = exports.stepLabel = exports.supportsTaskProgress = exports.SUBAGENT_EVERY_MS = exports.REASONING_EVERY_MS = exports.HEARTBEAT_MILESTONES_S = void 0;
exports.nextMilestone = nextMilestone;
exports.finishedTask = finishedTask;
exports.startHeartbeat = startHeartbeat;
exports.chatStream = chatStream;
exports.thoughtLine = thoughtLine;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("node:path"));
const core_1 = require("./core");
const followups_1 = require("./followups");
exports.HEARTBEAT_MILESTONES_S = [3, 10, 30, 60, 120, 180, 300, 600];
exports.REASONING_EVERY_MS = 5000;
exports.SUBAGENT_EVERY_MS = 2000;
function nextMilestone(elapsedS) {
    for (const m of exports.HEARTBEAT_MILESTONES_S) {
        if (m > elapsedS) {
            return m;
        }
    }
    const last = exports.HEARTBEAT_MILESTONES_S[exports.HEARTBEAT_MILESTONES_S.length - 1];
    return last + Math.ceil((elapsedS - last + 1) / 300) * 300;
}
const supportsTaskProgress = (response) => typeof response.progress === "function" && response.progress.length >= 2;
exports.supportsTaskProgress = supportsTaskProgress;
const stepRow = (label, file) => {
    const Ref = vscode.ChatResponseReferencePart;
    const value = file ? { variableName: file.tool, value: file.uri } : { variableName: label };
    return Ref ? new Ref(value) : { value };
};
const FILE_TOOLS = /^(?:read|edit|write|patch|multiedit|apply_patch)$/i;
function finishedTask(response, title, rows, files) {
    response.progress.call(response, title, (reporter) => {
        for (const row of rows) {
            reporter.report(stepRow(row, files?.get(row)));
        }
        return Promise.resolve(title);
    });
}
const STEP_RUNNING = / \(running\)$/;
const shortDetail = (detail, cwd) => {
    const root = cwd?.replace(/[\\/]+$/, "");
    if (root && detail.length > root.length + 1 && /[\\/]/.test(detail[root.length]) && detail.slice(0, root.length).toLowerCase() === root.toLowerCase()) {
        detail = detail.slice(root.length + 1);
    }
    return detail.length > 60 && /^\S*[\\/]\S*$/.test(detail) ? `…${detail.slice(-59)}` : (0, core_1.truncate)(detail, 60);
};
const stepLabel = (step, cwd) => {
    const detail = (step.detail ?? "").replace(STEP_RUNNING, "");
    return !detail || detail === "running" ? "" : `${step.tool}: ${shortDetail(detail, cwd)}`;
};
exports.stepLabel = stepLabel;
exports.GROUP_MAX_ROWS = 24;
exports.CHILD_MAX_ROWS = 8;
exports.SETTLE_MS = 120;
const childRows = (kids) => {
    const rows = [...(kids?.rows ?? [])];
    return rows.length > exports.CHILD_MAX_ROWS
        ? [...rows.slice(0, exports.CHILD_MAX_ROWS - 1), `${kids?.agent} › ${rows.length - exports.CHILD_MAX_ROWS + 1} more`]
        : rows;
};
function startHeartbeat(response, initial, timeoutMs, cwd) {
    const everyMs = (0, core_1.config)().get("progressHeartbeatMs", 1000);
    const accordion = (0, core_1.config)().get("groupProgress", true) && (0, exports.supportsTaskProgress)(response);
    const started = Date.now();
    let phase = initial;
    const running = new Set();
    let stopped = false;
    let lastText = "";
    let lastReasoningAt = 0;
    let sub = "";
    let lastSubAt = 0;
    let dueS = exports.HEARTBEAT_MILESTONES_S[0];
    const label = () => {
        const now = sub || ([...running].pop() ?? phase);
        const elapsed = Math.round((Date.now() - started) / 1000);
        return timeoutMs > 0 ? `${now} · ${elapsed}s / ${Math.round(timeoutMs / 1000)}s` : `${now} · ${elapsed}s`;
    };
    const emit = () => {
        const text = label();
        if (stopped || text === lastText) {
            return;
        }
        lastText = text;
        response.progress(text);
        dueS = nextMilestone((Date.now() - started) / 1000);
    };
    let timer;
    if (everyMs > 0) {
        timer = setInterval(() => {
            if ((Date.now() - started) / 1000 >= dueS) {
                emit();
            }
        }, Math.max(250, everyMs));
        timer.unref?.();
    }
    emit();
    const setPhase = (text, thought = false) => {
        if (text === phase) {
            return;
        }
        phase = text;
        if (thought) {
            const now = Date.now();
            if (now - lastReasoningAt < exports.REASONING_EVERY_MS) {
                return;
            }
            lastReasoningAt = now;
        }
        emit();
    };
    let group;
    let pendingThought = "";
    const seen = new Set();
    let lastSentAt = 0;
    const closeGroup = () => {
        const g = group;
        group = undefined;
        if (!accordion || !g || !g.rows.length) {
            return false;
        }
        const n = g.rows.length;
        const rows = g.rows.flatMap((row) => [row, ...childRows(g.children.get(row))]);
        finishedTask(response, `${g.title} · ${n} step${n === 1 ? "" : "s"} · ${(0, core_1.secs)(Date.now() - g.openedAt)}`, rows, g.files);
        lastSentAt = Date.now();
        return true;
    };
    const currentGroup = () => {
        if (!group || group.rows.length >= exports.GROUP_MAX_ROWS || (pendingThought && !group.open.size)) {
            closeGroup();
            group = {
                title: pendingThought ? `${(0, followups_1.mark)("thought")} ${pendingThought}` : `${(0, followups_1.mark)("tool")} Working`,
                rows: [],
                open: new Set(),
                files: new Map(),
                children: new Map(),
                openedAt: Date.now()
            };
            pendingThought = "";
        }
        return group;
    };
    const addRow = (step) => {
        const row = (0, exports.stepLabel)(step, cwd);
        if (!accordion || !row) {
            return;
        }
        const file = step.filePath && FILE_TOOLS.test(step.tool) ? path.resolve(cwd ?? "", step.filePath) : "";
        const remember = (g) => {
            if (file && !g.files.has(row)) {
                g.files.set(row, { uri: vscode.Uri.file(file), tool: step.tool.toLowerCase() });
            }
        };
        if (step.status === "running") {
            if (seen.has(row)) {
                return;
            }
            seen.add(row);
            const g = currentGroup();
            g.rows.push(row);
            g.open.add(row);
            remember(g);
            return;
        }
        if (seen.delete(row)) {
            group?.open.delete(row);
            if (group) {
                remember(group);
            }
            return;
        }
        const g = currentGroup();
        g.rows.push(row);
        remember(g);
    };
    return {
        phase: (text) => {
            if (stopped) {
                return;
            }
            sub = "";
            closeGroup();
            setPhase(text);
        },
        step: (step) => {
            if (stopped) {
                return;
            }
            sub = "";
            addRow(step);
            const text = (0, exports.stepLabel)(step, cwd) || `${step.tool}: running`;
            const bare = `${step.tool}: running`;
            if (step.status === "running") {
                if (text !== bare) {
                    running.delete(bare);
                }
                if (!running.has(text)) {
                    running.add(text);
                    emit();
                }
                return;
            }
            if (!running.delete(text)) {
                const same = [...running].find((k) => k.startsWith(`${step.tool}: `));
                if (same) {
                    running.delete(same);
                }
            }
            setPhase(text);
        },
        subagent: ({ agent, task, step }) => {
            if (stopped) {
                return;
            }
            const row = (0, exports.stepLabel)(step, cwd);
            const parent = task ? (0, exports.stepLabel)({ tool: "task", detail: task, durationMs: undefined }, cwd) : "";
            if (accordion && row && parent && group?.rows.includes(parent)) {
                const kids = group.children.get(parent) ?? { agent, rows: new Set() };
                kids.rows.add(`${agent} › ${row}`);
                group.children.set(parent, kids);
            }
            if (step.status !== "running") {
                sub = "";
                return;
            }
            const detail = (0, core_1.truncate)(step.detail, 60);
            sub = `${agent} › ${step.tool}${detail ? ` ${detail}` : ""}`;
            const now = Date.now();
            if (now - lastSubAt >= exports.SUBAGENT_EVERY_MS) {
                lastSubAt = now;
                emit();
            }
        },
        thought: (line) => {
            if (stopped || !line) {
                return;
            }
            if (group && group.open.size) {
                if (group.title === `${(0, followups_1.mark)("tool")} Working`) {
                    group.title = `${(0, followups_1.mark)("thought")} ${line}`;
                }
                else {
                    pendingThought = line;
                }
            }
            else {
                closeGroup();
                pendingThought = line;
            }
            setPhase(`${(0, followups_1.mark)("thought")} ${line}`, true);
        },
        activity: () => {
            if (!stopped && group) {
                closeGroup();
            }
        },
        stop: async (cancelled = false) => {
            if (stopped) {
                return;
            }
            if (timer) {
                clearInterval(timer);
            }
            if (!cancelled) {
                closeGroup();
            }
            stopped = true;
            const wait = cancelled || !lastSentAt ? 0 : exports.SETTLE_MS - (Date.now() - lastSentAt);
            if (wait > 0) {
                await new Promise((resolve) => setTimeout(resolve, wait));
            }
        }
    };
}
const STREAM_METHODS = ["markdown", "progress", "button", "reference", "anchor", "filetree", "push", "warning"];
function chatStream(response, token) {
    const pill = (0, core_1.config)().get("kaomojiBadges", true) ? (0, followups_1.createBadger)() : undefined;
    const host = response;
    const wrapped = Object.create(response);
    let warned = false;
    const call = (name, args) => {
        const fn = host[name];
        if (token.isCancellationRequested || typeof fn !== "function") {
            return wrapped;
        }
        try {
            fn.apply(response, args);
        }
        catch (error) {
            if (!warned) {
                warned = true;
                core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] chat stream refused ${name}(): ${error}`);
            }
        }
        return wrapped;
    };
    for (const name of STREAM_METHODS) {
        if (typeof host[name] !== "function") {
            continue;
        }
        const value = name === "markdown"
            ? (text) => call(name, [pill && typeof text === "string" ? pill(text) : text])
            : name === "progress" && host.progress.length >= 2
                ? (text, task) => call(name, task === undefined ? [text] : [text, task])
                : (...args) => call(name, args);
        Object.defineProperty(wrapped, name, { enumerable: true, value });
    }
    return wrapped;
}
const RESTATEMENT = /^(the user|user|they|i('| a)m being asked|the request|the task|okay|ok|alright|so,?|let me (re)?read)\b/i;
function thoughtLine(reasoning, max = 90) {
    const plain = reasoning
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/[`*_#>]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
    if (!plain) {
        return "";
    }
    const split = plain.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 12);
    const sentences = split.length ? split : [plain];
    const pick = [...sentences].reverse().find((x) => !RESTATEMENT.test(x)) ?? sentences[sentences.length - 1] ?? plain;
    return (0, core_1.truncate)(pick, max);
}
//# sourceMappingURL=heartbeat.js.map