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
exports.readDeniedOnReadOnly = void 0;
exports.isInstructionFile = isInstructionFile;
exports.buildChatContext = buildChatContext;
exports.referenceLogLine = referenceLogLine;
exports.contextNotice = contextNotice;
exports.emitReferences = emitReferences;
exports.createFileLinker = createFileLinker;
exports.emitAnswerParts = emitAnswerParts;
exports.stepUris = stepUris;
exports.splitModelPrefix = splitModelPrefix;
exports.splitLanePrefixes = splitLanePrefixes;
exports.splitModelsFanout = splitModelsFanout;
exports.parseChatPrompt = parseChatPrompt;
exports.uniqueModels = uniqueModels;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const core_1 = require("./core");
const context_markers_1 = require("./context-markers");
const MIN_EXCERPT_BYTES = 32;
const readDeniedOnReadOnly = (fsPath) => {
    const p = fsPath.replace(/\\/g, "/");
    return !/\.env\.example$/.test(p) && (/\.env$/.test(p) || /\.env\./.test(p));
};
exports.readDeniedOnReadOnly = readDeniedOnReadOnly;
const INSTRUCTION_FILES = /(^|[\\/])(AGENTS\.md|CLAUDE\.md|copilot-instructions\.md|.*\.instructions\.md|.*\.prompt\.md)$/i;
function isInstructionFile(uri) {
    return INSTRUCTION_FILES.test(uri.fsPath);
}
const AUTOMATIC_ID = /instruction|prompt|copilot\./i;
const IMPLICIT_ID = /vscode\.implicit/i;
function droppedKind(value) {
    const v = value;
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
function findOpenDocument(uri) {
    const scheme = String(uri.scheme ?? "file");
    const docs = vscode.workspace.textDocuments ?? [];
    const found = docs.find((d) => String(d.uri?.scheme ?? "file") === scheme && d.uri?.fsPath === uri.fsPath);
    if (found) {
        return found;
    }
    const active = vscode.window.activeTextEditor?.document;
    if (active && String(active.uri?.scheme ?? "file") === scheme && active.uri?.fsPath === uri.fsPath) {
        return active;
    }
    return undefined;
}
function safeFence(text) {
    let run = 3;
    for (const m of text.matchAll(/`{3,}/g)) {
        if (m[0].length >= run) {
            run = m[0].length + 1;
        }
    }
    return "`".repeat(run);
}
function clampExcerpt(text, cap) {
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
function lineExcerpt(text, start, end, cap) {
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
function diagSeverity(sev) {
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
function buildChatContext(request, cwd, origin = {}) {
    const lines = [];
    const excerpts = [];
    const problemLines = [];
    let excerptBytes = 0;
    let problemOverflow = 0;
    const uris = [];
    const notes = [];
    const seen = new Set();
    const settings = (0, core_1.config)();
    const include = settings.get("includeChatReferences", true);
    const pushExcerpt = (heading, rawText) => {
        const cleaned = rawText.replace(/\r\n?/g, "\n").trimEnd();
        if (!cleaned.trim() || context_markers_1.TOTAL_EXCERPT_BYTES_CAP - excerptBytes < MIN_EXCERPT_BYTES) {
            return false;
        }
        const budget = Math.min(context_markers_1.EXCERPT_BYTES_CAP, context_markers_1.TOTAL_EXCERPT_BYTES_CAP - excerptBytes);
        const body = clampExcerpt(cleaned, budget);
        if (!body) {
            return false;
        }
        excerptBytes += Buffer.byteLength(body, "utf8");
        const fence = safeFence(body);
        excerpts.push(`### ${heading}\n${fence}\n${body}\n${fence}`);
        return true;
    };
    for (const ref of request.references ?? []) {
        const value = ref.value;
        const id = String(ref.id ?? "");
        const uri = typeof value === "string" ? undefined : (0, core_1.refUri)(value);
        const kind = uri ? (value.range ? "range" : "file") : droppedKind(value);
        const label = uri
            ? (0, core_1.relTo)(cwd, uri)
            : kind === "image" || kind === "binary"
                ? String(value.mimeType)
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
            const tuples = value?.diagnostics ?? [];
            let addedForRef = 0;
            for (const entry of tuples) {
                if (!Array.isArray(entry) || entry.length < 2) {
                    continue;
                }
                const dUri = (0, core_1.refUri)(entry[0]);
                const dList = Array.isArray(entry[1]) ? entry[1] : [];
                const fileLabel = dUri ? (String(dUri.scheme ?? "file") === "file" ? (0, core_1.relTo)(cwd, dUri) : `${String(dUri.scheme)}:${dUri.fsPath}`) : "workspace";
                if (dUri && String(dUri.scheme ?? "file") === "file") {
                    uris.push(dUri);
                }
                for (const d of dList) {
                    const item = d;
                    const msg = clampExcerpt(String(item?.message ?? "").slice(0, context_markers_1.PROBLEM_BYTES_CAP * 2).replace(/\s+/g, " ").trim(), context_markers_1.PROBLEM_BYTES_CAP);
                    if (!msg) {
                        continue;
                    }
                    addedForRef += 1;
                    if (problemLines.length >= context_markers_1.PROBLEMS_MAX_ITEMS) {
                        problemOverflow += 1;
                        continue;
                    }
                    const lineNo = typeof item?.range?.start?.line === "number" ? `:${item.range.start.line + 1}` : "";
                    const sev = diagSeverity(item?.severity);
                    const rawCode = item?.code && typeof item.code === "object" ? item.code.value : item?.code;
                    const codeStr = rawCode !== undefined && rawCode !== null && String(rawCode).trim() ? ` [${String(rawCode).trim()}]` : "";
                    problemLines.push(clampExcerpt(`- ${fileLabel}${lineNo} (${sev}${codeStr}): ${msg}`, context_markers_1.PROBLEM_BYTES_CAP));
                }
            }
            if (addedForRef > 0) {
                notes.push({ id, kind: "diagnostics", label: "Problems", kept: true });
            }
            else {
                notes.push({ id, kind: "diagnostics", label: id || "diagnostics", kept: false, why: "no problems listed" });
            }
            continue;
        }
        if (!uri) {
            notes.push({ id, kind, label, kept: false, why: "not a file" });
            continue;
        }
        const scheme = String(uri.scheme ?? "file");
        if (scheme === "untitled") {
            const untitledLabel = `${scheme}:${uri.fsPath}`;
            const doc = findOpenDocument(uri);
            const text = typeof doc?.getText === "function" ? doc.getText() : "";
            if (text.trim() && pushExcerpt(`${untitledLabel} (unsaved)`, text)) {
                notes.push({ id, kind: "text", label: untitledLabel, kept: true });
            }
            else {
                notes.push({ id, kind: "resource", label: untitledLabel, kept: false, why: text.trim() ? "excerpt budget exhausted" : "never saved" });
            }
            continue;
        }
        if (scheme !== "file") {
            notes.push({ id, kind: "resource", label: `${scheme}:${uri.fsPath}`, kept: false, why: "not a file on disk" });
            continue;
        }
        const range = value.range;
        const startLine = range?.start?.line;
        const endLine = range?.end?.line;
        const span = startLine !== undefined && endLine !== undefined
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
        const withheld = wouldExcerpt && Boolean(origin.readOnly) && settings.get("enforceReadOnly", true) && (0, exports.readDeniedOnReadOnly)(uri.fsPath);
        if (withheld) {
        }
        else if (context_markers_1.TOTAL_EXCERPT_BYTES_CAP - excerptBytes >= MIN_EXCERPT_BYTES && startLine !== undefined && endLine !== undefined) {
            const sourceText = typeof doc?.getText === "function" ? doc.getText() : undefined;
            if (sourceText !== undefined) {
                const lo = Math.max(0, Math.min(startLine, endLine));
                const hi = Math.max(startLine, endLine);
                const slice = lineExcerpt(sourceText, lo, hi, context_markers_1.EXCERPT_BYTES_CAP);
                excerptKept = pushExcerpt(`${label}${span}${dirty ? " (unsaved)" : ""}`, slice);
            }
        }
        else if (context_markers_1.TOTAL_EXCERPT_BYTES_CAP - excerptBytes >= MIN_EXCERPT_BYTES && dirty && doc?.getText) {
            excerptKept = pushExcerpt(`${label} (unsaved buffer)`, doc.getText());
        }
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
    if (origin.inline || settings.get("includeEditorSelection", false)) {
        const editor = vscode.window.activeTextEditor;
        const sel = editor?.selection;
        if (origin.inline && editor && sel && (sel.isEmpty || !editor.document.getText(sel).trim())) {
            const name = (0, core_1.relTo)(cwd, editor.document.uri);
            selectionBlock = `\n${context_markers_1.CONTEXT_INLINE}${name}:${sel.active.line + 1} (cursor, nothing selected)\n`;
            if (!seen.has(editor.document.uri.fsPath)) {
                uris.push(editor.document.uri);
            }
        }
        else if (editor && sel && !sel.isEmpty) {
            const text = editor.document.getText(sel);
            if (text.trim()) {
                const name = (0, core_1.relTo)(cwd, editor.document.uri);
                const span = `:${sel.start.line + 1}-${sel.end.line + 1}`;
                if (Boolean(origin.readOnly) && settings.get("enforceReadOnly", true) && (0, exports.readDeniedOnReadOnly)(editor.document.uri.fsPath)) {
                    notes.push({ id: "vscode.selection", kind: "range", label: `${name}${span}`, kept: true, withheld: true });
                }
                else {
                    selectionBlock =
                        `\n${context_markers_1.CONTEXT_SELECTION}${name}${span}\n` +
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
    const attached = lines.length ? `${context_markers_1.CONTEXT_FILES}\n${lines.join("\n")}\n` : "";
    const excerptSection = excerpts.length
        ? `${attached ? "\n" : ""}${context_markers_1.CONTEXT_EXCERPTS}\n${excerpts.join("\n")}\n`
        : "";
    if (problemOverflow > 0) {
        problemLines.push(`- …${problemOverflow} more problems`);
    }
    const problemSection = problemLines.length
        ? `${attached || excerptSection ? "\n" : ""}${context_markers_1.CONTEXT_PROBLEMS}\n${problemLines.join("\n")}\n`
        : "";
    return {
        preamble: `\n\n${context_markers_1.CONTEXT_RULE}${attached}${excerptSection}${problemSection}${selectionBlock}${context_markers_1.CONTEXT_NOTE}`,
        uris,
        notes
    };
}
function referenceLogLine(notes) {
    if (!notes.length) {
        return undefined;
    }
    const kept = notes.filter((n) => n.kept).map((n) => `${n.label} (${n.kind}${n.outside ? ", outside the folder" : ""})`);
    const dropped = notes
        .filter((n) => !n.kept)
        .map((n) => `${n.id || "(no id)"}${n.label && n.label !== n.id ? ` ${n.label}` : ""} (${n.kind}: ${n.why})`);
    return `references (${notes.length}): kept ${kept.join(", ") || "none"}; dropped ${dropped.join(", ") || "none"}`;
}
const NOT_SENT = {
    image: ["an image", "images"],
    binary: ["a binary attachment", "binary attachments"],
    diagnostics: ["Problems", "Problems"],
    text: ["a text attachment", "text attachments"],
    other: ["an attachment of another kind", "attachments of other kinds"]
};
let implicitNoted = false;
function contextNotice(notes, readOnly) {
    const parts = [];
    const omitted = notes.filter((n) => n.omittedText).map((n) => `\`${n.label}\``);
    if (omitted.length) {
        parts.push(`Unsaved editor text not sent for ${omitted.join(", ")}: no excerpt fit. OpenCode only gets the disk path; its contents may be stale.`);
    }
    const counts = new Map();
    const resources = [];
    for (const n of notes) {
        if (n.kept || n.automatic || n.why === "implicit context") {
            continue;
        }
        if (n.kind === "resource") {
            resources.push(`\`${n.label}\` (${n.why})`);
        }
        else {
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
    const outside = notes.filter((n) => n.kept && n.outside && !n.excerpted).map((n) => `\`${n.label}\``);
    if (readOnly && outside.length && (0, core_1.config)().get("enforceReadOnly", true)) {
        const one = outside.length === 1;
        parts.push(`${outside.join(", ")} ${one ? "is" : "are"} outside this folder: a read-only turn cannot open ${one ? "it" : "them"} (\`/dev\` can).`);
    }
    return parts.length ? parts.join(" ") : undefined;
}
function emitReferences(response, uris) {
    if (typeof response.reference !== "function") {
        return;
    }
    const seen = new Set();
    for (const uri of uris) {
        if (!uri || seen.has(uri.fsPath)) {
            continue;
        }
        seen.add(uri.fsPath);
        try {
            response.reference(uri);
        }
        catch {
        }
    }
}
const PATH_SPAN = /^((?:[A-Za-z]:)?[\w@.\-\\/]*[\w@\-]\.[A-Za-z0-9]{1,10})(?::(\d{1,6})(?:[:-]\d{1,6})?|#L(\d{1,6}))?$/;
function createFileLinker(cwd, isFile = (p) => {
    try {
        return fs.statSync(p).isFile();
    }
    catch {
        return false;
    }
}) {
    let fence = "";
    let multi = 0;
    let lineStart = true;
    let held = "";
    const known = new Map();
    const anchorFor = (span) => {
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
        const Loc = vscode.Location;
        const Range = vscode.Range;
        return { anchor: line > 0 && Loc && Range ? new Loc(uri, new Range(line - 1, 0, line - 1, 0)) : uri };
    };
    const run = (text, final) => {
        const parts = [];
        let out = "";
        let i = 0;
        let nlAt = 0;
        const hold = (from) => {
            held = text.slice(from);
            i = text.length;
        };
        while (i < text.length) {
            const c = text[i];
            if (c === "\n") {
                if (lineStart) {
                    multi = 0;
                }
                lineStart = true;
                out += c;
                i += 1;
                continue;
            }
            if (lineStart && !multi) {
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
            }
            else {
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
        push: (chunk) => {
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
function emitAnswerParts(response, parts) {
    for (const part of parts) {
        if (typeof part === "string") {
            response.markdown(part);
        }
        else {
            response.anchor(part.anchor);
        }
    }
}
function stepUris(cwd, steps) {
    const out = [];
    for (const step of steps) {
        const raw = step.filePath?.trim();
        if (!raw) {
            continue;
        }
        try {
            out.push(vscode.Uri.file(path.isAbsolute(raw) ? raw : path.join(cwd, raw)));
        }
        catch {
        }
    }
    return out;
}
function splitModelPrefix(raw) {
    const m = raw.trim().match(/^(?:model|m)\s*[:=]\s*([^\s,]+)(?:,|\s|$)\s*([\s\S]*)$/i);
    const model = m?.[1].replace(/:$/, "");
    return m && model ? { model, task: m[2].trim() } : { task: raw.trim() };
}
function splitLanePrefixes(raw) {
    let rest = raw.trim();
    let model;
    let agent;
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
function splitModelsFanout(raw) {
    const m = raw.trim().match(/^models\s*[:=]\s*(\S+)\s*([\s\S]*)$/i);
    return m ? { models: m[1].split(",").map((x) => x.trim()).filter(Boolean), task: m[2].trim() } : undefined;
}
function parseChatPrompt(raw) {
    let rest = raw.trim();
    let kind = "plan";
    let model;
    let effort;
    let explicitKind = false;
    for (let i = 0; i < 5 && rest; i += 1) {
        const match = rest.match(/^(?:(plan|dev|parallel|par)\s*:|(?:model|m)\s*[:=]\s*(\S+)\s*:?|(?:effort\s*[:=]\s*|e[:=])([A-Za-z][\w-]{0,23})(?=\s|$))\s*/i);
        if (!match) {
            break;
        }
        if (match[1]) {
            const word = match[1].toLowerCase();
            kind = (word === "par" ? "parallel" : word);
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
function uniqueModels(candidates, cap = 4) {
    const out = [];
    const seen = new Set();
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
//# sourceMappingURL=context.js.map