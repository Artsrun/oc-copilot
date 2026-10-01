import * as vscode from "vscode";
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