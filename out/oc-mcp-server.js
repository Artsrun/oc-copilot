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
exports.cancelSource = cancelSource;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const node_readline_1 = require("node:readline");
const node_url_1 = require("node:url");
const agents_1 = require("./agents");
const core_1 = require("./core");
const format_1 = require("./format");
const natural_1 = require("./natural");
const followups_1 = require("./followups");
const net_1 = require("./net");
const prompt_1 = require("./prompt");
const proc_1 = require("./proc");
const run_server_1 = require("./run-server");
const server_session_1 = require("./server-session");
const VERSION = "0.0.246";
const SERVER_INFO = { name: "opencode-bridge", version: VERSION };
const MODERN = "2026-07-28";
const LEGACY = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";
const META_SERVER = "io.modelcontextprotocol/serverInfo";
const UNSUPPORTED_VERSION = -32022;
const DEFAULT_WAIT_MS = 100_000;
const MAX_RUNNING = 4;
const KEPT_JOBS = 50;
const KEEP_DONE_MS = 30 * 60_000;
const LOG_CAP = 1024 * 1024;
const QUIET_MS = 400;
const SETTLE_MS = 5000;
function parseArgs(argv) {
    const args = { folders: [], dev: false, waitMs: DEFAULT_WAIT_MS, selftest: false };
    for (let i = 0; i < argv.length; i += 1) {
        const next = () => argv[(i += 1)];
        switch (argv[i]) {
            case "--settings":
                args.settings = next();
                break;
            case "--log":
                args.log = next();
                break;
            case "--folder": {
                const f = next();
                if (f)
                    args.folders.push(f);
                break;
            }
            case "--dev":
                args.dev = true;
                break;
            case "--selftest":
                args.selftest = true;
                break;
            case "--wait-ms": {
                const n = Number(next());
                if (Number.isFinite(n) && n >= 50)
                    args.waitMs = Math.min(n, 10 * 60_000);
                break;
            }
            default: process.stderr.write(`oc-mcp: unknown argument ${JSON.stringify(argv[i])}\n`);
        }
    }
    return args;
}
const ARGS = parseArgs(process.argv.slice(2));
const FORCED = { serverPort: 0, transport: "server" };
let settingsRead = { stamp: "", values: {} };
function fileSettings() {
    if (ARGS.settings) {
        try {
            const stat = fs.statSync(ARGS.settings);
            const now = `${stat.mtimeMs}:${stat.size}`;
            if (now !== settingsRead.stamp) {
                const parsed = JSON.parse(fs.readFileSync(ARGS.settings, "utf8"));
                const values = parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings) ? parsed.settings : {};
                settingsRead = { stamp: now, values };
            }
        }
        catch {
        }
    }
    const values = settingsRead.values;
    return {
        get: (key, fallback) => Object.hasOwn(FORCED, key) ? FORCED[key] : Object.hasOwn(values, key) && values[key] !== undefined && values[key] !== null ? values[key] : fallback
    };
}
let logBytes = -1;
function appendLog(line) {
    process.stderr.write(line + "\n");
    if (!ARGS.log) {
        return;
    }
    try {
        if (logBytes < 0) {
            logBytes = fs.existsSync(ARGS.log) ? fs.statSync(ARGS.log).size : 0;
        }
        if (logBytes > LOG_CAP) {
            fs.renameSync(ARGS.log, `${ARGS.log}.1`);
            logBytes = 0;
        }
        fs.appendFileSync(ARGS.log, line + "\n");
        logBytes += Buffer.byteLength(line) + 1;
    }
    catch {
    }
}
const note = (text) => core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] mcp ${text}`);
const real = (p) => {
    try {
        return fs.realpathSync.native(p);
    }
    catch {
        return path.resolve(p);
    }
};
const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const samePath = (a, b) => fold(path.resolve(a)) === fold(path.resolve(b));
function callFolder(raw, pinned = ARGS.folders, cwd = process.cwd()) {
    if (raw !== undefined && typeof raw !== "string") {
        throw new Error("`folder` must be a string: the absolute path of the folder to work in.");
    }
    let asked = raw?.trim() ?? "";
    if (/^file:\/\//i.test(asked)) {
        try {
            asked = (0, node_url_1.fileURLToPath)(asked);
        }
        catch {
            throw new Error(`\`folder\` is not a usable file URI: ${(0, core_1.truncate)(asked, 120)}`);
        }
    }
    const pins = pinned.map(real);
    const wanted = asked || (pins.length === 1 ? pins[0] : pins.length ? "" : cwd);
    if (!wanted) {
        throw new Error(`\`folder\` is required: this server is configured for ${pins.length} folders (${pins.join(", ")}).`);
    }
    if (!path.isAbsolute(wanted)) {
        throw new Error(`\`folder\` must be an absolute path, got ${JSON.stringify((0, core_1.truncate)(wanted, 120))}.`);
    }
    const folder = real(wanted);
    let isDirectory = false;
    try {
        isDirectory = fs.statSync(folder).isDirectory();
    }
    catch {
        isDirectory = false;
    }
    if (!isDirectory) {
        throw new Error(`\`folder\` is not a folder on this machine: ${(0, core_1.truncate)(wanted, 160)}`);
    }
    if (pins.length) {
        if (!pins.some((pin) => samePath(pin, folder) || (0, core_1.underRoot)(pin, folder) !== "")) {
            throw new Error(`\`folder\` is outside the folders this server is configured for (${pins.join(", ")}).`);
        }
        return folder;
    }
    if (samePath(folder, real(os.homedir())) || samePath(folder, path.parse(folder).root)) {
        throw new Error(`${asked ? "`folder`" : "The folder this server was started in"} is ${folder}: name a project folder in \`folder\`` +
            ", not the home folder or a drive's root.");
    }
    return folder;
}
const jobs = new Map();
function cancelSource() {
    const listeners = new Set();
    let cancelled = false;
    return {
        token: {
            get isCancellationRequested() {
                return cancelled;
            },
            onCancellationRequested: (listener) => {
                if (cancelled) {
                    const timer = setTimeout(listener, 0);
                    return { dispose: () => clearTimeout(timer) };
                }
                listeners.add(listener);
                return { dispose: () => listeners.delete(listener) };
            }
        },
        cancel: () => {
            if (cancelled) {
                return;
            }
            cancelled = true;
            for (const listener of [...listeners]) {
                try {
                    listener();
                }
                catch {
                }
            }
        }
    };
}
async function beforeSend(work, token) {
    const cancelled = () => new Error("Cancelled before anything was sent to OpenCode.");
    if (token.isCancellationRequested) {
        throw cancelled();
    }
    const settled = Promise.resolve()
        .then(() => {
        if (token.isCancellationRequested) {
            throw cancelled();
        }
        return work();
    })
        .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
    const result = await (0, core_1.untilStop)(settled, token);
    if (!result || token.isCancellationRequested) {
        throw cancelled();
    }
    if (!result.ok) {
        throw result.error;
    }
    return result.value;
}
function prune() {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (job.finishedAt && (now - job.finishedAt > KEEP_DONE_MS || jobs.size > KEPT_JOBS)) {
            jobs.delete(id);
        }
    }
}
const running = () => [...jobs.values()].filter((j) => !j.finishedAt);
function startJob(ask) {
    const source = cancelSource();
    const job = {
        id: `job_${(0, node_crypto_1.randomBytes)(5).toString("hex")}`,
        kind: ask.kind,
        folder: ask.folder,
        agent: ask.kind === "dev" ? (0, core_1.config)().get("devAgent", "build").trim() || "build" : "plan",
        asked: ask.sessionId,
        startedAt: Date.now(),
        text: [],
        steps: [],
        notes: [],
        watchers: new Set(),
        done: Promise.resolve(),
        stop: () => {
            job.stopped = true;
            source.cancel();
        },
        stopped: false
    };
    job.done = (async () => {
        const settings = (0, core_1.config)();
        const executable = settings.get("executable", "opencode");
        const base = await beforeSend(() => (0, net_1.ensureServer)(ask.folder), source.token);
        const clashed = (0, net_1.dataFolderRefusal)(executable);
        if (clashed) {
            throw clashed;
        }
        const readOnly = ask.kind === "ask";
        if (readOnly) {
            const choice = await beforeSend(() => (0, agents_1.resolvePlanAgent)(ask.folder, base), source.token);
            job.agent = choice.agent;
            if (choice.fallback) {
                job.notes.push(`planAgent "${choice.wanted}" is not usable here (${choice.fallback}); this ran as plan.`);
            }
        }
        if (source.token.isCancellationRequested) {
            throw new Error("Cancelled before anything was sent to OpenCode.");
        }
        const timeouts = (0, prompt_1.planTimeout)();
        const echo = (0, format_1.createEchoGate)([ask.prompt]);
        let lastPart;
        const say = (text) => {
            if (text) {
                job.text.push(text);
            }
        };
        job.metrics = await (0, run_server_1.runOpenCodeServer)({
            executable,
            task: ask.prompt,
            cwd: ask.folder,
            agent: job.agent,
            model: ask.model ?? (settings.get("model", "").trim() || undefined),
            pure: settings.get("pure", false),
            autoApprove: !readOnly,
            readOnly,
            json: true,
            timeoutMs: timeouts.timeoutMs,
            idleTimeoutMs: timeouts.idleTimeoutMs,
            sessionId: ask.sessionId,
            serverUrl: base,
            thinking: false,
            token: source.token,
            onText: (text, part) => {
                lastPart = part;
                say(echo.push(text, part));
            },
            onStep: (step) => {
                job.steps.push(step);
                for (const watch of job.watchers) {
                    watch(step);
                }
            }
        });
        say(echo.push("", lastPart));
        say(echo.flush());
        const sessionId = job.metrics.sessionId;
        if (sessionId && (job.metrics.cancelled || job.stopped)) {
            let last = Date.now();
            const events = (0, net_1.connectSse)(base, () => void (last = Date.now()), () => undefined, sessionId);
            try {
                await (0, server_session_1.abortServerRun)(base, sessionId, ask.folder, "stopped through MCP");
                for (const until = Date.now() + SETTLE_MS; Date.now() < until && Date.now() - last < QUIET_MS;) {
                    await (0, core_1.delay)(50);
                }
            }
            finally {
                events.close();
            }
        }
    })()
        .catch((error) => {
        job.failure = error instanceof Error ? error.message : String(error);
    })
        .finally(() => {
        job.finishedAt = Date.now();
        note(`job ${job.id} ${job.failure ? `not run: ${(0, core_1.truncate)(job.failure, 160)}` : statusOf(job)} after ${(0, core_1.secs)(job.finishedAt - job.startedAt)}`);
    });
    jobs.set(job.id, job);
    prune();
    return job;
}
function statusOf(job) {
    if (!job.finishedAt) {
        return "running";
    }
    if (job.failure) {
        return job.stopped ? "cancelled" : "refused";
    }
    if (job.stopped || job.metrics?.cancelled) {
        return "cancelled";
    }
    return job.metrics?.error || job.metrics?.timedOut ? "failed" : "done";
}
const textResult = (text, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });
function nextSteps(job, sessionId, answer) {
    const out = [];
    const ask = job.kind === "dev" ? "opencode_dev" : "opencode_ask";
    const waiting = job.metrics?.backgroundTasks?.[0];
    if (waiting) {
        out.push(`The ${waiting.agent} subagent (${(0, core_1.truncate)(waiting.description || waiting.agent, 80)}) is still working in the background; ` +
            `OpenCode gives this session its result with the next prompt. To collect it, call ${ask} with sessionId "${sessionId}" and ask for that result.`);
    }
    const steps = (0, natural_1.naturalFollowups)({ agent: job.agent, answer, steps: job.steps }, 3)
        .filter((c) => c.command === "plan" || (c.command === "dev" && ARGS.dev))
        .map((c) => `- ${plainLabel(c.label, c.kind)} (${c.command === "dev" ? "opencode_dev" : "opencode_ask"})`);
    if (steps.length) {
        out.push(`Next steps this answer offers; send one as the prompt with sessionId "${sessionId}":\n${steps.join("\n")}`);
    }
    return out;
}
const plainLabel = (label, kind) => {
    const kao = Object.hasOwn(followups_1.NATURAL_KAO, kind) ? followups_1.NATURAL_KAO[kind] : "";
    return (kao && label.startsWith(`${kao} `) ? label.slice(kao.length + 1) : label).trim();
};
function jobResult(job) {
    const status = statusOf(job);
    const m = job.metrics;
    const facts = [
        `status=${status}`,
        ...(m?.sessionId ? [`sessionId=${m.sessionId}`] : []),
        `jobId=${job.id}`,
        `agent=${job.agent}`,
        ...(m?.model ? [`model=${m.model}`] : []),
        ...(job.kind === "ask" && m?.readOnlyEnforcement ? [`readOnly=${m.readOnlyEnforcement.kind}`] : []),
        `steps=${job.steps.filter((s) => s.status !== "running").length}`,
        `seconds=${(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000).toFixed(1)}`,
        ...(m && m.cost > 0 ? [`cost=${m.cost.toFixed(4)}`] : []),
        `folder=${job.folder}`
    ];
    const line = `[opencode] ${facts.join(" ")}`;
    const answer = job.text.join("").trim();
    if (status === "running") {
        const last = job.steps.at(-1);
        return textResult(`OpenCode is still working${last ? ` (last step: ${last.tool}${last.detail ? ` ${(0, core_1.truncate)(last.detail, 80)}` : ""})` : ""}. ` +
            `Call opencode_wait with jobId "${job.id}" for the answer, or opencode_cancel to stop it.\n\n${line}`);
    }
    if (status === "refused") {
        return textResult(`${job.failure}\n\n${line}`, true);
    }
    const parts = [];
    if (status === "cancelled") {
        parts.push("Cancelled before OpenCode finished.");
    }
    else if (status === "failed") {
        parts.push(m?.timedOut ? `OpenCode was stopped after ${(0, core_1.secs)(m.totalMs)} without finishing.` : `OpenCode reported an error: ${m?.error}`);
    }
    if (answer) {
        parts.push(answer);
    }
    else if (status === "done") {
        parts.push("OpenCode finished without an answer.");
    }
    if (job.kind === "ask" && m?.readOnlyEnforcement && m.readOnlyEnforcement.kind !== "enforced") {
        parts.push(m.readOnlyEnforcement.kind === "disabled"
            ? "Note: `enforceReadOnly` is off, so this agent's own permissions applied to this run."
            : `Note: read-only rules could not be verified for \`${job.agent}\`; its own permissions applied to this run.`);
    }
    parts.push(...job.notes);
    if (m?.sessionId && status !== "cancelled") {
        parts.push(`To continue this conversation, pass sessionId "${m.sessionId}".`);
        if (status === "done") {
            parts.push(...nextSteps(job, m.sessionId, answer));
        }
    }
    parts.push(line);
    return textResult(parts.join("\n\n"), status !== "done");
}
const RUN_PROPERTIES = {
    prompt: { type: "string", description: "The task or question, in full: OpenCode sees none of this conversation." },
    folder: { type: "string", description: "Absolute path of the project folder to work in. Default: the folder this server was configured for or started in." },
    sessionId: { type: "string", description: "A sessionId from an earlier result, to continue that OpenCode conversation." },
    model: { type: "string", description: "Optional `provider/model` for this run. Default: OpenCode's own." }
};
function tools() {
    const enforced = (0, core_1.config)().get("enforceReadOnly", true);
    const list = [
        {
            name: "opencode_ask",
            description: "Ask OpenCode, a coding agent running on this machine, to research, review or plan in a project folder. " +
                "Read-only: it reads and searches the code and cannot edit files or run shell commands. " +
                "Returns its answer and a sessionId; pass the sessionId back to continue the same conversation. " +
                "A long run returns status=running with a jobId: call opencode_wait with it.",
            inputSchema: { type: "object", properties: RUN_PROPERTIES, required: ["prompt"], additionalProperties: false },
            annotations: { title: "Ask OpenCode (read-only)", readOnlyHint: enforced, destructiveHint: false, idempotentHint: false, openWorldHint: true }
        }
    ];
    if (ARGS.dev) {
        list.push({
            name: "opencode_dev",
            description: "Have OpenCode, a coding agent running on this machine, make a change in a project folder: it edits files and runs commands there with its own permissions. " +
                "Returns what it did and a sessionId; pass the sessionId back to continue the same conversation. " +
                "A long run returns status=running with a jobId: call opencode_wait with it.",
            inputSchema: { type: "object", properties: RUN_PROPERTIES, required: ["prompt"], additionalProperties: false },
            annotations: { title: "Have OpenCode make a change", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
        });
    }
    list.push({
        name: "opencode_wait",
        description: "Wait for an OpenCode run that returned status=running, and return its answer. Call it again while the status is still running.",
        inputSchema: {
            type: "object",
            properties: {
                jobId: { type: "string", description: "The jobId from the result that said status=running." },
                seconds: { type: "number", description: "How long to wait, 1 to 100. Default: this server's own limit for one call." }
            },
            required: ["jobId"],
            additionalProperties: false
        },
        annotations: { title: "Wait for OpenCode", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, {
        name: "opencode_cancel",
        description: "Stop an OpenCode run that is still running.",
        inputSchema: { type: "object", properties: { jobId: { type: "string", description: "The jobId of the run to stop." } }, required: ["jobId"], additionalProperties: false },
        annotations: { title: "Stop OpenCode", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    });
    return list;
}
function runArguments(kind, input) {
    const unknown = Object.keys(input).filter((key) => !Object.hasOwn(RUN_PROPERTIES, key));
    if (unknown.length) {
        throw new Error(`Unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Expected: prompt, folder, sessionId, model.`);
    }
    if (typeof input.prompt !== "string" || !input.prompt.trim()) {
        throw new Error("`prompt` is required: the task or question for OpenCode.");
    }
    const folder = callFolder(input.folder);
    let sessionId;
    if (input.sessionId !== undefined && input.sessionId !== "") {
        if (typeof input.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.sessionId)) {
            throw new Error("`sessionId` must be a sessionId from an earlier result of this server.");
        }
        sessionId = input.sessionId;
    }
    let model;
    if (input.model !== undefined && input.model !== "") {
        if (typeof input.model !== "string" || !/^[\w.-]+\/[\w.:@/-]+$/.test(input.model)) {
            throw new Error("`model` must be `provider/model`, as OpenCode lists it.");
        }
        model = input.model;
    }
    return { kind, prompt: input.prompt, folder, sessionId, model };
}
async function waitFor(job, ms, call) {
    job.watchers.add(call.progress);
    let stop = false;
    try {
        await Promise.race([job.done, (0, core_1.delay)(ms), call.cancelled.then(() => void (stop = true))]);
    }
    finally {
        job.watchers.delete(call.progress);
    }
    if (stop && !job.finishedAt) {
        note(`job ${job.id} stopped: the client cancelled the call`);
        job.stop();
        await Promise.race([job.done, (0, core_1.delay)(3000)]);
    }
    return jobResult(job);
}
async function callTool(name, input, call) {
    if (name === "opencode_dev" && !ARGS.dev) {
        return undefined;
    }
    switch (name) {
        case "opencode_dev":
        case "opencode_ask": {
            let ask;
            try {
                ask = runArguments(name === "opencode_dev" ? "dev" : "ask", input);
            }
            catch (error) {
                return textResult(error instanceof Error ? error.message : String(error), true);
            }
            const active = running();
            const busy = ask.sessionId ? active.find((j) => j.asked === ask.sessionId) : undefined;
            if (busy) {
                return textResult(`Session ${ask.sessionId} is still running job "${busy.id}". Call opencode_wait with it, or opencode_cancel, before sending the next prompt.`, true);
            }
            if (active.length >= MAX_RUNNING) {
                return textResult(`${active.length} OpenCode runs are already in progress (${active.map((j) => j.id).join(", ")}). Wait for one or cancel it.`, true);
            }
            const job = startJob(ask);
            note(`job ${job.id} ${ask.kind} folder=${ask.folder} session=${ask.sessionId ?? "new"} model=${ask.model ?? "-"} prompt=${ask.prompt.length} chars`);
            return waitFor(job, ARGS.waitMs, call);
        }
        case "opencode_wait":
        case "opencode_cancel": {
            const job = typeof input.jobId === "string" ? jobs.get(input.jobId) : undefined;
            if (!job) {
                return textResult(`No run with jobId ${JSON.stringify(input.jobId ?? null)}: it is a jobId from a result of this server, and a finished run is kept for 30 minutes.`, true);
            }
            if (name === "opencode_cancel") {
                if (!job.finishedAt) {
                    job.stop();
                    await Promise.race([job.done, (0, core_1.delay)(3000)]);
                }
                return jobResult(job);
            }
            const seconds = typeof input.seconds === "number" && Number.isFinite(input.seconds) ? Math.min(100, Math.max(1, input.seconds)) * 1000 : ARGS.waitMs;
            return waitFor(job, seconds, call);
        }
        default:
            return undefined;
    }
}
const INSTRUCTIONS = "OpenCode is a coding agent on this machine with its own model, tools and project instructions. " +
    "Give it a self-contained prompt and the absolute project folder. Keep the sessionId a result names and pass it back to continue that conversation.";
const send = (message) => void process.stdout.write(JSON.stringify(message) + "\n");
const fail = (id, code, message, data) => send({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
const open = new Map();
async function handle(frame) {
    const id = frame.id;
    const method = frame.method;
    const params = frame.params ?? {};
    const meta = (params._meta && typeof params._meta === "object" ? params._meta : {});
    if (id === undefined) {
        if (method === "notifications/cancelled") {
            const target = params.requestId;
            note(`← notifications/cancelled requestId=${JSON.stringify(target ?? null)} ${target !== undefined && open.has(target) ? "in flight" : "not in flight"}`);
            if (target !== undefined) {
                open.get(target)?.();
            }
        }
        else {
            note(`← ${method}`);
        }
        return;
    }
    const asked = meta[META_VERSION];
    const modern = asked !== undefined || method === "server/discover";
    const reply = (result) => send({ jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...result, _meta: { [META_SERVER]: SERVER_INFO } } : result });
    if (asked !== undefined && asked !== MODERN && method !== "server/discover") {
        note(`← ${method} protocol=${JSON.stringify(asked)}: not supported`);
        fail(id, UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: [MODERN, ...LEGACY], requested: asked });
        return;
    }
    switch (method) {
        case "initialize": {
            const wanted = params.protocolVersion;
            const client = params.clientInfo;
            const capabilities = params.capabilities && typeof params.capabilities === "object" ? Object.keys(params.capabilities) : [];
            note(`← initialize protocol=${JSON.stringify(wanted ?? null)} client=${String(client?.name ?? "?")}/${String(client?.version ?? "?")} capabilities=${capabilities.join(",") || "-"}`);
            reply({
                protocolVersion: typeof wanted === "string" && LEGACY.includes(wanted) ? wanted : LEGACY[LEGACY.length - 1],
                capabilities: { tools: {} },
                serverInfo: SERVER_INFO,
                instructions: INSTRUCTIONS
            });
            return;
        }
        case "server/discover": {
            const client = meta[META_CLIENT];
            note(`← server/discover protocol=${JSON.stringify(asked ?? null)} client=${String(client?.name ?? "?")}/${String(client?.version ?? "?")}`);
            reply({ supportedVersions: [MODERN, ...LEGACY], capabilities: { tools: {} }, instructions: INSTRUCTIONS, ttlMs: 3_600_000, cacheScope: "private" });
            return;
        }
        case "ping":
            reply({});
            return;
        case "tools/list":
            note(`← tools/list${modern ? ` protocol=${String(asked)}` : ""}`);
            reply({ tools: tools(), ...(modern ? { ttlMs: 60_000, cacheScope: "private" } : {}) });
            return;
        case "tools/call": {
            const name = params.name;
            const input = params.arguments ?? {};
            if (typeof name !== "string" || typeof input !== "object" || input === null || Array.isArray(input)) {
                fail(id, -32602, "Invalid params: expected a tool name and an arguments object");
                return;
            }
            const token = meta.progressToken;
            note(`← tools/call ${name} id=${JSON.stringify(id)}${token === undefined ? "" : " progressToken=yes"}${modern ? ` protocol=${String(asked)}` : ""}`);
            let sent = 0;
            let cancelled = false;
            const call = {
                cancelled: new Promise((resolve) => void open.set(id, () => {
                    cancelled = true;
                    resolve();
                })),
                progress: (step) => {
                    if (token === undefined || step.status === "running") {
                        return;
                    }
                    sent += 1;
                    send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: sent, message: (0, core_1.truncate)(`${step.tool} ${step.detail}`.trim(), 120) } });
                }
            };
            try {
                const result = await callTool(name, input, call);
                if (cancelled) {
                    return;
                }
                if (result) {
                    reply(result);
                }
                else {
                    fail(id, -32602, `Unknown tool: ${(0, core_1.truncate)(name, 80)}`);
                }
            }
            finally {
                open.delete(id);
            }
            return;
        }
        default:
            note(`← ${method}: not a method of this server`);
            fail(id, -32601, "Method not found");
    }
}
function frame(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        fail(null, -32700, "Parse error");
        return;
    }
    const idOk = parsed?.id === undefined || typeof parsed.id === "string" || typeof parsed.id === "number";
    if (!parsed || Array.isArray(parsed) || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string" || !idOk) {
        if (parsed && !Array.isArray(parsed) && parsed.method === undefined) {
            return;
        }
        fail(null, -32600, "Invalid Request");
        return;
    }
    if (parsed.params !== undefined && (!parsed.params || typeof parsed.params !== "object" || Array.isArray(parsed.params))) {
        if (parsed.id !== undefined) {
            fail(parsed.id, -32602, "Invalid params");
        }
        return;
    }
    handle(parsed).catch((error) => {
        note(`${String(parsed.method)} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (parsed.id !== undefined) {
            fail(parsed.id, -32603, "Internal error");
        }
    });
}
let closing = false;
function shutdown(why) {
    if (closing) {
        return;
    }
    closing = true;
    note(`closing (${why}): ${running().length} run(s) stopped`);
    for (const job of running()) {
        job.stop();
    }
    (0, net_1.stopServer)();
    setTimeout(() => process.exit(0), 250).unref();
}
async function selftest() {
    const settings = (0, core_1.config)();
    const executable = settings.get("executable", "opencode");
    let version;
    try {
        version = (await (0, proc_1.runCapture)(executable, ["--version"], process.cwd(), 15000, true)).trim() || "(printed nothing)";
    }
    catch (error) {
        version = `not started: ${error instanceof Error ? error.message : String(error)}`;
    }
    let folder;
    try {
        folder = callFolder(undefined);
    }
    catch (error) {
        folder = `none without a \`folder\` argument: ${error instanceof Error ? error.message : String(error)}`;
    }
    process.stdout.write(JSON.stringify({
        server: SERVER_INFO,
        node: process.version,
        cwd: process.cwd(),
        settingsFile: ARGS.settings ?? null,
        settingsRead: Object.keys(settingsRead.values).length,
        executable,
        opencode: version,
        opencode2: settings.get("opencode2", true),
        enforceReadOnly: settings.get("enforceReadOnly", true),
        defaultFolder: folder,
        pinnedFolders: ARGS.folders,
        tools: tools().map((t) => t.name),
        waitMs: ARGS.waitMs,
        log: ARGS.log ?? null
    }, null, 2) + "\n");
}
function main() {
    (0, core_1.setHost)({ settings: fileSettings, folder: () => undefined, trusted: () => false, state: () => undefined });
    (0, core_1.setLogChannel)({ appendLine: appendLog, show: () => undefined });
    if (ARGS.selftest) {
        void selftest().finally(() => process.exit(0));
        return;
    }
    note(`oc-mcp ${VERSION} started · node ${process.version} · cwd=${process.cwd()} · settings=${ARGS.settings ?? "-"} · folders=${ARGS.folders.join(",") || "-"} · dev=${ARGS.dev} · waitMs=${ARGS.waitMs}`);
    const input = (0, node_readline_1.createInterface)({ input: process.stdin, crlfDelay: Infinity });
    input.on("line", (line) => {
        if (line.trim()) {
            frame(line);
        }
    });
    input.on("close", () => shutdown("stdin closed"));
    process.on("unhandledRejection", (reason) => note(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`));
    process.on("uncaughtException", (error) => note(`uncaught exception: ${error.stack ?? error.message}`));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}
if (require.main === module) {
    main();
}
//# sourceMappingURL=oc-mcp-server.js.map