#!/usr/bin/env node
// Measures, against a REAL `opencode serve` and model, whether a plan turn can
// edit through a subagent — with and without the read-only `task` rules the
// bridge puts on a plan turn's session (0.0.203 `turnPermission`) — and whether
// `GET /session/:id/children` lists the child. Prints one line per measurement.
//
//   node scripts/probe-plan-subagents.js [model]     e.g. anthropic/claude-sonnet-4-5
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-probe-subagents-"));
execFileSync("git", ["init", "-q"], { cwd: dir });
fs.writeFileSync(path.join(dir, "README.md"), "probe\n");
execFileSync("git", ["add", "."], { cwd: dir });
execFileSync("git", ["-c", "user.email=p@p", "-c", "user.name=p", "commit", "-qm", "init"], { cwd: dir });

const HEADLESS = [
    { permission: "question", action: "deny", pattern: "*" },
    { permission: "plan_enter", action: "deny", pattern: "*" },
    { permission: "plan_exit", action: "deny", pattern: "*" }
];
const READ_ONLY = [...HEADLESS, { permission: "task", action: "deny", pattern: "*" }, { permission: "task", action: "allow", pattern: "explore" }];

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

(async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const serve = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: dir, shell: process.platform === "win32" });
    serve.stderr.on("data", (d) => process.stderr.write(`[serve] ${d}`));
    for (let i = 0; i < 120; i++) {
        try {
            if ((await req("GET", base, "/global/health", undefined, 1000)).body?.healthy) break;
        } catch {
            // booting
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    const ask = "Use the task tool with the general subagent to create the file probe-<N>.txt containing the word hi. Do not do it yourself.";
    for (const [label, rules] of [["no task rules", HEADLESS], ["read-only task rules", READ_ONLY]]) {
        const n = label.startsWith("no") ? 1 : 2;
        const ses = (await req("POST", base, "/session", { title: `probe ${label}`, permission: rules })).body;
        const body = { agent: "plan", parts: [{ type: "text", text: ask.replace("<N>", String(n)) }] };
        if (model) {
            const i = model.indexOf("/");
            body.model = { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
        }
        const t0 = Date.now();
        const res = await req("POST", base, `/session/${ses.id}/message`, body);
        const kids = await req("GET", base, `/session/${ses.id}/children`, undefined, 5000).catch((e) => ({ status: String(e) }));
        const tools = (res.body?.parts ?? []).filter((p) => p.type === "tool").map((p) => `${p.tool}:${p.state?.status}${p.state?.input?.subagent_type ? `(${p.state.input.subagent_type})` : ""}`);
        console.log(
            `${label}: HTTP ${res.status} in ${Date.now() - t0}ms · tools ${tools.join(", ") || "none"} · ` +
            `probe-${n}.txt ${fs.existsSync(path.join(dir, `probe-${n}.txt`)) ? "WRITTEN" : "absent"} · ` +
            `/children HTTP ${kids.status} ${Array.isArray(kids.body) ? kids.body.length : "?"} child(ren)`
        );
    }
    serve.kill();
    console.log(`(work dir ${dir})`);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
