import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { config, refUri, relTo } from "./core";
import { ChatKind, StepRecord } from "./metrics";
import { CONTEXT_EXCERPTS, CONTEXT_FILES, CONTEXT_INLINE, CONTEXT_NOTE, CONTEXT_PROBLEMS, CONTEXT_RULE, CONTEXT_SELECTION, EXCERPT_BYTES_CAP, PROBLEMS_MAX_ITEMS, PROBLEM_BYTES_CAP, TOTAL_EXCERPT_BYTES_CAP } from "./context-markers";

const MIN_EXCERPT_BYTES = 32;

export interface ChatContextBlock {
    preamble: string;
    uris: vscode.Uri[];
    /** What became of each reference the host sent: the log line and the chat note read it. */
    notes: ReferenceNote[];
}

/** One reference the host sent, and what the bridge did with it. */
export interface ReferenceNote {
    id: string;
    kind: "file" | "range" | "text" | "image" | "binary" | "diagnostics" | "resource" | "other";
    /** A path relative to the folder (absolute outside it), a MIME type, or the id. */
    label: string;
    kept: boolean;
    /** Dropped without a chat note: the host added it, not the user. */
    automatic?: boolean;
    why?: string;
    /** Kept, but outside the folder: a read-only turn cannot open it. */
    outside?: boolean;
    /** The disk path was kept, but editor text could not fit. */
    omittedText?: boolean;
    /** Its text went into the prompt as an excerpt. */
    excerpted?: boolean;
    /** Its text was kept out: a `.env` file on a read-only turn. */
    withheld?: boolean;
}

// The read tool's own deny on read-only turns (enforce.ts readOnlyPermission:
// `*.env`, `*.env.*`, `*.env.example` allowed). An excerpt would hand the model
// what its read is refused.
export const readDeniedOnReadOnly = (fsPath: string): boolean => {
    const p = fsPath.replace(/\\/g, "/");
    return !/\.env\.example$/.test(p) && (/\.env$/.test(p) || /\.env\./.test(p));
};

// OpenCode already loads AGENTS.md / CLAUDE.md / .github/copilot-instructions.md
// itself. Re-sending them as "the user attached this" is pure token waste and
// confuses the model into narrating the context block back at you.
const INSTRUCTION_FILES = /(^|[\\/])(AGENTS\.md|CLAUDE\.md|copilot-instructions\.md|.*\.instructions\.md|.*\.prompt\.md)$/i;

export function isInstructionFile(uri: vscode.Uri): boolean {
    return INSTRUCTION_FILES.test(uri.fsPath);
}

// What the host adds by itself: instruction and prompt files, Copilot's
// "<instructions>…" STRING blob (folding it in leaked a raw <workspace-context>
// into the reply), and the implicit current-file / selection chip.
const AUTOMATIC_ID = /instruction|prompt|copilot\./i;
const IMPLICIT_ID = /vscode\.implicit/i;

// What a reference with no file is, from its value's shape: VS Code's
// ChatReferenceBinaryData (`mimeType`, `data()`) and ChatReferenceDiagnostic
// (`diagnostics`) carry nothing to point OpenCode at.
function droppedKind(value: unknown): ReferenceNote["kind"] {
    const v = value as { mimeType?: unknown; diagnostics?: unknown } | undefined;
    if (typeof value === "string") {
        return "text";
    }
    if (typeof v?.mimeType === "string") {
        return v.mimeType.startsWith("image/") ? "image" : "binary";
    }
    if (Array.isArray(v?.diagnostics)) {
        return "diagnostics";
    }
    return "other";
}

// Attachments the user explicitly added (#file, drag-drop, "Add context") are
// included by default because attaching them *is* the intent. The active editor
// selection is opt-in so nothing is ever sent that was not asked for.
// An inline (Ctrl+I) turn always sends its selection, or the file and cursor line.
// Files on disk go by path (OpenCode reads them itself); dirty buffers, line-range
// excerpts, open untitled editors, and #problems diagnostics are folded into
// bounded context sections; every reference, kept or not, is noted for the log
// and the chat line.

interface DocLike {
    uri?: vscode.Uri;
    isDirty?: boolean;
    getText?: () => string;
}

function findOpenDocument(uri: vscode.Uri): DocLike | undefined {
    const scheme = String((uri as { scheme?: unknown }).scheme ?? "file");
    const docs = (vscode.workspace as { textDocuments?: readonly DocLike[] }).textDocuments ?? [];
    const found = docs.find((d) => String((d.uri as { scheme?: unknown } | undefined)?.scheme ?? "file") === scheme && d.uri?.fsPath === uri.fsPath);
    if (found) {
        return found;
    }
    const active = vscode.window.activeTextEditor?.document as DocLike | undefined;
    if (active && String((active.uri as { scheme?: unknown } | undefined)?.scheme ?? "file") === scheme && active.uri?.fsPath === uri.fsPath) {
        return active;
    }
    return undefined;
}

function safeFence(text: string): string {
    let run = 3;
    for (const m of text.matchAll(/`{3,}/g)) {
        if (m[0].length >= run) {
            run = m[0].length + 1;
        }
    }
    return "`".repeat(run);
}

function clampExcerpt(text: string, cap: number): string {
    const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    if (Buffer.byteLength(normalized, "utf8") <= cap) {
        return normalized;
    }
    const marker = "\n…(truncated)";
    const budget = Math.max(0, cap - Buffer.byteLength(marker, "utf8"));
    const bytes = Buffer.from(normalized, "utf8");
    let end = budget;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
        end -= 1;
    }
    return cap < Buffer.byteLength(marker, "utf8") ? "" : bytes.subarray(0, end).toString("utf8") + marker;
}

function lineExcerpt(text: string, start: number, end: number, cap: number): string {
    let from = 0;
    for (let line = 0; line < start; line += 1) {
        const next = text.indexOf("\n", from);
        if (next < 0) {
            return "";
        }
        from = next + 1;
    }
    let to = from;
    for (let line = start; line <= end; line += 1) {
        const next = text.indexOf("\n", to);
        if (next < 0 || next - from > cap) {
            return text.slice(from, Math.min(text.length, from + cap + 1));
        }
        to = next + 1;
    }
    return text.slice(from, to);
}

function diagSeverity(sev: unknown): string {
    if (typeof sev === "string" && sev.trim()) {
        return sev.trim().toLowerCase();
    }
    switch (sev) {
        case 0: return "error";
        case 1: return "warning";
        case 2: return "info";
        case 3: return "hint";
        default: return "problem";
    }
}

export function buildChatContext(
    request: vscode.ChatRequest,
    cwd: string,
    origin: { inline?: boolean; readOnly?: boolean } = {}
): ChatContextBlock {
    const lines: string[] = [];
    const excerpts: string[] = [];
    const problemLines: string[] = [];
    let excerptBytes = 0;
    let problemOverflow = 0;
    const uris: vscode.Uri[] = [];
    const notes: ReferenceNote[] = [];
    const seen = new Set<string>();
    const settings = config();
    const include = settings.get<boolean>("includeChatReferences", true);

    const pushExcerpt = (heading: string, rawText: string): boolean => {
        const cleaned = rawText.replace(/\r\n?/g, "\n").trimEnd();
        if (!cleaned.trim() || TOTAL_EXCERPT_BYTES_CAP - excerptBytes < MIN_EXCERPT_BYTES) {
            return false;
        }
        const budget = Math.min(EXCERPT_BYTES_CAP, TOTAL_EXCERPT_BYTES_CAP - excerptBytes);
        const body = clampExcerpt(cleaned, budget);
        if (!body) {
            return false;
        }
        excerptBytes += Buffer.byteLength(body, "utf8");
        const fence = safeFence(body);
        excerpts.push(`### ${heading}\n${fence}\n${body}\n${fence}`);
        return true;
    };

    for (const ref of (request as { references?: readonly unknown[] }).references ?? []) {
        const value = (ref as { value?: unknown }).value;
        const id = String((ref as { id?: unknown }).id ?? "");
        const uri = typeof value === "string" ? undefined : refUri(value);
        const kind: ReferenceNote["kind"] = uri ? ((value as { range?: unknown }).range ? "range" : "file") : droppedKind(value);
        const label = uri
            ? relTo(cwd, uri)
            : kind === "image" || kind === "binary"
                ? String((value as { mimeType: string }).mimeType)
                : kind === "diagnostics"
                    ? "Problems"
                    : id || kind;
        if (!include) {
            notes.push({ id, kind, label: kind === "diagnostics" ? id || kind : label, kept: false, automatic: true, why: "includeChatReferences is off" });
            continue;
        }
        if (IMPLICIT_ID.test(id)) {
            notes.push({ id, kind, label, kept: false, why: "implicit context" });
            continue;
        }
        if (AUTOMATIC_ID.test(id) || (uri && isInstructionFile(uri))) {
            notes.push({ id, kind, label, kept: false, automatic: true, why: uri ? "instruction file, OpenCode loads its own" : "added by the host" });
            continue;
        }
        if (!uri && kind === "diagnostics") {
            const tuples = (value as { diagnostics?: unknown[] } | undefined)?.diagnostics ?? [];
            let addedForRef = 0;
            for (const entry of tuples) {
                if (!Array.isArray(entry) || entry.length < 2) {
                    continue;
                }
                const dUri = refUri(entry[0]);
                const dList = Array.isArray(entry[1]) ? entry[1] : [];
                const fileLabel = dUri ? (String((dUri as { scheme?: unknown }).scheme ?? "file") === "file" ? relTo(cwd, dUri) : `${String((dUri as { scheme?: unknown }).scheme)}:${dUri.fsPath}`) : "workspace";
                if (dUri && String((dUri as { scheme?: unknown }).scheme ?? "file") === "file") {
                    uris.push(dUri);
                }
                for (const d of dList) {
                    const item = d as { message?: unknown; severity?: unknown; code?: unknown; range?: { start?: { line?: number } } } | undefined;
                    const msg = clampExcerpt(String(item?.message ?? "").slice(0, PROBLEM_BYTES_CAP * 2).replace(/\s+/g, " ").trim(), PROBLEM_BYTES_CAP);
                    if (!msg) {
                        continue;
                    }
                    addedForRef += 1;
                    if (problemLines.length >= PROBLEMS_MAX_ITEMS) {
                        problemOverflow += 1;
                        continue;
                    }
                    const lineNo = typeof item?.range?.start?.line === "number" ? `:${item.range.start.line + 1}` : "";
                    const sev = diagSeverity(item?.severity);
                    const rawCode = item?.code && typeof item.code === "object" ? (item.code as { value?: unknown }).value : item?.code;
                    const codeStr = rawCode !== undefined && rawCode !== null && String(rawCode).trim() ? ` [${String(rawCode).trim()}]` : "";
                    problemLines.push(clampExcerpt(`- ${fileLabel}${lineNo} (${sev}${codeStr}): ${msg}`, PROBLEM_BYTES_CAP));
                }
            }
            if (addedForRef > 0) {
                notes.push({ id, kind: "diagnostics", label: "Problems", kept: true });
            } else {
                notes.push({ id, kind: "diagnostics", label: id || "diagnostics", kept: false, why: "no problems listed" });
            }
            continue;
        }
        if (!uri) {
            notes.push({ id, kind, label, kept: false, why: "not a file" });
            continue;
        }
        const scheme = String((uri as { scheme?: unknown }).scheme ?? "file");
        if (scheme === "untitled") {
            const untitledLabel = `${scheme}:${uri.fsPath}`;
            const doc = findOpenDocument(uri);
            const text = typeof doc?.getText === "function" ? doc.getText() : "";
            if (text.trim() && pushExcerpt(`${untitledLabel} (unsaved)`, text)) {
                notes.push({ id, kind: "text", label: untitledLabel, kept: true });
            } else {
                notes.push({ id, kind: "resource", label: untitledLabel, kept: false, why: text.trim() ? "excerpt budget exhausted" : "never saved" });
            }
            continue;
        }
        if (scheme !== "file") {
            notes.push({ id, kind: "resource", label: `${scheme}:${uri.fsPath}`, kept: false, why: "not a file on disk" });
            continue;
        }
        const range = (value as { range?: { start?: { line?: number }; end?: { line?: number } } }).range;
        const startLine = range?.start?.line;
        const endLine = range?.end?.line;
        const span =
            startLine !== undefined && endLine !== undefined
                ? `:${startLine + 1}-${endLine + 1}`
                : "";
        const key = `${uri.fsPath}${span}`;
        if (seen.has(key)) {
            notes.push({ id, kind, label: `${label}${span}`, kept: false, automatic: true, why: "duplicate" });
            continue;
        }
        seen.add(key);
        uris.push(uri);
        const doc = findOpenDocument(uri);
        const dirty = Boolean(doc?.isDirty && typeof doc.getText === "function");
        const outside = path.isAbsolute(label);
        let excerptKept = false;
        const wouldExcerpt = Boolean(doc?.getText) && (dirty || (startLine !== undefined && endLine !== undefined));
        const withheld = wouldExcerpt && Boolean(origin.readOnly) && settings.get<boolean>("enforceReadOnly", true) && readDeniedOnReadOnly(uri.fsPath);
        // Closed files stay path-based: OpenCode reads the requested range.
        // Never synchronously load a whole attachment on the extension host.
        if (withheld) {
            // the path stays; plan's read refuses it, as it would without the excerpt
        } else if (TOTAL_EXCERPT_BYTES_CAP - excerptBytes >= MIN_EXCERPT_BYTES && startLine !== undefined && endLine !== undefined) {
            const sourceText = typeof doc?.getText === "function" ? doc.getText() : undefined;
            if (sourceText !== undefined) {
                const lo = Math.max(0, Math.min(startLine, endLine));
                const hi = Math.max(startLine, endLine);
                const slice = lineExcerpt(sourceText, lo, hi, EXCERPT_BYTES_CAP);
                excerptKept = pushExcerpt(`${label}${span}${dirty ? " (unsaved)" : ""}`, slice);
            }
        } else if (TOTAL_EXCERPT_BYTES_CAP - excerptBytes >= MIN_EXCERPT_BYTES && dirty && doc?.getText) {
            excerptKept = pushExcerpt(`${label} (unsaved buffer)`, doc.getText());
        }
        // relTo answers an absolute path for a file outside the folder.
        notes.push({
            id,
            kind,
            label: `${label}${span}`,
            kept: true,
            ...(outside ? { outside: true } : {}),
            ...(dirty && !excerptKept && !withheld ? { omittedText: true } : {}),
            ...(excerptKept ? { excerpted: true } : {}),
            ...(withheld ? { withheld: true } : {})
        });
        lines.push(`- ${label}${span}${dirty && !withheld ? (excerptKept ? " (unsaved changes in editor)" : " (unsaved editor text omitted; disk contents may be stale)") : ""}`);
    }

    let selectionBlock = "";
    if (origin.inline || settings.get<boolean>("includeEditorSelection", false)) {
        const editor = vscode.window.activeTextEditor;
        const sel = editor?.selection;
        if (origin.inline && editor && sel && (sel.isEmpty || !editor.document.getText(sel).trim())) {
            const name = relTo(cwd, editor.document.uri);
            selectionBlock = `\n${CONTEXT_INLINE}${name}:${sel.active.line + 1} (cursor, nothing selected)\n`;
            if (!seen.has(editor.document.uri.fsPath)) {
                uris.push(editor.document.uri);
            }
        } else if (editor && sel && !sel.isEmpty) {
            const text = editor.document.getText(sel);
            if (text.trim()) {
                const name = relTo(cwd, editor.document.uri);
                const span = `:${sel.start.line + 1}-${sel.end.line + 1}`;
                if (Boolean(origin.readOnly) && settings.get<boolean>("enforceReadOnly", true) && readDeniedOnReadOnly(editor.document.uri.fsPath)) {
                    notes.push({ id: "vscode.selection", kind: "range", label: `${name}${span}`, kept: true, withheld: true });
                } else {
                    selectionBlock =
                        `\n${CONTEXT_SELECTION}${name}${span}\n` +
                        "```\n" +
                        text +
                        "\n```\n";
                    if (!seen.has(editor.document.uri.fsPath)) {
                        uris.push(editor.document.uri);
                    }
                }
            }
        }
    }

    if (lines.length === 0 && excerpts.length === 0 && problemLines.length === 0 && !selectionBlock) {
        return { preamble: "", uris, notes };
    }
    const attached = lines.length ? `${CONTEXT_FILES}\n${lines.join("\n")}\n` : "";
    const excerptSection = excerpts.length
        ? `${attached ? "\n" : ""}${CONTEXT_EXCERPTS}\n${excerpts.join("\n")}\n`
        : "";
    if (problemOverflow > 0) {
        problemLines.push(`- …${problemOverflow} more problems`);
    }
    const problemSection = problemLines.length
        ? `${attached || excerptSection ? "\n" : ""}${CONTEXT_PROBLEMS}\n${problemLines.join("\n")}\n`
        : "";
    return {
        preamble: `\n\n${CONTEXT_RULE}${attached}${excerptSection}${problemSection}${selectionBlock}${CONTEXT_NOTE}`,
        uris,
        notes
    };
}

/** The Output line for a turn's references: every one, kept or dropped, and why. */
export function referenceLogLine(notes: readonly ReferenceNote[]): string | undefined {
    if (!notes.length) {
        return undefined;
    }
    const kept = notes.filter((n) => n.kept).map((n) => `${n.label} (${n.kind}${n.outside ? ", outside the folder" : ""})`);
    const dropped = notes
        .filter((n) => !n.kept)
        .map((n) => `${n.id || "(no id)"}${n.label && n.label !== n.id ? ` ${n.label}` : ""} (${n.kind}: ${n.why})`);
    return `references (${notes.length}): kept ${kept.join(", ") || "none"}; dropped ${dropped.join(", ") || "none"}`;
}

const NOT_SENT: Record<string, [string, string]> = {
    image: ["an image", "images"],
    binary: ["a binary attachment", "binary attachments"],
    diagnostics: ["Problems", "Problems"],
    text: ["a text attachment", "text attachments"],
    other: ["an attachment of another kind", "attachments of other kinds"]
};
let implicitNoted = false;

/**
 * The one chat line a turn's references earn, or undefined: what the user
 * attached that OpenCode will not get, and — read-only turns under
 * enforceReadOnly — attached files outside the folder it cannot open. VS Code's
 * implicit current-file chip rides along on every turn: said once per window.
 */
export function contextNotice(notes: readonly ReferenceNote[], readOnly: boolean): string | undefined {
    const parts: string[] = [];
    const omitted = notes.filter((n) => n.omittedText).map((n) => `\`${n.label}\``);
    if (omitted.length) {
        parts.push(`Unsaved editor text not sent for ${omitted.join(", ")}: no excerpt fit. OpenCode only gets the disk path; its contents may be stale.`);
    }
    const counts = new Map<string, number>();
    const resources: string[] = [];
    for (const n of notes) {
        if (n.kept || n.automatic || n.why === "implicit context") {
            continue;
        }
        if (n.kind === "resource") {
            resources.push(`\`${n.label}\` (${n.why})`);
        } else {
            counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
        }
    }
    const names = [...counts].map(([kind, n]) => {
        const [one, many] = NOT_SENT[kind] ?? NOT_SENT.other;
        return n === 1 || kind === "diagnostics" ? one : `${n} ${many}`;
    });
    names.push(...resources);
    if (names.length) {
        parts.push(`Not sent to OpenCode: ${names.join(", ")}. The bridge passes files on disk, by path.`);
    }
    if (!implicitNoted && notes.some((n) => n.why === "implicit context")) {
        implicitNoted = true;
        parts.push("VS Code's current-file chip is not sent: attach the file with `#file`, or set `includeEditorSelection` for a selection.");
    }
    const withheld = notes.filter((n) => n.withheld).map((n) => `\`${n.label}\``);
    if (withheld.length) {
        parts.push(`Text of ${withheld.join(", ")} not sent: a read-only turn keeps \`.env\` files out, as plan's read does (\`/dev\` sends it).`);
    }
    // An excerpt already carries the text: only a path-only file outside is out of reach.
    const outside = notes.filter((n) => n.kept && n.outside && !n.excerpted).map((n) => `\`${n.label}\``);
    if (readOnly && outside.length && config().get<boolean>("enforceReadOnly", true)) {
        const one = outside.length === 1;
        parts.push(`${outside.join(", ")} ${one ? "is" : "are"} outside this folder: a read-only turn cannot open ${one ? "it" : "them"} (\`/dev\` can).`);
    }
    return parts.length ? parts.join(" ") : undefined;
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
    /** `effort:<variant>`: OpenCode's reasoning-effort variant for this turn. */
    effort?: string;
    /** A `plan:` / `dev:` / `parallel:` prefix was typed (autoParallel leaves it alone). */
    explicitKind?: boolean;
}

/** A lane's own `m:<model>` / `model:<model>` prefix, and the rest. */
export function splitModelPrefix(raw: string): { model?: string; task: string } {
    // An id may hold colons (`openrouter/…/deepseek-r1:free`, `ollama/qwen2.5-coder:7b`):
    // only a trailing one is punctuation, as in `m:tundra: review`.
    const m = raw.trim().match(/^(?:model|m)\s*[:=]\s*([^\s,]+)(?:,|\s|$)\s*([\s\S]*)$/i);
    const model = m?.[1].replace(/:$/, "");
    return m && model ? { model, task: m[2].trim() } : { task: raw.trim() };
}

/**
 * A lane's own prefixes, in either order: `m:<model>` and `a:<agent>`
 * (`agent:` / `model:` spelled out). An agent name may be nested
 * (`team/look`); a trailing colon is punctuation, as in `a:look: review`.
 * `a:` takes no space (`a: the bug` is prose), as `e:` does.
 */
export function splitLanePrefixes(raw: string): { model?: string; agent?: string; task: string } {
    let rest = raw.trim();
    let model: string | undefined;
    let agent: string | undefined;
    for (let i = 0; i < 2; i += 1) {
        const a = agent ? undefined : rest.match(/^(?:agent\s*[:=]\s*|a[:=])([A-Za-z0-9_][\w./-]{0,63}?):?(?:,|\s|$)\s*([\s\S]*)$/i);
        if (a) {
            agent = a[1];
            rest = a[2].trim();
            continue;
        }
        if (!model) {
            const m = splitModelPrefix(rest);
            if (m.model) {
                model = m.model;
                rest = m.task;
                continue;
            }
        }
        break;
    }
    return { model, agent, task: rest };
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
    let effort: string | undefined;
    let explicitKind = false;
    // `effort:high` (or `e:high`, no space after the colon: "e: the bug" is
    // prose) sends OpenCode's reasoning-effort variant for this turn.
    for (let i = 0; i < 5 && rest; i += 1) {
        const match = rest.match(
            /^(?:(plan|dev|parallel|par)\s*:|(?:model|m)\s*[:=]\s*(\S+)\s*:?|(?:effort\s*[:=]\s*|e[:=])([A-Za-z][\w-]{0,23})(?=\s|$))\s*/i
        );
        if (!match) {
            break;
        }
        if (match[1]) {
            const word = match[1].toLowerCase();
            kind = (word === "par" ? "parallel" : word) as ChatKind;
            explicitKind = true;
        }
        if (match[2]) {
            model = match[2].replace(/,$/, "");
        }
        if (match[3]) {
            effort = match[3];
        }
        rest = rest.slice(match[0].length).trim();
    }
    return { kind, model, task: rest, effort, explicitKind };
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
