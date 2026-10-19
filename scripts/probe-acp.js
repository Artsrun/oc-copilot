#!/usr/bin/env node
// ACP probe: drives `opencode acp` (Agent Client Protocol: newline-delimited
// JSON-RPC 2.0 over stdio) and prints what came back, as JSON. The groundwork
// for `transport: "acp"` (claude/v215-plan.md, 0.0.216): run it against each
// OpenCode you test, the company 2.x first.
//
//   node scripts/probe-acp.js <exe> <work-dir> <scenario> [prompt] [option=value…]
//
// Scenarios: handshake | prompt | cancel | load | loadprompt (load: session=<id>)
// Options:   mode=<id> reply=reject|allow cancelAfter=<ms> session=<id> child=1
// <work-dir>/project is the folder (git repo, opencode.json); <work-dir>/home an
// isolated HOME, so no user config or plugin loads. With `model=scripted` the
// prompt goes to probe-model.js (`[[probe:<action>]]`, no provider, no cost).
// Writes only under <work-dir>; use one under the OS temp dir (AGENTS §4).
// Also a module: probe-readonly.js drives `acpClient` over spawnOpenCode.
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** A JSON-RPC client over a spawned `opencode acp`. */
function acpClient(child, { transcript, onPermission } = {}) {
    const started = Date.now();
    const t = () => Date.now() - started;
    const pending = new Map();
    const updates = [];
    const asks = [];
    let nextId = 1;
    let buffer = "";
    let stderr = "";
    const record = (dir, msg) => transcript && fs.appendFileSync(transcript, JSON.stringify({ t: t(), dir, msg }) + "\n");
    const send = (msg) => {
        record("out", msg);
        child.stdin.write(JSON.stringify(msg) + "\n");
    };
    const request = (method, params, timeoutMs = 20000) => {
        const id = nextId++;
        send({ jsonrpc: "2.0", id, method, params });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`${method} timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
        });
    };
    const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
    const onAgentRequest = (msg) => {
        if (msg.method === "session/request_permission") {
            const p = msg.params ?? {};
            const want = (onPermission?.(p) ?? "reject") === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
            const option = (p.options ?? []).find((o) => want.includes(o.kind));
            asks.push({ t: t(), tool: p.toolCall?.title ?? p.toolCall?.name, kind: p.toolCall?.kind, answered: option?.optionId ?? "cancelled", child: Boolean(p.toolCall?._meta) });
            send({ jsonrpc: "2.0", id: msg.id, result: { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } } });
            return;
        }
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `probe does not serve ${msg.method}` } });
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-20000)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) {
                continue;
            }
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                record("garbage", line.slice(0, 400));
                continue;
            }
            record("in", msg);
            if (msg.id !== undefined && msg.method) {
                onAgentRequest(msg);
            } else if (msg.id !== undefined) {
                const p = pending.get(msg.id);
                if (p) {
                    pending.delete(msg.id);
                    msg.error ? p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error })) : p.resolve(msg.result);
                }
            } else if (msg.method === "session/update") {
                const u = msg.params?.update ?? {};
                updates.push({ t: t(), kind: u.sessionUpdate, title: u.title, status: u.status, toolKind: u.kind, text: u.content?.text, meta: u._meta ? Object.keys(u._meta) : undefined, raw: u.sessionUpdate === "usage_update" || u.sessionUpdate === "config_option_update" ? u : undefined });
            } else {
                updates.push({ t: t(), notification: msg.method });
            }
        }
    });
    child.on("exit", (code, signal) => {
        for (const [, p] of pending) {
            p.reject(new Error(`agent exited (${code ?? signal})`));
        }
        pending.clear();
    });
    const close = () =>
        new Promise((resolve) => {
            child.stdin.end();
            const done = setTimeout(() => (child.exitCode === null && child.kill("SIGKILL"), resolve()), 1500);
            child.once("exit", () => (clearTimeout(done), resolve()));
            setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), 500);
        });
    return { request, notify, updates, asks, close, t, stderr: () => stderr };
}

const initialize = (client, { childUpdates = false } = {}) =>
    client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, ...(childUpdates ? { _meta: { "opencode/child-session-updates": true } } : {}) },
        clientInfo: { name: "ocb-acp-probe", version: "0" }
    });

/** mode via config options (2.x, 1.19.0) or session/set_mode (older). */
async function setMode(client, session, mode) {
    if ((session.configOptions ?? []).some((o) => o.id === "mode")) {
        return client.request("session/set_config_option", { sessionId: session.sessionId, configId: "mode", value: mode });
    }
    return client.request("session/set_mode", { sessionId: session.sessionId, modeId: mode });
}

/** One prompt in a new session: stop reason, tool rows, text, asks. */
async function acpTurn(client, cwd, { mode, prompt, timeoutMs = 90000 } = {}) {
    const session = await client.request("session/new", { cwd, mcpServers: [] }, 30000);
    if (mode) {
        await setMode(client, session, mode);
    }
    const before = client.updates.length;
    const asksBefore = client.asks.length;
    let res;
    try {
        res = await client.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: prompt }] }, timeoutMs);
    } catch (error) {
        res = { error: error.message };
    }
    await new Promise((r) => setTimeout(r, 300));
    const seen = client.updates.slice(before);
    return {
        sessionId: session.sessionId,
        stopReason: res?.stopReason ?? res?.error,
        tools: seen.filter((u) => u.kind === "tool_call" || u.kind === "tool_call_update").map((u) => `${u.kind}:${u.toolKind ?? ""}:${u.status ?? ""}:${(u.title ?? "").slice(0, 50)}`),
        text: seen.filter((u) => u.kind === "agent_message_chunk").map((u) => u.text ?? "").join(""),
        asks: client.asks.slice(asksBefore)
    };
}

module.exports = { acpClient, initialize, setMode, acpTurn };

const summarizeOptions = (configOptions) =>
    (configOptions ?? []).map((o) => ({ id: o.id, current: o.currentValue, values: (o.options ?? []).map((v) => v.value ?? v.name).slice(0, 12) }));

async function cli() {
    const [exe, work, scenarioName = "handshake", promptText = "", ...rest] = process.argv.slice(2);
    if (!exe || !work) {
        console.error("usage: node scripts/probe-acp.js <exe> <work-dir> <handshake|prompt|cancel|load|loadprompt> [prompt] [option=value…]");
        process.exit(2);
    }
    const opts = Object.fromEntries(rest.map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
    const project = path.join(work, "project");
    const home = path.join(work, "home");
    fs.mkdirSync(project, { recursive: true });
    let model;
    if (opts.model === "scripted") {
        model = await require("./probe-model").startScriptedModel();
        fs.writeFileSync(path.join(project, "opencode.json"), JSON.stringify(require("./probe-model").projectConfig(model.url), null, 1));
    }
    const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        XDG_STATE_HOME: path.join(home, ".local", "state"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
        PWD: project
    };
    const child = spawn(exe, ["acp"], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(exe) });
    const transcript = path.join(work, `transcript-${scenarioName}-${Date.now()}.jsonl`);
    const client = acpClient(child, { transcript, onPermission: () => (opts.reply === "allow" ? "allow" : "reject") });
    const hardStop = setTimeout(() => {
        console.log(JSON.stringify({ error: "probe hard timeout", stderr: client.stderr().slice(-1500) }));
        child.kill("SIGKILL");
        process.exit(2);
    }, Number(opts.hardMs ?? 150000));
    const out = { exe, scenario: scenarioName };
    try {
        const init = await initialize(client, { childUpdates: Boolean(opts.child) });
        out.initialize = { ms: client.t(), protocolVersion: init.protocolVersion, agentInfo: init.agentInfo, agentCapabilities: init.agentCapabilities, authMethods: (init.authMethods ?? []).map((m) => m.id) };
        let session;
        if (scenarioName === "load" || scenarioName === "loadprompt") {
            const before = client.updates.length;
            const loaded = await client.request("session/load", { sessionId: opts.session, cwd: project, mcpServers: [] }, 30000);
            await new Promise((r) => setTimeout(r, 500));
            session = { sessionId: opts.session, configOptions: loaded?.configOptions };
            out.load = { configOptions: summarizeOptions(loaded?.configOptions), modes: loaded?.modes, replayed: client.updates.slice(before).map((u) => u.kind ?? u.notification) };
        } else {
            session = await client.request("session/new", { cwd: project, mcpServers: [] }, 30000);
            out.session = {
                id: session.sessionId,
                configOptions: summarizeOptions(session.configOptions),
                modes: session.modes ? { current: session.modes.currentModeId, available: session.modes.availableModes?.map((m) => m.id) } : undefined,
                models: session.models ? { current: session.models.currentModelId, available: session.models.availableModels?.map((m) => m.modelId).slice(0, 8) } : undefined
            };
        }
        if (opts.mode) {
            try {
                const set = await setMode(client, session, opts.mode);
                out.setMode = set?.configOptions ? summarizeOptions(set.configOptions) : "set_mode ok";
            } catch (error) {
                out.setMode = `error: ${error.message}`;
            }
        }
        if (scenarioName === "prompt" || scenarioName === "cancel" || scenarioName === "loadprompt") {
            const before = client.updates.length;
            const sent = client.t();
            const prompting = client.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: promptText }] }, 90000);
            let cancelAt;
            if (scenarioName === "cancel") {
                await new Promise((r) => setTimeout(r, Number(opts.cancelAfter ?? 1500)));
                cancelAt = client.t();
                client.notify("session/cancel", { sessionId: session.sessionId });
            }
            try {
                const res = await prompting;
                out.prompt = { stopReason: res?.stopReason, ms: client.t() - sent, usage: res?.usage, meta: res?._meta };
            } catch (error) {
                out.prompt = { error: error.message, rpc: error.rpc };
            }
            if (cancelAt !== undefined) {
                out.cancel = { settledMs: client.t() - cancelAt, updatesAfterCancel: client.updates.slice(before).filter((u) => u.t > cancelAt + 50).length };
            }
            await new Promise((r) => setTimeout(r, 400));
            const seen = client.updates.slice(before);
            const kinds = {};
            for (const u of seen) {
                kinds[u.kind ?? u.notification] = (kinds[u.kind ?? u.notification] ?? 0) + 1;
            }
            out.updates = kinds;
            out.tools = seen.filter((u) => u.kind === "tool_call" || u.kind === "tool_call_update").map((u) => `${u.kind}:${u.toolKind ?? ""}:${u.status ?? ""}:${(u.title ?? "").slice(0, 50)}${u.meta ? ":meta" : ""}`);
            out.usage = seen.filter((u) => u.raw).map((u) => u.raw);
            out.text = seen.filter((u) => u.kind === "agent_message_chunk").map((u) => u.text ?? "").join("").slice(0, 200);
            out.asks = client.asks;
        } else {
            await new Promise((r) => setTimeout(r, 800));
            out.notifications = [...new Set(client.updates.map((u) => u.kind ?? u.notification))];
        }
        if (out.initialize.agentCapabilities?.sessionCapabilities?.list || out.initialize.agentCapabilities?.listSessions) {
            try {
                out.list = ((await client.request("session/list", { cwd: project }))?.sessions ?? []).map((s) => s.sessionId).slice(0, 5);
            } catch (error) {
                out.list = `error: ${error.message}`;
            }
        }
    } catch (error) {
        out.error = error.message;
        out.rpc = error.rpc;
        out.stderr = client.stderr().slice(-2500);
    }
    out.transcript = transcript;
    console.log(JSON.stringify(out, null, 1));
    clearTimeout(hardStop);
    await client.close();
    await model?.close();
}

if (require.main === module) {
    cli().then(() => process.exit(0));
}
