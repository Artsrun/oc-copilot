import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { config, refUri, relTo } from "./core";
import { ChatKind, StepRecord } from "./metrics";

export interface ChatContextBlock {
    preamble: string;
    uris: vscode.Uri[];
}

// OpenCode already loads AGENTS.md / CLAUDE.md / .github/copilot-instructions.md
// itself. Re-sending them as "the user attached this" is pure token waste and
// confuses the model into narrating the context block back at you.
const INSTRUCTION_FILES = /(^|[\\/])(AGENTS\.md|CLAUDE\.md|copilot-instructions\.md|.*\.instructions\.md|.*\.prompt\.md)$/i;

export function isInstructionFile(uri: vscode.Uri): boolean {
    return INSTRUCTION_FILES.test(uri.fsPath);
}

export function isIgnorableReference(id: string, value: unknown): boolean {
    if (typeof value === "string") {
        return true;
    }
    return /instruction|prompt|copilot\.|vscode\.implicit/i.test(id);
}

// Attachments the user explicitly added (#file, drag-drop, "Add context") are
// included by default because attaching them *is* the intent. The active editor
// selection is opt-in so nothing is ever sent that was not asked for.
// An inline (Ctrl+I) turn always sends its selection, or the file and cursor line.
export function buildChatContext(
    request: vscode.ChatRequest,
    cwd: string,
    origin: { inline?: boolean } = {}
): ChatContextBlock {
    const lines: string[] = [];
    const uris: vscode.Uri[] = [];
    const seen = new Set<string>();
    const settings = config();

    if (settings.get<boolean>("includeChatReferences", true)) {
        for (const ref of (request as { references?: readonly unknown[] }).references ?? []) {
            const value = (ref as { value?: unknown }).value;
            const id = String((ref as { id?: unknown }).id ?? "");
            // Only real file attachments. Copilot silently adds its own
            // instruction-file references plus a multi-hundred-word
            // "<instructions>…" STRING blob; folding those into the preamble is
            // what leaks a raw <workspace-context> into the reply. A
            // string-valued reference is never a user attachment.
            if (isIgnorableReference(id, value)) {
                continue;
            }
            const uri = refUri(value);
            if (!uri || isInstructionFile(uri)) {
                continue;
            }
            const key = uri.fsPath;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            uris.push(uri);
            const range = (value as { range?: { start?: { line?: number }; end?: { line?: number } } })
                .range;
            const span =
                range?.start?.line !== undefined && range?.end?.line !== undefined
                    ? `:${range.start.line + 1}-${range.end.line + 1}`
                    : "";
            lines.push(`- ${relTo(cwd, uri)}${span}`);
        }
    }

    let selectionBlock = "";
    if (origin.inline || settings.get<boolean>("includeEditorSelection", false)) {
        const editor = vscode.window.activeTextEditor;
        const sel = editor?.selection;
        if (origin.inline && editor && sel && (sel.isEmpty || !editor.document.getText(sel).trim())) {
            const name = relTo(cwd, editor.document.uri);
            selectionBlock = `\nInline chat — ${name}:${sel.active.line + 1} (cursor, nothing selected)\n`;
            if (!seen.has(editor.document.uri.fsPath)) {
                uris.push(editor.document.uri);
            }
        } else if (editor && sel && !sel.isEmpty) {
            const text = editor.document.getText(sel);
            if (text.trim()) {
                const name = relTo(cwd, editor.document.uri);
                selectionBlock =
                    `\nActive selection — ${name}:${sel.start.line + 1}-${sel.end.line + 1}\n` +
                    "```\n" +
                    text +
                    "\n```\n";
                if (!seen.has(editor.document.uri.fsPath)) {
                    uris.push(editor.document.uri);
                }
            }
        }
    }

    if (lines.length === 0 && !selectionBlock) {
        return { preamble: "", uris };
    }
    const attached = lines.length ? `Files the user attached:\n${lines.join("\n")}\n` : "";
    return {
        preamble: `\n\n---\n${attached}${selectionBlock}(Context only. Do not repeat or summarize this block.)`,
        uris
    };
}

// `response.reference` renders a "Used N references" chip in Copilot Chat. Older
// hosts (and the verify stub) may not implement it, so it is probed first.
export function emitReferences(response: vscode.ChatResponseStream, uris: vscode.Uri[]): void {
    if (typeof (response as { reference?: unknown }).reference !== "function") {
        return;
    }
    const seen = new Set<string>();
    for (const uri of uris) {
        if (!uri || seen.has(uri.fsPath)) {
            continue;
        }
        seen.add(uri.fsPath);
        try {
            response.reference(uri);
        } catch {
            // never let a decorative reference break the turn
        }
    }
}

// ---------------------------------------------------------------------------
// claim:file-links — `src/cart.ts:42` in inline code becomes an anchor
// that opens the file at that line. Only a file that exists in the workspace;
// never inside a fence or a multi-backtick span. VS Code 1.139 merges an
// inline reference into the markdown before it (chatModel.ts), so the pill
// sits in the sentence; an empty-text markdown link would drop the line on
// click (the pill passes `selection: undefined` over the URI's #L42).

export type AnswerPart = string | { anchor: vscode.Uri | vscode.Location };

const PATH_SPAN = /^((?:[A-Za-z]:)?[\w@.\-\\/]*[\w@\-]\.[A-Za-z0-9]{1,10})(?::(\d{1,6})(?:[:-]\d{1,6})?|#L(\d{1,6}))?$/;

/** One linker per answer: text in, parts out. A span still open at a chunk's
 * end is held until it closes; `flush()` releases whatever is held. */
export function createFileLinker(
    cwd: string,
    isFile: (p: string) => boolean = (p) => {
        try {
            return fs.statSync(p).isFile();
        } catch {
            return false;
        }
    }
): { push: (chunk: string) => AnswerPart[]; flush: () => AnswerPart[] } {
    let fence = ""; // the run that opened a fenced block
    let multi = 0; // inside a ``-or-longer inline span: its run length
    let lineStart = true;
    let held = "";
    const known = new Map<string, boolean>();

    const anchorFor = (span: string): AnswerPart | undefined => {
        const m = span.length <= 240 ? span.match(PATH_SPAN) : null;
        if (!m) {
            return undefined;
        }
        const abs = path.resolve(cwd, m[1]);
        const rel = path.relative(cwd, abs);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
            return undefined;
        }
        if (!known.has(abs)) {
            known.set(abs, isFile(abs));
        }
        if (!known.get(abs)) {
            return undefined;
        }
        const uri = vscode.Uri.file(abs);
        const line = Number(m[2] ?? m[3] ?? 0);
        // Optional: the verify stub may lack them; a bare file still opens.
        const Loc = (vscode as unknown as { Location?: typeof vscode.Location }).Location;
        const Range = (vscode as unknown as { Range?: typeof vscode.Range }).Range;
        return { anchor: line > 0 && Loc && Range ? new Loc(uri, new Range(line - 1, 0, line - 1, 0)) : uri };
    };

    const run = (text: string, final: boolean): AnswerPart[] => {
        const parts: AnswerPart[] = [];
        let out = "";
        let i = 0;
        let nlAt = 0; // the next newline after a span's opening, reused per line
        const hold = (from: number): void => {
            held = text.slice(from);
            i = text.length;
        };
        while (i < text.length) {
            const c = text[i];
            if (c === "\n") {
                // A blank line ends a paragraph, and any code span in it.
                if (lineStart) {
                    multi = 0;
                }
                lineStart = true;
                out += c;
                i += 1;
                continue;
            }
            if (lineStart && !multi) {
                // A fence line: up to three spaces, then ``` or ~~~. Held whole
                // until its newline: "```" then "js" may arrive apart.
                const nl = text.indexOf("\n", i);
                const line = text.slice(i, nl === -1 ? text.length : nl);
                if (!final && nl === -1 && /^ {0,3}(?:`*|~*)$|^ {0,3}(?:`{3,}|~{3,})/.test(line)) {
                    hold(i);
                    break;
                }
                const lead = line.match(/^ {0,3}(`{3,}|~{3,})/);
                if (lead) {
                    const r = lead[1];
                    if (!fence || (r[0] === fence[0] && r.length >= fence.length && !line.slice(lead[0].length).trim())) {
                        fence = fence ? "" : r;
                    }
                    out += line;
                    i += line.length;
                    continue;
                }
            }
            lineStart = false;
            if (fence) {
                out += c;
                i += 1;
                continue;
            }
            if (c === "\\") {
                if (i + 1 === text.length && !final) {
                    hold(i);
                    break;
                }
                out += text.slice(i, i + 2);
                i += 2;
                continue;
            }
            if (c !== "`") {
                out += c;
                i += 1;
                continue;
            }
            let n = 1;
            while (text[i + n] === "`") {
                n += 1;
            }
            if (i + n === text.length && !final) {
                hold(i);
                break;
            }
            if (multi) {
                multi = n === multi ? 0 : multi;
                out += text.slice(i, i + n);
                i += n;
                continue;
            }
            if (n > 1) {
                multi = n;
                out += text.slice(i, i + n);
                i += n;
                continue;
            }
            // One backtick: a span that closes on this line with one backtick.
            // indexOf, not a slice per backtick: a whole answer arrives at once
            // when nothing streamed.
            const tickAt = text.indexOf("`", i + 1);
            if (nlAt !== -1 && nlAt <= i) {
                nlAt = text.indexOf("\n", i + 1);
            }
            const end = tickAt === -1 ? nlAt : nlAt === -1 ? tickAt : Math.min(tickAt, nlAt);
            if (end === -1 && !final) {
                hold(i);
                break;
            }
            if (end === -1 || text[end] === "\n" || text[end + 1] === "`") {
                out += c;
                i += 1;
                continue;
            }
            const link = anchorFor(text.slice(i + 1, end));
            if (link) {
                if (out) {
                    parts.push(out);
                }
                parts.push(link);
                out = "";
            } else {
                out += text.slice(i, end + 1);
            }
            i = end + 1;
        }
        if (out) {
            parts.push(out);
        }
        return parts;
    };

    return {
        push: (chunk: string) => {
            const text = held + chunk;
            held = "";
            return run(text, false);
        },
        flush: () => {
            const text = held;
            held = "";
            return text ? run(text, true) : [];
        }
    };
}

/** Sends linked parts: text as markdown, a file as an inline anchor. */
export function emitAnswerParts(response: vscode.ChatResponseStream, parts: readonly AnswerPart[]): void {
    for (const part of parts) {
        if (typeof part === "string") {
            response.markdown(part);
        } else {
            response.anchor(part.anchor);
        }
    }
}

export function stepUris(cwd: string, steps: StepRecord[]): vscode.Uri[] {
    const out: vscode.Uri[] = [];
    for (const step of steps) {
        const raw = step.filePath?.trim();
        if (!raw) {
            continue;
        }
        try {
            out.push(vscode.Uri.file(path.isAbsolute(raw) ? raw : path.join(cwd, raw)));
        } catch {
            // ignore unparseable paths
        }
    }
    return out;
}

export interface ParsedChat {
    kind: ChatKind;
    model?: string;
    task: string;
}

/** A lane's own `m:<model>` / `model:<model>` prefix, and the rest. */
export function splitModelPrefix(raw: string): { model?: string; task: string } {
    // An id may hold colons (`openrouter/…/deepseek-r1:free`, `ollama/qwen2.5-coder:7b`):
    // only a trailing one is punctuation, as in `m:tundra: review`.
    const m = raw.trim().match(/^(?:model|m)\s*[:=]\s*([^\s,]+)(?:,|\s|$)\s*([\s\S]*)$/i);
    const model = m?.[1].replace(/:$/, "");
    return m && model ? { model, task: m[2].trim() } : { task: raw.trim() };
}

/** `/parallel models:a,b,c <task>`: one task, one lane per model (claim:parallel-models). */
export function splitModelsFanout(raw: string): { models: string[]; task: string } | undefined {
    const m = raw.trim().match(/^models\s*[:=]\s*(\S+)\s*([\s\S]*)$/i);
    return m ? { models: m[1].split(",").map((x) => x.trim()).filter(Boolean), task: m[2].trim() } : undefined;
}

export function parseChatPrompt(raw: string): ParsedChat {
    let rest = raw.trim();
    let kind: ChatKind = "plan";
    let model: string | undefined;
    for (let i = 0; i < 4 && rest; i += 1) {
        const match = rest.match(
            /^(?:(plan|dev|parallel|par)\s*:|(?:model|m)\s*[:=]\s*(\S+)\s*:?)\s*/i
        );
        if (!match) {
            break;
        }
        if (match[1]) {
            const word = match[1].toLowerCase();
            kind = (word === "par" ? "parallel" : word) as ChatKind;
        }
        if (match[2]) {
            model = match[2].replace(/,$/, "");
        }
        rest = rest.slice(match[0].length).trim();
    }
    return { kind, model, task: rest };
}

export function uniqueModels(candidates: Array<string | undefined>, cap = 4): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        const value = (candidate ?? "").trim();
        if (!value || seen.has(value)) {
            continue;
        }
        seen.add(value);
        out.push(value);
        if (out.length >= cap) {
            break;
        }
    }
    return out;
}