#!/usr/bin/env node
// Records what a REAL OpenCode server sends for a few scripted turns, as the
// suite's fixtures (scripts/fixtures/*.json): the event frames of each turn in
// order, as the server wrote them, with only the folder and the session ids
// replaced by placeholders (`/work/project`, `ses_ROOT`, `ses_CHILD1`, …).
// The fakes in verify-chat-output.js replay them, so both majors' paths are
// checked on real wire bytes. Dev only, never shipped.
//
//   node scripts/record-wire-fixtures.js --v1 <opencode 1.x> --v2 <opencode 2.x> [--out scripts/fixtures]
//
// Each binary runs with an isolated HOME in a temp git repo against the
// scripted model (scripts/probe-model.js). Writes to the OS temp dir otherwise.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const cp = require("node:child_process");
const { startScriptedModel, projectConfig } = require("./probe-model");

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const outDir = path.resolve(arg("--out") ?? path.join(__dirname, "fixtures"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function workspace(major) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ocb-wire${major}-`));
    const home = path.join(root, "home");
    const proj = path.join(root, "project");
    fs.mkdirSync(home);
    fs.mkdirSync(proj);
    const git = (...a) => cp.execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: proj });
    git("init", "-q");
    fs.writeFileSync(path.join(proj, "README"), "x\n");
    git("add", ".");
    git("commit", "-qm", "init");
    const env = {
        ...process.env, HOME: home, PWD: proj,
        XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local", "state"),
        OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
        NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost"
    };
    delete env.OPENCODE_CONFIG_CONTENT;
    return { root, proj, env };
}

async function serve(bin, ws) {
    const port = 47000 + Math.floor(Math.random() * 2000);
    const child = cp.spawn(bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: ws.proj, env: ws.env, stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    child.stdout.on("data", (c) => (said += c));
    child.stderr.on("data", (c) => (said += c));
    for (let i = 0; i < 160 && !/listening/.test(said); i++) await sleep(250);
    const password = said.match(/server password (\S+)/)?.[1];
    const headers = password ? { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") } : {};
    const base = `http://127.0.0.1:${port}`;
    const call = (method, p, body) => new Promise((resolve) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request(base + p, { method, headers: { ...headers, ...(data ? { "content-type": "application/json" } : {}) } }, (res) => {
            let b = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (b += c));
            res.on("end", () => { let json; try { json = JSON.parse(b); } catch { /* not JSON */ } resolve({ status: res.statusCode, json, text: b }); });
        });
        req.on("error", (e) => resolve({ status: 0, text: String(e) }));
        if (data) req.write(data);
        req.end();
    });
    const frames = [];
    let buf = "";
    http.get(base + (password ? "/api/event" : "/global/event"), { headers }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (c) => {
            buf += c;
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
                const block = buf.slice(0, i);
                buf = buf.slice(i + 2);
                const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
                if (data) frames.push(data);
            }
        });
    });
    await sleep(500);
    return { child, call, frames, v2: Boolean(password) };
}

// Placeholders for what differs per run: the folder, then each session id in
// order of appearance (the root first).
function sanitize(raw, ws, root) {
    const ids = new Map([[root, "ses_ROOT"]]);
    return raw.map((data) =>
        data.split(ws.proj).join("/work/project").split(ws.root).join("/work").replace(/ses_[A-Za-z0-9]{20,}/g, (id) => {
            if (!ids.has(id)) ids.set(id, `ses_CHILD${ids.size}`);
            return ids.get(id);
        })
    );
}

const ofSession = (data, sids) => [...sids].some((s) => data.includes(s));

async function recordV2(bin) {
    const ws = workspace(2);
    const model = await startScriptedModel({});
    fs.writeFileSync(path.join(ws.proj, "opencode.json"), JSON.stringify(projectConfig(model.url), null, 1));
    const s = await serve(bin, ws);
    const info = await s.call("GET", "/api/info");
    const out = { version: info.json?.version, turns: {} };
    const turn = async (name, text, act, permissions) => {
        const created = await s.call("POST", "/api/session", { agent: "build", model: { id: "scripted", providerID: "probe" }, location: { directory: ws.proj }, ...(permissions ? { permissions } : {}) });
        const sid = created.json?.data?.id;
        const from = s.frames.length;
        const prompt = await s.call("POST", `/api/session/${sid}/prompt`, { text });
        const sids = new Set([sid]);
        for (let i = 0; i < 120; i++) {
            await sleep(100);
            for (const f of s.frames.slice(from)) {
                const parent = f.match(/"parentID":"(ses_[A-Za-z0-9]+)"/)?.[1];
                const child = f.match(/"sessionID":"(ses_[A-Za-z0-9]+)"/)?.[1];
                if (parent && sids.has(parent) && child) sids.add(child);
            }
            if (act) await act(s, sid, s.frames.slice(from));
            if (s.frames.slice(from).some((f) => f.includes(`"sessionID":"${sid}"`) && /"type":"session\.execution\.(succeeded|failed|interrupted)"/.test(f))) break;
        }
        await sleep(200);
        out.turns[name] = {
            prompt: text,
            promptStatus: prompt.status,
            frames: sanitize(s.frames.slice(from).filter((f) => ofSession(f, sids)), ws, sid)
        };
    };
    await turn("text", "[[probe:text]] hi");
    let replied = false;
    await turn("permission", "[[probe:bash:echo wired]] go", async (srv, sid, frames) => {
        const ask = frames.map((f) => JSON.parse(f)).find((e) => e.type === "permission.asked");
        if (ask && !replied) {
            replied = true;
            await srv.call("POST", `/api/session/${ask.data.sessionID}/permission/${ask.data.id}/reply`, { decision: "once" });
        }
    }, [{ action: "shell", resource: "*", effect: "ask" }]);
    await turn("subagent", "[[probe:task@explore:text]] delegate");
    // A provider rate limit twice, then the answer: what 2.x says while it waits.
    await turn("retry", "[[probe:ratelimit:2]] hi");
    let interrupted = false;
    await turn("interrupt", "[[probe:slow]] stream", async (srv, sid, frames) => {
        if (!interrupted && frames.some((f) => f.includes('"type":"session.text.delta"'))) {
            interrupted = true;
            await srv.call("POST", `/api/session/${sid}/interrupt`);
        }
    });
    s.child.kill();
    model.close?.();
    return out;
}

async function recordV1(bin) {
    const ws = workspace(1);
    const model = await startScriptedModel({});
    fs.writeFileSync(path.join(ws.proj, "opencode.json"), JSON.stringify(projectConfig(model.url), null, 1));
    const s = await serve(bin, ws);
    const q = `directory=${encodeURIComponent(ws.proj)}`;
    const health = await s.call("GET", "/global/health");
    const out = { version: health.json?.version, turns: {} };
    const turn = async (name, text, act) => {
        const created = await s.call("POST", `/session?${q}`, { title: name, permission: [{ permission: "question", pattern: "*", action: "deny" }] });
        const sid = created.json?.id;
        const from = s.frames.length;
        const pending = s.call("POST", `/session/${sid}/message?${q}`, { agent: "build", model: { providerID: "probe", modelID: "scripted" }, parts: [{ type: "text", text }] });
        let done = false;
        void pending.then(() => (done = true));
        for (let i = 0; i < 120 && !done; i++) {
            await sleep(100);
            if (act) await act(s, sid, s.frames.slice(from), q);
        }
        const reply = await pending;
        await sleep(200);
        out.turns[name] = {
            prompt: text,
            reply: sanitize([reply.text], ws, sid)[0],
            frames: sanitize(s.frames.slice(from).filter((f) => f.includes(sid)), ws, sid)
        };
    };
    await turn("text", "[[probe:text]] hi");
    s.child.kill();
    model.close?.();
    return out;
}

(async () => {
    fs.mkdirSync(outDir, { recursive: true });
    const v1 = arg("--v1");
    const v2 = arg("--v2");
    if (!v1 && !v2) {
        console.error("usage: record-wire-fixtures.js --v1 <bin> --v2 <bin> [--out dir]");
        process.exit(2);
    }
    for (const [major, bin, record] of [[1, v1, recordV1], [2, v2, recordV2]]) {
        if (!bin) continue;
        const got = await record(bin);
        const file = path.join(outDir, `wire-v${major}.json`);
        fs.writeFileSync(file, JSON.stringify(got, null, 1) + "\n");
        const rows = Object.entries(got.turns).map(([k, t]) => `${k}: ${t.frames.length} frames`).join(", ");
        console.log(`v${major} ${got.version}: ${rows} → ${path.relative(process.cwd(), file)}`);
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
