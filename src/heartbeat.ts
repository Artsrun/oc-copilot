// The live turn in chat: the heartbeat (plain live lines, milestone ticker,
// finished accordions with `groupProgress`), `chatStream` (nothing after Stop,
// never throws, one pill badger per turn) and the live thought line.
import * as vscode from "vscode";
import * as path from "node:path";
import { config, logChannel, secs, stamp, truncate } from "./core";
import { StepRecord, SubagentStep } from "./metrics";
import { createBadger, mark } from "./followups";

export interface Heartbeat {
    /** A status line of the bridge's own ("handing off…", "retrying via cli").
     * `quiet`: becomes the line's text for the next milestone, sends nothing now. */
    phase: (text: string, quiet?: boolean) => void;
    /** A tool step from the run, running or done. */
    step: (step: StepRecord) => void;
    /** The latest reasoning sentence (already reduced by thoughtLine). */
    thought: (line: string) => void;
    /** The answer started streaming: the tools before it are done. */
    activity: () => void;
    /** A subagent's tool call: a row under its parent's `task` row in the
     * accordion, and while it runs the live line (`explore › read src/x.ts`),
     * paced like thoughts — every progress() call is a new line. */
    subagent: (sub: SubagentStep) => void;
    /** Ends the heartbeat. `cancelled`: the user pressed Stop, and VS Code
     * drops everything sent after that, so nothing is sent. Await it. */
    stop: (cancelled?: boolean) => Promise<void>;
}

// Every progress() call is a new line (no in-place update): elapsed time
// renders only at milestones, so a quiet run moves without a scrolling wall.
export const HEARTBEAT_MILESTONES_S = [3, 10, 30, 60, 120, 180, 300, 600];
// Reasoning is the least urgent news; one thought line per window is plenty.
export const REASONING_EVERY_MS = 5000;
// A subagent's tools change fast; one line every two seconds at most.
export const SUBAGENT_EVERY_MS = 2000;

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
// label; with a file as `value` it renders `cart.js  #read` and opens the file
// on click (chatReferencesContentPart.ts, measured in VS Code 1.139).
export interface RowFile {
    uri: vscode.Uri;
    tool: string;
}
const stepRow = (label: string, file?: RowFile): unknown => {
    const Ref = (vscode as unknown as { ChatResponseReferencePart?: new (v: unknown) => unknown }).ChatResponseReferencePart;
    const value = file ? { variableName: file.tool, value: file.uri } : { variableName: label };
    return Ref ? new Ref(value) : { value };
};

// The tools whose path is one file: their rows open it.
const FILE_TOOLS = /^(?:read|edit|write|patch|multiedit|apply_patch)$/i;

/** A collapsed accordion that is already done: header, rows and result leave
 * together, so there is no open spinner for Stop to strand. */
export function finishedTask(
    response: vscode.ChatResponseStream,
    title: string,
    rows: readonly string[],
    files?: ReadonlyMap<string, RowFile>
): void {
    (response.progress as unknown as TaskProgress).call(response, title, (reporter) => {
        for (const row of rows) {
            reporter.report(stepRow(row, files?.get(row)));
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

// A group that never sees a thought would grow for the whole run; past this
// many rows it closes and the next step opens a fresh one.
export const GROUP_MAX_ROWS = 24;
// A subagent's calls nest under its `task` row, this many at most: the last
// row then counts the rest. They do not count towards GROUP_MAX_ROWS.
export const CHILD_MAX_ROWS = 8;
// A group's rows reach the host only after its header is acknowledged, and
// chunks after the request ends are dropped: stop() waits this out since the
// last group sent (by anyone).
export const SETTLE_MS = 120;

interface Group {
    title: string;
    rows: string[];
    /** Rows whose tool has not reported done yet. */
    open: Set<string>;
    /** Rows that name one file, by row label. */
    files: Map<string, RowFile>;
    /** A subagent's calls, by the parent `task` row they ran under. */
    children: Map<string, { agent: string; rows: Set<string> }>;
    openedAt: number;
}

// The rows under one `task` row: `explore › read: src/auth.ts`, plain labels
// (no file pill: a pill renders its tool, not the `explore ›` that says whose).
const childRows = (kids: { agent: string; rows: Set<string> } | undefined): string[] => {
    const rows = [...(kids?.rows ?? [])];
    return rows.length > CHILD_MAX_ROWS
        ? [...rows.slice(0, CHILD_MAX_ROWS - 1), `${kids?.agent} › ${rows.length - CHILD_MAX_ROWS + 1} more`]
        : rows;
};

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
    let sub = "";
    let lastSubAt = 0;
    let dueS = HEARTBEAT_MILESTONES_S[0];

    const label = (): string => {
        // A subagent's tool is the newer news than the parent's `task` row it runs under.
        const now = sub || ([...running].pop() ?? phase);
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
        const rows = g.rows.flatMap((row) => [row, ...childRows(g.children.get(row))]);
        finishedTask(response, `${g.title} · ${n} step${n === 1 ? "" : "s"} · ${secs(Date.now() - g.openedAt)}`, rows, g.files);
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
                files: new Map(),
                children: new Map(),
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
        const file = step.filePath && FILE_TOOLS.test(step.tool) ? path.resolve(cwd ?? "", step.filePath) : "";
        const remember = (g: Group): void => {
            if (file && !g.files.has(row)) {
                g.files.set(row, { uri: vscode.Uri.file(file), tool: step.tool.toLowerCase() });
            }
        };
        if (step.status === "running") {
            // The running report and the done report of one call are one row.
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
        phase: (text: string, quiet = false) => {
            if (stopped) {
                return;
            }
            if (quiet) {
                phase = text;
                return;
            }
            sub = "";
            closeGroup();
            setPhase(text);
        },
        step: (step: StepRecord) => {
            if (stopped) {
                return;
            }
            sub = "";
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
        subagent: ({ agent, task, step }: SubagentStep) => {
            if (stopped) {
                return;
            }
            // Under its parent's row while that row's group is still open; a
            // group already sent keeps its rows, and an unnamed child has none.
            const row = stepLabel(step, cwd);
            const parent = task ? stepLabel({ tool: "task", detail: task, durationMs: undefined }, cwd) : "";
            if (accordion && row && parent && group?.rows.includes(parent)) {
                const kids = group.children.get(parent) ?? { agent, rows: new Set<string>() };
                kids.rows.add(`${agent} › ${row}`);
                group.children.set(parent, kids);
            }
            if (step.status !== "running") {
                // The child's call is done: the ticker names the parent again,
                // not a tool that already ended (no line for a quiet finish —
                // the next milestone or parent step prints the cleared label).
                sub = "";
                return;
            }
            const detail = truncate(step.detail, 60);
            sub = `${agent} › ${step.tool}${detail ? ` ${detail}` : ""}`;
            const now = Date.now();
            // Paced: every progress() call is a new line.
            if (now - lastSubAt >= SUBAGENT_EVERY_MS) {
                lastSubAt = now;
                emit();
            }
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

