#!/usr/bin/env node
// Route H probe (0.0.244): `opencode-ahp`, a plugin that adds an AHP (Agent Host Protocol)
// WebSocket listener to `opencode serve`, inside a REAL OpenCode 2, driven by a raw AHP
// 1.0.0 client and the scripted model (probe-model.js). Three servers: stock `opencode
// serve`, the bridge's own (out/: ensureServer → spawnOpenCode, the enforced overrides),
// and the bridge's with the plugin in OPENCODE_CONFIG_CONTENT, nothing in the workspace
// (§2 rule 5). Every ask is approved, as a user clicking Approve would. One line per row;
// the control row must be CREATED, or this binary never attempted the write.
//
//   npm run compile
//   npm install opencode-ahp --prefix <tmp>      (third-party code: MIT, read it first)
//   node scripts/probe-ahp.js <path-to-opencode-2> <tmp>/node_modules/opencode-ahp
//
// Writes only under the OS temp dir (AGENTS §4). Node 22+ (global WebSocket).
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const Module = require("node:module");
const { spawn, execFileSync } = require("node:child_process");
const { startScriptedModel, projectConfig } = require("./probe-model");

const exe = process.argv[2] || "opencode";
const pluginDir = process.argv[3];
if (!pluginDir || !fs.existsSync(path.join(pluginDir, "package.json"))) {
    console.error("usage: node scripts/probe-ahp.js <opencode-2> <opencode-ahp package dir>");
    process.exit(2);
}
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
out("core.js").setHost({ settings: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }), folder: () => undefined, trusted: () => true, state: () => undefined });
out("core.js").setLogChannel({ appendLine: (l) => log.push(l), show() {}, dispose() {} });
const { ensureServer, stopServer, serverAuth, httpGetJson } = out("net.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
    new Promise((r) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
            const p = s.address().port;
            s.close(() => r(p));
        });
    });
const basic = (password) => ({ authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") });

function makeProject(root, modelUrl, plugin, viaEnv) {
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: project });
    git("init", "-q");
    fs.writeFileSync(path.join(project, "README"), "probe\n");
    git("add", ".");
    git("commit", "-qm", "init");
    const pluginConfig = { experimental: { location_idle_timeout: false }, plugins: [plugin] };
    fs.writeFileSync(path.join(project, "opencode.json"), JSON.stringify({ ...projectConfig(modelUrl), ...(viaEnv ? {} : pluginConfig) }, null, 1));
    if (viaEnv) {
        process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(pluginConfig);
    }
    return project;
}

function ahpClient(port, token) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ahp?token=${encodeURIComponent(token)}`);
    let nextId = 1;
    let clientSeq = 1;
    const pending = new Map();
    const actions = [];
    const listeners = [];
    ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
        if (msg.id !== undefined && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        } else if (msg.method === "action") {
            actions.push(msg.params);
            listeners.forEach((f) => f(msg.params));
        }
    });
    const opened = new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve);
        ws.addEventListener("error", () => reject(new Error("websocket error")));
    });
    const request = (method, params) =>
        new Promise((resolve) => {
            const id = nextId++;
            pending.set(id, resolve);
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
    const dispatch = (channel, action) => ws.send(JSON.stringify({ jsonrpc: "2.0", method: "dispatchAction", params: { channel, clientSeq: clientSeq++, action } }));
    return { ws, opened, request, dispatch, actions, listeners };
}

async function runCase(label, start, viaEnv) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-probe-ahp-"));
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    Object.assign(process.env, {
        HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local", "state"),
        OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost"
    });
    delete process.env.OPENCODE_CONFIG_CONTENT;
    const model = await startScriptedModel({});
    const ahpPort = await freePort();
    const token = "probe-" + Math.random().toString(36).slice(2);
    const plugin = { package: pluginDir, options: { token, port: ahpPort, host: "127.0.0.1", capabilities: { terminals: false } } };
    const project = makeProject(root, model.url, plugin, viaEnv);
    const rows = [];
    const row = (name, expect, got, note = "") => {
        rows.push({ ok: expect === "*" || expect === got });
        console.log(`[${label}] ${name.padEnd(52)} ${got.padEnd(13)} expect ${expect}${note ? "  · " + note : ""}`);
    };
    const server = await start(project);
    // The listener exists only while the location is up; one location request boots it.
    const booted = Date.now();
    await httpGetJson(`${server.base}/api/location?location%5Bdirectory%5D=${encodeURIComponent(project)}`, 60000, server.auth).catch((e) => log.push(`boot: ${e.message}`));
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i++) {
        healthy = await fetch(`http://127.0.0.1:${ahpPort}/healthz`).then((r) => r.text()).then((t) => t.trim() === "ok", () => false);
        if (!healthy) {
            await sleep(250);
        }
    }
    row("listener /healthz after a location boot", "ok", healthy ? "ok" : "absent", `${Date.now() - booted} ms`);
    if (!healthy) {
        server.stop();
        await model.close();
        return rows;
    }
    const c = ahpClient(ahpPort, token);
    await c.opened;
    const init = await c.request("initialize", { channel: "ahp-root://", clientId: `probe-${label}`, protocolVersions: ["1.1.0", "1.0.0"], initialSubscriptions: ["ahp-root://"] });
    row("initialize offering 1.1.0 and 1.0.0", "*", String(init.result?.protocolVersion ?? `error ${init.error?.code}`));
    const sessionChannel = `ahp-session:/probe-${label}`;
    const created = await c.request("createSession", { channel: sessionChannel, provider: "opencode", workingDirectories: ["file://" + project] });
    row("createSession in the project folder", "null", created.error ? `error ${created.error.message}` : String(created.result));
    const state = (await c.request("subscribe", { channel: sessionChannel })).result?.snapshot?.state;
    const agents = (state?.customizations ?? []).find((x) => x.type === "directory")?.children?.map((x) => x.name) ?? [];
    console.log(`[${label}] agent picker: ${agents.join(", ")}`);
    const chat = state?.defaultChat;
    await c.request("subscribe", { channel: chat });
    let asks = 0;
    c.listeners.push((p) => {
        const a = p.action;
        if (a?.type === "session/inputNeededSet" && a.request?.toolCall) {
            asks++;
            c.dispatch(a.request.chat ?? chat, { type: "chat/toolCallConfirmed", turnId: a.request.turnId, toolCallId: a.request.id, approved: true, confirmed: "user-action" });
        }
    });
    const turn = async (agent, text, cancelAfterMs) => {
        const turnId = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const from = c.actions.length;
        const began = Date.now();
        c.dispatch(chat, { type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message: { text, origin: { kind: "user" }, agent: { uri: `opencode:agent/${agent}` }, model: { id: "probe/scripted" } } });
        if (cancelAfterMs !== undefined) {
            await sleep(cancelAfterMs);
            c.dispatch(chat, { type: "chat/turnCancelled", turnId, duration: Date.now() - began });
        }
        while (Date.now() - began < 60000) {
            const mine = c.actions.slice(from).filter((p) => p.action?.turnId === turnId);
            const done = mine.find((p) => ["chat/turnComplete", "chat/turnCancelled", "chat/error"].includes(p.action?.type) && !p.rejectionReason);
            if (done) {
                const said = mine.filter((p) => p.action?.type === "chat/responsePart" || p.action?.type === "chat/delta").map((p) => p.action.part?.content ?? p.action.content ?? "").join("");
                return { end: done.action.type.slice(5), ms: Date.now() - began, tools: mine.filter((p) => p.action?.type === "chat/toolCallStart").map((p) => p.action.toolName), said };
            }
            await sleep(25);
        }
        return { end: "timeout", ms: Date.now() - began, tools: [], said: "" };
    };
    const fileRow = async (name, expect, agent, rel, prompt) => {
        const target = path.join(project, rel);
        const before = asks;
        const r = await turn(agent, prompt);
        let exists = fs.existsSync(target);
        // A 2.3 subagent runs in the background (§7): give its file time either way.
        for (let i = 0; i < 40 && !exists; i++) {
            await sleep(100);
            exists = fs.existsSync(target);
        }
        row(name, expect, exists ? "CREATED" : "absent", `turn ${r.end} ${r.ms} ms, tools [${r.tools.join(",")}], asks ${asks - before}`);
    };
    const readOnly = label === "stock" ? "*" : "absent";
    await fileRow("plan · shell echo > p1.txt", readOnly, "plan", "p1.txt", "[[probe:bash:echo plan > p1.txt]]");
    await fileRow("plan · write p2.txt", readOnly, "plan", "p2.txt", "[[probe:write:p2.txt]]");
    await fileRow("plan → explore · shell echo > p3.txt", readOnly, "plan", "p3.txt", "[[probe:task@explore:bash:echo sub > p3.txt]]");
    // The child reports back with a `<subagent>` message (2.3, §7): a prompt sent before
    // that lands behind it, and the scripted model answers the report instead (measured:
    // the next row ran no tool, 103 ms, when it followed at once).
    await sleep(3000);
    await fileRow("control: build · shell echo > b1.txt", "CREATED", "build", "b1.txt", "[[probe:bash:echo build > b1.txt]]");
    const streamed = () => c.actions.filter((p) => p.action?.type === "chat/delta" || p.action?.type === "chat/responsePart").length;
    const stopped = await turn("plan", "[[probe:slow]]", 1500);
    const atEnd = streamed();
    await sleep(3000);
    row("Stop: plan · slow, cancelled at 1.5 s", "turnCancelled", stopped.end, `${stopped.ms} ms`);
    row("Stop: stream parts in the 3 s after", "0", String(streamed() - atEnd));
    const next = await turn("plan", "[[probe:text]]");
    row("next turn, same chat, right after Stop", "turnComplete", next.end, `${next.ms} ms, ${JSON.stringify(next.said.slice(0, 40))}`);
    c.ws.close();
    server.stop();
    await model.close();
    return rows;
}

(async () => {
    const started = Date.now();
    console.log(`${execFileSync(exe, ["--version"]).toString().trim()} · opencode-ahp ${require(path.join(pluginDir, "package.json")).version} · node ${process.version}`);
    const stock = async (project) => {
        const port = await freePort();
        const child = spawn(exe, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: project, env: process.env });
        let password;
        let said = "";
        const read = (d) => {
            said += d;
            password = password ?? said.match(/\bserver password\s+(\S+)/i)?.[1];
        };
        child.stdout.on("data", read);
        child.stderr.on("data", read);
        const base = `http://127.0.0.1:${port}`;
        for (let i = 0; i < 180; i++) {
            if (password && (await httpGetJson(`${base}/api/info`, 2000, basic(password)).then(() => true, () => false))) {
                break;
            }
            await sleep(250);
        }
        return { base, auth: basic(password), stop: () => child.kill() };
    };
    const bridge = async (project) => {
        const base = await ensureServer(project);
        return { base, auth: serverAuth(base), stop: () => stopServer() };
    };
    const rows = [
        ...(await runCase("stock", stock, false)),
        ...(await runCase("bridge", bridge, false)),
        ...(await runCase("bridge-env", bridge, true))
    ];
    const bad = rows.filter((r) => !r.ok).length;
    console.log(bad ? `${bad} ROW(S) NOT AS EXPECTED` : `ALL ${rows.length} ROWS AS EXPECTED`, `(${Math.round((Date.now() - started) / 1000)} s)`);
    process.exit(bad ? 1 : 0);
})().catch((e) => {
    console.error("PROBE CRASHED:", e);
    console.error(log.slice(-15).join("\n"));
    process.exit(1);
});
