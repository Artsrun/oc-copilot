#!/usr/bin/env node
// Data-folder probe (0.0.238): what a real 2.x does to a folder a real 1.x already
// uses, through the bridge's own code (out/) and the scripted model: does it import
// the sessions, can a chat bound to a 1.x session go on, and does 1.x still open the
// folder afterwards? Decides what `opencode2` on by default has to say. One line per row.
//
//   npm run compile && node scripts/probe-data-folder.js <path-to-opencode-2> <path-to-opencode-1>
//
// Writes only under the OS temp dir (AGENTS §4): a git repo and an isolated HOME.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const { startScriptedModel, projectConfig } = require("./probe-model");

const [two, one] = process.argv.slice(2);
if (!two || !one) {
    console.error("usage: probe-data-folder.js <path-to-opencode-2> <path-to-opencode-1>");
    process.exit(2);
}
const settings = { executable: one, opencode2: true, enforceReadOnly: true, readOnlySubagents: ["explore"], serverPort: 0, serverHostname: "127.0.0.1", transport: "server" };
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
const { ensureServer, stopServer, serverAuth, serverVersion } = out("net.js");
const { listSessions } = out("sessions.js");
const { runCapture } = out("proc.js");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-probe-data-"));
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
    fs.writeFileSync(path.join(project, "opencode.json"), JSON.stringify(projectConfig(model.url), null, 1));
    const dbFile = path.join(process.env.XDG_DATA_HOME, "opencode", "opencode.db");

    console.log(`2.x ${(await runCapture(two, ["--version"], project, 15000)).trim()} · 1.x ${(await runCapture(one, ["--version"], project, 15000)).trim()}`);
    const use = (exe) => {
        stopServer();
        settings.executable = exe;
    };
    const rows = [];
    const row = async (label, expect, run) => {
        const t0 = Date.now();
        let got;
        let note = "";
        try {
            [got, note] = await run();
        } catch (error) {
            got = "error";
            note = String(error?.message ?? error).slice(0, 240);
        }
        rows.push({ label, expect, got });
        console.log(`${got === expect ? "ok  " : "FAIL"} ${label}: ${got}${got === expect ? "" : ` (expected ${expect})`} · ${Date.now() - t0} ms${note ? ` · ${note}` : ""}`);
    };
    const turn = (exe, sessionId) => {
        const said = [];
        return runOpenCode({
            executable: exe, task: "[[probe:text]] hi", cwd: project, agent: "build", model: "probe/scripted", pure: false, autoApprove: true,
            json: true, timeoutMs: 90000, idleTimeoutMs: 60000, thinking: false, sessionId, onText: (t) => said.push(t), onStep: () => undefined
        }).then((metrics) => ({ metrics, text: said.join("") }));
    };
    const verdict = (r) => (/Hello from the scripted model/.test(r.text) && !r.metrics.error ? "answered" : "no answer");
    const note = (r) => `session=${r.metrics.sessionId ?? "-"} error=${String(r.metrics.error ?? "-").slice(0, 160)}`;
    const listed = async (id) => {
        const base = await ensureServer(project);
        return (await listSessions(base, project, 50)).some((s) => s.id === id);
    };
    // A copy, with every process stopped: the live file is the product's, read through nothing it could lock.
    const counts = (label) => {
        try {
            const copy = path.join(root, `copy-${Date.now()}.db`);
            for (const suffix of ["", "-wal", "-shm"]) {
                if (fs.existsSync(dbFile + suffix)) fs.copyFileSync(dbFile + suffix, copy + suffix);
            }
            const { DatabaseSync } = require("node:sqlite");
            const db = new DatabaseSync(copy, { readOnly: true });
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
            const shown = ["session", "session_v2", "message", "part", "session_message", "event"].filter((t) => tables.includes(t))
                .map((t) => `${t} ${db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n}`);
            console.log(`     db ${label}: ${tables.length} tables · ${shown.join(" · ")} · ${Math.round(fs.statSync(dbFile).size / 1024)} KB`);
            db.close();
        } catch (error) {
            console.log(`     db ${label}: unreadable (${String(error?.message ?? error).slice(0, 120)})`);
        }
    };

    // 1.x, as a user has it before the upgrade.
    use(one);
    let first;
    await row("1.x · a turn makes a session", "answered", async () => {
        const r = await turn(one);
        first = r.metrics.sessionId;
        return [verdict(r), note(r)];
    });
    use(one);
    counts("after 1.x");

    // 2.x on that folder for the first time: the import, read as it happens.
    use(two);
    await row("2.x · starts on a folder 1.x made, and reads the import's status", "completed", async () => {
        const base = await ensureServer(project);
        const seen = [];
        let last = "";
        for (let i = 0; i < 40; i++) {
            const res = await fetch(`${base}/api/experimental/migration/v1`, { headers: serverAuth(base) ?? {} });
            const body = await res.json().catch(() => ({}));
            last = res.ok ? String(body?.status ?? "?") : `HTTP ${res.status}`;
            seen.push(last);
            if (last !== "required" && last !== "running") break;
            await delay(250);
        }
        return [last, `version ${serverVersion(base)} · ${[...new Set(seen)].join(" → ")}`];
    });
    await row("2.x · lists the 1.x session", "listed", async () => {
        const started = Date.now();
        while (Date.now() - started < 30000) {
            if (await listed(first)) return ["listed", `after ${Date.now() - started} ms`];
            await delay(500);
        }
        return ["not listed", ""];
    });
    await row("2.x · a chat bound to the 1.x session goes on in it", "answered, same session", async () => {
        const r = await turn(two, first);
        return [`${verdict(r)}, ${r.metrics.sessionId === first ? "same session" : "another session"}`, note(r)];
    });
    let onTwo;
    await row("2.x · a new session answers", "answered", async () => {
        const r = await turn(two);
        onTwo = r.metrics.sessionId;
        return [verdict(r), note(r)];
    });
    use(one);
    counts("after 2.x");

    // Back on 1.x: the way out, if 2.x is rolled back.
    use(one);
    await row("1.x again · still opens the folder", "answered", async () => {
        const r = await turn(one);
        return [verdict(r), note(r)];
    });
    await row("1.x again · still lists its session", "listed", async () => [(await listed(first)) ? "listed" : "not listed", ""]);
    await row("1.x again · goes on in its session", "answered, same session", async () => {
        const r = await turn(one, first);
        return [`${verdict(r)}, ${r.metrics.sessionId === first ? "same session" : "another session"}`, note(r)];
    });
    await row("1.x again · a session 2.x made", "not listed", async () => [(await listed(onTwo)) ? "listed" : "not listed", ""]);
    let later;
    await row("1.x again · a new session", "answered", async () => {
        const r = await turn(one);
        later = r.metrics.sessionId;
        return [verdict(r), note(r)];
    });
    use(one);
    counts("after 1.x again");

    // 2.x once more: does it pick up what 1.x made after the import?
    use(two);
    await row("2.x again · a session 1.x made after the import", "not listed", async () => {
        await ensureServer(project);
        await delay(3000);
        return [(await listed(later)) ? "listed" : "not listed", ""];
    });
    use(one);
    counts("at the end");
    model.close?.();
    const failed = rows.filter((r) => r.got !== r.expect);
    console.log(failed.length ? `${failed.length} ROW(S) NOT AS EXPECTED` : `ALL ${rows.length} ROWS AS EXPECTED`);
    if (failed.length || process.env.PROBE_LOG) console.log(log.filter((l) => !/\[serve\]/.test(l)).slice(-40).join("\n"));
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
