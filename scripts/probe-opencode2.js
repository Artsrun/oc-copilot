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
const { runCapture } = out("proc.js");

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
    // MCP (0.0.232): gitScan is in `readOnlyTools`; `w_touch` is not, and writes a file when called.
    // Written before the first server starts: a running server reads its config once.
    const mcpTarget = path.join(project, "w-mcp.txt");
    const writerMcp = path.join(root, "mcp-writer.js");
    fs.writeFileSync(writerMcp,
        "const fs = require('fs'); const out = process.argv[2];\n" +
        "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');\n" +
        "require('readline').createInterface({ input: process.stdin }).on('line', (l) => { let r; try { r = JSON.parse(l); } catch { return; } if (r.id === undefined) return;\n" +
        "  if (r.method === 'initialize') reply(r.id, { protocolVersion: r.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'w', version: '1' } });\n" +
        "  else if (r.method === 'tools/list') reply(r.id, { tools: [{ name: 'touch', description: 'Create a marker file', inputSchema: { type: 'object', properties: {} } }] });\n" +
        "  else if (r.method === 'tools/call') { fs.writeFileSync(out, 'written'); reply(r.id, { content: [{ type: 'text', text: 'touched' }] }); }\n" +
        "  else reply(r.id, {}); });\n");
    // A level the effort rows can ask for (0.0.237): the scripted model ignores what it means.
    const probeConfig = projectConfig(model.url);
    probeConfig.provider.probe.models.scripted.variants = { high: { reasoningEffort: "high" } };
    fs.writeFileSync(path.join(project, "opencode.json"), JSON.stringify({
        ...probeConfig,
        mcp: {
            "git-scan": { type: "local", command: [process.execPath, path.join(__dirname, "..", "out", "git-scan-server.js"), project], enabled: true },
            w: { type: "local", command: [process.execPath, writerMcp, mcpTarget], enabled: true }
        }
    }, null, 1));

    const rows = [];
    // Expectations that differ by version name what was measured on each (REFS 0.0.232).
    const version = (await runCapture(exe, ["--version"], project, 15000)).trim();
    const [vMajor, vMinor] = (version.match(/(\d+)\.(\d+)\.\d+/) || []).slice(1).map(Number);
    // MCP tools by name: 1.x, and 2.x from 2.2.0 (2.0.29 and 2.1.4 keep them in Code Mode's
    // `execute`; 2.2.0 and 2.2.5 offer an allowed one by name; REFS 0.0.233).
    const mcpByName = vMajor === 1 || vMajor > 2 || (vMajor === 2 && vMinor >= 2);
    console.log(`opencode ${version}`);
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
    // Effort with no model named (0.0.237, written from source: 2.x takes a variant only
    // inside a model ref, and a session keeps both). Read back from the session itself.
    const heldLevel = async (sid) => {
        const base = await ensureServer(project);
        const info = await (await fetch(`${base}/api/session/${sid}`, { headers: out("net.js").serverAuth(base) ?? {} })).json();
        return String(info?.data?.model?.variant ?? "default");
    };
    let effortSession;
    await row("no model named · effort reaches the session", "high", async () => {
        const r = await turn("[[probe:text]] hi", { model: undefined, variant: "high" });
        effortSession = r.metrics.sessionId;
        return [await heldLevel(effortSession), `error=${r.metrics.error ?? "-"}`];
    });
    await row("no model named · the next turn without one is back at the default", "default", async () => {
        const r = await turn("[[probe:text]] hi", { model: undefined, sessionId: effortSession });
        return [await heldLevel(effortSession), `error=${r.metrics.error ?? "-"}`];
    });
    await row("no model named · a level the model lacks runs at the default, and answers", "default answered", async () => {
        const r = await turn("[[probe:text]] hi", { model: undefined, variant: "nosuchlevel" });
        return [`${await heldLevel(r.metrics.sessionId)} ${/Hello from the scripted model/.test(r.text) ? "answered" : "no answer"}`, `error=${r.metrics.error ?? "-"}`];
    });
    const base = await ensureServer(project);
    const serverState = log.find((l) => /answered after/.test(l)) ? "up" : "?";
    console.log(`     server ${base} (${serverState})`);
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
    // A subagent starts and its parent answers. Whether the child's `git status` ran is not
    // measured here: the scripted model says "Done." either way (0.0.232).
    await row("plan → explore · a subagent starts and answers", "answered", async () => {
        const r = await turn("[[probe:task@explore:bash:git status]] look", { agent: "plan", readOnly: true });
        return [r.metrics.subagents?.count >= 1 && /Done\./.test(r.text) ? "answered" : "no", `subagents=${r.metrics.subagents?.count ?? 0} text=${JSON.stringify(r.text.slice(0, 80))}`];
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
    // 0.0.232: reach outside the folder, on both majors (1.19.5 and 2.2.5 measured the same).
    // A "refused" row only shows the secret never reached the answer; the "read" controls
    // show the probe sees a read that worked.
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "OUTSIDE-SECRET-7Q\n");
    fs.writeFileSync(path.join(project, ".env"), "ENV-SECRET-9Z\n");
    const saw = (r, t) => (r.text.includes(t) ? "read" : "refused");
    // A tool that was not offered is named in the model's reply: keep the whole list.
    const note = (r) => `steps=${r.steps.join(",") || "-"} text=${JSON.stringify(r.text.slice(0, /tool offered/.test(r.text) ? 400 : 90))}`;
    const plan = (action) => turn(`[[probe:${action}]] go`, { agent: "plan", readOnly: true });
    const dev = (action) => turn(`[[probe:${action}]] go`, { autoApprove: true });
    await row("control: plan · read README inside", "read", async () => { const r = await plan(`read:${path.join(project, "README")}`); return [/probe/.test(r.text) ? "read" : "refused", note(r)]; });
    await row("plan · read a file OUTSIDE the folder", "refused", async () => { const r = await plan(`read:${secret}`); return [saw(r, "OUTSIDE-SECRET"), note(r)]; });
    await row("plan → explore · read a file OUTSIDE the folder", "refused", async () => { const r = await plan(`task@explore:read:${secret}`); return [saw(r, "OUTSIDE-SECRET"), note(r)]; });
    await row("plan · read .env inside the folder", "refused", async () => { const r = await plan(`read:${path.join(project, ".env")}`); return [saw(r, "ENV-SECRET"), note(r)]; });
    // /dev is not sandboxed: OpenCode 2 allows `external_directory` by default (migrate-v1), and
    // the bridge answers 1.x's asks on /dev. Recorded so a change either way shows up.
    await row("known · /dev · read a file OUTSIDE the folder", "read", async () => { const r = await dev(`read:${secret}`); return [saw(r, "OUTSIDE-SECRET"), note(r)]; });
    await row("known · /dev · write OUTSIDE the folder", "CREATED", async () => { const f = path.join(outside, "w.txt"); const r = await dev(`write:${f}`); return [wrote(f), note(r)]; });
    await row("known · /dev · shell OUTSIDE the folder", "CREATED", async () => { const f = path.join(outside, "s.txt"); const r = await dev(`bash:${echoTo(f)}`); return [wrote(f), note(r)]; });
    // MCP on read-only turns (2.2.3 moved MCP use out of `integration.use`): only `readOnlyTools` runs.
    const mcpGot = (r, ran) => (ran ? ran : /No call tool offered/.test(r.text) ? "not offered" : "no");
    await row("plan · the gitScan MCP tool (readOnlyTools)", mcpByName ? "runs" : "not offered", async () => { const r = await plan("call:gitScan"); return [mcpGot(r, /Working tree|Branch/i.test(r.text) && "runs"), note(r)]; });
    await row("plan · an MCP tool outside readOnlyTools writes nothing", "absent", async () => { fs.rmSync(mcpTarget, { force: true }); const r = await plan("call:touch"); return [wrote(mcpTarget), note(r)]; });
    // The control changes one thing: the same tool listed in readOnlyTools (overrides are per
    // process, so a new server). On 2.2.5 build is not offered MCP tools by name at all.
    // Before 2.2.0 a folder's agent list loads in stages (`[]`, stock rules, then the
    // overrides); the bridge reads until it settles, so plan first on a fresh server is
    // sent on every version (2.0.29, 2.1.4 bisected; REFS 0.0.233).
    stopServer();
    await row("plan as the first turn on a fresh server", "sent", async () => {
        try {
            const r = await plan("text");
            return [/Hello from the scripted model/.test(r.text) ? "sent" : "no answer", note(r)];
        } catch (error) {
            return [/Nothing was sent/.test(error.message) ? "refused, nothing sent" : "error", error.message.slice(0, 120)];
        }
    });
    stopServer();
    settings.readOnlyTools = ["git-scan_gitScan", "w_touch"];
    // 2.x starts a folder's MCP servers on its first request, and their tools reach a turn
    // 0.5–1 s later: the first turn on a fresh server is offered none, and a wait with no
    // request changes nothing (2.2.5: after GET /api/mcp, 500 ms none, 1000 ms offered).
    if (vMajor >= 2) {
        const mcpBase = await ensureServer(project);
        await fetch(`${mcpBase}/api/mcp?location%5Bdirectory%5D=${encodeURIComponent(project)}`, { headers: out("net.js").serverAuth(mcpBase) ?? {} }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 2000));
    }
    await row("control: plan · the same MCP tool, listed in readOnlyTools", mcpByName ? "CREATED" : "not offered", async () => {
        fs.rmSync(mcpTarget, { force: true });
        const r = await plan("call:touch");
        return [fs.existsSync(mcpTarget) ? "CREATED" : mcpGot(r, false), note(r)];
    });
    delete settings.readOnlyTools;
    // 0.0.234: prewarm reads the folder's agent list (prewarmFolder), which starts its MCP
    // servers. The first message comes after it: 1 s stands for that gap here (2.2.5: 0.5 s
    // was enough; a wait with no request starts nothing). The pair isolates the read.
    const firstTurnMcp = async (readList) => {
        stopServer();
        const warmed = await out("net.js").warmServer(project);
        if (readList && warmed) await out("agents.js").listAgents(project, warmed, "plan");
        await new Promise((r) => setTimeout(r, 1000));
        const r = await plan("call:gitScan");
        return [mcpGot(r, /Working tree|Branch/i.test(r.text) && "runs"), note(r)];
    };
    await row("control: first turn, no agent list read before it · gitScan", vMajor === 1 ? "runs" : "not offered", () => firstTurnMcp(false));
    await row("prewarm: first turn after the folder's agent list was read · gitScan", mcpByName ? "runs" : "not offered", () => firstTurnMcp(true));
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
