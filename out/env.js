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
exports.existsQuiet = existsQuiet;
exports.readJsonc = readJsonc;
exports.openCodeConfigModel = openCodeConfigModel;
exports.discoverOpenCodeEnv = discoverOpenCodeEnv;
exports.summariseEnv = summariseEnv;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_process_1 = require("node:process");
function existsQuiet(target) {
    try {
        return fs.existsSync(target);
    }
    catch {
        return false;
    }
}
function opencodeGlobalDir() {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const explicit = process.env.OPENCODE_CONFIG_DIR;
    if (explicit) {
        return explicit;
    }
    const xdg = path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
    if (existsQuiet(xdg)) {
        return xdg;
    }
    if (node_process_1.platform === "win32" && process.env.APPDATA) {
        return path.join(process.env.APPDATA, "opencode");
    }
    return xdg;
}
function readJsonc(file) {
    try {
        const raw = fs.readFileSync(file, "utf8");
        const stripped = raw
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/(^|[^:])\/\/.*$/gm, "$1")
            .replace(/,\s*([}\]])/g, "$1");
        return JSON.parse(stripped);
    }
    catch {
        return undefined;
    }
}
function listDirNames(dir, ext) {
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((e) => (ext ? e.isFile() && e.name.endsWith(ext) : e.isDirectory() || e.isFile()))
            .map((e) => e.name.replace(ext ?? "", ""))
            .sort();
    }
    catch {
        return [];
    }
}
function listAgentFiles(dir, prefix = "", depth = 0) {
    if (depth > 3) {
        return [];
    }
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const out = [];
    for (const e of entries) {
        if (e.isDirectory()) {
            out.push(...listAgentFiles(path.join(dir, e.name), `${prefix}${e.name}/`, depth + 1));
        }
        else if (e.isFile() && e.name.endsWith(".md")) {
            out.push(prefix + e.name.slice(0, -3));
        }
    }
    return out.sort();
}
function listSkillDirs(dir) {
    return listDirNames(dir).filter((name) => existsQuiet(path.join(dir, name, "SKILL.md")));
}
function openCodeConfigModel(cwd) {
    const global = opencodeGlobalDir();
    const files = [
        [path.join(global, "config.json"), "global config.json"],
        [path.join(global, "opencode.json"), "global opencode.json"],
        [path.join(global, "opencode.jsonc"), "global opencode.jsonc"],
        [process.env.OPENCODE_CONFIG ?? "", "OPENCODE_CONFIG"],
        [path.join(cwd, "opencode.json"), "opencode.json"],
        [path.join(cwd, "opencode.jsonc"), "opencode.jsonc"],
        [path.join(cwd, ".opencode", "opencode.json"), ".opencode/opencode.json"],
        [path.join(cwd, ".opencode", "opencode.jsonc"), ".opencode/opencode.jsonc"]
    ];
    let found;
    for (const [file, from] of files) {
        const model = file && existsQuiet(file) ? readJsonc(file)?.model : undefined;
        if (typeof model === "string" && model.trim()) {
            found = { model: model.trim(), from };
        }
    }
    try {
        const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "null");
        if (typeof inline?.model === "string" && inline.model.trim()) {
            found = { model: inline.model.trim(), from: "OPENCODE_CONFIG_CONTENT" };
        }
    }
    catch {
    }
    return found;
}
function discoverOpenCodeEnv(cwd) {
    const out = [];
    const roots = [
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
            const parsed = readJsonc(cfg);
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
        for (const name of listDirNames(path.join(root, "command"), ".md").concat(listDirNames(path.join(root, "commands"), ".md"))) {
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
    for (const name of ["opencode.json", "opencode.jsonc"]) {
        const full = path.join(cwd, name);
        if (existsQuiet(full)) {
            out.push({ kind: "config", name, scope: "project", detail: full });
            const parsed = readJsonc(full);
            for (const plugin of parsed?.plugin ?? []) {
                out.push({ kind: "plugin", name: plugin, scope: "project" });
            }
            for (const server of Object.keys(parsed?.mcp ?? {})) {
                out.push({ kind: "mcp", name: server, scope: "project" });
            }
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
function summariseEnv(items) {
    if (!items.length) {
        return "_No OpenCode configuration, plugins, commands, skills, or hooks found._";
    }
    const order = [
        "config",
        "plugin",
        "hooks",
        "mcp",
        "agent",
        "command",
        "skill",
        "instructions"
    ];
    const label = {
        config: "Config",
        plugin: "Plugins",
        hooks: "Hooks",
        mcp: "MCP servers",
        agent: "Agents",
        command: "Commands",
        skill: "Skills",
        instructions: "Instruction files"
    };
    const lines = [];
    for (const kind of order) {
        const group = items.filter((i) => i.kind === kind);
        if (!group.length) {
            continue;
        }
        const rendered = group
            .slice(0, 24)
            .map((i) => `\`${i.name}\`${i.scope === "global" ? " ᵍ" : ""}`)
            .join(", ");
        lines.push(`- **${label[kind]}** (${group.length}): ${rendered}` +
            (group.length > 24 ? ` _…and ${group.length - 24} more_` : ""));
    }
    lines.push("", "_ᵍ = global config; everything else is this project._");
    return lines.join("\n");
}
//# sourceMappingURL=env.js.map