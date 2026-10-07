#!/usr/bin/env node
// Measures, against a REAL `opencode serve` and model, whether a prompt whose
// only part is `{ type: "subtask", agent, description, prompt }` runs that
// subagent on the server — the way a subagent-mode lane could run without
// `opencode run --agent <subagent>` (which falls back to `build`). Issue #21659
// (closed, not planned) says such a part finds only global agents, not the
// project's `.opencode/agents/*`; the bridge always sends `?directory=`, so the
// project-local `look` here is the case that matters. For the built-in
// `explore` and the local `look`: HTTP status, time, the parts that came back,
// the child sessions, and whether the child's own reply carries the word asked for.
//
//   node scripts/probe-subtask-lanes.js [model]     e.g. anthropic/claude-sonnet-4-5
//
// Costs two short model runs. Works in a fresh git repo under the OS temp dir,
// never this repo (AGENTS §4). Needs `opencode` on PATH.
"use strict";
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const model = process.argv[2];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-probe-subtask-"));
execFileSync("git", ["init", "-q"], { cwd: dir });
fs.writeFileSync(path.join(dir, "README.md"), "probe\n");
fs.mkdirSync(path.join(dir, ".opencode", "agents"), { recursive: true });
fs.writeFileSync(
    path.join(dir, ".opencode", "agents", "look.md"),
    "---\ndescription: Reads code and answers; never edits.\nmode: subagent\npermission:\n  edit: deny\n  bash: deny\n---\nYou read code and answer briefly.\n"
);
execFileSync("git", ["add", "."], { cwd: dir });
execFileSync("git", ["-c", "user.email=p@p", "-c", "user.name=p", "commit", "-qm", "init"], { cwd: dir });

const HEADLESS = [
    { permission: "question", action: "deny", pattern: "*" },
    { permission: "plan_enter", action: "deny", pattern: "*" },
    { permission: "plan_exit", action: "deny", pattern: "*" }
];

const req = (method, base, p, body, ms = 240000) =>
    new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const sep = p.includes("?") ? "&" : "?";
        const r = http.request(`${base}${p}${sep}directory=${encodeURIComponent(dir)}`, { method, headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (res) => {
            let raw = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
                try {
                    resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : undefined });
                } catch {
                    resolve({ status: res.statusCode, body: raw });
                }
            });
        });
        r.setTimeout(ms, () => r.destroy(new Error("timeout")));
        r.on("error", reject);
        if (data) r.write(data);
        r.end();
    });

const freePort = () =>
    new Promise((resolve) => {
        const s = http.createServer().listen(0, "127.0.0.1", () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });

const textOf = (messages) =>
    (Array.isArray(messages) ? messages : [])
        .flatMap((m) => m.parts ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join(" ");

(async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const serve = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: dir, shell: process.platform === "win32" });
    serve.stderr.on("data", (d) => process.stderr.write(`[serve] ${d}`));
    let health;
    for (let i = 0; i < 120; i++) {
        try {
            health = (await req("GET", base, "/global/health", undefined, 1000)).body;
            if (health?.healthy) break;
        } catch {
            // booting
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`server: ${JSON.stringify(health)}`);
    const agents = (await req("GET", base, "/agent", undefined, 10000)).body;
    const listed = (Array.isArray(agents) ? agents : []).filter((a) => ["explore", "look", "general"].includes(a.name)).map((a) => `${a.name}(${a.mode})`);
    console.log(`GET /agent?directory=: ${listed.join(", ") || "none of explore/look/general"}`);

    for (const agent of ["explore", "look"]) {
        const word = `PONG-${agent.toUpperCase()}`;
        const ses = (await req("POST", base, "/session", { title: `probe subtask ${agent}`, permission: HEADLESS })).body;
        const body = { parts: [{ type: "subtask", agent, description: `probe ${agent}`, prompt: `Reply with the single word ${word} and nothing else. Use no tools.` }] };
        if (model) {
            const i = model.indexOf("/");
            body.model = { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
        }
        const t0 = Date.now();
        const res = await req("POST", base, `/session/${ses.id}/message`, body).catch((e) => ({ status: String(e) }));
        const ms = Date.now() - t0;
        const parts = (res.body?.parts ?? []).map((p) => (p.type === "tool" ? `tool:${p.tool}:${p.state?.status}${p.state?.input?.subagent_type ? `(${p.state.input.subagent_type})` : ""}` : p.type));
        const kids = await req("GET", base, `/session/${ses.id}/children`, undefined, 5000).catch((e) => ({ status: String(e) }));
        const kidList = Array.isArray(kids.body) ? kids.body : [];
        let kidText = "";
        for (const k of kidList) {
            kidText += textOf((await req("GET", base, `/session/${k.id}/message`, undefined, 10000)).body);
        }
        const parentText = textOf((await req("GET", base, `/session/${ses.id}/message`, undefined, 10000)).body);
        console.log(
            `subtask ${agent}: HTTP ${res.status} in ${ms}ms · reply parts [${parts.join(", ") || "none"}]` +
            `${res.body?.info?.error ? ` · error ${JSON.stringify(res.body.info.error).slice(0, 200)}` : ""}` +
            ` · ${kidList.length} child(ren)${kidList[0]?.title ? ` "${kidList[0].title}"` : ""}` +
            ` · ${word} in child ${kidText.includes(word) ? "YES" : "no"} · in parent ${parentText.includes(word) ? "YES" : "no"}`
        );
    }
    serve.kill();
    console.log(`(work dir ${dir})`);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
