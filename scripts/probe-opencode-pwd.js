#!/usr/bin/env node
// PWD probe: which directory does `opencode run` work in — the spawn cwd, or
// the PWD it inherits?
//
// Why it exists: the 1.18.32 binary's run handler resolves its directory as
// `process.env.PWD ?? process.cwd()`, and Node's cwd option does not touch
// PWD. v0.0.182 and earlier handed every CLI run the extension host's PWD — the
// folder VS Code was launched from — so a cold /dev run, a server-unreachable
// fallback or a no-server /worktree run could work in (and edit) the wrong
// folder. v0.0.183 sets PWD = cwd in spawnOpenCode().
//
// No model call and no cost: a model id that cannot resolve makes `run` create
// its session — logging the directory — and exit in ~2s. Writes only under the
// OS temp dir (AGENTS §4). Case A must show the WRONG folder, or this machine's
// OpenCode no longer reads PWD and the probe measured nothing.
//
//   node scripts/probe-opencode-pwd.js [path-to-opencode]
//
// Run `npm run compile` first: case B loads the shipped out/proc.js.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { spawn } = require("node:child_process");

const exe = process.argv[2] || "opencode";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-pwd-"));
const target = path.join(root, "target");
const stale = path.join(root, "stale");
fs.mkdirSync(target);
fs.mkdirSync(stale);
fs.writeFileSync(path.join(target, "TARGET.txt"), "the folder the bridge chose\n");

// out/proc.js imports ./core, which imports vscode; nothing here needs more
// than a settings reader and a log sink.
const realLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === "vscode") {
        return { workspace: { getConfiguration: () => ({ get: (_k, d) => d }) }, window: {} };
    }
    return realLoad.call(this, request, ...rest);
};
const core = require(path.join(__dirname, "..", "out", "core.js"));
core.setLogChannel({ appendLine() {}, show() {}, dispose() {} });
const { spawnOpenCode, resolveExecutable } = require(path.join(__dirname, "..", "out", "proc.js"));

const ARGS = ["run", "--print-logs", "-m", "ocb-probe/no-such-model", "probe"];
const CREATED = /message=created id=\S+ .*?directory=(\S+)/;

const collect = (child) =>
    new Promise((resolve) => {
        let out = "";
        child.stdout?.on("data", (d) => (out += d));
        child.stderr?.on("data", (d) => (out += d));
        child.stdin?.end();
        const timer = setTimeout(() => child.kill(), 60000);
        child.on("error", (e) => (out += `\nspawn error: ${e.message}`));
        child.on("close", () => {
            clearTimeout(timer);
            resolve((out.match(CREATED) || [])[1] || `(no "created" log line — output starts: ${JSON.stringify(out.slice(0, 160))})`);
        });
    });

// The pre-v183 shape: cwd set, PWD left as whatever the parent had.
const rawSpawn = (pwd) => {
    const r = resolveExecutable(exe);
    return spawn(r.command, [...r.prefixArgs, ...ARGS], {
        cwd: target,
        env: { ...process.env, PWD: pwd },
        shell: Boolean(r.viaCmd),
        windowsHide: true
    });
};

const same = (a, b) => {
    try {
        return fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
        return false;
    }
};

(async () => {
    console.log(`opencode: ${resolveExecutable(exe).target}`);
    console.log(`target  : ${target}`);
    console.log(`stale   : ${stale}\n`);

    const a = await collect(rawSpawn(stale));
    const savedPwd = process.env.PWD;
    process.env.PWD = stale; // what the extension host would have inherited
    const b = await collect(spawnOpenCode(exe, ARGS, target));
    process.env.PWD = savedPwd;
    const c = await collect(rawSpawn(target));

    const row = (label, dir) => console.log(`${label.padEnd(46)} ${same(dir, target) ? "target " : same(dir, stale) ? "STALE  " : "?      "} ${dir}`);
    row("A  raw spawn, cwd=target, PWD=stale (≤v182)", a);
    row("B  spawnOpenCode(target), host PWD=stale (v183)", b);
    row("C  raw spawn, cwd=target, PWD=target (control)", c);

    console.log(
        `\nopencode run follows PWD over cwd on this machine: ${same(a, stale) ? "YES" : same(a, target) ? "no" : "unknown"}`
    );
    console.log(`the bridge's spawnOpenCode lands in the chosen folder: ${same(b, target) ? "YES" : "NO — investigate"}`);
    fs.rmSync(root, { recursive: true, force: true });
})();
