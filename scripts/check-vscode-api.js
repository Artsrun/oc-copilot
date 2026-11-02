#!/usr/bin/env node
// Nightly tripwire (M3): the chat participant API @opencode is built on. VS Code's
// docs call it deprecated (the Copilot harness has no participants, 1.142+), yet
// vscode.d.ts on main gave `createChatParticipant` no @deprecated tag (1.146 dev,
// read 2026-11-02, REFS 0.0.235). This fails the day that changes: a declaration
// gone, or its doc comment gaining @deprecated. Dev only, never shipped.
//
//   node scripts/check-vscode-api.js [path or URL of vscode.d.ts]   (default: main)
"use strict";
const fs = require("node:fs");

const MAIN = "https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.d.ts";
// What the extension calls or implements (src/extension.ts, chat.ts, heartbeat.ts).
const WATCHED = [
    ["function", "createChatParticipant"],
    ["interface", "ChatParticipant"],
    ["interface", "ChatResponseStream"],
    ["interface", "ChatFollowupProvider"],
    ["type", "ChatRequestHandler"]
];

/** The doc comment directly above `index`, or "" when the declaration has none. */
const docAbove = (text, index) => {
    const end = text.lastIndexOf("*/", index);
    const start = text.lastIndexOf("/**", end);
    return end >= 0 && start >= 0 && /^\s*$/.test(text.slice(end + 2, index)) ? text.slice(start, end + 2) : "";
};

/** One verdict per watched declaration: "ok", "missing" or "deprecated". */
const check = (text) =>
    WATCHED.map(([kind, name]) => {
        const at = text.search(new RegExp(`\\n\\s*export ${kind} ${name}\\b`));
        const verdict = at < 0 ? "missing" : /@deprecated\b/.test(docAbove(text, at + 1)) ? "deprecated" : "ok";
        return { kind, name, verdict };
    });

const load = async (source) => {
    if (!/^https?:/.test(source)) {
        return fs.readFileSync(source, "utf8");
    }
    const res = await fetch(source);
    if (!res.ok) {
        throw new Error(`${source}: HTTP ${res.status}`);
    }
    return res.text();
};

if (require.main === module) {
    const source = process.argv[2] || MAIN;
    load(source).then((text) => {
        const version = text.match(/\* @version\s+(\S+)/)?.[1];
        const rows = check(text);
        for (const r of rows) {
            console.log(`${r.verdict === "ok" ? "ok  " : "FAIL"} ${r.kind} ${r.name}: ${r.verdict}`);
        }
        const failed = rows.filter((r) => r.verdict !== "ok");
        console.log(`${failed.length ? `${failed.length} CHANGED` : "CHAT PARTICIPANT API UNCHANGED"} — ${source}${version ? ` (${version})` : ""}, ${text.length} chars`);
        process.exitCode = failed.length ? 1 : 0;
    }).catch((error) => {
        console.error(`could not read vscode.d.ts: ${error.message}`);
        process.exitCode = 2;
    });
}

module.exports = { check, docAbove };
