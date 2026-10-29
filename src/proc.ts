// Process launching. This is the ONLY place shim resolution, cmd.exe quoting and
// prefixArgs live — AGENTS.md §2 rule 3. The single permitted spawn outside
// spawnOpenCode is the taskkill in killTree, which takes no user text.
import { spawn, ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { platform } from "node:process";

import { config, logChannel, stamp } from "./core";
import { enforcedConfigContent, executableMajor } from "./enforce";

export interface ResolvedExe {
    command: string;
    target: string;
    viaCmd: boolean;
    // Arguments the shim itself supplied, e.g. the script path in `node cli.js %*`.
    prefixArgs: string[];
    // Keep the wrapper too: an upgrade can retarget it without changing the old binary.
    launcher: string;
}

const exeCache = new Map<string, ResolvedExe>();

// Quoting for a cmd.exe command line. Doubling `"` is the only escape cmd
// understands inside a quoted token; everything else (& | > < ^ parentheses)
// is then literal. `%` is deliberately left alone: cmd expands `%VAR%` before
// quotes are considered and there is no command-line escape for it, so the
// only real fix is to avoid cmd entirely (see preferNonCmdSibling).
export function quoteCmdArg(arg: string): string {
    return `"${arg.replace(/"/g, '""')}"`;
}

function lookupOnPath(exe: string): string | undefined {
    if (exe.includes("/") || exe.includes("\\")) {
        return exe;
    }
    const dirs = (process.env.PATH ?? "").split(path.delimiter);
    const hasExt = path.extname(exe) !== "";
    // Windows only executes files whose extension is in PATHEXT, so an
    // extensionless match on PATH (npm drops a bare shell script next to the
    // .cmd shim) must never be picked.
    const names =
        platform !== "win32" || hasExt
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
            } catch {
                // skip unreadable entries
            }
        }
    }
    return undefined;
}

// A `.cmd`/`.bat` shim has to go through cmd.exe, which mangles `%VAR%` in the
// prompt. npm installs usually drop a real `.exe` next to the shim, so prefer it.
function preferNonCmdSibling(target: string): string {
    const dir = path.dirname(target);
    const base = path.basename(target, path.extname(target));
    for (const ext of [".exe", ".com"]) {
        const candidate = path.join(dir, base + ext);
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            // fall through to the shim
        }
    }
    return target;
}

export function tokenizeCmdLine(line: string): string[] {
    const out: string[] = [];
    let current = "";
    let quoted = false;
    for (const ch of line) {
        if (ch === '"') {
            quoted = !quoted;
        } else if (!quoted && (ch === " " || ch === "\t")) {
            if (current) {
                out.push(current);
                current = "";
            }
        } else {
            current += ch;
        }
    }
    if (current) {
        out.push(current);
    }
    return out;
}

// npm's own shim only ever refers to its own directory, so `%dp0%`/`%~dp0` are the
// only variables worth expanding. Anything still holding a `%` is rejected rather
// than guessed at, and the shim falls back to cmd.exe.
export function expandShimVar(token: string, dir: string): string {
    const expanded = token.replace(/%~?dp0%?/gi, `${dir}${path.sep}`);
    return /%/.test(expanded) ? expanded : path.normalize(expanded);
}

// The npm shim for a binary package points at `node_modules/<pkg>/bin/<name>.exe`,
// which is NOT a sibling of the shim, so preferNonCmdSibling misses it. Read the
// line that forwards `%*` and spawn what it names directly — that is the only way
// a prompt with newlines or `%` reaches OpenCode intact on Windows.
export function readShimTarget(shim: string): { target: string; prefixArgs: string[] } | undefined {
    let text: string;
    try {
        if (fs.statSync(shim).size > 65536) {
            return undefined;
        }
        text = fs.readFileSync(shim, "utf8");
    } catch {
        return undefined;
    }
    const dir = path.dirname(shim);
    const execLines = text.split(/\r?\n/).filter((line) => line.includes("%*"));
    for (const raw of execLines.reverse()) {
        const tokens = tokenizeCmdLine(raw.replace(/^\s*@?\s*(?:call\s+)?/i, "").trim()).filter(
            (token) => token !== "%*"
        );
        if (!tokens.length) {
            continue;
        }
        const head = expandShimVar(tokens[0], dir);
        if (!head || /%/.test(head)) {
            continue;
        }
        const target = lookupOnPath(head);
        const lower = target?.toLowerCase() ?? "";
        // Never chain into another shim: that reintroduces the cmd.exe hop.
        if (!target || lower.endsWith(".cmd") || lower.endsWith(".bat")) {
            continue;
        }
        try {
            if (!fs.statSync(target).isFile()) {
                continue;
            }
        } catch {
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

export function resolveExecutable(exe: string): ResolvedExe {
    const cached = exeCache.get(exe);
    if (cached) {
        return cached;
    }
    // `~/…` is the home folder, as a shell reads it; a spawn would not.
    const named = /^~(?=$|[\\/])/.test(exe) ? path.join(os.homedir(), exe.slice(1)) : exe;
    let target = lookupOnPath(named) ?? (named.includes("/") || named.includes("\\") ? named : undefined);
    let prefixArgs: string[] = [];
    if (!target) {
        const err = new Error(`spawn ${exe} ENOENT`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
    }
    const launcher = target;
    let lower = target.toLowerCase();
    if (platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
        const sibling = preferNonCmdSibling(target);
        if (sibling !== target) {
            target = sibling;
        } else {
            const shim = readShimTarget(target);
            if (shim) {
                target = shim.target;
                prefixArgs = shim.prefixArgs;
            }
        }
        lower = target.toLowerCase();
    }
    const viaCmd = platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"));
    const resolved: ResolvedExe = {
        command: viaCmd ? process.env.ComSpec || "cmd.exe" : target,
        target,
        viaCmd,
        prefixArgs,
        launcher
    };
    exeCache.set(exe, resolved);
    return resolved;
}

/** The files `exe` runs as they are on disk now: the resolved target and a
 * script a shim hands it. An installer that replaces a binary in place keeps
 * the name and changes this. `forget` resolves the name afresh first (an npm
 * shim names another file after an upgrade). Throws as resolveExecutable does. */
export function executableStamp(exe: string, forget = false): string {
    if (forget) {
        exeCache.delete(exe);
    }
    const resolved = resolveExecutable(exe);
    return [...new Set([resolved.launcher, resolved.target, ...resolved.prefixArgs])]
        .map((file) => {
            try {
                const s = fs.statSync(file);
                return s.isFile() ? `${file}:${s.size}:${s.mtimeMs}:${s.ino}` : "";
            } catch {
                return "";
            }
        })
        .join("|");
}

// `dataHome`: OpenCode's data folder (`XDG_DATA_HOME`) for every process the
// bridge starts, so a 1.x keeps a folder of its own beside 2.x's
// (docs/data-folder-design.md). `~/` is the home folder; empty is the host's.
export function dataHomeEnv(): { XDG_DATA_HOME?: string } {
    const raw = config().get<string>("dataHome", "").trim();
    if (!raw) {
        return {};
    }
    return { XDG_DATA_HOME: /^~(?=$|[\\/])/.test(raw) ? path.join(os.homedir(), raw.slice(1)) : raw };
}

export function spawnOpenCode(
    executable: string,
    args: string[],
    cwd?: string
): ChildProcessWithoutNullStreams {
    const resolved = resolveExecutable(executable);
    const full = resolved.prefixArgs.length ? [...resolved.prefixArgs, ...args] : args;
    logChannel.appendLine(`[${stamp()}] $ ${resolved.target} ${full.join(" ")}`);
    // `opencode run` works in `process.env.PWD ?? process.cwd()` (the
    // 1.18.32 binary's run handler; the TUI does the same), and the `cwd` spawn
    // option leaves PWD as the extension host's — the folder VS Code was launched
    // from. A CLI run could work in, and edit, that folder instead of `cwd`:
    // `code ~/proj` from $HOME, a multi-root workspace, Git Bash on Windows
    // (PWD=/c/Users/…). Attached and server runs pass --dir / ?directory=.
    // Measured with scripts/probe-opencode-pwd.js; check PW.
    // Read-only turns are read-only by permission in every process started here
    // (./enforce): one place, so serve, run, agent list and an ACP child agree.
    const enforced = enforcedConfigContent(process.env.OPENCODE_CONFIG_CONTENT, executableMajor(executable));
    const env = { ...process.env, ...dataHomeEnv(), ...(cwd ? { PWD: cwd } : {}), ...(enforced ? { OPENCODE_CONFIG_CONTENT: enforced } : {}) };
    if (resolved.viaCmd) {
        // Node escapes quotes with backslashes, which cmd.exe does not understand,
        // so the command line is built by hand and passed verbatim. The extra outer
        // quotes are the pair that `/s` strips.
        const line = `"${[resolved.target, ...full].map(quoteCmdArg).join(" ")}"`;
        return spawn(resolved.command, ["/d", "/s", "/c", line], {
            cwd,
            env,
            shell: false,
            windowsVerbatimArguments: true
        });
    }
    return spawn(resolved.command, full, { cwd, env, shell: false });
}

// A short command's whole output (`--version`, `agent list`): stdout and stderr
// together, bounded; diagnostics resolve errors, identity checks reject them.
export function runCapture(executable: string, args: string[], cwd: string, timeoutMs = 8000, requireSuccess = false): Promise<string> {
    return new Promise((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawnOpenCode(executable, args, cwd);
        } catch (error) {
            if (requireSuccess) {
                reject(error);
                return;
            }
            resolve(`error: ${(error as Error).message}`);
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
        const keep = (chunk: string): void => {
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

// Kill a child and its descendants. On Windows a `.cmd`/`.bat` shim is spawned
// through cmd.exe, so child.kill() only terminates that shell and leaves the real
// opencode process running — taskkill /T reaps the whole tree.
export function killTree(child: ChildProcess): void {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode) {
        return;
    }
    if (platform === "win32") {
        try {
            const reaper = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
            // spawn reports failure ASYNCHRONOUSLY, so the try/catch above never
            // sees it. An unhandled "error" on a ChildProcess is an uncaught
            // exception in the extension host — the whole window goes down
            // because a timeout tried to reap a run. Fall back to the plain kill.
            reaper.on("error", () => {
                try {
                    child.kill();
                } catch {
                    // the child is already gone
                }
            });
            return;
        } catch {
            // fall through to the plain kill below
        }
    }
    child.kill();
}
