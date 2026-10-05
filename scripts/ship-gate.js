#!/usr/bin/env node
// Ship gate. Four checks, in order, fail-fast. A red check or an unexpected file
// in the package list is a release blocker.
//
//   1. typecheck   tsc --noEmit          source is sound
//   2. build       tsc                   extension.js matches src
//   3. verify      headless suite        behaviour is unchanged
//   4. package     file list allowlist   only intended files ship
//
// v0.0.145 shipped with a red typecheck and a stray .vsix committed at the repo
// root. Both were visible; nothing was looking. This is what looks.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// The package list is an ALLOWLIST. .vscodeignore is a denylist, so any new file
// dropped at the repo root ships by default unless someone remembers to exclude
// it. This inverts that: an unlisted file fails the gate.
const ALLOWED = [
    "extension.vsixmanifest",
    "[Content_Types].xml",
    "extension/package.json",
    // One entry per emitted module, deliberately: a new cluster must be added
    // here consciously rather than shipping because it landed in out/.
    "extension/out/extension.js",
    "extension/out/core.js",
    "extension/out/env.js",
    "extension/out/format.js",
    "extension/out/metrics.js",
    "extension/out/proc.js",
    "extension/out/prompt.js",
    "extension/out/net.js",
    "extension/out/context.js",
    "extension/out/session.js",
    "extension/out/models.js",
    "extension/out/runs.js",
    "extension/out/commands.js",
    "extension/out/chat-boot.js",
    "extension/out/chat.js",
    "extension/out/chat-commands.js",
    "extension/out/commands-registry.js",
    "extension/out/worktree.js",
    "extension/out/chat-worktree.js",
    // v181: every chip, prompt and kaomoji mark — loaded by out/followups.js.
    "extension/out/followups.js",
    "extension/out/followups.json",
    // v183: answer-derived follow-up chips.
    "extension/out/natural.js",
    // v185: which agent a read-only turn runs as (planAgent).
    "extension/out/agents.js",
    // v190: /sessions and the /parallel composer.
    "extension/out/sessions.js",
    "extension/out/chat-sessions.js",
    "extension/out/compose.js",
    "extension/readme.md",
    "extension/README.md",
    "extension/LICENSE.txt",
    "extension/LICENSE",
    // CHANGELOG.md is deliberately NOT shippable: .vscodeignore keeps the
    // release history out of the package (see the note there). Listing it
    // here as allowed would state the opposite intent — AGENTS.md rule 7
    // is that these two controls agree, not merely that neither fails.
    "extension/media/icon.png",
    "extension/scripts/start-parallel-agents.sh",
    "extension/scripts/start-parallel-agents.ps1"
];

let failed = 0;
const results = [];

const run = (label, cmd, args, opts = {}) => {
    process.stdout.write(`\n─── ${label} ─── ${cmd} ${args.join(" ")}\n`);
    const res = spawnSync(cmd, args, {
        cwd: root,
        encoding: "utf8",
        shell: process.platform === "win32",
        ...opts
    });
    const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
    if (out) {
        console.log(out);
    }
    const ok = res.status === 0;
    if (!ok) {
        failed += 1;
    }
    results.push([label, ok]);
    return { ok, out, status: res.status };
};

// ---------------------------------------------------------------------------
// 1 · typecheck
// ---------------------------------------------------------------------------
run("1/4 typecheck", "npx", ["tsc", "-p", ".", "--noEmit"]);

// ---------------------------------------------------------------------------
// 2 · build
// ---------------------------------------------------------------------------
const built = run("2/4 build", "npx", ["tsc", "-p", "."]);
if (built.ok) {
    // A stale build is the single easiest way to ship code nobody tested. With
    // several modules the check is newest-output vs newest-source, so a stale
    // cluster cannot hide behind a freshly rebuilt entry point.
    const newest = (dir, ext) =>
        fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(ext))
            .reduce((max, f) => Math.max(max, fs.statSync(path.join(dir, f)).mtimeMs), 0);
    const fresh = newest(path.join(root, "out"), ".js") >= newest(path.join(root, "src"), ".ts");
    results.push(["2/4 build output is newer than source", fresh]);
    if (!fresh) {
        failed += 1;
    }
}

// ---------------------------------------------------------------------------
// 3 · verify
// ---------------------------------------------------------------------------
// shell:false is deliberate. process.execPath is "C:\Program Files\nodejs\node.exe"
// on a default Windows install, and a shell splits it at the space, so this check
// could never pass here. node.exe needs no shell to launch.
const verified = run("3/4 verify", process.execPath, [path.join("scripts", "verify-chat-output.js")], {
    shell: false
});
if (verified.ok && !/ALL \d+ CHECKS PASSED/.test(verified.out)) {
    // Exit 0 without the banner means the suite bailed early.
    results.push(["3/4 verify printed the pass banner", false]);
    failed += 1;
}

// ---------------------------------------------------------------------------
// 4 · package file list
// ---------------------------------------------------------------------------
process.stdout.write("\n─── 4/4 package ─── npx vsce ls\n");
const ls = spawnSync("npx", ["--yes", "@vscode/vsce", "ls", "--tree"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32"
});

if (ls.status !== 0) {
    // Distinguish "vsce could not run" from "vsce ran and rejected the extension".
    // Both exit non-zero, but only the first is safe to simulate around. Treating a
    // validation error as "offline" hides a hard packaging blocker behind a green
    // check — and the local simulation cannot see manifest errors at all, because
    // it only walks the file tree. Both 0.0.148 and 0.0.151 reached this gate with
    // "@types/vscode ^1.136.0 greater than engines.vscode ^1.90.0", and the
    // outage-only branch reported it as a network problem.
    const diag = `${ls.stdout || ""}${ls.stderr || ""}`;
    const rejected = /^\s*ERROR\b/m.test(diag);
    if (rejected) {
        console.log(diag.trim());
        console.log("\nvsce ran and REJECTED this extension — that is a packaging blocker, not an outage.");
        results.push(["4/4 vsce accepts the manifest", false]);
        failed += 1;
    } else {
        console.log("vsce unavailable — falling back to the local file-list simulation.");
        const listed = simulatePackageList(root);
        checkList(listed);
    }
} else {
    console.log(ls.stdout.trim());
    const listed = spawnSync("npx", ["--yes", "@vscode/vsce", "ls"], {
        cwd: root,
        encoding: "utf8",
        shell: process.platform === "win32"
    })
        .stdout.split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => `extension/${l}`);
    checkList(listed);
}

function checkList(listed) {
    const unexpected = listed.filter(
        (f) => !ALLOWED.includes(f) && !ALLOWED.includes(f.replace(/^extension\//, ""))
    );
    console.log(`\n${listed.length} file(s) would ship:`);
    for (const f of listed) {
        console.log(`  ${unexpected.includes(f) ? "✗" : "·"} ${f}`);
    }
    const ok = unexpected.length === 0;
    results.push(["4/4 no unexpected files in the package", ok]);
    if (!ok) {
        failed += 1;
        console.log(`\nUnexpected: ${unexpected.join(", ")}`);
        console.log("Add it to ALLOWED in scripts/ship-gate.js, or to .vscodeignore.");
    }
    // v150: the packaged files are public once the .vsix leaves your machine.
    // An internal hostname in package.json or the README renders as a dead
    // "Repository" link for everyone else and leaks infrastructure names.
    // v162: the org token itself leaks, not just the hostname. Measured: fetching
    // https://github.com/<employer-org>/opencode-copilot-connect does not
    // 404 — it redirects to the employer's single sign-on page, so the marketplace
    // "Repository" link advertised the employer and sent every visitor to a
    // corporate SSO page. Match the bare token wherever it appears.
    // The repository is public, so the private tokens (employer, internal hosts)
    // cannot live in it: they come from OCB_LEAKY (comma/pipe-separated) and
    // ~/.ocb-leaky (one per line, # comments). Without either the gate warns.
    const privateTokens = [
        ...(process.env.OCB_LEAKY || "").split(/[,|]/),
        ...(fs.existsSync(path.join(os.homedir(), ".ocb-leaky"))
            ? fs.readFileSync(path.join(os.homedir(), ".ocb-leaky"), "utf8").split(/\r?\n/).filter((l) => !l.trim().startsWith("#"))
            : [])
    ]
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (privateTokens.length === 0) {
        console.log("\nNote: no private leak tokens (OCB_LEAKY or ~/.ocb-leaky); only generic hostnames are scanned.");
    }
    const LEAKY = new RegExp(
        [/\b(tfs|jira)\.[a-z0-9-]+\.(tools|com|local|internal)\b|GitCollection/.source, ...privateTokens].join("|"),
        "i"
    );
    const leaks = [];
    // Everything git would commit is public, not only what ships: the suite's
    // fixtures held the employer's gateway ids while this scan read only the
    // package. Without a git checkout (a tar of the tree) the same list comes
    // from walking the tree under .gitignore: a scan of the packaged files alone
    // passed the 0.0.195 tar's .vscode/settings.json, which named the gateway.
    const tracked = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" });
    const scanned = tracked.status === 0 ? tracked.stdout.split(/\r?\n/).filter(Boolean) : committable(root);
    for (const rel of scanned) {
        if (rel === "scripts/ship-gate.js") {
            continue; // holds the generic patterns themselves
        }
        const full = path.join(root, rel);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
            continue;
        }
        const raw = fs.readFileSync(full);
        if (raw.includes(0)) {
            continue; // binary (icon.png)
        }
        for (const [i, line] of raw.toString("utf8").split(/\r?\n/).entries()) {
            if (LEAKY.test(line)) {
                leaks.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
            }
        }
    }
    const noLeaks = leaks.length === 0;
    results.push([`4/4 no internal names in ${tracked.status === 0 ? "committed" : "any"} files`, noLeaks]);

    // v178: a README claim must name code that backs it. Tag the claim with
    // <!-- claim:id --> and put `claim:id` in a comment next to the code. A
    // claim with no anchor is a promise nothing implements (v177 README told
    // people to review with a git command that printed nothing).
    const claimReadme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const claimIds = [...new Set([...claimReadme.matchAll(/<!--\s*claim:([\w-]+)\s*-->/g)].map((m) => m[1]))];
    const anchorText = ["src", "scripts"]
        .flatMap((d) => fs.readdirSync(path.join(root, d)).map((f) => path.join(root, d, f)))
        .filter((f) => fs.statSync(f).isFile())
        .map((f) => fs.readFileSync(f, "utf8"))
        .join("\n");
    const orphanClaims = claimIds.filter((id) => !new RegExp(`claim:${id}\\b(?!\\s*-->)`).test(anchorText));
    results.push([`4/4 every README claim is anchored in code (${claimIds.length} claims)`, claimIds.length > 0 && orphanClaims.length === 0]);
    if (orphanClaims.length) {
        failed += 1;
        console.log(`\nREADME claims with no code anchor: ${orphanClaims.join(", ")}`);
    }
    if (!noLeaks) {
        failed += 1;
        console.log("\nInternal references that would ship publicly:");
        for (const l of leaks) {
            console.log(`  ${l}`);
        }
    }

    // A dead or SSO-walled "Repository" link is worse than none: the marketplace
    // renders it for everyone. Absent is honest. If a public repo ever exists, add
    // its host here deliberately.
    const PUBLIC_HOSTS = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//i;
    const badLinks = [];
    for (const field of ["repository", "homepage", "bugs"]) {
        const value = pkg[field];
        const url = typeof value === "string" ? value : value && value.url;
        if (url && !PUBLIC_HOSTS.test(url)) {
            badLinks.push(`${field}: ${url}`);
        }
    }
    const linksOk = badLinks.length === 0;
    results.push(["4/4 package.json links omitted or on a public host", linksOk]);
    if (!linksOk) {
        failed += 1;
        console.log("\nLinks that would render publicly but are not public:");
        for (const l of badLinks) {
            console.log(`  ${l}`);
        }
        console.log("Remove the field, or point it at a real public repository.");
    }

    // The docs drift while the manifest moves. Each check is loose on purpose — a
    // gate that fires is better than none — but together they close the gap that
    // let eight versions ship undocumented: the version, every command, and every
    // setting must name themselves in the readme.
    const readmePath = path.join(root, "README.md");
    const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, "utf8") : "";
    // 1 · the changelog must name the current version exactly as a heading.
    const docVersion = new RegExp(`^#{2,6}\\s+${pkg.version.replace(/\./g, "\\.")}\\s*$`, "m");
    results.push(["4/4 readme has a changelog heading for this version", docVersion.test(readme)]);
    // The lock's own version drifted twice (0.0.187 in 0.0.189, 0.0.194 in
    // 0.0.195): `npm version` was never run, the manifest was edited by hand.
    const lockPath = path.join(root, "package-lock.json");
    const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")) : {};
    const lockVersions = [lock.version, lock.packages?.[""]?.version];
    results.push([
        `4/4 package-lock.json is at ${pkg.version}${lockVersions.every((v) => v === pkg.version) ? "" : ` (has ${lockVersions.join(", ")})`}`,
        lockVersions.every((v) => v === pkg.version)
    ]);
    if (!lockVersions.every((v) => v === pkg.version)) {
        failed += 1;
        console.log(`\npackage-lock.json says ${lockVersions.join(" / ")}; run \`npm install --package-lock-only\`.`);
    }
    // v183: `vsce package` (not `vsce ls`) rejects a relative README link when
    // package.json has no repository URL — which is deliberate here (REFS). The
    // gate said "safe to package" and packaging then failed on
    // `[CHANGELOG.md](CHANGELOG.md)`. Links in the readme must be absolute.
    const relativeLinks = [...readme.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)].map((m) => m[1]);
    results.push([
        `4/4 readme links are absolute${relativeLinks.length ? ` (relative: ${relativeLinks.join(", ")})` : ""}`,
        relativeLinks.length === 0
    ]);
    if (relativeLinks.length) {
        failed += 1;
    }
    if (!docVersion.test(readme)) {
        failed += 1;
        console.log(`\nThe readme has no changelog heading matching version ${pkg.version}.`);
        console.log("Add one before the gate will pass.");
    }
    // 2 · every contributed command names its last segment in the readme.
    const missingCommands = [];
    for (const c of pkg.contributes?.commands ?? []) {
        const last = c.command.split(".").pop();
        if (!readme.includes(last)) {
            missingCommands.push(c.command);
        }
    }
    results.push(["4/4 every command is documented in the readme", missingCommands.length === 0]);
    if (missingCommands.length) {
        failed += 1;
        console.log(`\nUndocumented command(s): ${missingCommands.join(", ")}`);
    }
    // v188: every chat command too, as `/name` (a chat command once shipped
    // undocumented in a draft: this list only read the palette commands).
    const missingChat = (pkg.contributes?.chatParticipants ?? [])
        .flatMap((p) => (p.commands ?? []).map((c) => c.name))
        .filter((name, i, all) => all.indexOf(name) === i && !readme.includes(`/${name}`));
    results.push(["4/4 every chat command is documented in the readme", missingChat.length === 0]);
    if (missingChat.length) {
        failed += 1;
        console.log(`\nUndocumented chat command(s): ${missingChat.map((n) => `/${n}`).join(", ")}`);
    }
    // 3 · every setting names its last segment in the readme.
    const config = pkg.contributes?.configuration?.properties ?? {};
    const missingSettings = [];
    for (const key of Object.keys(config)) {
        const last = key.split(".").pop();
        if (!readme.includes(last)) {
            missingSettings.push(key);
        }
    }
    results.push(["4/4 every setting is documented in the readme", missingSettings.length === 0]);
    if (missingSettings.length) {
        failed += 1;
        console.log(`\nUndocumented setting(s): ${missingSettings.join(", ")}`);
    }

    // v188: one version, one build. 0.0.187 was rebuilt with different code
    // under the same number; a VSIX already in dist/ for this version must hold
    // exactly today's out/*.js, or the version needs a bump.
    const drift = packagedDrift(path.join(root, "dist", `${pkg.name}-${pkg.version}.vsix`));
    results.push([`4/4 no packaged ${pkg.version} with other code${drift.length ? ` (differs: ${drift.join(", ")})` : ""}`, drift.length === 0]);
    if (drift.length) {
        failed += 1;
        console.log(`\ndist/ already holds ${pkg.version} built from other code. Bump the version.`);
    }

    // The .vsix itself must never be committed next to the source it packages.
    const strays = fs
        .readdirSync(root)
        .filter((f) => f.endsWith(".vsix") || f.endsWith(".tgz") || f.endsWith(".log"));
    const clean = strays.length === 0;
    results.push(["4/4 no build artifacts at the repo root", clean]);
    if (!clean) {
        failed += 1;
        console.log(`\nStray artifacts at repo root: ${strays.join(", ")} — these belong in .gitignore.`);
    }
}

// The out/*.js a packaged VSIX holds that differ from out/ now (none if there
// is no such VSIX). A VSIX is a zip: central directory → local header → data.
function packagedDrift(vsix) {
    if (!fs.existsSync(vsix)) {
        return [];
    }
    const zlib = require("node:zlib");
    const buf = fs.readFileSync(vsix);
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let at = buf.readUInt32LE(eocd + 16);
    const packed = new Map();
    for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
        const method = buf.readUInt16LE(at + 10);
        const size = buf.readUInt32LE(at + 20);
        const nameLen = buf.readUInt16LE(at + 28);
        const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
        const local = buf.readUInt32LE(at + 42);
        at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
        const m = name.match(/^extension\/out\/([^/]+\.js)$/);
        if (m) {
            const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
            const data = buf.subarray(start, start + size);
            packed.set(m[1], method === 8 ? zlib.inflateRawSync(data) : data);
        }
    }
    const outDir = path.join(root, "out");
    const built = fs.readdirSync(outDir).filter((f) => f.endsWith(".js"));
    return [...new Set([...packed.keys(), ...built])].filter((f) => {
        const mine = path.join(outDir, f);
        return !packed.has(f) || !fs.existsSync(mine) || !packed.get(f).equals(fs.readFileSync(mine));
    });
}

// Mirrors vsce's own rules closely enough to catch a stray root file offline:
// everything under the repo, minus .vscodeignore globs, minus .git.
function simulatePackageList(dir) {
    const ignoreFile = path.join(dir, ".vscodeignore");
    const patterns = fs.existsSync(ignoreFile)
        ? fs
              .readFileSync(ignoreFile, "utf8")
              .split(/\r?\n/)
              // Trailing \r on a CRLF .vscodeignore silently breaks every pattern
              // in vsce too; trimming here keeps the simulation honest either way.
              .map((l) => l.trim())
              .filter((l) => l && !l.startsWith("#"))
        : [];
    // Placeholders first: replacing `**` with `(.*/)?` and then `*` and `?`
    // rewrote the group it had just written, so `dist/**` matched nothing and
    // every dist VSIX "shipped" whenever vsce could not run.
    const toRe = (glob) =>
        new RegExp(
            "^" +
                glob
                    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                    .replace(/\*\*\//g, "\u0000")
                    .replace(/\*\*/g, "\u0003")
                    .replace(/\*/g, "\u0001")
                    .replace(/\?/g, "\u0002")
                    .replace(/\u0000/g, "(.*/)?")
                    .replace(/\u0003/g, ".*")
                    .replace(/\u0001/g, "[^/]*")
                    .replace(/\u0002/g, "[^/]") +
                "$"
        );
    const res = patterns.map(toRe);
    const out = [];
    const walk = (cur, rel) => {
        for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
            const r = rel ? `${rel}/${entry.name}` : entry.name;
            if (r === ".git" || r === "node_modules") {
                continue;
            }
            if (entry.isDirectory()) {
                walk(path.join(cur, entry.name), r);
            } else if (!res.some((re) => re.test(r))) {
                out.push(`extension/${r}`);
            }
        }
    };
    walk(dir, "");
    return out;
}

// What git would commit, without git: the tree minus .gitignore. Covers the
// pattern forms that file uses — `dir/`, `*.ext`, and a path with a `/`, which
// is anchored at the root — and nothing more (no `!`, no `**`).
function committable(dir) {
    const ignorePath = path.join(dir, ".gitignore");
    const rules = (fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8") : "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
        .map((l) => {
            const dirOnly = l.endsWith("/");
            const body = l.replace(/\/$/, "").replace(/^\//, "");
            const glob = body.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
            return { dirOnly, re: new RegExp(body.includes("/") ? `^${glob}$` : `(^|/)${glob}$`) };
        });
    const ignored = (rel, isDir) => rules.some((r) => (isDir || !r.dirOnly) && r.re.test(rel));
    const walk = (rel) =>
        fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.name === ".git" || ignored(r, e.isDirectory())) {
                return [];
            }
            return e.isDirectory() ? walk(r) : e.isFile() ? [r] : [];
        });
    return walk("");
}

// ---------------------------------------------------------------------------

console.log(`\n${"═".repeat(60)}\nSHIP GATE — ${pkg.name} ${pkg.version}\n${"═".repeat(60)}`);
for (const [label, ok] of results) {
    console.log(`  ${ok ? "\u001b[32mPASS\u001b[0m" : "\u001b[31mFAIL\u001b[0m"}  ${label}`);
}
if (failed) {
    console.log(`\n\u001b[31m${failed} BLOCKER(S) — DO NOT SHIP\u001b[0m\n`);
    process.exit(1);
}
console.log("\n\u001b[32mALL GATES GREEN — safe to package\u001b[0m\n");
