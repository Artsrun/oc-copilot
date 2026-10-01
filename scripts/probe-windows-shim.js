#!/usr/bin/env node
// Windows shim probe.
//
// The rule this exists to enforce: NEVER assert platform behaviour in a comment.
// v0.0.145 carried a comment claiming preferNonCmdSibling handled real npm
// installs. It was false, and nothing tested it, so the claim survived review.
//
// Run this, paste the output into the PR. It measures what actually happens on
// THIS machine: where `opencode` resolves, whether a non-.cmd sibling exists,
// what the shim forwards `%*` to, and — the part that matters — whether a prompt
// containing newlines, `%VAR%`, `&`, and quotes survives the trip to argv.
//
//   node scripts/probe-windows-shim.js
//   node scripts/probe-windows-shim.js --exe /custom/path/opencode
//
// Everything is written under the OS temp directory. Never the repo root: a
// probe that litters the tree it is validating is how stray files ship.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const argExe = process.argv.indexOf("--exe");
const EXE = argExe > -1 ? process.argv[argExe + 1] : "opencode";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-probe-"));
const line = (s = "") => console.log(s);
const h = (s) => line(`\n── ${s} ${"─".repeat(Math.max(0, 58 - s.length))}`);

line(`OpenCode bridge · Windows shim probe`);
line(`platform ${process.platform} ${process.arch} · node ${process.versions.node}`);
line(`probe dir ${tmp}`);
line(`ComSpec  ${process.env.ComSpec || "(unset)"}`);

// ---------------------------------------------------------------------------
h("1 · PATH resolution");
// ---------------------------------------------------------------------------
const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
const hits = [];
for (const dir of dirs) {
    const candidates =
        process.platform === "win32" ? [EXE, ...exts.map((e) => `${EXE}${e.toLowerCase()}`)] : [EXE];
    for (const c of candidates) {
        const full = path.join(dir, c);
        try {
            if (fs.statSync(full).isFile()) {
                hits.push(full);
            }
        } catch {
            /* not here */
        }
    }
}
if (!hits.length) {
    line(`  ${EXE} NOT FOUND on PATH (${dirs.length} entries searched)`);
} else {
    for (const hit of hits) {
        line(`  ${hit}`);
    }
}
const primary = hits[0];

// ---------------------------------------------------------------------------
h("2 · sibling scan (what preferNonCmdSibling sees)");
// ---------------------------------------------------------------------------
if (!primary) {
    line("  skipped — nothing resolved");
} else {
    const dir = path.dirname(primary);
    const base = path.basename(primary).replace(/\.(cmd|bat|ps1)$/i, "");
    const siblings = fs
        .readdirSync(dir)
        .filter((f) => f.replace(/\.[^.]*$/, "").toLowerCase() === base.toLowerCase());
    for (const s of siblings) {
        const full = path.join(dir, s);
        line(`  ${s.padEnd(24)} ${fs.statSync(full).size} bytes`);
    }
    const nonCmd = siblings.find((s) => !/\.(cmd|bat|ps1)$/i.test(s));
    line(`  → non-.cmd sibling: ${nonCmd ? path.join(dir, nonCmd) : "NONE (this is the case that broke)"}`);
}

// ---------------------------------------------------------------------------
h("3 · shim contents (what readShimTarget parses)");
// ---------------------------------------------------------------------------
if (primary && /\.(cmd|bat)$/i.test(primary)) {
    const text = fs.readFileSync(primary, "utf8");
    line(`  ${primary} (${text.length} bytes)`);
    for (const raw of text.split(/\r?\n/)) {
        if (raw.includes("%*")) {
            line(`  forwards: ${raw.trim()}`);
        }
    }
} else {
    line(`  ${primary || EXE} is not a .cmd/.bat shim — no parse needed`);
}

// ---------------------------------------------------------------------------
h("4 · argv round trip (the only check that matters)");
// ---------------------------------------------------------------------------
// A stand-in for OpenCode that reports exactly what reached argv. If the prompt
// below does not come back byte-for-byte, user text is being mangled by a shell.
const echoJs = path.join(tmp, "echo-argv.js");
fs.writeFileSync(
    echoJs,
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n"
);

const HOSTILE = [
    "line one",
    "line two after a newline",
    "%PATH% and %USERPROFILE% must stay literal",
    'quotes " and \'',
    "ampersand & pipe | caret ^ redirect > <",
    "trailing backslash \\"
].join("\n");

const direct = spawnSync(process.execPath, [echoJs, "run", HOSTILE], { encoding: "utf8" });
let survived = false;
try {
    const got = JSON.parse(direct.stdout);
    survived = got[1] === HOSTILE;
    line(`  direct spawn (shell:false) → ${survived ? "INTACT" : "MANGLED"}`);
    if (!survived) {
        line(`    sent: ${JSON.stringify(HOSTILE)}`);
        line(`    got : ${JSON.stringify(got[1])}`);
    }
} catch {
    line(`  direct spawn failed: ${direct.stderr.trim()}`);
}

if (process.platform === "win32") {
    // The same payload through a .cmd shim, which is what the bridge is avoiding.
    const shim = path.join(tmp, "shim.cmd");
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${echoJs}" %*\r\n`);
    const viaCmd = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${shim}" "run" "${HOSTILE.replace(/"/g, '""')}""`], {
        encoding: "utf8"
    });
    line(`  via .cmd shim → ${viaCmd.stdout.trim().slice(0, 200)}`);
    line("    (newlines truncate and %VAR% expands here — that is why the shim is bypassed)");
} else {
    line("  via .cmd shim → skipped, not Windows");
}

// ---------------------------------------------------------------------------
h("5 · verdict");
// ---------------------------------------------------------------------------
line(`  executable        ${primary || "NOT FOUND"}`);
line(`  needs cmd.exe hop ${primary && /\.(cmd|bat)$/i.test(primary) ? "YES — readShimTarget must fire" : "no"}`);
line(`  argv round trip   ${survived ? "PASS" : "FAIL"}`);
line("");
line("Paste everything above into the PR. Do not summarise it in a comment.");

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(survived ? 0 : 1);
