// The suite's watchdog. The suite prints its checks only at the end and then lets
// Node exit by itself, and the ship gate captures it with spawnSync: a hang (a turn
// that never settles, or a handle left open after the banner) showed nothing until
// CI's 30-minute limit cancelled the job (PR #20, Windows, once in six runs). Past
// the cap, or a grace period after the banner, this prints what is still open and
// exits 1 — written with fs.writeSync, which a hard exit cannot truncate.
"use strict";
const fs = require("node:fs");

const say = (text) => {
    try {
        fs.writeSync(1, `${text}\n`);
    } catch {
        // stdout gone: nothing left to tell.
    }
};

/** What keeps the process alive, one line each: children by pid and argv, sockets and servers by port. */
function openResources() {
    const handles = typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [];
    const lines = [];
    for (const h of handles) {
        if (h === process.stdout || h === process.stderr || h === process.stdin) {
            continue;
        }
        if (Array.isArray(h?.spawnargs)) {
            lines.push(`child ${h.pid ?? "?"} ${h.spawnargs.join(" ").slice(0, 160)}`);
        } else if (typeof h?.address === "function" && typeof h?.listening === "boolean") {
            const a = h.address();
            lines.push(`server ${typeof a === "object" && a ? `${a.address}:${a.port}` : a}`);
        } else if (h && "remotePort" in h) {
            lines.push(`socket ${h.localPort ?? "?"} -> ${h.remoteAddress ?? "?"}:${h.remotePort ?? "?"}`);
        } else if (h && typeof h.hasRef === "function" && "_idleTimeout" in h) {
            lines.push(`timer ${h._idleTimeout} ms${h.hasRef() ? "" : " (unref)"}`);
        } else {
            lines.push(h?.constructor?.name ?? typeof h);
        }
    }
    const kinds = typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : [];
    return { lines, kinds };
}

/**
 * `capMs`: the whole run's cap. `graceMs`: how long a finished run may take to exit.
 * `last()`: the last check's name. `count()`: checks so far. `tail()`: recent log lines.
 */
module.exports = function watchdog({ capMs, graceMs = 20000, last = () => undefined, count = () => 0, tail = () => [] }) {
    const report = (why) => {
        const { lines, kinds } = openResources();
        say(`\nWATCHDOG: ${why}`);
        say(`  checks so far: ${count()}; the last: ${last() ?? "(none)"}`);
        say(`  open (${kinds.join(", ") || "none"}):`);
        for (const l of lines) {
            say(`    ${l}`);
        }
        const t = tail();
        if (t.length) {
            say("  last log lines:");
            for (const l of t) {
                say(`    ${String(l).slice(0, 200)}`);
            }
        }
    };
    const started = Date.now();
    const cap = setTimeout(() => {
        report(`the suite is still running after ${Math.round((Date.now() - started) / 1000)} s (cap ${Math.round(capMs / 1000)} s)`);
        process.exit(1);
    }, capMs);
    return {
        /** The banner is out: a run still alive `graceMs` later is held open by something. */
        finished() {
            clearTimeout(cap);
            const grace = setTimeout(() => {
                report(`the suite finished ${Math.round(graceMs / 1000)} s ago and has not exited`);
                process.exit(1);
            }, graceMs);
            // Unref'd: a run that exits on its own is not held for the grace (WD).
            grace.unref();
        }
    };
};
module.exports.openResources = openResources;
