// Every user-facing word the bridge suggests, in one editable JSON file:
// the `tail` every sent prompt ends with ("Be short."), the
// recovery chips (short, kaomoji-led so the row scans at a glance), which of
// them each turn outcome gets, the templates for answer-derived chips
// (./natural), and the kaomoji marks that replaced every emoji. A leaf module
// like core.ts: it imports nothing local but ./followups.json.
//
// Marks that reach response.markdown must stay markdown-inert (no _ * ` \ [ ]
// | < > # ~); check KM pins that for every entry.

import * as data from "./followups.json";

export type PromptKey = keyof typeof data.prompts;
export type ChipKey = keyof typeof data.chips;
export type MarkKey = keyof typeof data.marks;
export type Outcome = keyof typeof data.cases;
export type NaturalKey = Exclude<keyof typeof data.natural, "maxLabel">;
/** The commands a chip may name besides "@kind" — one table for the type and the check. */
export const CHIP_COMMANDS = ["dev", "plan", "new", "ping", "parallel", "compact", "model"] as const;
export type ChipCommand = (typeof CHIP_COMMANDS)[number];

/** The one phrase every sent prompt ends with. */
export const TAIL: string = data.tail;

const fill = (template: string, vars: Record<string, string> = {}): string =>
    template.replace(/\{(\w+)\}/g, (all, key: string) => (key === "tail" ? TAIL : vars[key] ?? all)).trim();

export const PROMPTS: Readonly<Record<PromptKey, string>> = Object.fromEntries(
    Object.entries(data.prompts).map(([k, v]) => [k, fill(v)])
) as Record<PromptKey, string>;
export const MARKS: Readonly<Record<MarkKey, string>> = data.marks;
export const CASES = data.cases as Readonly<Record<Outcome, readonly ChipKey[]>>;
export const NATURAL_MAX_LABEL: number = data.natural.maxLabel;

export const mark = (key: MarkKey): string => MARKS[key];
export const prompt = (key: PromptKey): string => PROMPTS[key];

/** A prompt template with its own placeholders filled (`{run}`), tail included. */
export const fillPrompt = (key: PromptKey, vars: Record<string, string>): string => fill(data.prompts[key], vars);

// The Merge and Compare lanes chips send the run id inside their sentence,
// because a chip carries only a prompt and a command — no metadata travels
// with it. The matchers are built from the same templates, so the words stay
// in the JSON.
export const LANE_RUN_PROMPTS = ["MERGE_LANES", "COMPARE_LANES"] as const;
const LANE_RUNS = LANE_RUN_PROMPTS.map(
    (key) => new RegExp(`^\\s*${PROMPTS[key].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{run\\}", "([A-Za-z0-9]{4,32})")}`)
);

/** The lane-run id a merge or compare prompt names, or undefined. */
export const mergeRunId = (text: string): string | undefined => LANE_RUNS.map((re) => text.match(re)?.[1]).find(Boolean);

/** `ᕦ(ò‸ó)ᕤ Retry` — recovery chips lead with a kaomoji. */
export const chipLabel = (key: ChipKey): string => {
    const def = data.chips[key];
    return `${def.kao} ${def.label}`;
};

/**
 * A recovery chip as VS Code wants it. `"@kind"` means the turn's own agent
 * (every chip names one: Copilot keeps the last command sticky). `text`
 * overrides the stored prompt (Run it anyway, Retry resend the user's words).
 */
export const chipOf = (
    key: ChipKey,
    kind: "dev" | "plan",
    text?: string
): { label: string; prompt: string; command: ChipCommand } | undefined => {
    const def = data.chips[key];
    if (!def) {
        return undefined;
    }
    const command = (def.command === "@kind" ? kind : def.command) as ChipCommand;
    const stored = def.prompt ? PROMPTS[def.prompt as PromptKey] ?? "" : "";
    // An "@kind" chip with no text would send nothing: left out, never thrown
    // (a throw in provideFollowups costs the turn every chip).
    if (!(text ?? stored) && def.command === "@kind") {
        return undefined;
    }
    return { label: chipLabel(key), prompt: text ?? stored, command };
};

/** An answer-derived chip's kaomoji, label and prompt, from its JSON template.
 * A prompt of "@KEY" reuses that prompt verbatim: one sentence, one place.
 * The agent's own offers and choices carry no kaomoji — they are its words. */
export const naturalText = (key: NaturalKey, vars: Record<string, string> = {}): { kao: string; label: string; prompt: string } => {
    const def = data.natural[key];
    const promptText = def.prompt.startsWith("@") ? PROMPTS[def.prompt.slice(1) as PromptKey] : fill(def.prompt, vars);
    return { kao: def.kao, label: fill(def.label, vars), prompt: promptText };
};

// ---------------------------------------------------------------------------
// Kaomoji pills: a mark in chat markdown is wrapped in inline code, drawn on the
// theme's code background. HTML badges cannot render in chat: its KaTeX `style`
// rule replaces the span rule (REFS "Badges"). Marks hold no backtick (KM).

const MARK_LIST: readonly string[] = Object.values(data.marks).sort((a, b) => b.length - a.length);

export const badge = (text: string): string => `\`${text}\``;

/**
 * One badger per turn. The model's answer streams in deltas, so fence and
 * inline-code state carry across chunks: a ``` opened in one delta still holds
 * in the next. A mark inside fenced or inline code stays plain; everywhere else
 * — line start, blockquote, table cell, mid-sentence — it becomes a pill.
 * Inline code closes on a backtick run of the length that opened it
 * (CommonMark), and a blank line ends it, as it ends the paragraph.
 */
export const createBadger = (): ((chunk: string) => string) => {
    let fence = ""; // the fence run that opened the fenced block
    let inlineLen = 0; // length of the backtick run that opened inline code
    let lineStart = true;
    let blank = false; // the current line is blank so far, after a newline
    let run = ""; // a ` or ~ run still being read; may span chunks
    let runAtLineStart = false;
    let escaped = false; // the previous char was an unescaped backslash
    let tick = false; // the last char sent was a backtick of a run (not an escaped one)
    let pillEnd = false; // the last thing sent was a pill
    const closeRun = (): void => {
        if (!run) {
            return;
        }
        const ch = run[0];
        if (run.length >= 3 && runAtLineStart && inlineLen === 0 && (!fence || (fence[0] === ch && run.length >= fence.length))) {
            fence = fence ? "" : run;
        } else if (!fence && ch === "`") {
            inlineLen = inlineLen === 0 ? run.length : inlineLen === run.length ? 0 : inlineLen;
        }
        run = "";
    };
    // a pill never touches another backtick — a zero-width space keeps
    // the runs apart, or a pill followed by `x` would read as one unclosed run.
    const sep = "\u200b";
    return (chunk: string): string => {
        let out = "";
        let i = 0;
        while (i < chunk.length) {
            const c = chunk[i];
            if (pillEnd && c === "`") {
                out += sep;
            }
            pillEnd = false;
            const tickBefore = tick;
            tick = false;
            // A CRLF line ending is one line ending: the \r must not count as
            // text, or a CRLF blank line never ends inline code and a fence
            // after \r\n never opens.
            if (c === "\r") {
                closeRun();
                escaped = false;
                out += c;
                i += 1;
                continue;
            }
            // CommonMark: \` outside code is a literal backtick, not a run.
            const wasEscaped = escaped;
            escaped = false;
            if (wasEscaped && (c === "`" || c === "\\")) {
                out += c;
                blank = false;
                lineStart = false;
                i += 1;
                continue;
            }
            if (c === "\\") {
                closeRun();
                escaped = !fence && inlineLen === 0;
                out += c;
                blank = false;
                lineStart = false;
                i += 1;
                continue;
            }
            if (c === "`" || c === "~") {
                if (run && run[0] !== c) {
                    closeRun();
                }
                if (!run) {
                    runAtLineStart = lineStart;
                }
                run += c;
                out += c;
                tick = c === "`";
                lineStart = false;
                blank = false;
                i += 1;
                continue;
            }
            closeRun();
            if (c === "\n") {
                if (blank) {
                    inlineLen = 0;
                }
                blank = true;
                lineStart = true;
                out += c;
                i += 1;
                continue;
            }
            if (c === " " || c === "\t") {
                out += c;
                i += 1;
                continue;
            }
            blank = false;
            // An escaped char is the model's literal: `\(•‿•)` stays as written.
            const kao = !fence && inlineLen === 0 && !wasEscaped ? MARK_LIST.find((m) => chunk.startsWith(m, i)) : undefined;
            if (kao) {
                out += (tickBefore ? sep : "") + badge(kao);
                i += kao.length;
                pillEnd = true;
            } else {
                out += c;
                i += 1;
            }
            lineStart = false;
        }
        return out;
    };
};

/** One-shot form: a whole markdown string, fresh state. */
export const badgeMarks = (markdown: string): string => createBadger()(markdown);

/**
 * followups.json cross-references, as a list of problems: checked by the suite
 * (MB), logged at activation, never thrown (a typo must not stop activation).
 */
export const followupsProblems = (d: typeof data = data): string[] => {
    const problems: string[] = [];
    const prompts = d.prompts as Record<string, string>;
    for (const key of LANE_RUN_PROMPTS) {
        if (!prompts[key]?.includes("{run}")) {
            problems.push(`prompts.${key} has no {run}: mergeRunId would never match`);
        }
    }
    const commands: readonly string[] = ["@kind", ...CHIP_COMMANDS];
    for (const [k, def] of Object.entries(d.chips as Record<string, { prompt: string; command: string }>)) {
        if (def.prompt && !(def.prompt in prompts)) {
            problems.push(`chips.${k}.prompt "${def.prompt}" is not a prompt key`);
        }
        if (!commands.includes(def.command)) {
            problems.push(`chips.${k}.command "${def.command}" is neither "@kind" nor a chip command`);
        }
    }
    for (const [k, keys] of Object.entries(d.cases as Record<string, string[]>)) {
        for (const c of keys) {
            if (!(c in d.chips)) {
                problems.push(`cases.${k} names unknown chip "${c}"`);
            }
        }
    }
    for (const [k, def] of Object.entries(d.natural as Record<string, unknown>)) {
        const prompt = (def as { prompt?: unknown })?.prompt;
        if (typeof prompt === "string" && prompt.startsWith("@") && !(prompt.slice(1) in prompts)) {
            problems.push(`natural.${k}.prompt "${prompt}" is not a prompt key`);
        }
    }
    return problems;
};
