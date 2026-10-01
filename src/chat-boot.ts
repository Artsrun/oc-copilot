import * as vscode from "vscode";
import { config, logChannel, secs, stamp, truncate } from "./core";
import { ChatKind, RunMetrics, StepRecord, emptyTokens, finalizeStepStatuses } from "./metrics";
import { flowLine, scrubLeakedContext } from "./format";
import { abortServerRun, createServerSession, runOpenCode } from "./runs";
import { CASES, ChipKey, Outcome, chipOf, createBadger, mark } from "./followups";
import { naturalFollowups } from "./natural";
import { cachedModelInfo } from "./models";
import { FlowNode, FlowTrace, flowAdd, noteFlowChips } from "./flow";

export interface Heartbeat {
    /** A status line of the bridge's own ("handing off…", "retrying via cli"). */
    phase: (text: string) => void;
    /** A tool step from the run, running or done. */
    step: (step: StepRecord) => void;
    /** The latest reasoning sentence (already reduced by thoughtLine). */
    thought: (line: string) => void;
    /** The answer started streaming: the tools before it are done. */
    activity: () => void;
    /** Ends the heartbeat. `cancelled`: the user pressed Stop, and VS Code
     * drops everything sent after that, so nothing is sent. Await it. */
    stop: (cancelled?: boolean) => Promise<void>;
}

// Every progress() call is a new line (no in-place update): elapsed time
// renders only at milestones, so a quiet run moves without a scrolling wall.
export const HEARTBEAT_MILESTONES_S = [3, 10, 30, 60, 120, 180, 300, 600];
// Reasoning is the least urgent news; one thought line per window is plenty.
export const REASONING_EVERY_MS = 5000;

export function nextMilestone(elapsedS: number): number {
    for (const m of HEARTBEAT_MILESTONES_S) {
        if (m > elapsedS) {
            return m;
        }
    }
    const last = HEARTBEAT_MILESTONES_S[HEARTBEAT_MILESTONES_S.length - 1];
    return last + Math.ceil((elapsedS - last + 1) / 300) * 300;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------
//
// A plain line hides once another part follows; a task line spins until it
// settles, and a task open at Stop spins for good (AGENTS §7, REFS "What VS
// Code does after Stop"). So live lines are plain, the accordion
// (groupProgress) is a task already finished when sent, and nothing is sent
// after Stop.

type TaskProgress = (value: string, task?: (reporter: { report: (part: unknown) => void }) => Thenable<string | void>) => void;

// Detected by ARITY, so nothing is emitted to find out: the host's method is
// `progress(value, task?)` (length 2); a one-argument stream gets lines only.
export const supportsTaskProgress = (response: vscode.ChatResponseStream): boolean =>
    typeof response.progress === "function" && response.progress.length >= 2;

// One accordion row. `{ variableName }` with no value renders as a plain text
// label in the collapsible list (chatReferencesContentPart.ts).
const stepRow = (label: string): unknown => {
    const Ref = (vscode as unknown as { ChatResponseReferencePart?: new (v: unknown) => unknown }).ChatResponseReferencePart;
    return Ref ? new Ref({ variableName: label }) : { value: { variableName: label } };
};

/** A collapsed accordion that is already done: header, rows and result leave
 * together, so there is no open spinner for Stop to strand. */
export function finishedTask(response: vscode.ChatResponseStream, title: string, rows: readonly string[]): void {
    (response.progress as unknown as TaskProgress).call(response, title, (reporter) => {
        for (const row of rows) {
            reporter.report(stepRow(row));
        }
        return Promise.resolve(title);
    });
}

const STEP_RUNNING = / \(running\)$/;

// A path inside the workspace is shown relative to it ("read: src/cart.js");
// any other long path keeps its END, not "read: /home/me/projects/…". The
// drive letter's case differs between VS Code (c:) and OpenCode (C:).
const shortDetail = (detail: string, cwd?: string): string => {
    const root = cwd?.replace(/[\\/]+$/, "");
    if (root && detail.length > root.length + 1 && /[\\/]/.test(detail[root.length]) && detail.slice(0, root.length).toLowerCase() === root.toLowerCase()) {
        detail = detail.slice(root.length + 1);
    }
    return detail.length > 60 && /^\S*[\\/]\S*$/.test(detail) ? `…${detail.slice(-59)}` : truncate(detail, 60);
};

/** `bash: git status…` — or "" for a bare "running" ping that names nothing yet. */
export const stepLabel = (step: StepRecord, cwd?: string): string => {
    const detail = (step.detail ?? "").replace(STEP_RUNNING, "");
    return !detail || detail === "running" ? "" : `${step.tool}: ${shortDetail(detail, cwd)}`;
};

/** Each tool step of a run as /flow nodes, merged when the same tool repeats. */
export function traceSteps(nodes: FlowNode[], steps: readonly StepRecord[], cwd?: string): void {
    for (const step of steps) {
        const label = stepLabel(step, cwd);
        flowAdd(nodes, "step", step.tool, label.slice(step.tool.length + 2), step.status === "timeout" ? "fail" : undefined);
    }
}

// A group that never sees a thought would grow for the whole run; past this
// many rows it closes and the next step opens a fresh one.
export const GROUP_MAX_ROWS = 24;
// A group's rows reach the host only after its header is acknowledged, and
// chunks after the request ends are dropped: stop() waits this out since the
// last group sent (by anyone).
export const SETTLE_MS = 120;

interface Group {
    title: string;
    rows: string[];
    /** Rows whose tool has not reported done yet. */
    open: Set<string>;
    openedAt: number;
}

export function startHeartbeat(response: vscode.ChatResponseStream, initial: string, timeoutMs: number, cwd?: string): Heartbeat {
    const everyMs = config().get<number>("progressHeartbeatMs", 1000);
    const accordion = config().get<boolean>("groupProgress", true) && supportsTaskProgress(response);
    const started = Date.now();
    let phase = initial;
    // A tool the run reports as running names the line until it is done, so a
    // thought that lands mid-tool cannot make a 40s `npm test` look idle.
    const running = new Set<string>();
    let stopped = false;
    let lastText = "";
    let lastReasoningAt = 0;
    let dueS = HEARTBEAT_MILESTONES_S[0];

    const label = (): string => {
        const now = [...running].pop() ?? phase;
        const elapsed = Math.round((Date.now() - started) / 1000);
        return timeoutMs > 0 ? `${now} · ${elapsed}s / ${Math.round(timeoutMs / 1000)}s` : `${now} · ${elapsed}s`;
    };
    const emit = (): void => {
        const text = label();
        if (stopped || text === lastText) {
            return;
        }
        lastText = text;
        response.progress(text);
        // Any line on screen resets the milestone clock: news already proves
        // the run is alive, so the ticker only speaks into silence.
        dueS = nextMilestone((Date.now() - started) / 1000);
    };
    let timer: NodeJS.Timeout | undefined;
    if (everyMs > 0) {
        timer = setInterval(() => {
            if ((Date.now() - started) / 1000 >= dueS) {
                emit();
            }
        }, Math.max(250, everyMs));
        timer.unref?.();
    }
    emit();
    const setPhase = (text: string, thought = false): void => {
        if (text === phase) {
            return;
        }
        phase = text;
        if (thought) {
            const now = Date.now();
            if (now - lastReasoningAt < REASONING_EVERY_MS) {
                return;
            }
            lastReasoningAt = now;
        }
        emit();
    };

    // The accordion: a thought and the tools that ran under it. The attached
    // CLI prints a reasoning part when it COMPLETES, which is often after its
    // tool started, so a thought arriving while the group's tools still run
    // names that group instead of closing it.
    let group: Group | undefined;
    let pendingThought = "";
    const seen = new Set<string>();
    let lastSentAt = 0;
    const closeGroup = (): boolean => {
        const g = group;
        group = undefined;
        if (!accordion || !g || !g.rows.length) {
            return false;
        }
        const n = g.rows.length;
        finishedTask(response, `${g.title} · ${n} step${n === 1 ? "" : "s"} · ${secs(Date.now() - g.openedAt)}`, g.rows);
        lastSentAt = Date.now();
        return true;
    };
    const currentGroup = (): Group => {
        // A thought queued while the group's tools were still running starts
        // the next group once they are all done.
        if (!group || group.rows.length >= GROUP_MAX_ROWS || (pendingThought && !group.open.size)) {
            closeGroup();
            group = {
                title: pendingThought ? `${mark("thought")} ${pendingThought}` : `${mark("tool")} Working`,
                rows: [],
                open: new Set(),
                openedAt: Date.now()
            };
            pendingThought = "";
        }
        return group;
    };
    const addRow = (step: StepRecord): void => {
        const row = stepLabel(step, cwd);
        if (!accordion || !row) {
            return;
        }
        if (step.status === "running") {
            // The running report and the done report of one call are one row.
            if (seen.has(row)) {
                return;
            }
            seen.add(row);
            const g = currentGroup();
            g.rows.push(row);
            g.open.add(row);
            return;
        }
        if (seen.delete(row)) {
            group?.open.delete(row);
            return;
        }
        currentGroup().rows.push(row);
    };

    return {
        phase: (text: string) => {
            if (stopped) {
                return;
            }
            closeGroup();
            setPhase(text);
        },
        step: (step: StepRecord) => {
            if (stopped) {
                return;
            }
            addRow(step);
            const text = stepLabel(step, cwd) || `${step.tool}: running`;
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
            // Done: drop its running entry — by label, else the oldest of the
            // same tool, so a ticker can never keep naming a finished call.
            if (!running.delete(text)) {
                const same = [...running].find((k) => k.startsWith(`${step.tool}: `));
                if (same) {
                    running.delete(same);
                }
            }
            setPhase(text);
        },
        thought: (line: string) => {
            if (stopped || !line) {
                return;
            }
            if (group && group.open.size) {
                if (group.title === `${mark("tool")} Working`) {
                    group.title = `${mark("thought")} ${line}`;
                } else {
                    pendingThought = line;
                }
            } else {
                closeGroup();
                pendingThought = line;
            }
            setPhase(`${mark("thought")} ${line}`, true);
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
            // Any accordion sent in the last SETTLE_MS still has rows in
            // flight — the answer's first text may have closed one just now.
            const wait = cancelled || !lastSentAt ? 0 : SETTLE_MS - (Date.now() - lastSentAt);
            if (wait > 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, wait));
            }
        }
    };
}

// ---------------------------------------------------------------------------
// The chat stream every handler writes to
// ---------------------------------------------------------------------------
//
// After Stop the host drops every chunk and, 1s later, closes the stream (each
// call then throws). So nothing is sent once cancelled, a write racing the
// close is swallowed, methods run on the host's own object (`this.push`), and
// marks in markdown become pills.
const STREAM_METHODS = ["markdown", "progress", "button", "reference", "anchor", "filetree", "push", "warning"] as const;

export function chatStream(response: vscode.ChatResponseStream, token: vscode.CancellationToken): vscode.ChatResponseStream {
    const pill = config().get<boolean>("kaomojiBadges", true) ? createBadger() : undefined;
    const host = response as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;
    // Inherit, then shadow: the host's stream is a frozen object literal today
    // and may be a class instance tomorrow; both keep every other member.
    const wrapped = Object.create(response) as Record<string, unknown>;
    let warned = false;
    const call = (name: string, args: unknown[]): unknown => {
        const fn = host[name];
        if (token.isCancellationRequested || typeof fn !== "function") {
            return wrapped;
        }
        try {
            fn.apply(response, args);
        } catch (error) {
            if (!warned) {
                warned = true;
                logChannel.appendLine(`[${stamp()}] chat stream refused ${name}(): ${error}`);
            }
        }
        return wrapped;
    };
    for (const name of STREAM_METHODS) {
        if (typeof host[name] !== "function") {
            continue;
        }
        const value =
            name === "markdown"
                ? (text: unknown) => call(name, [pill && typeof text === "string" ? pill(text) : text])
                : name === "progress" && (host.progress as (...a: unknown[]) => unknown).length >= 2
                    // Keep the arity: supportsTaskProgress reads it.
                    ? (text: unknown, task?: unknown) => call(name, task === undefined ? [text] : [text, task])
                    : (...args: unknown[]) => call(name, args);
        Object.defineProperty(wrapped, name, { enumerable: true, value });
    }
    return wrapped as unknown as vscode.ChatResponseStream;
}

// The live thought line: the latest substantive sentence of the reasoning, not
// its first (usually a restatement of the prompt).
const RESTATEMENT = /^(the user|user|they|i('| a)m being asked|the request|the task|okay|ok|alright|so,?|let me (re)?read)\b/i;

export function thoughtLine(reasoning: string, max = 90): string {
    const plain = reasoning
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/[`*_#>]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
    if (!plain) {
        return "";
    }
    // Split on terminal punctuation followed by space, so `hooks.json` and
    // `v1.2` stay inside their sentence.
    const split = plain.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 12);
    const sentences = split.length ? split : [plain];
    const pick =
        [...sentences].reverse().find((x) => !RESTATEMENT.test(x)) ?? sentences[sentences.length - 1] ?? plain;
    return truncate(pick, max);
}

// One source of truth for the control commands: the manifest's
// `chatParticipants[].commands`, the runtime set, and the typed-`/word`
// regex all derive from this, so they cannot drift (the LB group guards it).
export const SLASH_COMMANDS = ["new", "session", "sessions", "help", "model", "ping", "env", "stop", "flow"] as const;
const CONTROL_COMMANDS = new Set<string>(SLASH_COMMANDS);
const KIND_COMMANDS: Record<string, ChatKind> = {
    plan: "plan",
    dev: "dev",
    parallel: "parallel"
};

export function controlCommand(declared: string, typed: string): string {
    return CONTROL_COMMANDS.has(declared) ? declared : typed;
}

export function typedSlash(prompt: string): string {
    return (
        prompt.match(new RegExp(`^/(${SLASH_COMMANDS.join("|")})\\b\\s*`, "i"))?.[1]?.toLowerCase() ?? ""
    );
}

// ---------------------------------------------------------------------------
// claim:command-aliases — `/d fix it` is `/dev fix it`. Typed only, never in the
// manifest. A real command always wins; an alias to a non-command is refused.
export const DEFAULT_ALIASES: Readonly<Record<string, string>> = {
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

export const allCommands = (): string[] => [...SLASH_COMMANDS, ...KIND_COMMAND_NAMES, ...ROUTED_COMMANDS];

const bare = (word: string): string => word.trim().replace(/^\//, "").toLowerCase();

/** The defaults with the user's `commandAliases` on top (keys and targets without the `/`). */
export function commandAliases(user: unknown = config().get<unknown>("commandAliases", {})): Record<string, string> {
    const table: Record<string, string> = { ...DEFAULT_ALIASES };
    if (user && typeof user === "object") {
        for (const [k, v] of Object.entries(user as Record<string, unknown>)) {
            if (typeof v === "string" && bare(k) && bare(v)) {
                table[bare(k)] = bare(v);
            }
        }
    }
    return table;
}

export function resolveAlias(
    prompt: string,
    table: Record<string, string> = commandAliases()
): { prompt: string; alias?: string; problem?: string } {
    const m = prompt.match(/^\/(\S+)(?=\s|$)/);
    if (!m) {
        return { prompt };
    }
    const word = m[1].toLowerCase();
    const commands = allCommands();
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
            problem:
                `\`/${word}\` is set to \`/${target}\` in \`commandAliases\`, and that is not a command. ` +
                `Commands: ${commands.map((c) => `\`/${c}\``).join(" ")}.`
        };
    }
    return { prompt: `/${target}${prompt.slice(m[0].length)}`, alias: word };
}

export function kindChoice(declared: string, parsedKind: ChatKind): ChatKind {
    return KIND_COMMANDS[declared] ?? parsedKind;
}

export const KIND_COMMAND_NAMES = Object.keys(KIND_COMMANDS);
// Participant commands routed to their own handler before kind/control parsing.
export const ROUTED_COMMANDS = ["worktree"] as const;

export function isKindCommand(declared: string): boolean {
    return Boolean(KIND_COMMANDS[declared]);
}

export function helpMarkdown(): string {
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

// ---------------------------------------------------------------------------
// parallel lanes
// ---------------------------------------------------------------------------
//
// N independent sessions at once: OpenCode's own subagents run one at a time
// (sst/opencode #14195). Lanes are read-only (`planAgent`); concurrent writers
// in one checkout overwrite each other, so write lanes need parallelAllowWrite.

/** One lane: its task, the model it runs on, or why it cannot run. */
export interface LaneSpec {
    task: string;
    model?: string;
    error?: string;
    /** The model as typed, for /flow when it did not resolve. */
    ref?: string;
}

interface LaneResult {
    lane: string;
    answer: string;
    metrics: RunMetrics;
}

// Lanes split on `|`, `;;` or a `---` line; `||` (a shell OR) is text. Inside
// backticks or a table row they are text too: with no lane cap, a stray split
// is a paid run. An unclosed backtick guards to the end. Line endings are
// normalised first: in 0.0.188 a `---` line never matched a CRLF prompt (a
// Windows paste; reproduced: 4 lanes with LF, 1 with CRLF).
const LANE_MASK: Record<string, string> = { "|": "\u0001", ";": "\u0002", "-": "\u0003" };
const LANE_UNMASK: Record<string, string> = { "\u0001": "|", "\u0002": ";", "\u0003": "-" };
const maskLane = (s: string) => s.replace(/[|;-]/g, (c) => LANE_MASK[c]);

export function splitLanes(task: string): string[] {
    return task
        .replace(/\r\n?/g, "\n")
        .replace(/(`+)(?:[\s\S]*?\1|[\s\S]*$)/g, maskLane)
        .replace(/^[ \t]*\|.*$/gm, maskLane)
        .replace(/\|{2,}/g, maskLane)
        .split(/\s*(?:\||;;|\n[ \t]*-{2,}[ \t]*\n)\s*/)
        .map((part) => part.replace(/[\u0001-\u0003]/g, (c) => LANE_UNMASK[c]).trim())
        .filter(Boolean);
}

export async function runParallelLanes(opts: {
    response: vscode.ChatResponseStream;
    token: vscode.CancellationToken;
    cwd: string;
    executable: string;
    timeoutMs: number;
    model?: string;
    pure: boolean;
    lanes: LaneSpec[];
    write: boolean;
    devAgent?: string;
    /** `planAgent` as OpenCode confirmed it (see ./agents). */
    planAgent?: string;
    attachUrl?: string;
    /** Lanes and their steps, for /flow. */
    trace?: FlowTrace;
}): Promise<void> {
    const specs = opts.lanes;
    const lanes = specs.map((s) => s.task);
    const laneAgent = opts.write ? opts.devAgent ?? "build" : opts.planAgent ?? "plan";
    const names = cachedModelInfo();
    const modelName = (id: string): string => names[id]?.name ?? id;
    // One task on several models (`models:`): lanes are told apart by model.
    const sameTask = specs.length > 1 && specs.every((s) => s.task === specs[0].task);

    opts.response.markdown(
        `Running **${lanes.length} lanes** in parallel` +
        (opts.write
            ? " with the editing agent"
            : laneAgent === "plan"
                ? " with the read-only plan agent"
                : ` with the read-only \`${laneAgent}\` agent`) +
        (sameTask ? ` on ${specs.length} models` : "") +
        (opts.timeoutMs > 0 ? `, ${Math.round(opts.timeoutMs / 1000)}s cap each.` : ", no wall-clock cap.") +
        "\n"
    );

    const done: boolean[] = specs.map((s) => Boolean(s.error));
    const tickLabel = (i: number): string =>
        sameTask && specs[i].model ? truncate(modelName(specs[i].model as string).split(/[\s(]/)[0], 22) : truncate(lanes[i], 22);
    const tick = (): void => {
        opts.response.progress(
            specs.map((s, i) => `${s.error ? mark("warn") : done[i] ? mark("ok") : "•"} ${tickLabel(i)}`).join("   ")
        );
    };
    tick();

    // Sessions up front, so Stop can abort an attached lane on the server.
    const attachUrl = opts.attachUrl;
    const laneSessions: (string | undefined)[] = attachUrl
        ? await Promise.all(specs.map((s) => (s.error ? undefined : createServerSession(attachUrl, opts.cwd, s.task).catch(() => undefined))))
        : specs.map(() => undefined);

    const results = await Promise.all(
        lanes.map(async (lane, i): Promise<LaneResult> => {
            let answer = "";
            const laneStarted = Date.now();
            // A lane that threw reports what it spent, not the cap.
            const blank: RunMetrics = {
                firstByteMs: undefined,
                totalMs: 0,
                timedOut: false,
                steps: [],
                tokens: emptyTokens(),
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
                const metrics = await runOpenCode({
                    executable: opts.executable,
                    task: lane,
                    cwd: opts.cwd,
                    // A fresh session per lane: no shared context.
                    agent: laneAgent,
                    // N lanes attached to one warm server: no N cold boots.
                    attachUrl,
                    sessionId: laneSessions[i],
                    model: specs[i].model ?? opts.model,
                    pure: opts.pure,
                    // `--auto` for write lanes and the built-in plan only.
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
                    // Not awaited: after Stop the host allows the handler one second.
                    void abortServerRun(attachUrl, laneSession, opts.cwd, opts.token.isCancellationRequested ? "lane cancelled" : "lane timed out");
                }
                return { lane, answer, metrics };
            } catch (error) {
                done[i] = true;
                tick();
                logChannel.appendLine(`[${stamp()}] lane "${truncate(lane, 60)}" failed: ${error}`);
                blank.totalMs = Date.now() - laneStarted;
                blank.error = error instanceof Error ? error.message : String(error);
                return { lane, answer, metrics: blank };
            }
        })
    );

    for (const [i, result] of results.entries()) {
        finalizeStepStatuses(result.metrics);
        const body = scrubLeakedContext(result.answer.trim()) || "_(no output)_";
        const flow = flowLine(result.metrics);
        // A failed lane shows its error; "partial" is for a real timeout only.
        const fail = result.metrics.error
            ? ` · ${mark("warn")} ${truncate(String(result.metrics.error), 120)}`
            : "";
        const laneModel = specs[i].model ?? opts.model;
        const title = sameTask && laneModel ? modelName(laneModel) : truncate(result.lane, 80) + (laneModel ? ` · ${modelName(laneModel)}` : "");
        opts.response.markdown(
            `\n\n### ${i + 1}. ${title}\n\n${specs[i].error ? "_(not run)_" : body}\n\n` +
            `> ${flow ? flow + " · " : ""}${secs(result.metrics.totalMs)}` +
            (result.metrics.cost > 0 ? ` · $${result.metrics.cost.toFixed(4)}` : "") +
            (result.metrics.timedOut ? " · " + mark("quiet") + " partial" : fail)
        );
    }

    const ok = results.filter((r) => !r.metrics.timedOut && r.answer.trim()).length;
    if (opts.trace) {
        for (const [i, r] of results.entries()) {
            const nodes: FlowNode[] = [];
            const m = r.metrics;
            const laneModel = specs[i].model ?? opts.model;
            flowAdd(nodes, "info", "model", specs[i].ref ?? (laneModel ? modelName(laneModel) : "OpenCode default"), specs[i].error ? "fail" : undefined);
            traceSteps(nodes, m.steps, opts.cwd);
            const cost = m.cost > 0 ? ` · $${m.cost.toFixed(4)}` : "";
            flowAdd(
                nodes,
                "info",
                specs[i].error ? "not run" : m.timedOut ? `timed out after ${secs(m.totalMs)}` : m.error ? `error: ${m.error}` : `answered in ${secs(m.totalMs)}${cost}`,
                "",
                specs[i].error || m.error || m.timedOut ? "fail" : undefined
            );
            opts.trace.lanes.push({ title: truncate(sameTask && laneModel ? modelName(laneModel) : r.lane, 40), nodes });
        }
    }
    const totalMs = Math.max(...results.map((r) => r.metrics.totalMs), 0);
    const serialMs = results.reduce((n, r) => n + r.metrics.totalMs, 0);
    const cost = results.reduce((n, r) => n + r.metrics.cost, 0);
    opts.response.markdown(
        `\n\n---\n\n**${ok}/${results.length} lanes returned.** ` +
        `Wall clock ${secs(totalMs)} vs ${secs(serialMs)} sequential` +
        (cost > 0 ? ` · $${cost.toFixed(4)}` : "") +
        ".\n\nLanes ran in isolated sessions, so nothing above is in your ongoing " +
        "conversation. Paste the parts you want to keep into a normal `@opencode` turn."
    );
    if (opts.trace) {
        opts.trace.end = { kind: "end", key: `${ok}/${results.length} lanes returned in ${secs(totalMs)}${cost > 0 ? ` · $${cost.toFixed(4)}` : ""}`, parts: [], count: 1, status: ok < results.length ? "warn" : undefined };
    }
}

// ---------------------------------------------------------------------------
// smart follow-ups
// ---------------------------------------------------------------------------
//
// Chips read from the finished answer (./natural), kept in memory, not in
// metadata: a chip only matters right after its turn.

export interface Followup {
    label: string;
    prompt: string;
    /** Set on every chip: Copilot keeps the last command sticky, so the kind
     * lives here and the prompt is only the sentence. */
    command: "dev" | "plan";
}

export function suggestFollowups(input: { agent: string; answer: string; steps: StepRecord[] }): Followup[] {
    return naturalFollowups(input);
}

const followupStore = new Map<string, Followup[]>();
const FOLLOWUP_STORE_CAP = 64;

export function rememberFollowups(sessionId: string, turns: number, chips: Followup[]): void {
    const key = `${sessionId}#${turns}`;
    followupStore.delete(key);
    followupStore.set(key, chips);
    while (followupStore.size > FOLLOWUP_STORE_CAP) {
        followupStore.delete(followupStore.keys().next().value as string);
    }
}

export function recalledFollowups(sessionId: string | undefined, turns: number): Followup[] {
    return sessionId ? followupStore.get(`${sessionId}#${turns}`) ?? [] : [];
}


// ---------------------------------------------------------------------------
// Follow-up chips, a pure function of the turn's metadata: the one channel for
// "the next message". Words and cases live in ./followups.json. At most three:
// a fourth wraps in the ~320px Chat view.

// A replayed prompt carries its kind in front; a chip keeps it in `command`.
const stripKind = (text: string): string => text.replace(/^\/(?:dev|plan)\b\s*/i, "");

// A failure that looks like the bridge could not reach OpenCode at all gets
// Ping (check the connection) instead of Continue.
const UNREACHABLE = /ENOENT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|not found on PATH|could not be started|unreachable|socket hang up|fetch failed/i;

export function outcomeOf(metadata: Record<string, unknown>): Outcome {
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
            // Lanes ran in isolated sessions that are already closed; a turn
            // that ran none offers the composer.
            return metadata.lanesMissing ? "lanesMissing" : "parallel";
        case "composed":
            return "composed";
    }
    const turns = typeof metadata.turns === "number" ? metadata.turns : 0;
    const error = typeof metadata.error === "string" ? metadata.error : "";
    switch (true) {
        case Boolean(error) && UNREACHABLE.test(error):
            return "failedNet";
        // A continuing session that timed out is usually carrying a huge tool
        // output; a fresh session is the fix.
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

export function followupsFor(metadata: Record<string, unknown>): vscode.ChatFollowup[] {
    const chips = chipsFor(metadata);
    noteFlowChips(metadata.flow, chips.map((c) => c.label ?? c.prompt));
    return chips;
}

function chipsFor(metadata: Record<string, unknown>): vscode.ChatFollowup[] {
    const outcome = outcomeOf(metadata);
    const kind: "dev" | "plan" = metadata.agent === "dev" || metadata.kind === "dev" ? "dev" : "plan";
    const own = typeof metadata.prompt === "string" ? metadata.prompt : undefined;
    const chips = (keys: readonly ChipKey[], text: Partial<Record<ChipKey, string>> = {}): vscode.ChatFollowup[] =>
        keys.flatMap((k) => {
            const chip = chipOf(k, kind, text[k]);
            if (!chip) {
                logChannel.appendLine(`[${stamp()}] follow-up chip ${k} left out: it has no text to send`);
            }
            return chip ? [chip] : [];
        });

    switch (outcome) {
        case "clarify":
            // The only honest follow-up to "I did not act on this" is the
            // original text, unchanged, under the kind the user was in.
            return own === undefined ? [] : chips(CASES.clarify, { RUN_ANYWAY: own });
        case "failed":
        case "failedLong":
        case "failedNet": {
            // A launch failure carries the user's words, and there may be no
            // session to "try again" in — so Retry resends them.
            const again = own ? stripKind(own) : "";
            return chips(CASES[outcome], again ? { RETRY: again } : {});
        }
        case "composed":
            // The composed lanes are the next message: a chip, not a button.
            return typeof metadata.lanes === "string" && metadata.lanes ? chips(CASES.composed, { RUN_LANES: metadata.lanes }) : [];
        case "done": {
            // Only what this answer points at (./natural), else nothing.
            const sessionId = typeof metadata.sessionId === "string" ? metadata.sessionId : undefined;
            const turns = typeof metadata.turns === "number" ? metadata.turns : 0;
            const seen = new Set<string>();
            return recalledFollowups(sessionId, turns)
                .filter((f) => !seen.has(`${f.command}|${f.prompt}`) && Boolean(seen.add(`${f.command}|${f.prompt}`)))
                .slice(0, 3);
        }
        default:
            return chips(CASES[outcome]);
    }
}
