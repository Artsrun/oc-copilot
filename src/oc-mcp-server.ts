// claim:mcp-tools — standalone MCP stdio server on the engine: OpenCode as tools for an MCP client
// that has no chat participants (Copilot's harness reads the user's own
// `mcp-config.json`). Runs as a plain Node process, copied to global storage with
// the engine's modules; no `vscode` (EN). Newline-delimited JSON-RPC.
//
// State a client needs across calls is a handle it passes back as an argument
// (`sessionId`, `jobId`, `folder`), never the connection: MCP 2026-07-28 is
// stateless and deprecates roots (REFS 0.0.241).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { resolvePlanAgent } from "./agents";
import { Cancel, config, delay, logChannel, secs, setHost, setLogChannel, Settings, stamp, truncate, underRoot } from "./core";
import { createEchoGate } from "./format";
import { RunMetrics, StepRecord } from "./metrics";
import { naturalFollowups } from "./natural";
import { NATURAL_KAO } from "./followups";
import { connectSse, dataFolderRefusal, ensureServer, stopServer } from "./net";
import { planTimeout } from "./prompt";
import { runCapture } from "./proc";
import { runOpenCodeServer } from "./run-server";
import { abortServerRun } from "./server-session";

const VERSION = "0.0.243";
const SERVER_INFO = { name: "opencode-bridge", version: VERSION };
const MODERN = "2026-07-28";
const LEGACY = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";
const META_SERVER = "io.modelcontextprotocol/serverInfo";
const UNSUPPORTED_VERSION = -32022;

// One tool call answers within this long, or hands back a job to wait on: a
// client's own ceiling for a call is not documented (one report: ~180 s).
const DEFAULT_WAIT_MS = 100_000;
const MAX_RUNNING = 4;
const KEPT_JOBS = 50;
const KEEP_DONE_MS = 30 * 60_000;
const LOG_CAP = 1024 * 1024;
// A stopped run's abort is not awaited by the engine (a chat's Stop has one second).
// Here the next prompt can follow at once, and it read the stopped run's last events
// as its own: "Step interrupted" on 2.3.0, the old text on 1.19.5 (probe-mcp.js). So a
// stopped job is finished only once its abort was answered, the session is idle and
// its events have stopped for QUIET_MS (idle alone was not enough on 1.19.5: 6 of 8).
const QUIET_MS = 400;
const SETTLE_MS = 5000;

// ---------------------------------------------------------------------------
// arguments: the server's configuration, written by the user in their own file
// ---------------------------------------------------------------------------

interface Args {
    settings?: string;
    log?: string;
    folders: string[];
    dev: boolean;
    waitMs: number;
    selftest: boolean;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { folders: [], dev: false, waitMs: DEFAULT_WAIT_MS, selftest: false };
    for (let i = 0; i < argv.length; i += 1) {
        const next = (): string | undefined => argv[(i += 1)];
        switch (argv[i]) {
            case "--settings": args.settings = next(); break;
            case "--log": args.log = next(); break;
            case "--folder": { const f = next(); if (f) args.folders.push(f); break; }
            case "--dev": args.dev = true; break;
            case "--selftest": args.selftest = true; break;
            case "--wait-ms": { const n = Number(next()); if (Number.isFinite(n) && n >= 50) args.waitMs = Math.min(n, 10 * 60_000); break; }
            default: process.stderr.write(`oc-mcp: unknown argument ${JSON.stringify(argv[i])}\n`);
        }
    }
    return args;
}

const ARGS = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// host: settings from the file the extension writes, the log to a file and stderr
// ---------------------------------------------------------------------------

// This process runs its own server, whatever the window's settings say: a fixed
// `serverPort` is another process's server, without this process's overrides.
const FORCED: Record<string, unknown> = { serverPort: 0, transport: "server" };

let settingsRead = { stamp: "", values: {} as Record<string, unknown> };

/** The user-scope settings the extension wrote, read again when the file changes. */
function fileSettings(): Settings {
    if (ARGS.settings) {
        try {
            const stat = fs.statSync(ARGS.settings);
            const now = `${stat.mtimeMs}:${stat.size}`;
            if (now !== settingsRead.stamp) {
                const parsed = JSON.parse(fs.readFileSync(ARGS.settings, "utf8")) as { settings?: unknown };
                const values = parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings) ? (parsed.settings as Record<string, unknown>) : {};
                settingsRead = { stamp: now, values };
            }
        } catch {
            // No file, or half written: the last good read stands, else the defaults.
        }
    }
    const values = settingsRead.values;
    return {
        get: <T>(key: string, fallback?: T): T | undefined =>
            Object.hasOwn(FORCED, key) ? (FORCED[key] as T) : Object.hasOwn(values, key) && values[key] !== undefined && values[key] !== null ? (values[key] as T) : fallback
    } as Settings;
}

let logBytes = -1;

function appendLog(line: string): void {
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
    } catch {
        // A log that cannot be written must not take a tool call down.
    }
}

const note = (text: string): void => logChannel.appendLine(`[${stamp()}] mcp ${text}`);

// ---------------------------------------------------------------------------
// the folder a call works in
// ---------------------------------------------------------------------------

const real = (p: string): string => {
    try {
        return fs.realpathSync.native(p);
    } catch {
        return path.resolve(p);
    }
};
const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
const samePath = (a: string, b: string): boolean => fold(path.resolve(a)) === fold(path.resolve(b));

/** The folder a call named, or the one this server was configured or started in.
 * `--folder` pins: a call may only name a pinned folder or one inside it. Without a
 * pin any folder goes but the home folder and a drive's root, which are a whole
 * machine rather than a project. Throws what the caller is told. */
function callFolder(raw: unknown, pinned: readonly string[] = ARGS.folders, cwd = process.cwd()): string {
    if (raw !== undefined && typeof raw !== "string") {
        throw new Error("`folder` must be a string: the absolute path of the folder to work in.");
    }
    let asked = raw?.trim() ?? "";
    if (/^file:\/\//i.test(asked)) {
        try {
            asked = fileURLToPath(asked);
        } catch {
            throw new Error(`\`folder\` is not a usable file URI: ${truncate(asked, 120)}`);
        }
    }
    const pins = pinned.map(real);
    const wanted = asked || (pins.length === 1 ? pins[0] : pins.length ? "" : cwd);
    if (!wanted) {
        throw new Error(`\`folder\` is required: this server is configured for ${pins.length} folders (${pins.join(", ")}).`);
    }
    if (!path.isAbsolute(wanted)) {
        throw new Error(`\`folder\` must be an absolute path, got ${JSON.stringify(truncate(wanted, 120))}.`);
    }
    const folder = real(wanted);
    let isDirectory = false;
    try {
        isDirectory = fs.statSync(folder).isDirectory();
    } catch {
        isDirectory = false;
    }
    if (!isDirectory) {
        throw new Error(`\`folder\` is not a folder on this machine: ${truncate(wanted, 160)}`);
    }
    if (pins.length) {
        if (!pins.some((pin) => samePath(pin, folder) || underRoot(pin, folder) !== "")) {
            throw new Error(`\`folder\` is outside the folders this server is configured for (${pins.join(", ")}).`);
        }
        return folder;
    }
    if (samePath(folder, real(os.homedir())) || samePath(folder, path.parse(folder).root)) {
        throw new Error(
            `${asked ? "`folder`" : "The folder this server was started in"} is ${folder}: name a project folder in \`folder\`` +
            ", not the home folder or a drive's root."
        );
    }
    return folder;
}

// ---------------------------------------------------------------------------
// jobs: a run outlives the call that started it
// ---------------------------------------------------------------------------

interface Job {
    id: string;
    kind: "ask" | "dev";
    folder: string;
    agent: string;
    asked?: string;
    startedAt: number;
    finishedAt?: number;
    text: string[];
    steps: StepRecord[];
    metrics?: RunMetrics;
    failure?: string;
    notes: string[];
    watchers: Set<(step: StepRecord) => void>;
    done: Promise<void>;
    stop(): void;
    stopped: boolean;
}

const jobs = new Map<string, Job>();

/** Stop for one job, with the rule core's `Cancel` names. Exported for its check (`MP`). */
export function cancelSource(): { token: Cancel; cancel(): void } {
    const listeners = new Set<() => unknown>();
    let cancelled = false;
    return {
        token: {
            get isCancellationRequested(): boolean {
                return cancelled;
            },
            // As VS Code's token does: a listener added after Stop is still called, on the
            // next tick. The engine's waits are written against that.
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
                } catch {
                    // One listener's failure must not keep the others from stopping.
                }
            }
        }
    };
}

function prune(): void {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (job.finishedAt && (now - job.finishedAt > KEEP_DONE_MS || jobs.size > KEPT_JOBS)) {
            jobs.delete(id);
        }
    }
}

const running = (): Job[] => [...jobs.values()].filter((j) => !j.finishedAt);

interface RunAsk {
    kind: "ask" | "dev";
    prompt: string;
    folder: string;
    sessionId?: string;
    model?: string;
}

function startJob(ask: RunAsk): Job {
    const source = cancelSource();
    const job: Job = {
        id: `job_${randomBytes(5).toString("hex")}`,
        kind: ask.kind,
        folder: ask.folder,
        agent: ask.kind === "dev" ? config().get<string>("devAgent", "build").trim() || "build" : "plan",
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
        const settings = config();
        const executable = settings.get<string>("executable", "opencode");
        // The server first: it checks which OpenCode this is, and names it.
        const base = await ensureServer(ask.folder);
        const clashed = dataFolderRefusal(executable);
        if (clashed) {
            throw clashed;
        }
        const readOnly = ask.kind === "ask";
        if (readOnly) {
            const choice = await resolvePlanAgent(ask.folder, base);
            job.agent = choice.agent;
            if (choice.fallback) {
                job.notes.push(`planAgent "${choice.wanted}" is not usable here (${choice.fallback}); this ran as plan.`);
            }
        }
        if (source.token.isCancellationRequested) {
            throw new Error("Cancelled before anything was sent to OpenCode.");
        }
        const timeouts = planTimeout();
        // OpenCode 1 sends the prompt back as a text part of its own: not the answer.
        const echo = createEchoGate([ask.prompt]);
        let lastPart: string | undefined;
        const say = (text: string): void => {
            if (text) {
                job.text.push(text);
            }
        };
        job.metrics = await runOpenCodeServer({
            executable,
            task: ask.prompt,
            cwd: ask.folder,
            agent: job.agent,
            model: ask.model ?? (settings.get<string>("model", "").trim() || undefined),
            pure: settings.get<boolean>("pure", false),
            // On the server path the bridge answers OpenCode's asks itself, by `readOnly`.
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
            const events = connectSse(base, () => void (last = Date.now()), () => undefined, sessionId);
            try {
                await abortServerRun(base, sessionId, ask.folder, "stopped through MCP");
                for (const until = Date.now() + SETTLE_MS; Date.now() < until && Date.now() - last < QUIET_MS;) {
                    await delay(50);
                }
            } finally {
                events.close();
            }
        }
    })()
        .catch((error: unknown) => {
            job.failure = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
            job.finishedAt = Date.now();
            note(`job ${job.id} ${job.failure ? `not run: ${truncate(job.failure, 160)}` : statusOf(job)} after ${secs(job.finishedAt - job.startedAt)}`);
        });
    jobs.set(job.id, job);
    prune();
    return job;
}

function statusOf(job: Job): "running" | "refused" | "cancelled" | "failed" | "done" {
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

interface ToolResult {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}

const textResult = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

// A client with no chips (0.0.243): what chat would offer under this answer, as lines its
// model can act on. A 2.3+ subagent still working hands its result to the parent with the
// next prompt (REFS 0.0.242); an editing step is listed only where opencode_dev is offered.
function nextSteps(job: Job, sessionId: string, answer: string): string[] {
    const out: string[] = [];
    const ask = job.kind === "dev" ? "opencode_dev" : "opencode_ask";
    const waiting = job.metrics?.backgroundTasks?.[0];
    if (waiting) {
        out.push(`The ${waiting.agent} subagent (${truncate(waiting.description || waiting.agent, 80)}) is still working in the background; ` +
            `OpenCode gives this session its result with the next prompt. To collect it, call ${ask} with sessionId "${sessionId}" and ask for that result.`);
    }
    const steps = naturalFollowups({ agent: job.agent, answer, steps: job.steps }, 3)
        .filter((c) => c.command === "plan" || (c.command === "dev" && ARGS.dev))
        .map((c) => `- ${plainLabel(c.label, c.kind)} (${c.command === "dev" ? "opencode_dev" : "opencode_ask"})`);
    if (steps.length) {
        out.push(`Next steps this answer offers; send one as the prompt with sessionId "${sessionId}":\n${steps.join("\n")}`);
    }
    return out;
}
// A cue chip's label starts with its kind's kaomoji (followups.json); a client's model reads the words.
const plainLabel = (label: string, kind: string): string => {
    const kao = Object.hasOwn(NATURAL_KAO, kind) ? NATURAL_KAO[kind] : "";
    return (kao && label.startsWith(`${kao} `) ? label.slice(kao.length + 1) : label).trim();
};

/** What a call returns for a job: the answer, then one line of handles and facts. */
function jobResult(job: Job): ToolResult {
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
        // Last: a path may hold spaces, and this one runs to the end of the line.
        `folder=${job.folder}`
    ];
    const line = `[opencode] ${facts.join(" ")}`;
    const answer = job.text.join("").trim();
    if (status === "running") {
        const last = job.steps.at(-1);
        return textResult(
            `OpenCode is still working${last ? ` (last step: ${last.tool}${last.detail ? ` ${truncate(last.detail, 80)}` : ""})` : ""}. ` +
            `Call opencode_wait with jobId "${job.id}" for the answer, or opencode_cancel to stop it.\n\n${line}`
        );
    }
    if (status === "refused") {
        return textResult(`${job.failure}\n\n${line}`, true);
    }
    const parts: string[] = [];
    if (status === "cancelled") {
        parts.push("Cancelled before OpenCode finished.");
    } else if (status === "failed") {
        parts.push(m?.timedOut ? `OpenCode was stopped after ${secs(m.totalMs)} without finishing.` : `OpenCode reported an error: ${m?.error}`);
    }
    if (answer) {
        parts.push(answer);
    } else if (status === "done") {
        parts.push("OpenCode finished without an answer.");
    }
    if (job.kind === "ask" && m?.readOnlyEnforcement && m.readOnlyEnforcement.kind !== "enforced") {
        parts.push(
            m.readOnlyEnforcement.kind === "disabled"
                ? "Note: `enforceReadOnly` is off, so this agent's own permissions applied to this run."
                : `Note: read-only rules could not be verified for \`${job.agent}\`; its own permissions applied to this run.`
        );
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

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const RUN_PROPERTIES = {
    prompt: { type: "string", description: "The task or question, in full: OpenCode sees none of this conversation." },
    folder: { type: "string", description: "Absolute path of the project folder to work in. Default: the folder this server was configured for or started in." },
    sessionId: { type: "string", description: "A sessionId from an earlier result, to continue that OpenCode conversation." },
    model: { type: "string", description: "Optional `provider/model` for this run. Default: OpenCode's own." }
};

function tools(): unknown[] {
    const enforced = config().get<boolean>("enforceReadOnly", true);
    const list: unknown[] = [
        {
            name: "opencode_ask",
            description:
                "Ask OpenCode, a coding agent running on this machine, to research, review or plan in a project folder. " +
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
            description:
                "Have OpenCode, a coding agent running on this machine, make a change in a project folder: it edits files and runs commands there with its own permissions. " +
                "Returns what it did and a sessionId; pass the sessionId back to continue the same conversation. " +
                "A long run returns status=running with a jobId: call opencode_wait with it.",
            inputSchema: { type: "object", properties: RUN_PROPERTIES, required: ["prompt"], additionalProperties: false },
            annotations: { title: "Have OpenCode make a change", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
        });
    }
    list.push(
        {
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
        },
        {
            name: "opencode_cancel",
            description: "Stop an OpenCode run that is still running.",
            inputSchema: { type: "object", properties: { jobId: { type: "string", description: "The jobId of the run to stop." } }, required: ["jobId"], additionalProperties: false },
            annotations: { title: "Stop OpenCode", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        }
    );
    return list;
}

/** Reads the arguments of a run. Throws what the model is told, so it can correct itself. */
function runArguments(kind: "ask" | "dev", input: Record<string, unknown>): RunAsk {
    const unknown = Object.keys(input).filter((key) => !Object.hasOwn(RUN_PROPERTIES, key));
    if (unknown.length) {
        throw new Error(`Unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Expected: prompt, folder, sessionId, model.`);
    }
    if (typeof input.prompt !== "string" || !input.prompt.trim()) {
        throw new Error("`prompt` is required: the task or question for OpenCode.");
    }
    const folder = callFolder(input.folder);
    let sessionId: string | undefined;
    if (input.sessionId !== undefined && input.sessionId !== "") {
        // A session id reaches a URL: only the shape OpenCode mints (MA).
        if (typeof input.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.sessionId)) {
            throw new Error("`sessionId` must be a sessionId from an earlier result of this server.");
        }
        sessionId = input.sessionId;
    }
    let model: string | undefined;
    if (input.model !== undefined && input.model !== "") {
        if (typeof input.model !== "string" || !/^[\w.-]+\/[\w.:@/-]+$/.test(input.model)) {
            throw new Error("`model` must be `provider/model`, as OpenCode lists it.");
        }
        model = input.model;
    }
    return { kind, prompt: input.prompt, folder, sessionId, model };
}

interface Call {
    /** Fired when the client cancels this request: Stop was pressed. */
    cancelled: Promise<void>;
    progress(step: StepRecord): void;
}

async function waitFor(job: Job, ms: number, call: Call): Promise<ToolResult> {
    job.watchers.add(call.progress);
    let stop = false;
    try {
        await Promise.race([job.done, delay(ms), call.cancelled.then(() => void (stop = true))]);
    } finally {
        job.watchers.delete(call.progress);
    }
    if (stop && !job.finishedAt) {
        note(`job ${job.id} stopped: the client cancelled the call`);
        job.stop();
        await Promise.race([job.done, delay(3000)]);
    }
    return jobResult(job);
}

async function callTool(name: string, input: Record<string, unknown>, call: Call): Promise<ToolResult | undefined> {
    if (name === "opencode_dev" && !ARGS.dev) {
        return undefined;
    }
    switch (name) {
        case "opencode_dev":
        case "opencode_ask": {
            let ask: RunAsk;
            try {
                ask = runArguments(name === "opencode_dev" ? "dev" : "ask", input);
            } catch (error) {
                return textResult(error instanceof Error ? error.message : String(error), true);
            }
            const active = running();
            // A prompt to a busy session queues without a word: say so instead.
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
                    await Promise.race([job.done, delay(3000)]);
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

// ---------------------------------------------------------------------------
// the wire
// ---------------------------------------------------------------------------

type Id = string | number;
interface Frame {
    jsonrpc?: unknown;
    id?: unknown;
    method?: unknown;
    params?: Record<string, unknown>;
}

const INSTRUCTIONS =
    "OpenCode is a coding agent on this machine with its own model, tools and project instructions. " +
    "Give it a self-contained prompt and the absolute project folder. Keep the sessionId a result names and pass it back to continue that conversation.";

const send = (message: unknown): void => void process.stdout.write(JSON.stringify(message) + "\n");
const fail = (id: unknown, code: number, message: string, data?: unknown): void =>
    send({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });

// Requests in flight, by id: `notifications/cancelled` names one.
const open = new Map<Id, () => void>();

async function handle(frame: Frame): Promise<void> {
    const id = frame.id as Id | undefined;
    const method = frame.method as string;
    const params = frame.params ?? {};
    const meta = (params._meta && typeof params._meta === "object" ? params._meta : {}) as Record<string, unknown>;
    if (id === undefined) {
        if (method === "notifications/cancelled") {
            const target = params.requestId as Id | undefined;
            note(`← notifications/cancelled requestId=${JSON.stringify(target ?? null)} ${target !== undefined && open.has(target) ? "in flight" : "not in flight"}`);
            if (target !== undefined) {
                open.get(target)?.();
            }
        } else {
            note(`← ${method}`);
        }
        return;
    }
    // 2026-07-28: every request names its version; before it, `initialize` did once.
    const asked = meta[META_VERSION];
    const modern = asked !== undefined || method === "server/discover";
    const reply = (result: Record<string, unknown>): void =>
        send({ jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...result, _meta: { [META_SERVER]: SERVER_INFO } } : result });
    if (asked !== undefined && asked !== MODERN && method !== "server/discover") {
        note(`← ${method} protocol=${JSON.stringify(asked)}: not supported`);
        fail(id, UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: [MODERN, ...LEGACY], requested: asked });
        return;
    }
    switch (method) {
        case "initialize": {
            const wanted = params.protocolVersion;
            const client = params.clientInfo as { name?: unknown; version?: unknown } | undefined;
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
            const client = meta[META_CLIENT] as { name?: unknown; version?: unknown } | undefined;
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
            const token = meta.progressToken as Id | undefined;
            note(`← tools/call ${name} id=${JSON.stringify(id)}${token === undefined ? "" : " progressToken=yes"}${modern ? ` protocol=${String(asked)}` : ""}`);
            let sent = 0;
            let cancelled = false;
            const call: Call = {
                cancelled: new Promise<void>((resolve) => void open.set(id, () => {
                    cancelled = true;
                    resolve();
                })),
                progress: (step) => {
                    if (token === undefined || step.status === "running") {
                        return;
                    }
                    sent += 1;
                    send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: sent, message: truncate(`${step.tool} ${step.detail}`.trim(), 120) } });
                }
            };
            try {
                const result = await callTool(name, input as Record<string, unknown>, call);
                if (cancelled) {
                    // A cancelled request gets no response: the client stopped listening for it.
                    return;
                }
                if (result) {
                    reply(result as unknown as Record<string, unknown>);
                } else {
                    fail(id, -32602, `Unknown tool: ${truncate(name, 80)}`);
                }
            } finally {
                open.delete(id);
            }
            return;
        }
        default:
            note(`← ${method}: not a method of this server`);
            fail(id, -32601, "Method not found");
    }
}

function frame(line: string): void {
    let parsed: Frame;
    try {
        parsed = JSON.parse(line) as Frame;
    } catch {
        fail(null, -32700, "Parse error");
        return;
    }
    const idOk = parsed?.id === undefined || typeof parsed.id === "string" || typeof parsed.id === "number";
    if (!parsed || Array.isArray(parsed) || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string" || !idOk) {
        // A response to a request this server never sent is not answered.
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
    // Not queued: a wait and a cancel must be read while a run's call is open.
    handle(parsed).catch((error: unknown) => {
        note(`${String(parsed.method)} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (parsed.id !== undefined) {
            fail(parsed.id, -32603, "Internal error");
        }
    });
}

let closing = false;

function shutdown(why: string): void {
    if (closing) {
        return;
    }
    closing = true;
    note(`closing (${why}): ${running().length} run(s) stopped`);
    for (const job of running()) {
        job.stop();
    }
    stopServer();
    // The server's exit is waited for briefly, so its data folder is released.
    setTimeout(() => process.exit(0), 250).unref();
}

/** What this process would run with, without sending a prompt. */
async function selftest(): Promise<void> {
    const settings = config();
    const executable = settings.get<string>("executable", "opencode");
    let version: string;
    try {
        version = (await runCapture(executable, ["--version"], process.cwd(), 15000, true)).trim() || "(printed nothing)";
    } catch (error) {
        version = `not started: ${error instanceof Error ? error.message : String(error)}`;
    }
    let folder: string;
    try {
        folder = callFolder(undefined);
    } catch (error) {
        folder = `none without a \`folder\` argument: ${error instanceof Error ? error.message : String(error)}`;
    }
    process.stdout.write(
        JSON.stringify(
            {
                server: SERVER_INFO,
                node: process.version,
                cwd: process.cwd(),
                settingsFile: ARGS.settings ?? null,
                settingsRead: Object.keys(settingsRead.values).length,
                executable,
                opencode: version,
                opencode2: settings.get<boolean>("opencode2", true),
                enforceReadOnly: settings.get<boolean>("enforceReadOnly", true),
                defaultFolder: folder,
                pinnedFolders: ARGS.folders,
                tools: (tools() as Array<{ name: string }>).map((t) => t.name),
                waitMs: ARGS.waitMs,
                log: ARGS.log ?? null
            },
            null,
            2
        ) + "\n"
    );
}

function main(): void {
    setHost({ settings: fileSettings, folder: () => undefined, trusted: () => false, state: () => undefined });
    setLogChannel({ appendLine: appendLog, show: () => undefined });
    if (ARGS.selftest) {
        void selftest().finally(() => process.exit(0));
        return;
    }
    note(`oc-mcp ${VERSION} started · node ${process.version} · cwd=${process.cwd()} · settings=${ARGS.settings ?? "-"} · folders=${ARGS.folders.join(",") || "-"} · dev=${ARGS.dev} · waitMs=${ARGS.waitMs}`);
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on("line", (line) => {
        if (line.trim()) {
            frame(line);
        }
    });
    input.on("close", () => shutdown("stdin closed"));
    // The extension host logs these and carries on; a plain Node process ends on the
    // first one, taking every run and the client's tools with it.
    process.on("unhandledRejection", (reason) => note(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`));
    process.on("uncaughtException", (error) => note(`uncaught exception: ${error.stack ?? error.message}`));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}

// Loaded as a module (the suite's engine load, EN), it starts nothing and sets no host.
if (require.main === module) {
    main();
}
