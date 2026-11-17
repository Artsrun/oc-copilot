// A minimal MCP stdio client for the suite (`MP`) and scripts/probe-mcp.js: it
// starts a server as a child process and speaks newline-delimited JSON-RPC to
// it. Dev only.
"use strict";
const { spawn } = require("node:child_process");

/** `legacy`: 2025-11-25's `initialize`. `modern`: 2026-07-28, the version in each request's `_meta`. */
function startMcp(script, args = [], { env = process.env, cwd = process.cwd(), mode = "legacy" } = {}) {
    const child = spawn(process.execPath, [script, ...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    const pending = new Map();
    const notifications = [];
    const frames = [];
    let stderr = "";
    let buffer = "";
    let nextId = 1;
    child.stdout.on("data", (chunk) => {
        buffer += chunk;
        for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
            const line = buffer.slice(0, at).trim();
            buffer = buffer.slice(at + 1);
            if (!line) continue;
            let message;
            try { message = JSON.parse(line); } catch { frames.push({ unparsed: line }); continue; }
            frames.push(message);
            if (message.id !== undefined && message.id !== null && pending.has(message.id)) {
                pending.get(message.id)(message);
                pending.delete(message.id);
            } else if (message.method) {
                notifications.push(message);
            }
        }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => {
        // A request the server died on is answered here, not left to its timeout.
        for (const [id, answer] of pending) answer({ exited: true, id, code, signal });
        pending.clear();
        resolve({ code, signal });
    }));
    const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "ocb-check", version: "1" } };
    const write = (message) => child.stdin.write(JSON.stringify(message) + "\n");
    /** Sends a request; resolves with the whole response frame (`result` or `error`). */
    const request = (method, params, { meta, timeoutMs = 120000, id = nextId++ } = {}) => {
        const withMeta = mode === "modern" || meta ? { ...(params ?? {}), _meta: { ...(mode === "modern" ? META : {}), ...(meta ?? {}), ...(params?._meta ?? {}) } } : params;
        const answered = new Promise((resolve) => pending.set(id, resolve));
        write({ jsonrpc: "2.0", id, method, ...(withMeta === undefined ? {} : { params: withMeta }) });
        let timer;
        const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true, id }), timeoutMs); });
        return Object.assign(Promise.race([answered, late]).finally(() => clearTimeout(timer)), { id });
    };
    const notify = (method, params) => write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    const client = {
        child, notifications, frames, exited, request, notify, write,
        stderr: () => stderr,
        initialize: async (protocolVersion = "2025-11-25") => {
            const reply = await request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "ocb-check", version: "1" } });
            notify("notifications/initialized");
            return reply;
        },
        /** A tool call's result text, with `isError` and the facts of its `[opencode]` line. */
        call: (name, args = {}, options) => {
            const sent = request("tools/call", { name, arguments: args }, options);
            return Object.assign(sent.then((reply) => {
                const text = (reply.result?.content ?? []).map((c) => c.text ?? "").join("");
                const line = text.split("\n").reverse().find((l) => l.startsWith("[opencode] ")) ?? "";
                // `folder` is last and runs to the end of the line: a path may hold spaces.
                const at = line.indexOf(" folder=");
                const facts = Object.fromEntries(line.slice(11, at < 0 ? undefined : at).split(" ").filter((p) => p.includes("=")).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
                if (at >= 0) facts.folder = line.slice(at + 8);
                return { reply, text, facts, isError: reply.result?.isError === true, error: reply.error, timedOut: reply.timedOut === true };
            }), { id: sent.id });
        },
        /** Closes stdin, as a client that is done does; resolves with the exit. */
        close: async (waitMs = 8000) => {
            child.stdin.end();
            const gone = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(undefined), waitMs))]);
            if (!gone) child.kill("SIGKILL");
            return gone;
        }
    };
    return client;
}

module.exports = { startMcp };
