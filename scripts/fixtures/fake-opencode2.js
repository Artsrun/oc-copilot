// A fake OpenCode 2 (`opencode v2.0.29`) for the suite's TW group: its server
// answers what 2.0.29 answered (REFS, scripts/fixtures/wire-v2.json) — the web
// app on every path but `/api`, Basic `opencode:<password>` there, and each
// prompt's event frames replayed from the recording with the session ids put
// back. Dev only. Run as `node fake-opencode2.js <argv>` through writeFake.
//
// Env: FAKE_OC2_RECORD   file that gets one JSON line per request
//      FAKE_OC2_VERSION  the version it names (default: the recording's)
//      FAKE_OC2_DROP=1   the server ignores the injected overrides (a 2.x that
//                        does not apply them: the bridge must refuse plan turns)
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const wire = require(path.join(__dirname, "wire-v2.json"));
const PASSWORD = "fake-oc2-PW0rd";
const VERSION = process.env.FAKE_OC2_VERSION || wire.version;

module.exports = (argv) => {
    const a = argv.slice(2);
    if (a.includes("--version")) {
        process.stdout.write(`opencode v${VERSION}\n`);
        process.exit(0);
    }
    const portAt = a.indexOf("--port");
    if (!a.includes("serve") || portAt < 0) {
        process.stderr.write("fake-opencode2: only --version and serve\n");
        process.exit(2);
    }
    const port = Number(a[portAt + 1]);
    const record = (entry) => {
        if (process.env.FAKE_OC2_RECORD) fs.appendFileSync(process.env.FAKE_OC2_RECORD, JSON.stringify(entry) + "\n");
    };
    let occ = {};
    try {
        occ = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}") || {};
    } catch {
        occ = { unparsable: true };
    }
    record({ boot: true, occ });
    // 2.0.29's stock rules for these agents (GET /api/agent), then the injected ones APPENDED (measured).
    const R = (action, effect, resource = "*") => ({ action, resource, effect });
    const stock = {
        build: [R("*", "allow")],
        plan: [R("*", "allow"), R("read", "ask", "*.env"), R("question", "allow"), R("edit", "deny")],
        explore: [R("*", "allow"), R("*", "deny"), R("shell", "allow"), R("read", "allow"), R("subagent", "deny")],
        general: [R("*", "allow")]
    };
    const modes = { build: "primary", plan: "primary", explore: "subagent", general: "subagent" };
    const agentInfo = (id) => ({
        id, name: id, mode: modes[id], hidden: false,
        permissions: [...stock[id], ...(process.env.FAKE_OC2_DROP === "1" ? [] : occ.agents?.[id]?.permissions ?? []), R("browser", "deny")]
    });

    const sessions = new Map();
    const clients = new Set();
    const emit = (frame) => {
        for (const res of clients) res.write(`data: ${frame}\n\n`);
    };
    let n = 0;
    const turns = new Map(); // sessionID → { frames, at, waitingAsk, interrupted }
    const pump = (sid) => {
        const t = turns.get(sid);
        if (!t || t.paused) return;
        while (t.at < t.frames.length) {
            const frame = t.frames[t.at];
            // The bridge replies to an ask; the recorded reply waits for it.
            if (frame.includes('"type":"permission.replied"') && !t.replied) {
                t.paused = true;
                return;
            }
            // An interrupted run streams until the bridge interrupts it.
            if (t.kind === "interrupt" && frame.includes('"type":"session.step.failed"') && !t.interrupted) {
                t.paused = true;
                return;
            }
            t.at += 1;
            emit(frame);
            if (frame.includes('"type":"permission.asked"')) {
                setTimeout(() => pump(sid), 5);
                return;
            }
        }
        turns.delete(sid);
    };
    const kindOf = (text) => (/probe:slow/.test(text) ? "interrupt" : /probe:task@/.test(text) ? "subagent" : /probe:bash/.test(text) ? "permission" : "text");

    const server = http.createServer((req, res) => {
        const u = new URL(req.url, "http://x");
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            const json = (() => { try { return body ? JSON.parse(body) : undefined; } catch { return undefined; } })();
            const authed = req.headers.authorization === "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64");
            record({ method: req.method, path: u.pathname, query: u.search, authed, body: json });
            const send = (code, payload) => {
                res.writeHead(code, { "content-type": "application/json" });
                res.end(payload === undefined ? "" : JSON.stringify(payload));
            };
            if (!u.pathname.startsWith("/api/")) {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end("<!doctype html><html><title>OpenCode</title></html>");
            }
            if (!authed) return send(401, { _tag: "UnauthorizedError", message: "Authentication required" });
            const p = u.pathname.slice(4);
            if (p === "/info") return send(200, { version: VERSION, pid: process.pid, urls: [`http://127.0.0.1:${port}`], paths: { tmp: "/tmp" } });
            if (p === "/event") {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(`data: ${JSON.stringify({ id: "evt_fake", type: "server.connected", data: {} })}\n\n`);
                clients.add(res);
                res.on("close", () => clients.delete(res));
                return;
            }
            if (p === "/agent") return send(200, { location: { directory: u.searchParams.get("location[directory]") }, data: Object.keys(stock).map(agentInfo) });
            const agent = p.match(/^\/agent\/([^/]+)$/);
            if (agent) return stock[agent[1]] ? send(200, { data: agentInfo(agent[1]) }) : send(404, { _tag: "AgentNotFoundError" });
            if (p === "/model") return send(200, { data: [{ id: "scripted", modelID: "scripted", providerID: "probe", name: "Scripted", limit: { context: 64000, output: 4096 }, variants: [{ id: "high" }], enabled: true }] });
            if (p === "/session/active") return send(200, { data: Object.fromEntries([...turns.keys()].map((s) => [s, { type: "running" }])) });
            if (p === "/session" && req.method === "POST") {
                n += 1;
                const id = `ses_fakeTwo${String(n).padStart(4, "0")}AbCdEfGhIjKl`;
                sessions.set(id, { id, time: { created: Date.now(), updated: Date.now() }, permissions: json?.permissions ?? [], metadata: json?.metadata ?? {} });
                return send(200, { data: sessions.get(id) });
            }
            if (p === "/session" && req.method === "GET") return send(200, { data: [...sessions.values()], cursor: {} });
            const one = p.match(/^\/session\/([^/]+)(\/.*)?$/);
            if (!one) return send(404, { _tag: "NotFound" });
            const [, sid, tail = ""] = one;
            const s = sessions.get(sid);
            if (!s) return send(404, { _tag: "SessionNotFoundError" });
            if (!tail && req.method === "GET") return send(200, { data: s });
            if (!tail && req.method === "PATCH") {
                if (json?.permissions) s.permissions = [...s.permissions, ...json.permissions];
                return send(204);
            }
            if (!tail && req.method === "DELETE") { sessions.delete(sid); return send(204); }
            if (tail === "/agent" || tail === "/model") return send(200, { data: {} });
            if (tail === "/message") return send(200, { data: [] });
            if (tail === "/prompt") {
                const kind = kindOf(String(json?.text ?? ""));
                const turn = wire.turns[kind];
                const frames = turn.frames.map((f) => f.split("ses_ROOT").join(sid).replace(/ses_CHILD(\d+)/g, (_, k) => `${sid}c${k}`));
                const inbox = JSON.parse(frames.find((f) => f.includes('"type":"session.inbox.enqueued"'))).data.inboxID;
                turns.set(sid, { frames, at: 0, kind });
                setTimeout(() => pump(sid), 10);
                return send(200, { data: { id: inbox, sessionID: sid, type: "user", payload: { text: json?.text }, delivery: "steer" } });
            }
            const reply = tail.match(/^\/permission\/([^/]+)\/reply$/);
            if (reply) {
                const t = turns.get(sid);
                if (t) { t.replied = true; t.paused = false; setTimeout(() => pump(sid), 5); }
                return send(204);
            }
            if (tail === "/interrupt") {
                const t = turns.get(sid);
                if (t) { t.interrupted = true; t.paused = false; setTimeout(() => pump(sid), 5); }
                return send(200, { interrupted: Boolean(t) });
            }
            if (tail === "/compact") return send(200, { data: { id: "msg_fakecompact", sessionID: sid, type: "compaction" } });
            return send(404, { _tag: "NotFound", path: p });
        });
    });
    server.listen(port, "127.0.0.1", () => {
        process.stdout.write(`server listening on http://127.0.0.1:${port}\n`);
        process.stdout.write(`server password ${PASSWORD}\n`);
    });
};
