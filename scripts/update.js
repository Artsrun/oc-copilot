#!/usr/bin/env node
// Install the newest delivered VSIX into VS Code when it is newer than the one
// installed. A VSIX installed by hand never auto-updates (no gallery behind it).
//
//   node scripts/update.js                       code and code-insiders, VSIX from dist/
//   node scripts/update.js --from <folder>       VSIXes from a shared folder or download
//   node scripts/update.js --editor code         only this editor CLI (repeatable)
//   node scripts/update.js --check               report, install nothing
//
// Trust comes from docs/released.txt (in git): a VSIX is installed only if its
// sha256 is the one recorded for its version, wherever the file came from.
// Dev only, never shipped. Reload VS Code windows afterwards.
"use strict";
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ID = "local.opencode-copilot-bridge";
const NAME = "opencode-copilot-bridge";
const root = path.resolve(__dirname, "..");
const win = process.platform === "win32";

function args(argv) {
    const out = { from: path.join(root, "dist"), ledger: path.join(root, "docs", "released.txt"), editors: [], check: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--from") out.from = path.resolve(argv[++i] ?? "");
        else if (a === "--ledger") out.ledger = path.resolve(argv[++i] ?? "");
        else if (a === "--editor") out.editors.push(argv[++i] ?? "");
        else if (a === "--check") out.check = true;
        else throw new Error(`unknown argument ${a}`);
    }
    if (!out.editors.length) out.editors = ["code", "code-insiders"];
    return out;
}

const cmp = (a, b) => {
    const x = a.split(".").map(Number);
    const y = b.split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    }
    return 0;
};

function ledger(file) {
    return fs.readFileSync(file, "utf8").split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => l.split(/\s+/))
        .filter(([version, sha]) => /^\d+\.\d+\.\d+$/.test(version ?? "") && /^[0-9a-f]{64}$/.test(sha ?? ""))
        .map(([version, sha]) => ({ version, sha }));
}

// Editor CLIs are `.cmd` shims on Windows: they need a shell, so every argument is quoted.
function run(editor, argv, opts = {}) {
    const quoted = win ? argv.map((a) => `"${a.replace(/"/g, "")}"`) : argv;
    return execFileSync(win ? `"${editor}"` : editor, quoted, { encoding: "utf8", shell: win, windowsHide: true, ...opts });
}

function main() {
    const opt = args(process.argv.slice(2));
    const entries = ledger(opt.ledger).sort((a, b) => cmp(b.version, a.version));
    const latest = entries.find((e) => fs.existsSync(path.join(opt.from, `${NAME}-${e.version}.vsix`)));
    if (!latest) {
        console.log(`no delivered VSIX in ${opt.from} (versions in ${path.relative(root, opt.ledger) || opt.ledger}: ${entries.map((e) => e.version).join(", ") || "none"})`);
        return 1;
    }
    if (latest !== entries[0]) {
        console.log(`note: ${entries[0].version} is delivered but not in ${opt.from}; newest there is ${latest.version}`);
    }
    const vsix = path.join(opt.from, `${NAME}-${latest.version}.vsix`);
    const sha = crypto.createHash("sha256").update(fs.readFileSync(vsix)).digest("hex");
    if (sha !== latest.sha) {
        console.log(`REFUSED ${path.basename(vsix)}: sha256 ${sha.slice(0, 12)}… is not the delivered ${latest.sha.slice(0, 12)}…`);
        return 2;
    }
    let found = 0;
    for (const editor of opt.editors) {
        let listed;
        try {
            listed = run(editor, ["--list-extensions", "--show-versions"]);
        } catch {
            console.log(`${editor}: not found, skipped`);
            continue;
        }
        found += 1;
        const have = listed.match(new RegExp(`^${ID.replace(/\./g, "\\.")}@(\\S+)\\s*$`, "im"))?.[1];
        if (have && cmp(have, latest.version) >= 0) {
            console.log(`${editor}: ${have} is current`);
            continue;
        }
        if (opt.check) {
            console.log(`${editor}: ${have ?? "not installed"} → ${latest.version} available`);
            continue;
        }
        run(editor, ["--install-extension", vsix, "--force"], { stdio: "inherit" });
        console.log(`${editor}: ${have ?? "not installed"} → ${latest.version} (sha256 ${sha.slice(0, 12)}…) — reload its windows`);
    }
    return found ? 0 : 3;
}

try {
    process.exitCode = main();
} catch (error) {
    console.log(`update: ${error.message}`);
    process.exitCode = 1;
}
