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
exports.executableStamp = executableStamp;
exports.dataHomeEnv = dataHomeEnv;
exports.spawnOpenCode = spawnOpenCode;
exports.runCapture = runCapture;
exports.killTree = killTree;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_process_1 = require("node:process");
const core_1 = require("./core");
const enforce_1 = require("./enforce");
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
    const named = /^~(?=$|[\\/])/.test(exe) ? path.join(os.homedir(), exe.slice(1)) : exe;
    let target = lookupOnPath(named) ?? (named.includes("/") || named.includes("\\") ? named : undefined);
    let prefixArgs = [];
    if (!target) {
        const err = new Error(`spawn ${exe} ENOENT`);
        err.code = "ENOENT";
        throw err;
    }
    const launcher = target;
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
        prefixArgs,
        launcher
    };
    exeCache.set(exe, resolved);
    return resolved;
}
function executableStamp(exe, forget = false) {
    if (forget) {
        exeCache.delete(exe);
    }
    const resolved = resolveExecutable(exe);
    return [...new Set([resolved.launcher, resolved.target, ...resolved.prefixArgs])]
        .map((file) => {
        try {
            const s = fs.statSync(file);
            return s.isFile() ? `${file}:${s.size}:${s.mtimeMs}:${s.ino}` : "";
        }
        catch {
            return "";
        }
    })
        .join("|");
}
function dataHomeEnv() {
    const raw = (0, core_1.config)().get("dataHome", "").trim();
    if (!raw) {
        return {};
    }
    return { XDG_DATA_HOME: /^~(?=$|[\\/])/.test(raw) ? path.join(os.homedir(), raw.slice(1)) : raw };
}
function spawnOpenCode(executable, args, cwd) {
    const resolved = resolveExecutable(executable);
    const full = resolved.prefixArgs.length ? [...resolved.prefixArgs, ...args] : args;
    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] $ ${resolved.target} ${full.join(" ")}`);
    const enforced = (0, enforce_1.enforcedConfigContent)(process.env.OPENCODE_CONFIG_CONTENT, (0, enforce_1.executableMajor)(executable));
    const env = { ...process.env, ...dataHomeEnv(), ...(cwd ? { PWD: cwd } : {}), ...(enforced ? { OPENCODE_CONFIG_CONTENT: enforced } : {}) };
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
function runCapture(executable, args, cwd, timeoutMs = 8000, requireSuccess = false) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawnOpenCode(executable, args, cwd);
        }
        catch (error) {
            if (requireSuccess) {
                reject(error);
                return;
            }
            resolve(`error: ${error.message}`);
            return;
        }
        let out = "";
        let overflow = false;
        const timer = setTimeout(() => {
            killTree(child);
            if (requireSuccess) {
                reject(new Error(`OpenCode identity check timed out after ${timeoutMs} ms`));
                return;
            }
            resolve(out.trim() || "timed out");
        }, timeoutMs);
        child.stdin?.end();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        const keep = (chunk) => {
            if (out.length + chunk.length > 65536) {
                overflow = true;
            }
            out = (out + chunk).slice(0, 65536);
        };
        child.stdout.on("data", keep);
        child.stderr.on("data", keep);
        child.on("error", (err) => {
            clearTimeout(timer);
            if (requireSuccess) {
                reject(err);
                return;
            }
            resolve(`error: ${err.message}`);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (requireSuccess && (code !== 0 || overflow)) {
                reject(new Error(`OpenCode identity check exited with code ${code}`));
                return;
            }
            resolve(out.trim() || "(no output)");
        });
    });
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