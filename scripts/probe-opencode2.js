#!/usr/bin/env node
// OpenCode 2 probe (0.0.222): with `opencode2` on, the bridge's own code (out/:
// runOpenCode → the server runner, ensureServer, oc-api's 2.x routes, the
// translated event stream) against a REAL 2.x binary and the scripted model
// (probe-model.js, this process). One line per row; a control row must be
// CREATED, or this binary never attempted the write and the probe measured nothing.
//
//   npm run compile && node scripts/probe-opencode2.js <path-to-opencode-2>
//
// Writes only under the OS temp dir (AGENTS §4): a git repo and an isolated HOME.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const { startScriptedModel, projectConfig } = require("./probe-model");

const exe = process.argv[2] || "opencode";
const settings = { executable: exe, opencode2: true, enforceReadOnly: true, readOnlySubagents: ["explore"], serverPort: 0, serverHostname: "127.0.0.1", transport: "server" };
const realLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === "vscode") {
        return {
            workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }), workspaceFolders: undefined, isTrusted: true },
            window: {},
            Uri: { file: (p) => ({ fsPath: p }) },
            EventEmitter: class {
                event = () => ({ dispose() {} });
                fire() {}
                dispose() {}
            }
        };
    }
    return realLoad.call(this, request, ...rest);
};
const out = (name) => require(path.join(__dirname, "..", "out", name));
const log = [];
out("core.js").setLogChannel({ appendLine: (l) => log.push(l), show() {}, dispose() {} });
const { runOpenCode } = out("run-cli.js");
const { ensureServer, stopServer } = out("net.js");
const { listSessions, sessionExcerpt } = out("sessions.js");
const { compactSession } = out("server-session.js");

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-probe-oc2-"));
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: project });
    git("init", "-q");
    fs.writeFileSync(path.join(project, "README"), "probe\n");
    git("add", ".");
    git("commit", "-qm", "init");
    Object.assign(process.env, {
        HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local", "state"),
        OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost"
    });
    delete process.env.OPENCODE_CONFIG_CONTENT;
    const model = await startScriptedModel({});
    fs.writeFileSync(path.join(project, "opencode.json"), JSON.stringify(projectConfig(model.url), null, 1));

    const rows = [];
    const target = (n) => {
        const file = path.join(project, `w-${n}.txt`);
        fs.rmSync(file, { force: true });
        return file;
    };
    const turn = (task, extra = {}) => {
        const said = [];
        const steps = [];
        const opts = {
            executable: exe, task, cwd: project, agent: "build", model: "probe/scripted", pure: false, autoApprove: false,
            json: true, timeoutMs: 90000, idleTimeoutMs: 60000, thinking: false,
            onText: (t) => said.push(t), onStep: (s) => steps.push(`${s.tool}:${s.status}`), ...extra
        };
        return runOpenCode(opts).then((metrics) => ({ metrics, text: said.join(""), steps }));
    };
    const row = async (label, expect, run) => {
        const t0 = Date.now();
        let got;
        let note = "";
        try {
            [got, note] = await run();
        } catch (error) {
            got = "error";
            note = error.message.slice(0, 200);
        }
        rows.push({ label, expect, got });
        console.log(`${got === expect ? "ok  " : "FAIL"} ${label}: ${got}${got === expect ? "" : ` (expected ${expect})`} · ${Date.now() - t0} ms${note ? ` · ${note}` : ""}`);
    };
    const wrote = (file) => (fs.existsSync(file) ? "CREATED" : "absent");
    // A shell parses the command: 2.x on Windows runs Git Bash (2.0.18,
    // 2.0.32), where an unquoted `C:\…` loses its backslashes, so a control's
    // file landed as `C:Users…w-4.txt` in the project and read "absent" here.
    // Forward slashes reach the same file in bash, cmd and PowerShell (REFS).
    const echoTo = (file) => `echo hi > ${file.replace(/\\/g, "/")}`;

    await row("build · text turn streams and answers", "answered", async () => {
        const r = await turn("[[probe:text]] hi");
        return [/Hello from the scripted model/.test(r.text) && r.metrics.model === "probe/scripted" ? "answered" : "wrong",
            `model=${r.metrics.model} tokens=${r.metrics.tokens.input}/${r.metrics.tokens.output} error=${r.metrics.error ?? "-"} text=${JSON.stringify(r.text.slice(0, 60))}`];
    });
    const base = await ensureServer(project);
    const version = log.find((l) => /answered after/.test(l)) ? "up" : "?";
    console.log(`     server ${base} (${version})`);
    await row("plan · shell echo > file", "absent", async () => {
        const f = target(1);
        const r = await turn(`[[probe:bash:${echoTo(f)}]] go`, { agent: "plan", readOnly: true });
        return [wrote(f), `evidence=${r.metrics.readOnlyEnforcement?.kind} steps=${r.steps.join(",") || "-"}`];
    });
    await row("plan → explore · shell echo > file", "absent", async () => {
        const f = target(2);
        const r = await turn(`[[probe:task@explore:bash:${echoTo(f)}]] go`, { agent: "plan", readOnly: true });
        return [wrote(f), `subagents=${r.metrics.subagents?.count ?? 0} steps=${r.steps.join(",") || "-"}`];
    });
    await row("plan → general · write", "absent", async () => {
        const f = target(3);
        const r = await turn(`[[probe:task@general:write:${f}]] go`, { agent: "plan", readOnly: true });
        return [wrote(f), `steps=${r.steps.join(",") || "-"}`];
    });
    await row("control: /dev build · shell echo > file", "CREATED", async () => {
        const f = target(4);
        const r = await turn(`[[probe:bash:${echoTo(f)}]] go`, { autoApprove: true });
        return [wrote(f), `steps=${r.steps.join(",") || "-"}`];
    });
    // The write tool's own control: without it "plan → general · write: absent"
    // would read the same on a binary whose write tool never writes.
    await row("control: /dev build · write", "CREATED", async () => {
        const f = target(6);
        const r = await turn(`[[probe:write:${f}]] go`, { autoApprove: true });
        return [wrote(f), `steps=${r.steps.join(",") || "-"}`];
    });
    await row("plan → explore · git status runs (subagent row)", "runs", async () => {
        const r = await turn("[[probe:task@explore:bash:git status]] look", { agent: "plan", readOnly: true });
        return [r.metrics.subagents?.count >= 1 && /Done\./.test(r.text) ? "runs" : "no", `subagents=${r.metrics.subagents?.count ?? 0} text=${JSON.stringify(r.text.slice(0, 80))}`];
    });
    await row("Stop · a streaming turn returns within 1.5 s", "stopped", async () => {
        let cancel;
        const token = { isCancellationRequested: false, onCancellationRequested: (fn) => { cancel = fn; return { dispose() {} }; } };
        const pending = turn("[[probe:slow]] stream", { token });
        await new Promise((r) => setTimeout(r, 1500));
        token.isCancellationRequested = true;
        const t0 = Date.now();
        cancel?.();
        const r = await pending;
        const ms = Date.now() - t0;
        return [ms < 1500 ? "stopped" : "slow", `returned ${ms} ms after Stop, text=${r.text.length} chars`];
    });
    await row("sessions · listed, with the last ask and answer", "listed", async () => {
        const list = await listSessions(base, project, 50);
        const ex = list[0] ? await sessionExcerpt(base, project, list[0].id) : {};
        return [list.length >= 1 && ex.ask ? "listed" : "no", `sessions=${list.length} ask=${JSON.stringify((ex.ask ?? "").slice(0, 40))} answer=${JSON.stringify((ex.answer ?? "").slice(0, 40))}`];
    });
    stopServer();
    settings.enforceReadOnly = false;
    await row("control: enforceReadOnly off · plan shell echo > file", "CREATED", async () => {
        const f = target(5);
        await turn(`[[probe:bash:${echoTo(f)}]] go`, { agent: "plan", readOnly: true });
        return [wrote(f), ""];
    });
    stopServer();
    model.close?.();
    const failed = rows.filter((r) => r.got !== r.expect);
    console.log(failed.length ? `${failed.length} ROW(S) NOT AS EXPECTED` : `ALL ${rows.length} ROWS AS EXPECTED`);
    if (failed.length || process.env.PROBE_LOG) console.log(log.filter((l) => !/\[serve\]/.test(l)).slice(-40).join("\n"));
    void compactSession;
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
