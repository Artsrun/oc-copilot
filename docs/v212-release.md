# v212 release — 0.0.212

Dated 2026-10-13. Historical supplied release notes; delivery and sandbox claims
below were not independently reproduced in this checkout. Next:
`docs/v213-opencode2-plan.md`. The current 0.0.213 scope is safety fixes only.

## Gate

- `npm run ship`: 4/4 green, **ALL 1087 CHECKS PASSED** (v211: 1056), in a plain tree, in a `git init` copy (114 committed files, the no-git walk matches git) and in a fresh extract of the delivered tar.
- Suite wall time 2m45s → **2m05s** (CPU ~9 s).
- Red first: the new and changed checks run against v211's build → **24 FAILED** (C, I, SE×3, LN, GA, RO, PM×2, CP, VN×2, SB, OC×9, FX), all green on v212.
- Gate is fail-fast now: a red typecheck stops in 3.4 s (was 2.5 min).
- `dist/opencode-copilot-bridge-0.0.212.vsix` (47 files, 143 KB) matches `out/` (drift check green).
- Leak scan: no company token anywhere in the tree (`grep -i` on the org name: none). The V2 login URL stays out of the repo.

## What changed

**Fixes**
1. `/dev` after a plan turn kept the read-only subagent limit. OpenCode **appends** PATCHed rules and the last match wins (1.19.0 measured). `/dev` now re-applies the **dev agent's own** `task` rules from `GET /agent` (`* * allow` → `task * allow`; a user's `task general deny` survives), `task allow *` first only for patterns they leave open. Unknown sessions are read first (`GET /session/:id`, 2 s); a session that never had `task` rules gets none.
2. **OpenCode 2** is refused at once and nothing runs (was: 45 s × 2, then a cold run without the bridge's rules; password in the log). Signals: own server's health is HTML; `Unrecognized flag: --x in command opencode`; `--version` 2.x (`/ping`, Diagnose, and a background check on `transport: cli` via `prewarmServer`). A healthy 1.x server can still be adopted. Message gives the side-by-side 1.x recipe; chips Retry + Ping. `/ping` with a 1.x lifts the refusal (no reload needed).
3. A CLI run that exits non-zero with no error event/text shows the first stderr error line (else `opencode exited with code N`), debug-log button, fitting chips.
4. `autoCompactEveryTurns: 0` = the bridge never compacts (docs said so; the 60k/70% trigger ignored it) → Compact chip instead.
5. Suite honesty: `stopServer()` ends a start still polling (SB4 had passed on another check's orphaned start, 44.8 s); the 60 s summary timer is cleared.
6. `executable` expands `~/` (needed for the side-by-side 1.x path).

**UX copy:** `/help` lists every inline prefix incl. `effort:`/`e:`; new-chat note once per folder per window; merge line says "first 8 lanes" past 8; `/stop` names the OpenCode 2 refusal; `/env` gitScan hint only with `gitScan` on; Diagnose quick-action text; generic vague-prompt example; stale package.json descriptions fixed (no setting/command renamed, no default changed).

**Removed (dead):** `RunMetrics.reasoning`, `resetCompactBackoff`, `runs.ts` re-exports of `applyServerPart`/`sessionModel` (now module-private), `context.ts` `CONTEXT_*` re-export, suite stubs nobody calls, `docs/test-vsix-*.txt` + `docs/v210-plan.md` → `docs/manual-checks.md`. `runCapture` moved to `proc.ts`.

**Docs:** README (OpenCode 2 section, requirements, settings rows, changelog trimmed to 5), CHANGELOG, AGENTS (map, layering, Rule 9 version spots, gate, probes, 3 new traps, claims), REFS (1.19.0 + 2.0.27 measurements, ACP on both, shared data folder, suite timing, PWD re-measured on 1.19.0), docs/flow 02/05/06, `.vscodeignore`, `mac-setup.sh doctor` flags 2.x. Gate: code names cited in AGENTS/docs/flow must exist (90 names, 4 external allowed).

**Probes:** progress-inflation and sse-crosstalk run again (crosstalk: foreign text absent, own present); `probe-opencode-pwd.js` on 1.19.0: still follows `PWD`, bridge lands in the folder; server-adoption: impostor gets health only.

## Backward compatibility

No setting or command removed or renamed; all defaults unchanged. Behaviour changes, each documented: `autoCompactEveryTurns: 0` now matches its docs; `prewarmServer` on `transport: cli` runs one background `--version` (no server); OpenCode 2 executables are refused instead of half-run. `retryLast` and the v1 model-cache read kept.

## The company V2 move

Login template once V2 is installed; obtain the real server address privately:

```bash
opencode auth login opencode --method device --answer server=https://opencode.example.com
```

Until the bridge drives V2 (v213+ plan): keep a 1.x for the bridge —

```bash
npm i --prefix ~/.opencode1 opencode-ai@1
# setting: "opencodeCopilotBridge.executable": "~/.opencode1/node_modules/.bin/opencode"   (Windows: …\.bin\opencode.cmd)
~/.opencode1/node_modules/.bin/opencode auth list    # does 1.x see the company credentials?
```

If 1.x cannot authenticate against the company server, V2 support is urgent: start the v213 ACP spike.

## Verify / debug (Output › OpenCode)

- ``ses_…: headless rules; subagents as `build` allows them`` on the first `/dev` after a plan turn.
- OpenCode 2: ``<exe>: `opencode` here is not OpenCode 1: …`` once, `[serve] … password [redacted]`, then `server not started: not OpenCode 1 (logged above)`.
- `serve on … answered after N.Ns` per start; no `did not become healthy … 45 s` after a reload.
- `/ping` version row: `1.19.0` ✓ · `opencode v2.0.27 — OpenCode 2: the bridge drives 1.x only so far` ✗.
- Manual checks: `docs/manual-checks.md` › "This release: 0.0.212".
