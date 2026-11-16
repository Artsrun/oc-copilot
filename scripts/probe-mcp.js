#!/usr/bin/env node
// Against a real OpenCode binary: the bridge's MCP server (out/oc-mcp-server.js)
// driven over stdio as an MCP client drives it, with the scripted model. Can a
// read-only `opencode_ask` write, does a conversation continue by `sessionId`,
// does a long run hand back a job, does Stop reach OpenCode, does the server
// take its OpenCode down with it. One line per row; control rows must be
// `CREATED`. `npm run compile` first.
//
//   node scripts/probe-mcp.js <path-to-opencode>
//
// Dev only, never shipped. Writes to the OS temp dir.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startScriptedModel, projectConfig } = require("./probe-model");
const { startMcp } = require("./fixtures/mcp-client");

const exe = process.argv[2] || "opencode";
const server = path.join(__dirname, "..", "out", "oc-mcp-server.js");

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-probe-mcp-"));
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const outside = path.join(root, "outside");
    for (const dir of [home, project, outside]) fs.mkdirSync(dir);
    const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: project });
    git("init", "-q");
    fs.writeFileSync(path.join(project, "README"), "probe\n");
    fs.writeFileSync(path.join(project, ".env"), "ENV-SECRET\n");
    git("add", "README");
    git("commit", "-qm", "init");
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "OUTSIDE-SECRET\n");
    const env = {
        ...process.env,
        HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local", "state"),
        OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost"
    };
    delete env.OPENCODE_CONFIG_CONTENT;
    const model = await startScriptedModel({});
    fs.writeFileSync(path.join(project, "opencode.json"), JSON.stringify(projectConfig(model.url), null, 1));
    const settingsFile = path.join(root, "engine-settings.json");
    fs.writeFileSync(settingsFile, JSON.stringify({ settings: { executable: exe, opencode2: true, enforceReadOnly: true, readOnlySubagents: ["explore"], serverHostname: "127.0.0.1", idleTimeoutMs: 60000 } }));
    const logFile = path.join(root, "oc-mcp.log");
    const version = execFileSync(exe, ["--version"], { env, cwd: project, encoding: "utf8" }).trim();
    console.log(`opencode ${version}`);

    const rows = [];
    const row = async (label, expect, run) => {
        const t0 = Date.now();
        let got;
        let detail = "";
        try {
            [got, detail] = await run();
        } catch (error) {
            got = "error";
            detail = String(error.message).slice(0, 200);
        }
        rows.push({ label, expect, got });
        console.log(`${got === expect ? "ok  " : "FAIL"} ${label}: ${got}${got === expect ? "" : ` (expected ${expect})`} · ${Date.now() - t0} ms${detail ? ` · ${detail}` : ""}`);
    };
    const target = (n) => {
        const file = path.join(project, `w-${n}.txt`);
        fs.rmSync(file, { force: true });
        return file;
    };
    const wrote = (file) => (fs.existsSync(file) ? "CREATED" : "absent");
    // Forward slashes: OpenCode 2's shell on Windows is Git Bash (AGENTS §4).
    const echoTo = (file) => `echo hi > ${file.replace(/\\/g, "/")}`;
    const about = (r) => `status=${r.facts.status ?? "-"} readOnly=${r.facts.readOnly ?? "-"} agent=${r.facts.agent ?? "-"} steps=${r.facts.steps ?? "-"}${r.isError ? " isError" : ""}`;
    const serveUrl = () => (fs.readFileSync(logFile, "utf8").match(/server (http:\/\/127\.0\.0\.1:\d+)/g) || []).pop()?.slice(7);
    const answers = async (url) => {
        try {
            await fetch(url, { signal: AbortSignal.timeout(1500) });
            return true;
        } catch {
            return false;
        }
    };

    // --- a server as the config snippet starts it: read-only tools only ---
    const args = ["--settings", settingsFile, "--log", logFile, "--wait-ms", "60000"];
    const a = startMcp(server, args, { env, cwd: project });
    await row("legacy initialize answers 2025-11-25 and lists the read-only tools", "ask,wait,cancel", async () => {
        const init = await a.initialize();
        const list = await a.request("tools/list");
        const names = (list.result?.tools ?? []).map((t) => t.name.replace("opencode_", "")).join(",");
        return [init.result?.protocolVersion === "2025-11-25" ? names : `protocol ${init.result?.protocolVersion}`, `server=${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}`];
    });
    let sessionId;
    await row("ask · a text turn answers and names its session", "answered", async () => {
        const r = await a.call("opencode_ask", { prompt: "[[probe:text]] hi", folder: project });
        sessionId = r.facts.sessionId;
        // The answer alone: OpenCode 1 sends the prompt back as a text part of its own.
        return [r.text.startsWith("Hello from the scripted model.") && sessionId && r.facts.status === "done" ? "answered" : "wrong", `${about(r)} text=${JSON.stringify(r.text.slice(0, 50))}`];
    });
    await row("ask · the read-only rules were verified, not assumed", "enforced", async () => {
        const r = await a.call("opencode_ask", { prompt: "[[probe:text]] hi", folder: project, sessionId });
        return [r.facts.sessionId === sessionId ? r.facts.readOnly : `another session ${r.facts.sessionId}`, about(r)];
    });
    await row("ask · the folder defaults to where the server was started", "answered", async () => {
        const r = await a.call("opencode_ask", { prompt: "[[probe:text]] hi" });
        return [/Hello from the scripted model/.test(r.text) && r.facts.folder === fs.realpathSync(project) ? "answered" : "wrong", `folder=${r.facts.folder}`];
    });
    await row("ask · shell echo > file", "absent", async () => {
        const f = target(1);
        const r = await a.call("opencode_ask", { prompt: `[[probe:bash:${echoTo(f)}]] go`, folder: project });
        return [wrote(f), about(r)];
    });
    await row("ask · explore subagent · shell echo > file", "absent", async () => {
        const f = target(2);
        const r = await a.call("opencode_ask", { prompt: `[[probe:task@explore:bash:${echoTo(f)}]] go`, folder: project });
        return [wrote(f), about(r)];
    });
    await row("ask · general subagent · write file", "absent", async () => {
        const f = target(3);
        const r = await a.call("opencode_ask", { prompt: `[[probe:task@general:write:${f}]] go`, folder: project });
        return [wrote(f), about(r)];
    });
    await row("ask · read a file OUTSIDE the folder", "refused", async () => {
        const r = await a.call("opencode_ask", { prompt: `[[probe:read:${secret}]] go`, folder: project });
        return [/OUTSIDE-SECRET/.test(r.text) ? "READ" : "refused", about(r)];
    });
    await row("ask · read .env inside the folder", "refused", async () => {
        const r = await a.call("opencode_ask", { prompt: `[[probe:read:${path.join(project, ".env")}]] go`, folder: project });
        return [/ENV-SECRET/.test(r.text) ? "READ" : "refused", about(r)];
    });
    await row("ask · the home folder is not a project: nothing runs", "refused", async () => {
        const before = fs.readFileSync(logFile, "utf8").split("\n").filter((l) => /mcp job job_/.test(l)).length;
        const r = await a.call("opencode_ask", { prompt: "[[probe:text]] hi", folder: home });
        const after = fs.readFileSync(logFile, "utf8").split("\n").filter((l) => /mcp job job_/.test(l)).length;
        return [r.isError && after === before ? "refused" : "ran", r.text.slice(0, 90)];
    });
    await row("dev is not offered without --dev", "unknown tool", async () => {
        const f = target(4);
        const r = await a.call("opencode_dev", { prompt: `[[probe:bash:${echoTo(f)}]] go`, folder: project });
        return [r.error && wrote(f) === "absent" ? "unknown tool" : `ran: ${wrote(f)}`, r.error?.message ?? ""];
    });
    const aUrl = serveUrl();
    await row("closing stdin ends the server and its OpenCode", "both gone", async () => {
        const up = aUrl ? await answers(aUrl) : false;
        const exit = await a.close();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const still = aUrl ? await answers(aUrl) : true;
        return [up && exit && !still ? "both gone" : `up=${up} exit=${JSON.stringify(exit)} stillAnswers=${still}`, `opencode at ${aUrl}`];
    });

    // --- the same server with --dev, 2026-07-28 framing, and a short wait ---
    const b = startMcp(server, [...args.slice(0, 4), "--wait-ms", "1500", "--dev"], { env, cwd: project, mode: "modern" });
    await row("2026-07-28 server/discover and tools/list, with --dev", "ask,dev,wait,cancel", async () => {
        const found = await b.request("server/discover");
        const list = await b.request("tools/list");
        const names = (list.result?.tools ?? []).map((t) => t.name.replace("opencode_", "")).join(",");
        const modern = found.result?.resultType === "complete" && found.result?.supportedVersions?.includes("2026-07-28") && list.result?.resultType === "complete" && typeof list.result?.ttlMs === "number";
        return [modern ? names : "not modern", `versions=${found.result?.supportedVersions?.join("/")}`];
    });
    await row("control: dev · shell echo > file", "CREATED", async () => {
        const f = target(5);
        const r = await b.call("opencode_dev", { prompt: `[[probe:bash:${echoTo(f)}]] go`, folder: project });
        const first = r.facts.status === "running" ? await b.call("opencode_wait", { jobId: r.facts.jobId, seconds: 60 }) : r;
        return [wrote(f), about(first)];
    });
    let slowJob;
    await row("a run longer than the wait hands back a job", "running", async () => {
        const r = await b.call("opencode_ask", { prompt: "[[probe:slow]] stream", folder: project });
        slowJob = r.facts.jobId;
        return [r.facts.status, `jobId=${slowJob} after ${r.facts.seconds}s`];
    });
    let slowSession;
    await row("opencode_cancel stops it within 3 s", "cancelled", async () => {
        const t0 = Date.now();
        const r = await b.call("opencode_cancel", { jobId: slowJob });
        slowSession = r.facts.sessionId;
        return [Date.now() - t0 < 3000 ? r.facts.status : `slow: ${Date.now() - t0} ms`, about(r)];
    });
    // A prompt to a busy session queues behind its run: the model streams for 20 s unless OpenCode was stopped.
    await row("…and OpenCode itself stopped: the same session answers the next prompt at once", "answered", async () => {
        const t0 = Date.now();
        const r = await b.call("opencode_ask", { prompt: "[[probe:text]] hi", folder: project, sessionId: slowSession });
        const waited = r.facts.status === "running" ? await b.call("opencode_wait", { jobId: r.facts.jobId, seconds: 30 }) : r;
        const ms = Date.now() - t0;
        // `done`, not only the text: the stopped run's own "Step interrupted" must not land in this one.
        return [waited.text.startsWith("Hello from the scripted model.") && waited.facts.status === "done" && ms < 8000 ? "answered" : `${waited.facts.status} after ${ms} ms`, `session=${slowSession} ${about(waited)} text=${JSON.stringify(waited.text.slice(0, 60))}`];
    });
    await row("the client's own cancel (notifications/cancelled) stops a run", "cancelled", async () => {
        const pending = b.call("opencode_ask", { prompt: "[[probe:slow]] stream", folder: project }, { timeoutMs: 4000 });
        await new Promise((resolve) => setTimeout(resolve, 700));
        b.notify("notifications/cancelled", { requestId: pending.id, reason: "probe" });
        const r = await pending;
        const jobId = (fs.readFileSync(logFile, "utf8").match(/job (job_[0-9a-f]+) stopped: the client cancelled/g) || []).pop()?.split(" ")[1];
        const after = jobId ? await b.call("opencode_wait", { jobId, seconds: 5 }) : undefined;
        return [after?.facts.status ?? "no job stopped", `the cancelled call ${r.timedOut ? "got no response" : "was answered"}`];
    });
    await row("a job finished after its call returned is collected by opencode_wait", "done", async () => {
        const first = await b.call("opencode_dev", { prompt: "[[probe:bash:sleep 3]] go", folder: project });
        const r = first.facts.status === "running" ? await b.call("opencode_wait", { jobId: first.facts.jobId, seconds: 60 }) : first;
        return [first.facts.status === "running" ? r.facts.status : `first was ${first.facts.status}`, about(r)];
    });
    await b.close();

    model.close?.();
    const bad = rows.filter((r) => r.got !== r.expect);
    console.log(bad.length ? `${bad.length} ROW(S) NOT AS EXPECTED` : `ALL ${rows.length} ROWS AS EXPECTED — ${version}; work ${root}`);
    process.exit(bad.length ? 1 : 0);
})().catch((error) => {
    console.error(error);
    process.exit(2);
});
