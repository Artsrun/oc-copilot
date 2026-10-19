#!/usr/bin/env node
// Read-only probe (0.0.215): through the bridge's own code (out/: runOpenCode,
// spawnOpenCode, ensureServer, createServerSession, applyTurnPermission), can a
// read-only turn write? A REAL OpenCode binary decides; probe-model.js, in this
// process, makes every attempt certain. No provider, no cost. One line per row:
//   absent / CREATED   whether the file the model tried to write exists
//   runs / refused     whether an inspection tool ran (the result it got back)
// With enforceReadOnly on, every read-only write row is absent,
// and the control rows (enforcement off, /dev) are CREATED. A control row that is
// absent means this binary did not attempt the write: the probe measured nothing.
//
//   npm run compile && node scripts/probe-readonly.js [path-to-opencode]
//
// 1.x: cold `run`, the managed `serve`, and an adopted `serve` (one the bridge did
// not start). 2.x ACP is research only. Writes only under the
// OS temp dir (AGENTS §4): per major, a git repo and an isolated HOME, kept
// between runs so OpenCode fetches the provider package once.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const { startScriptedModel, projectConfig } = require("./probe-model");
const { acpClient, initialize, acpTurn } = require("./probe-acp");

const exe = process.argv[2] || "opencode";
const settings = { executable: exe, enforceReadOnly: true, readOnlySubagents: ["explore"], serverPort: 0, serverHostname: "127.0.0.1", transport: "server" };
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
const { spawnOpenCode, killTree } = out("proc.js");
const { runOpenCode } = out("run-cli.js");
const { runOpenCodeServer } = out("run-server.js");
const { ensureServer, stopServer, httpRequestJson, httpGetJson, withDirectory } = out("net.js");
const { createServerSession, applyTurnPermission } = out("server-session.js");

const capture = (args, cwd) =>
    new Promise((resolve) => {
        const child = spawnOpenCode(exe, args, cwd);
        let text = "";
        child.stdout.on("data", (d) => (text += d));
        child.stderr.on("data", (d) => (text += d));
        child.stdin.end();
        child.on("error", (e) => resolve(`spawn error: ${e.message}`));
        child.on("close", () => resolve(text));
    });

(async () => {
    const version = (await capture(["--version"])).trim();
    const major = Number((version.match(/(?:^|\s)v?(\d+)\.\d+\.\d+/) || [])[1]);
    if (!major) {
        throw new Error(`\`${exe} --version\` printed ${JSON.stringify(version.slice(0, 120))}`);
    }
    const root = path.join(os.tmpdir(), `ocb-probe-readonly-${major}`);
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    if (!fs.existsSync(path.join(project, ".git"))) {
        fs.mkdirSync(project, { recursive: true });
        fs.writeFileSync(path.join(project, "README.md"), "probe\n");
        execFileSync("git", ["init", "-q"], { cwd: project });
        execFileSync("git", ["add", "."], { cwd: project });
        execFileSync("git", ["-c", "user.email=p@p", "-c", "user.name=p", "commit", "-qm", "init"], { cwd: project });
    }
    // spawnOpenCode passes process.env on: isolate every OpenCode it starts.
    Object.assign(process.env, {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        XDG_STATE_HOME: path.join(home, ".local", "state"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1"
    });
    delete process.env.OPENCODE_CONFIG_CONTENT;
    delete process.env.OPENCODE_PERMISSION;
    const model = await startScriptedModel();
    // The bridge's gitScan MCP server, as its config command prints it: read-only, so plan keeps it.
    const gitScan = { "git-scan": { type: "local", command: [process.execPath, path.join(__dirname, "..", "out", "git-scan-server.js"), project], enabled: true } };
    fs.writeFileSync(path.join(project, "opencode.json"), JSON.stringify({ ...projectConfig(model.url), mcp: gitScan }, null, 1));
    // Untracked files stay out of `git status`, so its output is the same every run.
    fs.writeFileSync(path.join(project, ".git", "info", "exclude"), "opencode.json\nro-*.txt\nexternal-diff.*\na\nb\n.opencode/\n");

    // An attachment from outside the folder: what a read-only turn can open of it.
    const outsideFile = path.join(root, "outside", "notes.log");
    fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
    fs.writeFileSync(outsideFile, "outside the folder, read back\n");
    const rows = [];
    const target = (n) => {
        const file = path.join(project, `ro-${n}.txt`);
        fs.rmSync(file, { force: true });
        return file;
    };
    const resultSince = (from) => model.calls.slice(from).filter((c) => c.scenario.kind === "after-tool").map((c) => c.scenario.result).join(" | ");
    const offeredSince = (from) => [...new Set(model.calls.slice(from).flatMap((c) => c.tools))];
    const verdict = (kind, file, from) => {
        if (kind === "write") {
            return fs.existsSync(file) ? "CREATED" : "absent";
        }
        const said = resultSince(from);
        return /prevents you|denied|rejected|not allowed/i.test(said) ? "refused" : /On branch|nothing to commit|^\s*[0-9a-f]{7,} |Branch: |outside the folder, read back|probe/m.test(said) ? "runs" : `unclear (${said.slice(0, 80) || "no tool result"})`;
    };
    const row = async (label, expect, kind, n, run) => {
        const file = kind === "write" ? target(n) : undefined;
        const from = model.calls.length;
        const t0 = Date.now();
        let note = "";
        try {
            note = (await run(file)) ?? "";
        } catch (error) {
            note = `error: ${error.message}`;
        }
        const got = model.calls.length > from ? verdict(kind, file, from) : "NO MODEL REQUEST";
        if (got !== expect && kind !== "write") {
            note += ` · the tool said: ${resultSince(from).slice(0, 240)}`;
        }
        rows.push({ label, expect, got });
        console.log(`${got === expect ? "ok  " : "FAIL"} [${version}] ${label}: ${got}${got === expect ? "" : ` (expected ${expect})`} · ${Date.now() - t0} ms${note ? ` · ${note}` : ""}`);
        return from;
    };
    const say = (action) => `Go. [[probe:${action}]]`;
    const write = (file) => `bash:echo written > ${file}`;

    if (major === 1) {
        const helper = path.join(project, process.platform === "win32" ? "external-diff.cmd" : "external-diff.sh");
        const helperTarget = path.join(project, "ro-helper.txt");
        fs.writeFileSync(path.join(project, "a"), "before\n");
        fs.writeFileSync(path.join(project, "b"), "after\n");
        fs.writeFileSync(helper, process.platform === "win32"
            ? `@echo off\r\necho written > "${helperTarget}"\r\n`
            : `#!/bin/sh\nprintf written > '${helperTarget}'\n`, { mode: 0o755 });
        const previousDiff = process.env.GIT_EXTERNAL_DIFF;
        process.env.GIT_EXTERNAL_DIFF = helper.replace(/\\/g, "/");
        let plain;
        let other;
        try {
            const helperAction = "bash:git diff --no-index --ext-diff a b";
        const shellAbsent = async (label, run) => {
            const from = model.calls.length;
            await run();
            const tools = offeredSince(from);
            const ok = model.calls.length > from && tools.length > 0 && !tools.some((t) => ["bash", "shell", "edit", "write", "patch", "apply_patch"].includes(t));
            rows.push({ label, expect: "shell absent", got: ok ? "shell absent" : "unverified or shell offered" });
            console.log(`${ok ? "ok  " : "FAIL"} [${version}] ${label}: ${tools.join(", ")}`);
        };
        const cold = (agent, readOnly) => async (action) => {
            const m = await runOpenCode({ executable: exe, task: say(action), cwd: project, agent, model: "probe/scripted", pure: false, autoApprove: !readOnly || agent === "plan", readOnly, json: true, thinking: false, timeoutMs: 180000, idleTimeoutMs: 0 });
            return m.error ? `run: ${String(m.error).slice(0, 100)}` : undefined;
        };
        const plan = cold("plan", true);
        const localAgentDir = path.join(project, ".opencode", "agents");
        const globalAgentDir = path.join(home, ".config", "opencode", "agents");
        for (const [label, dir] of [["project", localAgentDir], ["global", globalAgentDir]]) {
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, "plan.md");
            const prior = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
            try {
                fs.writeFileSync(file, "---\nmode: primary\npermission:\n  bash: allow\n  edit: allow\n---\nInspect the project.\n");
                await shellAbsent(`cold plan · ${label} agent cannot restore shell`, () => plan(helperAction));
            } finally {
                if (prior === undefined) fs.rmSync(file);
                else fs.writeFileSync(file, prior);
            }
        }
        // Finding 1 regression: project opencode.json with `"*": "allow"` first,
        // `edit: "allow"`, and `bash: { "*": "deny", "git *": "allow" }`.
        const baseProjectJson = fs.readFileSync(path.join(project, "opencode.json"), "utf8");
        try {
            fs.writeFileSync(
                path.join(project, "opencode.json"),
                JSON.stringify({
                    ...JSON.parse(baseProjectJson),
                    agent: {
                        plan: { permission: { "*": "allow", edit: "allow", bash: { "*": "deny", "git *": "allow" } } },
                        explore: { permission: { "*": "allow", edit: "allow", bash: { "*": "deny", "git *": "allow" } } }
                    }
                }, null, 1)
            );
            await row("cold plan · opencode.json merge-order cannot restore write tool", "absent", "write", "merge1", (f) => plan(`write:${f}`));
            await row("cold plan · opencode.json merge-order cannot restore git helper", "absent", "write", "helper", () => plan(helperAction));
            await shellAbsent("cold plan · opencode.json merge-order keeps shell/edit absent", () => plan(helperAction));
            await row("cold plan → explore · opencode.json merge-order cannot restore write or bash", "absent", "write", "merge2", (f) => plan(`task@explore:${write(f)}`));
        } finally {
            fs.writeFileSync(path.join(project, "opencode.json"), baseProjectJson);
        }
        // 0.0.219: keys the bridge does not set. A config file's `"w_*": "allow"`
        // (an MCP tool) or `task: { general: allow }` kept its allow after the
        // overrides' `"*": "deny"`; the bridge now refuses before sending.
        const writerMcp = path.join(root, "mcp-writer.js");
        fs.writeFileSync(writerMcp,
            "const fs = require('fs'); const out = process.argv[2];\n" +
            "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');\n" +
            "require('readline').createInterface({ input: process.stdin }).on('line', (l) => { let r; try { r = JSON.parse(l); } catch { return; } if (r.id === undefined) return;\n" +
            "  if (r.method === 'initialize') reply(r.id, { protocolVersion: r.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'w', version: '1' } });\n" +
            "  else if (r.method === 'tools/list') reply(r.id, { tools: [{ name: 'touch', description: 'Create a marker file', inputSchema: { type: 'object', properties: {} } }] });\n" +
            "  else if (r.method === 'tools/call') { fs.writeFileSync(out, 'written'); reply(r.id, { content: [{ type: 'text', text: 'touched' }] }); }\n" +
            "  else reply(r.id, {}); });\n");
        const mcpTarget = path.join(project, "ro-mcp.txt");
        const reopened = (planPermission) => fs.writeFileSync(path.join(project, "opencode.json"), JSON.stringify({
            ...JSON.parse(baseProjectJson),
            mcp: { ...JSON.parse(baseProjectJson).mcp, w: { type: "local", command: [process.execPath, writerMcp, mcpTarget], enabled: true } },
            agent: { plan: { permission: planPermission } }
        }, null, 1));
        const refusedRow = async (label, run, sentinel) => {
            fs.rmSync(sentinel, { force: true });
            const from = model.calls.length;
            let code = "";
            let said = "";
            try {
                await run();
            } catch (error) {
                code = error.code || "";
                said = error.message;
            }
            const ok = code === "ETURNPERMISSION" && model.calls.length === from && !fs.existsSync(sentinel);
            rows.push({ label, expect: "refused before sending", got: ok ? "refused before sending" : "NOT refused" });
            console.log(`${ok ? "ok  " : "FAIL"} [${version}] ${label}: ${ok ? "refused before sending" : `NOT refused (${code || "ran"}, model requests ${model.calls.length - from}, sentinel ${fs.existsSync(sentinel) ? "CREATED" : "absent"})`} · ${said.slice(0, 160)}`);
        };
        try {
            reopened({ "*": "allow", "w_*": "allow" });
            await refusedRow("cold plan · an MCP tool reopened by opencode.json", () => plan("call:touch"), mcpTarget);
            settings.enforceReadOnly = false;
            await row("control · cold plan · enforceReadOnly false · the same MCP tool writes", "CREATED", "write", "mcp", () => plan("call:touch"));
            settings.enforceReadOnly = true;
            reopened({ "*": "allow", task: { "*": "deny", general: "allow" } });
            await refusedRow("cold plan · task → general reopened by opencode.json", () => plan(`task@general:write:${path.join(project, "ro-general.txt")}`), path.join(project, "ro-general.txt"));
            settings.enforceReadOnly = false;
            await row("control · cold plan · enforceReadOnly false · general writes", "CREATED", "write", "general", (f) => plan(`task@general:write:${f}`));
            settings.enforceReadOnly = true;
            reopened({ "*": "allow", "w_*": "allow" });
            const reopenedServer = await ensureServer(project);
            await refusedRow("managed serve · an MCP tool reopened by opencode.json", () => runOpenCodeServer({ executable: exe, task: say("call:touch"), cwd: project, agent: "plan", model: "probe/scripted", serverUrl: reopenedServer, readOnly: true, json: true, timeoutMs: 180000 }), mcpTarget);
            stopServer();
        } finally {
            fs.writeFileSync(path.join(project, "opencode.json"), baseProjectJson);
        }
        await row("cold plan · Git external-helper write", "absent", "write", "helper", () => plan(helperAction));
        await shellAbsent("cold plan · shell tool absent during helper attempt", () => plan(helperAction));
        await row("cold plan · redirect-only parser edge", "absent", "write", "redirect", (f) => plan(`bash:> "${f}"`));
        await row("cold plan · double-hyphen parser edge", "absent", "write", "helper", () => plan("bash:git diff --no-index --ext-diff -- a b"));
        await row("cold plan → explore · external helper", "absent", "write", "helper", () => plan(`task@explore:${helperAction}`));
        settings.readOnlySubagents = ["*"];
        await row("cold plan · wildcard cannot delegate to general", "absent", "write", "wildcard", (f) => plan(`task@general:write:${f}`));
        settings.readOnlySubagents = ["explore"];
        await row("cold run · plan · shell `echo > file`", "absent", "write", 1, (f) => plan(write(f)));
        await row("cold run · plan → explore · shell `echo > file`", "absent", "write", 2, (f) => plan(`task@explore:${write(f)}`));
        await row("cold run · plan → general · write tool", "absent", "write", 3, (f) => plan(`task@general:write:${f}`));
        await row("cold run · plan · write tool", "absent", "write", 4, (f) => plan(`write:${f}`));
        await row("cold run · plan · read README", "runs", "inspect", 0, () => plan(`read:${path.join(project, "README.md")}`));
        await row("cold run · plan → explore · read README", "runs", "inspect", 0, () => plan(`task@explore:read:${path.join(project, "README.md")}`));
        const toolsFrom = model.calls.length;
        await plan("text");
        const coldTools = offeredSince(toolsFrom);
        const coldLeaks = coldTools.filter((t) => ["bash", "shell", "write", "edit", "patch", "apply_patch", "question"].includes(t));
        rows.push({ label: "cold run · plan · tools offered", expect: "none that write", got: coldLeaks.length ? `offers ${coldLeaks.join(", ")}` : "none that write" });
        console.log(`${coldLeaks.length ? "FAIL" : "ok  "} [${version}] cold run · plan · tools offered: ${coldTools.join(", ")}`);
        await row("cold run · plan · the gitScan MCP tool", "runs", "inspect", 0, () => plan("call:gitScan"));
        await row("cold run · plan · read an attached file outside the folder", "refused", "inspect", 0, () => plan(`read:${outsideFile}`));
        settings.enforceReadOnly = false;
        await row("control · cold run · plan · enforceReadOnly false · shell `echo > file`", "CREATED", "write", 5, (f) => plan(write(f)));
        settings.enforceReadOnly = true;
        await row("control · cold run · build (/dev) · shell `echo > file`", "CREATED", "write", 6, (f) => cold("build", false)(write(f)));
        await row("control · /dev · Git external helper writes", "CREATED", "write", "helper", () => cold("build", false)(helperAction));
        await row("control · cold run · build (/dev) · read an attached file outside the folder", "runs", "inspect", 0, () => cold("build", false)(`read:${outsideFile}`));

        const message = (base, sid, agent, action) =>
            httpRequestJson("POST", withDirectory(`${base}/session/${sid}/message`, project), { agent, model: { providerID: "probe", modelID: "scripted" }, parts: [{ type: "text", text: say(action) }] }, 180000).then(() => undefined);
        // The managed server: started by the bridge, so plan and explore carry the overrides.
        const managed = await ensureServer(project);
        const agents = await httpGetJson(withDirectory(`${managed}/agent`, project), 10000);
        const planRules = (agents.find((a) => a.name === "plan")?.permission ?? []).map((r) => `${r.permission} ${r.pattern} ${r.action}`);
        const marked = planRules.includes("ocb-enforced * deny") && planRules.includes("bash * deny");
        rows.push({ label: "managed serve · GET /agent: plan lists `ocb-enforced * deny` and `bash * deny`", expect: "listed", got: marked ? "listed" : "missing" });
        console.log(`${marked ? "ok  " : "FAIL"} [${version}] managed serve · GET /agent: plan lists \`ocb-enforced * deny\` and \`bash * deny\`: ${marked ? "listed" : "missing"}`);
        const ownRo = await createServerSession(managed, project, "probe managed read-only", true);
        await row("managed plan · external helper", "absent", "write", "helper", () => message(managed, ownRo, "plan", helperAction));
        await shellAbsent("managed plan · shell tool absent", () => message(managed, ownRo, "plan", helperAction));
        const attached = await runOpenCode({ executable: exe, task: say(helperAction), cwd: project, agent: "plan", model: "probe/scripted", attachUrl: managed, sessionId: ownRo, readOnly: true, json: true, autoApprove: true, timeoutMs: 180000 });
        const serverRun = await runOpenCodeServer({ executable: exe, task: say(helperAction), cwd: project, agent: "plan", model: "probe/scripted", serverUrl: managed, readOnly: true, json: true, timeoutMs: 180000 });
        for (const [label, m] of [["attached CLI", attached], ["server runner", serverRun]]) {
            const ok = m.readOnlyEnforcement?.kind === "enforced" && !m.error && !fs.existsSync(helperTarget);
            rows.push({ label, expect: "enforced", got: ok ? "enforced" : "unverified or failed" });
            console.log(`${ok ? "ok  " : "FAIL"} [${version}] ${label} · actual enforcement evidence: ${JSON.stringify(m.readOnlyEnforcement)}${m.error ? ` ${m.error}` : ""}`);
        }
        await row("managed serve · read-only session · plan → explore · shell `echo > file`", "absent", "write", 7, (f) => message(managed, ownRo, "plan", `task@explore:${write(f)}`));
        await row("managed serve · read-only session · plan · gitScan", "runs", "inspect", 0, () => message(managed, ownRo, "plan", "call:gitScan"));
        await row("managed serve · read-only session · plan · read an attached file outside the folder", "refused", "inspect", 0, () => message(managed, ownRo, "plan", `read:${outsideFile}`));
        stopServer();

        // An adopted server: listening before the bridge came, so its agents keep
        // their own rules. Read-only turns there start no subagent; plan's own
        // shell is limited by instruction only (no session deny: every later
        // subagent of the session would inherit it).
        const port = await new Promise((resolve) => {
            const s = require("node:net").createServer().listen(0, "127.0.0.1", () => {
                const p = s.address().port;
                s.close(() => resolve(p));
            });
        });
        // Off while it spawns: spawnOpenCode injects nothing, as for a server you start yourself.
        settings.enforceReadOnly = false;
        plain = spawnOpenCode(exe, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], project);
        plain.stdin.end();
        settings.enforceReadOnly = true;
        settings.serverPort = port;
        const adoptedBase = `http://127.0.0.1:${port}`;
        for (let i = 0; i < 120; i++) {
            const h = await httpGetJson(`${adoptedBase}/global/health`, 1000).catch(() => undefined);
            if (h?.version) {
                break;
            }
            await new Promise((r) => setTimeout(r, 500));
        }
        const adopted = await ensureServer(project);
        const ro = await createServerSession(adopted, project, "probe adopted read-only", true);
        await row("adopted serve · read-only session · plan → explore · shell `echo > file` (no subagent starts)", "absent", "write", 8, (f) => message(adopted, ro, "plan", `task@explore:${write(f)}`));
        await row("adopted serve · read-only session · plan → general · write tool", "absent", "write", 9, (f) => message(adopted, ro, "plan", `task@general:write:${f}`));
        await row("adopted serve · read-only session · plan · `git status`", "runs", "inspect", 0, () => message(adopted, ro, "plan", "bash:git status"));
        await row("known · adopted serve · plan's own shell `echo > file` (by instruction only there: README)", "CREATED", "write", 10, (f) => message(adopted, ro, "plan", write(f)));
        await applyTurnPermission(adopted, project, ro, false, "build");
        await row("adopted serve · the same session's next /dev turn · build → general · shell `echo > file`", "CREATED", "write", 11, (f) => message(adopted, ro, "build", `task@general:${write(f)}`));
        settings.enforceReadOnly = false;
        const loose = await createServerSession(adopted, project, "probe adopted 0.0.214 rules", true);
        await row("control · adopted serve · enforceReadOnly false (0.0.214 rules) · plan → explore · shell `echo > file`", "CREATED", "write", 12, (f) => message(adopted, loose, "plan", `task@explore:${write(f)}`));
        settings.enforceReadOnly = true;
        killTree(plain);

        // A server another window of the bridge started on the shared port: it
        // has the overrides, and its `plan` lists the marker (GET /agent).
        const port2 = await new Promise((resolve) => {
            const s = require("node:net").createServer().listen(0, "127.0.0.1", () => {
                const p = s.address().port;
                s.close(() => resolve(p));
            });
        });
        other = spawnOpenCode(exe, ["serve", "--port", String(port2), "--hostname", "127.0.0.1"], project);
        other.stdin.end();
        settings.serverPort = port2;
        for (let i = 0; i < 120; i++) {
            const h = await httpGetJson(`http://127.0.0.1:${port2}/global/health`, 1000).catch(() => undefined);
            if (h?.version) {
                break;
            }
            await new Promise((r) => setTimeout(r, 500));
        }
        const shared = await ensureServer(project);
        const sharedRo = await createServerSession(shared, project, "probe another window's server", true);
        await row("shared plan · external helper", "absent", "write", "helper", () => message(shared, sharedRo, "plan", helperAction));
        await shellAbsent("shared plan · shell tool absent", () => message(shared, sharedRo, "plan", helperAction));
        await row("another window's serve (overrides on) · read-only session · plan → explore · shell `echo > file`", "absent", "write", 13, (f) => message(shared, sharedRo, "plan", `task@explore:${write(f)}`));
        await row("another window's serve (overrides on) · read-only session · plan → explore · read README", "runs", "inspect", 0, () => message(shared, sharedRo, "plan", `task@explore:read:${path.join(project, "README.md")}`));
        killTree(other);
        } finally {
            stopServer();
            if (plain && plain.exitCode === null) killTree(plain);
            if (other && other.exitCode === null) killTree(other);
            if (previousDiff === undefined) delete process.env.GIT_EXTERNAL_DIFF;
            else process.env.GIT_EXTERNAL_DIFF = previousDiff;
        }
    } else {
        // 2.x over ACP: one `opencode acp` per setting (the overrides are per process).
        const acp = async (enforced, turns) => {
            settings.enforceReadOnly = enforced;
            const child = spawnOpenCode(exe, ["acp"], project);
            settings.enforceReadOnly = true;
            let readOnlyTurn = true;
            const client = acpClient(child, { onPermission: () => (readOnlyTurn ? "reject" : "allow") });
            try {
                await initialize(client);
                for (const turn of turns) {
                    readOnlyTurn = turn.mode === "plan";
                    await turn(client);
                }
            } finally {
                await client.close();
            }
        };
        const step = (mode, label, expect, kind, n, action) => {
            const fn = (client) => row(label, expect, kind, n, async (f) => {
                const r = await acpTurn(client, project, { mode, prompt: say(action(f)), timeoutMs: 180000 });
                return `stop ${r.stopReason}${r.asks.length ? `, asks ${r.asks.map((a) => a.answered).join("/")}` : ""}`;
            });
            fn.mode = mode;
            return fn;
        };
        let planTools = [];
        const offered = (client) => {
            const from = model.calls.length;
            return acpTurn(client, project, { mode: "plan", prompt: say("text") }).then(() => (planTools = offeredSince(from)));
        };
        offered.mode = "plan";
        await acp(true, [
            step("plan", "acp · plan · shell `echo > file`", "absent", "write", 1, write),
            step("plan", "acp · plan → explore · shell `echo > file`", "absent", "write", 2, (f) => `task@explore:${write(f)}`),
            step("plan", "acp · plan → general · write tool", "absent", "write", 3, (f) => `task@general:write:${f}`),
            step("plan", "acp · plan · `git status`", "runs", "inspect", 0, () => "bash:git status"),
            step("plan", "acp · plan · read an attached file outside the folder", "refused", "inspect", 0, () => `read:${outsideFile}`),
            offered,
            step("build", "control · acp · build (/dev) · shell `echo > file`", "CREATED", "write", 4, write)
        ]);
        const leaks = planTools.filter((t) => ["execute", "write", "edit", "patch", "apply_patch", "question"].includes(t));
        rows.push({ label: "acp · plan · tools offered", expect: "none that write", got: leaks.length ? `offers ${leaks.join(", ")}` : "none that write" });
        console.log(`${leaks.length ? "FAIL" : "ok  "} [${version}] acp · plan · tools offered: ${planTools.join(", ")}`);
        await acp(false, [step("plan", "control · acp · plan · enforceReadOnly false · shell `echo > file`", "CREATED", "write", 5, write)]);
    }
    await model.close();
    const failed = rows.filter((r) => r.got !== r.expect);
    console.log(`\n${failed.length ? `${failed.length} ROW(S) NOT AS EXPECTED` : `ALL ${rows.length} ROWS AS EXPECTED`} — ${version} at ${exe}; work ${root}`);
    if (failed.length) {
        console.log("Bridge log (last 15 lines):\n" + log.slice(-15).join("\n"));
    }
    process.exit(failed.length ? 1 : 0);
})().catch((error) => {
    console.error(error);
    console.error("Bridge log (last 15 lines):\n" + log.slice(-15).join("\n"));
    process.exit(2);
});
