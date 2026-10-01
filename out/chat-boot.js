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
exports.ROUTED_COMMANDS = exports.KIND_COMMAND_NAMES = exports.allCommands = exports.DEFAULT_ALIASES = exports.SLASH_COMMANDS = exports.SETTLE_MS = exports.GROUP_MAX_ROWS = exports.stepLabel = exports.supportsTaskProgress = exports.REASONING_EVERY_MS = exports.HEARTBEAT_MILESTONES_S = void 0;
exports.nextMilestone = nextMilestone;
exports.finishedTask = finishedTask;
exports.traceSteps = traceSteps;
exports.startHeartbeat = startHeartbeat;
exports.chatStream = chatStream;
exports.thoughtLine = thoughtLine;
exports.controlCommand = controlCommand;
exports.typedSlash = typedSlash;
exports.commandAliases = commandAliases;
exports.resolveAlias = resolveAlias;
exports.kindChoice = kindChoice;
exports.isKindCommand = isKindCommand;
exports.helpMarkdown = helpMarkdown;
exports.splitLanes = splitLanes;
exports.runParallelLanes = runParallelLanes;
exports.suggestFollowups = suggestFollowups;
exports.rememberFollowups = rememberFollowups;
exports.recalledFollowups = recalledFollowups;
exports.outcomeOf = outcomeOf;
exports.followupsFor = followupsFor;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("node:path"));
const core_1 = require("./core");
const metrics_1 = require("./metrics");
const format_1 = require("./format");
const runs_1 = require("./runs");
const followups_1 = require("./followups");
const natural_1 = require("./natural");
const models_1 = require("./models");
const flow_1 = require("./flow");
exports.HEARTBEAT_MILESTONES_S = [3, 10, 30, 60, 120, 180, 300, 600];
exports.REASONING_EVERY_MS = 5000;
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
function traceSteps(nodes, steps, cwd) {
    for (const step of steps) {
        const label = (0, exports.stepLabel)(step, cwd);
        (0, flow_1.flowAdd)(nodes, "step", step.tool, label.slice(step.tool.length + 2), step.status === "timeout" ? "fail" : undefined);
    }
}
exports.GROUP_MAX_ROWS = 24;
exports.SETTLE_MS = 120;
function startHeartbeat(response, initial, timeoutMs, cwd) {
    const everyMs = (0, core_1.config)().get("progressHeartbeatMs", 1000);
    const accordion = (0, core_1.config)().get("groupProgress", true) && (0, exports.supportsTaskProgress)(response);
    const started = Date.now();
    let phase = initial;
    const running = new Set();
    let stopped = false;
    let lastText = "";
    let lastReasoningAt = 0;
    let dueS = exports.HEARTBEAT_MILESTONES_S[0];
    const label = () => {
        const now = [...running].pop() ?? phase;
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
        finishedTask(response, `${g.title} · ${n} step${n === 1 ? "" : "s"} · ${(0, core_1.secs)(Date.now() - g.openedAt)}`, g.rows, g.files);
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
            closeGroup();
            setPhase(text);
        },
        step: (step) => {
            if (stopped) {
                return;
            }
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
exports.SLASH_COMMANDS = ["new", "session", "sessions", "help", "model", "ping", "env", "stop", "flow"];
const CONTROL_COMMANDS = new Set(exports.SLASH_COMMANDS);
const KIND_COMMANDS = {
    plan: "plan",
    dev: "dev",
    parallel: "parallel"
};
function controlCommand(declared, typed) {
    return CONTROL_COMMANDS.has(declared) ? declared : typed;
}
function typedSlash(prompt) {
    return (prompt.match(new RegExp(`^/(${exports.SLASH_COMMANDS.join("|")})\\b\\s*`, "i"))?.[1]?.toLowerCase() ?? "");
}
exports.DEFAULT_ALIASES = {
    p: "parallel",
    d: "dev",
    pl: "plan",
    n: "new",
    s: "session",
    x: "stop",
    m: "model",
    w: "worktree",
    e: "env",
    f: "flow",
    ls: "sessions",
    h: "help",
    "?": "help"
};
const allCommands = () => [...exports.SLASH_COMMANDS, ...exports.KIND_COMMAND_NAMES, ...exports.ROUTED_COMMANDS];
exports.allCommands = allCommands;
const bare = (word) => word.trim().replace(/^\//, "").toLowerCase();
function commandAliases(user = (0, core_1.config)().get("commandAliases", {})) {
    const table = { ...exports.DEFAULT_ALIASES };
    if (user && typeof user === "object") {
        for (const [k, v] of Object.entries(user)) {
            if (typeof v === "string" && bare(k) && bare(v)) {
                table[bare(k)] = bare(v);
            }
        }
    }
    return table;
}
function resolveAlias(prompt, table = commandAliases()) {
    const m = prompt.match(/^\/(\S+)(?=\s|$)/);
    if (!m) {
        return { prompt };
    }
    const word = m[1].toLowerCase();
    const commands = (0, exports.allCommands)();
    if (commands.includes(word) || word === "par") {
        return { prompt };
    }
    const target = table[word];
    if (!target) {
        return { prompt };
    }
    if (!commands.includes(target)) {
        return {
            prompt,
            problem: `\`/${word}\` is set to \`/${target}\` in \`commandAliases\`, and that is not a command. ` +
                `Commands: ${commands.map((c) => `\`/${c}\``).join(" ")}.`
        };
    }
    return { prompt: `/${target}${prompt.slice(m[0].length)}`, alias: word };
}
function kindChoice(declared, parsedKind) {
    return KIND_COMMANDS[declared] ?? parsedKind;
}
exports.KIND_COMMAND_NAMES = Object.keys(KIND_COMMANDS);
exports.ROUTED_COMMANDS = ["worktree"];
function isKindCommand(declared) {
    return Boolean(KIND_COMMANDS[declared]);
}
function helpMarkdown() {
    return [
        "**OpenCode bridge** — one ongoing session per workspace.",
        "",
        "| Command | What it does |",
        "| --- | --- |",
        "| `/plan <task>` | Read-only agent (default): `plan`, or your `planAgent` |",
        "| `/dev <task>` | Editing agent — may write files |",
        "| `/parallel a \\| b \\| c` | Run independent lanes at once in isolated sessions — `/parallel` alone composes them step by step |",
        "| `/worktree <task>` | Editing agent in a NEW git worktree + branch next to the repo; your checkout is untouched |",
        "| `/session` | Session id, turns, totals |",
        "| `/sessions` | This folder's sessions: continue, fork, close or delete one |",
        "| `/stop` | Stop a run still going on the server (closing the chat does not) |",
        "| `/new` | Start a fresh session |",
        "| `/model` | Show and change the model chain |",
        "| `/flow [n\\|all]` | Diagram of what a turn did — folder, session, agent, model, steps, end. No model call |",
        "",
        "Inline prefixes still work: `dev:`, `model:provider/id` — or a short name, `model:tundra`.",
        "Lanes split on `|`, `;;` or a `---` line. Per lane: `/parallel m:tundra review auth | m:oasis read the logs`. One task on several models: `/parallel models:tundra,oasis,aspen review auth`.",
        "Attach files with `#file:` — they are passed to OpenCode as context.",
        "",
        `Aliases: ${Object.entries(commandAliases())
            .map(([k, v]) => `\`/${k}\` ${v}`)
            .join(" · ")} — add your own with the \`commandAliases\` setting.`
    ].join("\n");
}
const LANE_MASK = { "|": "\u0001", ";": "\u0002", "-": "\u0003" };
const LANE_UNMASK = { "\u0001": "|", "\u0002": ";", "\u0003": "-" };
const maskLane = (s) => s.replace(/[|;-]/g, (c) => LANE_MASK[c]);
function splitLanes(task) {
    return task
        .replace(/\r\n?/g, "\n")
        .replace(/(`+)(?:[\s\S]*?\1|[\s\S]*$)/g, maskLane)
        .replace(/^[ \t]*\|.*$/gm, maskLane)
        .replace(/\|{2,}/g, maskLane)
        .split(/\s*(?:\||;;|\n[ \t]*-{2,}[ \t]*\n)\s*/)
        .map((part) => part.replace(/[\u0001-\u0003]/g, (c) => LANE_UNMASK[c]).trim())
        .filter(Boolean);
}
async function runParallelLanes(opts) {
    const specs = opts.lanes;
    const lanes = specs.map((s) => s.task);
    const laneAgent = opts.write ? opts.devAgent ?? "build" : opts.planAgent ?? "plan";
    const names = (0, models_1.cachedModelInfo)();
    const modelName = (id) => names[id]?.name ?? id;
    const sameTask = specs.length > 1 && specs.every((s) => s.task === specs[0].task);
    opts.response.markdown(`Running **${lanes.length} lanes** in parallel` +
        (opts.write
            ? " with the editing agent"
            : laneAgent === "plan"
                ? " with the read-only plan agent"
                : ` with the read-only \`${laneAgent}\` agent`) +
        (sameTask ? ` on ${specs.length} models` : "") +
        (opts.timeoutMs > 0 ? `, ${Math.round(opts.timeoutMs / 1000)}s cap each.` : ", no wall-clock cap.") +
        "\n");
    const done = specs.map((s) => Boolean(s.error));
    const tickLabel = (i) => sameTask && specs[i].model ? (0, core_1.truncate)(modelName(specs[i].model).split(/[\s(]/)[0], 22) : (0, core_1.truncate)(lanes[i], 22);
    const tick = () => {
        opts.response.progress(specs.map((s, i) => `${s.error ? (0, followups_1.mark)("warn") : done[i] ? (0, followups_1.mark)("ok") : "•"} ${tickLabel(i)}`).join("   "));
    };
    tick();
    const attachUrl = opts.attachUrl;
    const laneSessions = attachUrl
        ? await Promise.all(specs.map((s) => (s.error ? undefined : (0, runs_1.createServerSession)(attachUrl, opts.cwd, s.task).catch(() => undefined))))
        : specs.map(() => undefined);
    const results = await Promise.all(lanes.map(async (lane, i) => {
        let answer = "";
        const laneStarted = Date.now();
        const blank = {
            firstByteMs: undefined,
            totalMs: 0,
            timedOut: false,
            steps: [],
            tokens: (0, metrics_1.emptyTokens)(),
            cost: 0,
            hadOutput: false,
            sessionId: undefined,
            reasoning: ""
        };
        if (specs[i].error) {
            blank.error = specs[i].error;
            return { lane, answer, metrics: blank };
        }
        try {
            const metrics = await (0, runs_1.runOpenCode)({
                executable: opts.executable,
                task: lane,
                cwd: opts.cwd,
                agent: laneAgent,
                attachUrl,
                sessionId: laneSessions[i],
                model: specs[i].model ?? opts.model,
                pure: opts.pure,
                autoApprove: opts.write || laneAgent === "plan",
                readOnly: !opts.write,
                json: true,
                thinking: false,
                timeoutMs: opts.timeoutMs,
                token: opts.token,
                onText: (text) => {
                    answer += text;
                },
                onStep: () => tick()
            });
            done[i] = true;
            tick();
            const laneSession = laneSessions[i] ?? metrics.sessionId;
            if (attachUrl && laneSession && (opts.token.isCancellationRequested || metrics.timedOut)) {
                void (0, runs_1.abortServerRun)(attachUrl, laneSession, opts.cwd, opts.token.isCancellationRequested ? "lane cancelled" : "lane timed out");
            }
            return { lane, answer, metrics };
        }
        catch (error) {
            done[i] = true;
            tick();
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] lane "${(0, core_1.truncate)(lane, 60)}" failed: ${error}`);
            blank.totalMs = Date.now() - laneStarted;
            blank.error = error instanceof Error ? error.message : String(error);
            return { lane, answer, metrics: blank };
        }
    }));
    for (const [i, result] of results.entries()) {
        (0, metrics_1.finalizeStepStatuses)(result.metrics);
        const body = (0, format_1.scrubLeakedContext)(result.answer.trim()) || "_(no output)_";
        const flow = (0, format_1.flowLine)(result.metrics);
        const fail = result.metrics.error
            ? ` · ${(0, followups_1.mark)("warn")} ${(0, core_1.truncate)(String(result.metrics.error), 120)}`
            : "";
        const laneModel = specs[i].model ?? opts.model;
        const title = sameTask && laneModel ? modelName(laneModel) : (0, core_1.truncate)(result.lane, 80) + (laneModel ? ` · ${modelName(laneModel)}` : "");
        opts.response.markdown(`\n\n### ${i + 1}. ${title}\n\n${specs[i].error ? "_(not run)_" : body}\n\n` +
            `> ${flow ? flow + " · " : ""}${(0, core_1.secs)(result.metrics.totalMs)}` +
            (result.metrics.cost > 0 ? ` · $${result.metrics.cost.toFixed(4)}` : "") +
            (result.metrics.timedOut ? " · " + (0, followups_1.mark)("quiet") + " partial" : fail));
    }
    const ok = results.filter((r) => !r.metrics.timedOut && r.answer.trim()).length;
    if (opts.trace) {
        for (const [i, r] of results.entries()) {
            const nodes = [];
            const m = r.metrics;
            const laneModel = specs[i].model ?? opts.model;
            (0, flow_1.flowAdd)(nodes, "info", "model", specs[i].ref ?? (laneModel ? modelName(laneModel) : "OpenCode default"), specs[i].error ? "fail" : undefined);
            traceSteps(nodes, m.steps, opts.cwd);
            const cost = m.cost > 0 ? ` · $${m.cost.toFixed(4)}` : "";
            (0, flow_1.flowAdd)(nodes, "info", specs[i].error ? "not run" : m.timedOut ? `timed out after ${(0, core_1.secs)(m.totalMs)}` : m.error ? `error: ${m.error}` : `answered in ${(0, core_1.secs)(m.totalMs)}${cost}`, "", specs[i].error || m.error || m.timedOut ? "fail" : undefined);
            opts.trace.lanes.push({ title: (0, core_1.truncate)(sameTask && laneModel ? modelName(laneModel) : r.lane, 40), nodes });
        }
    }
    const totalMs = Math.max(...results.map((r) => r.metrics.totalMs), 0);
    const serialMs = results.reduce((n, r) => n + r.metrics.totalMs, 0);
    const cost = results.reduce((n, r) => n + r.metrics.cost, 0);
    opts.response.markdown(`\n\n---\n\n**${ok}/${results.length} lanes returned.** ` +
        `Wall clock ${(0, core_1.secs)(totalMs)} vs ${(0, core_1.secs)(serialMs)} sequential` +
        (cost > 0 ? ` · $${cost.toFixed(4)}` : "") +
        ".\n\nLanes ran in isolated sessions, so nothing above is in your ongoing " +
        "conversation. Paste the parts you want to keep into a normal `@opencode` turn.");
    if (opts.trace) {
        opts.trace.end = { kind: "end", key: `${ok}/${results.length} lanes returned in ${(0, core_1.secs)(totalMs)}${cost > 0 ? ` · $${cost.toFixed(4)}` : ""}`, parts: [], count: 1, status: ok < results.length ? "warn" : undefined };
    }
}
function suggestFollowups(input) {
    try {
        return (0, natural_1.naturalFollowups)(input);
    }
    catch (error) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] follow-up chips left out: ${error}`);
        return [];
    }
}
const followupStore = new Map();
const FOLLOWUP_STORE_CAP = 64;
function rememberFollowups(sessionId, turns, chips) {
    const key = `${sessionId}#${turns}`;
    followupStore.delete(key);
    followupStore.set(key, chips);
    while (followupStore.size > FOLLOWUP_STORE_CAP) {
        followupStore.delete(followupStore.keys().next().value);
    }
}
function recalledFollowups(sessionId, turns) {
    return sessionId ? followupStore.get(`${sessionId}#${turns}`) ?? [] : [];
}
const stripKind = (text) => text.replace(/^\/(?:dev|plan)\b\s*/i, "");
const UNREACHABLE = /ENOENT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|not found on PATH|could not be started|unreachable|socket hang up|fetch failed/i;
function outcomeOf(metadata) {
    switch (metadata.kind) {
        case "new":
        case "help":
        case "idle":
        case "model":
        case "stop":
        case "worktree":
            return "silent";
        case "clarify":
            return "clarify";
        case "parallel":
            return metadata.lanesMissing ? "lanesMissing" : "parallel";
        case "composed":
            return "composed";
    }
    const turns = typeof metadata.turns === "number" ? metadata.turns : 0;
    const error = typeof metadata.error === "string" ? metadata.error : "";
    switch (true) {
        case Boolean(error) && UNREACHABLE.test(error):
            return "failedNet";
        case Boolean(metadata.timedOut) && turns > 1:
            return "failedLong";
        case Boolean(metadata.timedOut) || Boolean(error):
            return "failed";
        case Boolean(metadata.cancelled):
            return "cancelled";
        default:
            return "done";
    }
}
function followupsFor(metadata) {
    const chips = chipsFor(metadata);
    (0, flow_1.noteFlowChips)(metadata.flow, chips.map((c) => c.label ?? c.prompt));
    return chips;
}
function chipsFor(metadata) {
    const outcome = outcomeOf(metadata);
    const kind = metadata.agent === "dev" || metadata.kind === "dev" ? "dev" : "plan";
    const own = typeof metadata.prompt === "string" ? metadata.prompt : undefined;
    const chips = (keys, text = {}) => keys.flatMap((k) => {
        const chip = (0, followups_1.chipOf)(k, kind, text[k]);
        if (!chip) {
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] follow-up chip ${k} left out: it has no text to send`);
        }
        return chip ? [chip] : [];
    });
    switch (outcome) {
        case "clarify":
            return own === undefined ? [] : chips(followups_1.CASES.clarify, { RUN_ANYWAY: own });
        case "failed":
        case "failedLong":
        case "failedNet": {
            const again = own ? stripKind(own) : "";
            return chips(followups_1.CASES[outcome], again ? { RETRY: again } : {});
        }
        case "composed":
            return typeof metadata.lanes === "string" && metadata.lanes ? chips(followups_1.CASES.composed, { RUN_LANES: metadata.lanes }) : [];
        case "done": {
            const sessionId = typeof metadata.sessionId === "string" ? metadata.sessionId : undefined;
            const turns = typeof metadata.turns === "number" ? metadata.turns : 0;
            const seen = new Set();
            return recalledFollowups(sessionId, turns)
                .filter((f) => !seen.has(`${f.command}|${f.prompt}`) && Boolean(seen.add(`${f.command}|${f.prompt}`)))
                .slice(0, 3);
        }
        default:
            return chips(followups_1.CASES[outcome]);
    }
}
//# sourceMappingURL=chat-boot.js.map