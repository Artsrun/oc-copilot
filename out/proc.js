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
exports.quoteCmdArg = quoteCmdArg;
exports.tokenizeCmdLine = tokenizeCmdLine;
exports.expandShimVar = expandShimVar;
exports.readShimTarget = readShimTarget;
exports.resolveExecutable = resolveExecutable;
exports.spawnOpenCode = spawnOpenCode;
exports.killTree = killTree;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_process_1 = require("node:process");
const core_1 = require("./core");
const exeCache = new Map();
function quoteCmdArg(arg) {
    return `"${arg.replace(/"/g, '""')}"`;
}
function lookupOnPath(exe) {
    if (exe.includes("/") || exe.includes("\\")) {
        return exe;
    }
    const dirs = (process.env.PATH ?? "").split(path.delimiter);
    const hasExt = path.extname(exe) !== "";
    const names = node_process_1.platform !== "win32" || hasExt
        ? [exe]
        : (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .filter(Boolean)
            .map((ext) => exe + ext);
    for (const dir of dirs) {
        for (const name of names) {
            const candidate = path.join(dir, name);
            try {
                if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                    return candidate;
                }
            }
            catch {
            }
        }
    }
    return undefined;
}
function preferNonCmdSibling(target) {
    const dir = path.dirname(target);
    const base = path.basename(target, path.extname(target));
    for (const ext of [".exe", ".com"]) {
        const candidate = path.join(dir, base + ext);
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return candidate;
            }
        }
        catch {
        }
    }
    return target;
}
function tokenizeCmdLine(line) {
    const out = [];
    let current = "";
    let quoted = false;
    for (const ch of line) {
        if (ch === '"') {
            quoted = !quoted;
        }
        else if (!quoted && (ch === " " || ch === "\t")) {
            if (current) {
                out.push(current);
                current = "";
            }
        }
        else {
            current += ch;
        }
    }
    if (current) {
        out.push(current);
    }
    return out;
}
function expandShimVar(token, dir) {
    const expanded = token.replace(/%~?dp0%?/gi, `${dir}${path.sep}`);
    return /%/.test(expanded) ? expanded : path.normalize(expanded);
}
function readShimTarget(shim) {
    let text;
    try {
        if (fs.statSync(shim).size > 65536) {
            return undefined;
        }
        text = fs.readFileSync(shim, "utf8");
    }
    catch {
        return undefined;
    }
    const dir = path.dirname(shim);
    const execLines = text.split(/\r?\n/).filter((line) => line.includes("%*"));
    for (const raw of execLines.reverse()) {
        const tokens = tokenizeCmdLine(raw.replace(/^\s*@?\s*(?:call\s+)?/i, "").trim()).filter((token) => token !== "%*");
        if (!tokens.length) {
            continue;
        }
        const head = expandShimVar(tokens[0], dir);
        if (!head || /%/.test(head)) {
            continue;
        }
        const target = lookupOnPath(head);
        const lower = target?.toLowerCase() ?? "";
        if (!target || lower.endsWith(".cmd") || lower.endsWith(".bat")) {
            continue;
        }
        try {
            if (!fs.statSync(target).isFile()) {
                continue;
            }
        }
        catch {
            continue;
        }
        const prefixArgs = tokens.slice(1).map((token) => expandShimVar(token, dir));
        if (prefixArgs.some((arg) => /%/.test(arg))) {
            continue;
        }
        return { target, prefixArgs };
    }
    return undefined;
}
function resolveExecutable(exe) {
    const cached = exeCache.get(exe);
    if (cached) {
        return cached;
    }
    let target = lookupOnPath(exe) ?? (exe.includes("/") || exe.includes("\\") ? exe : undefined);
    let prefixArgs = [];
    if (!target) {
        const err = new Error(`spawn ${exe} ENOENT`);
        err.code = "ENOENT";
        throw err;
    }
    let lower = target.toLowerCase();
    if (node_process_1.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
        const sibling = preferNonCmdSibling(target);
        if (sibling !== target) {
            target = sibling;
        }
        else {
            const shim = readShimTarget(target);
            if (shim) {
                target = shim.target;
                prefixArgs = shim.prefixArgs;
            }
        }
        lower = target.toLowerCase();
    }
    const viaCmd = node_process_1.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"));
    const resolved = {
        command: viaCmd ? process.env.ComSpec || "cmd.exe" : target,
        target,
        viaCmd,
        prefixArgs
    };
    exeCache.set(exe, resolved);
    return resolved;
}
function spawnOpenCode(executable, args, cwd) {
    const resolved = resolveExecutable(executable);
    const full = resolved.prefixArgs.length ? [...resolved.prefixArgs, ...args] : args;
    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] $ ${resolved.target} ${full.join(" ")}`);
    const env = cwd ? { ...process.env, PWD: cwd } : process.env;
    if (resolved.viaCmd) {
        const line = `"${[resolved.target, ...full].map(quoteCmdArg).join(" ")}"`;
        return (0, node_child_process_1.spawn)(resolved.command, ["/d", "/s", "/c", line], {
            cwd,
            env,
            shell: false,
            windowsVerbatimArguments: true
        });
    }
    return (0, node_child_process_1.spawn)(resolved.command, full, { cwd, env, shell: false });
}
function killTree(child) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode) {
        return;
    }
    if (node_process_1.platform === "win32") {
        try {
            const reaper = (0, node_child_process_1.spawn)("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
            reaper.on("error", () => {
                try {
                    child.kill();
                }
                catch {
                }
            });
            return;
        }
        catch {
        }
    }
    child.kill();
}
//# sourceMappingURL=proc.js.map