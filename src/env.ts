// OpenCode environment discovery. OpenCode is extensible through config,
// commands, skills, agents, hook files and npm plugins, and NONE of that is
// visible from inside this extension. When a run behaves oddly the first
// question is always "what else is loaded?" — a hook that blocks a tool, a
// context-pruning plugin rewriting messages, a project agent overriding the
// model. This reads the same locations OpenCode reads and reports them. It
// never executes or parses plugin code; it lists.
//
// This module deliberately imports only the node standard library — no
// `vscode`, no `core` — so discovery can never block activation or a chat turn
// on a VS Code API.

import * as fs from "node:fs";
import * as path from "node:path";
import { platform } from "node:process";

export interface EnvItem {
    kind: "config" | "plugin" | "command" | "skill" | "agent" | "hooks" | "instructions" | "mcp";
    name: string;
    scope: "global" | "project";
    detail?: string;
}

export function existsQuiet(target: string): boolean {
    try {
        return fs.existsSync(target);
    } catch {
        return false;
    }
}

function opencodeGlobalDir(): string {
    // Matches OpenCode's own search order, including the Windows fallback.
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const explicit = process.env.OPENCODE_CONFIG_DIR;
    if (explicit) {
        return explicit;
    }
    // XDG_CONFIG_HOME first, as OpenCode's own path resolution does.
    const xdg = path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
    if (existsQuiet(xdg)) {
        return xdg;
    }
    if (platform === "win32" && process.env.APPDATA) {
        return path.join(process.env.APPDATA, "opencode");
    }
    return xdg;
}

export function readJsonc<T>(file: string): T | undefined {
    try {
        const raw = fs.readFileSync(file, "utf8");
        // opencode.json / dcp.jsonc allow comments and trailing commas.
        const stripped = raw
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/(^|[^:])\/\/.*$/gm, "$1")
            .replace(/,\s*([}\]])/g, "$1");
        return JSON.parse(stripped) as T;
    } catch {
        return undefined;
    }
}

function listDirNames(dir: string, ext?: string): string[] {
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((e) => (ext ? e.isFile() && e.name.endsWith(ext) : e.isDirectory() || e.isFile()))
            .map((e) => e.name.replace(ext ?? "", ""))
            .sort();
    } catch {
        return [];
    }
}

// Agent files are `{agent,agents}/**/*.md` (1.18.32's loader), named by their
// path below that folder: `agents/team/look.md` is `team/look`.
function listAgentFiles(dir: string, prefix = "", depth = 0): string[] {
    if (depth > 3) {
        return [];
    }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out: string[] = [];
    for (const e of entries) {
        if (e.isDirectory()) {
            out.push(...listAgentFiles(path.join(dir, e.name), `${prefix}${e.name}/`, depth + 1));
        } else if (e.isFile() && e.name.endsWith(".md")) {
            out.push(prefix + e.name.slice(0, -3));
        }
    }
    return out.sort();
}

// A skill is a folder holding SKILL.md; a stray README.md beside them is not one.
function listSkillDirs(dir: string): string[] {
    return listDirNames(dir).filter((name) => existsQuiet(path.join(dir, name, "SKILL.md")));
}

/**
 * The `model` OpenCode's own config sets, as OpenCode reads it — later files
 * win: global (config.json, opencode.json, opencode.jsonc), `OPENCODE_CONFIG`,
 * the folder's opencode.json(c), `.opencode/opencode.json(c)`,
 * `OPENCODE_CONFIG_CONTENT`. Advisory (for /model): the server may run with a
 * different environment.
 */
export function openCodeConfigModel(cwd: string): { model: string; from: string } | undefined {
    const global = opencodeGlobalDir();
    const files: Array<[string, string]> = [
        [path.join(global, "config.json"), "global config.json"],
        [path.join(global, "opencode.json"), "global opencode.json"],
        [path.join(global, "opencode.jsonc"), "global opencode.jsonc"],
        [process.env.OPENCODE_CONFIG ?? "", "OPENCODE_CONFIG"],
        [path.join(cwd, "opencode.json"), "opencode.json"],
        [path.join(cwd, "opencode.jsonc"), "opencode.jsonc"],
        [path.join(cwd, ".opencode", "opencode.json"), ".opencode/opencode.json"],
        [path.join(cwd, ".opencode", "opencode.jsonc"), ".opencode/opencode.jsonc"]
    ];
    let found: { model: string; from: string } | undefined;
    for (const [file, from] of files) {
        const model = file && existsQuiet(file) ? readJsonc<{ model?: unknown }>(file)?.model : undefined;
        if (typeof model === "string" && model.trim()) {
            found = { model: model.trim(), from };
        }
    }
    try {
        const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "null") as { model?: unknown } | null;
        if (typeof inline?.model === "string" && inline.model.trim()) {
            found = { model: inline.model.trim(), from: "OPENCODE_CONFIG_CONTENT" };
        }
    } catch {
        // not JSON: OpenCode would reject it too
    }
    return found;
}

export function discoverOpenCodeEnv(cwd: string): EnvItem[] {
    const out: EnvItem[] = [];
    const roots: Array<["global" | "project", string]> = [
        ["global", opencodeGlobalDir()],
        ["project", path.join(cwd, ".opencode")]
    ];

    for (const [scope, root] of roots) {
        if (!existsQuiet(root)) {
            continue;
        }
        for (const cfgName of ["opencode.json", "opencode.jsonc"]) {
            const cfg = path.join(root, cfgName);
            if (!existsQuiet(cfg)) {
                continue;
            }
            out.push({ kind: "config", name: cfgName, scope, detail: cfg });
            const parsed = readJsonc<{
                plugin?: string[];
                mcp?: Record<string, unknown>;
                model?: string;
                agent?: Record<string, unknown>;
            }>(cfg);
            for (const plugin of parsed?.plugin ?? []) {
                out.push({ kind: "plugin", name: plugin, scope });
            }
            for (const server of Object.keys(parsed?.mcp ?? {})) {
                out.push({ kind: "mcp", name: server, scope });
            }
            for (const agent of Object.keys(parsed?.agent ?? {})) {
                out.push({ kind: "agent", name: agent, scope, detail: "from config" });
            }
            if (parsed?.model) {
                out.push({ kind: "config", name: `model = ${parsed.model}`, scope });
            }
        }
        // A project opencode.json can also sit at the repo root, not under .opencode.
        for (const name of listDirNames(path.join(root, "command"), ".md").concat(
            listDirNames(path.join(root, "commands"), ".md")
        )) {
            out.push({ kind: "command", name, scope });
        }
        for (const dir of ["skill", "skills"]) {
            for (const name of listSkillDirs(path.join(root, dir))) {
                out.push({ kind: "skill", name, scope });
            }
        }
        const agentFiles = new Set(["agent", "agents"].flatMap((dir) => listAgentFiles(path.join(root, dir))));
        for (const name of [...agentFiles].sort()) {
            out.push({ kind: "agent", name, scope });
        }
        for (const dir of ["mode", "modes"]) {
            for (const name of listDirNames(path.join(root, dir), ".md")) {
                out.push({ kind: "agent", name, scope, detail: "primary mode" });
            }
        }
        for (const hookFile of ["hook/hooks.yaml", "hook/hooks.yml", "hooks.yaml"]) {
            const full = path.join(root, hookFile);
            if (existsQuiet(full)) {
                out.push({ kind: "hooks", name: hookFile, scope, detail: full });
            }
        }
        for (const dcp of ["dcp.jsonc", "dcp.json"]) {
            if (existsQuiet(path.join(root, dcp))) {
                out.push({ kind: "config", name: `dcp (${dcp})`, scope, detail: "context pruning active" });
            }
        }
    }

    // Root-level project config and instruction files OpenCode loads itself.
    for (const name of ["opencode.json", "opencode.jsonc"]) {
        const full = path.join(cwd, name);
        if (existsQuiet(full)) {
            out.push({ kind: "config", name, scope: "project", detail: full });
            const parsed = readJsonc<{
                plugin?: string[];
                mcp?: Record<string, unknown>;
                model?: string;
                agent?: Record<string, unknown>;
            }>(full);
            for (const plugin of parsed?.plugin ?? []) {
                out.push({ kind: "plugin", name: plugin, scope: "project" });
            }
            for (const server of Object.keys(parsed?.mcp ?? {})) {
                out.push({ kind: "mcp", name: server, scope: "project" });
            }
            // The root file sets these as much as .opencode/'s does.
            for (const agent of Object.keys(parsed?.agent ?? {})) {
                out.push({ kind: "agent", name: agent, scope: "project", detail: "from config" });
            }
            if (parsed?.model) {
                out.push({ kind: "config", name: `model = ${parsed.model}`, scope: "project" });
            }
        }
    }
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        if (existsQuiet(path.join(cwd, name))) {
            out.push({ kind: "instructions", name, scope: "project" });
        }
    }
    return out;
}

export function summariseEnv(items: EnvItem[]): string {
    if (!items.length) {
        return "_No OpenCode configuration, plugins, commands, skills, or hooks found._";
    }
    const order: EnvItem["kind"][] = [
        "config",
        "plugin",
        "hooks",
        "mcp",
        "agent",
        "command",
        "skill",
        "instructions"
    ];
    const label: Record<EnvItem["kind"], string> = {
        config: "Config",
        plugin: "Plugins",
        hooks: "Hooks",
        mcp: "MCP servers",
        agent: "Agents",
        command: "Commands",
        skill: "Skills",
        instructions: "Instruction files"
    };
    const lines: string[] = [];
    for (const kind of order) {
        const group = items.filter((i) => i.kind === kind);
        if (!group.length) {
            continue;
        }
        const rendered = group
            .slice(0, 24)
            .map((i) => `\`${i.name}\`${i.scope === "global" ? " ᵍ" : ""}`)
            .join(", ");
        lines.push(
            `- **${label[kind]}** (${group.length}): ${rendered}` +
            (group.length > 24 ? ` _…and ${group.length - 24} more_` : "")
        );
    }
    lines.push("", "_ᵍ = global config; everything else is this project._");
    return lines.join("\n");
}