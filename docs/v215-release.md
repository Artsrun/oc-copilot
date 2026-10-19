# v215 release — read-only by permission (0.0.215)

Dated 2026-10-15. Base: the local agent's tree (0.0.214 + two fixes). Plan: `claude/v215-plan.md` (D1 enforce on, D2 web allowed, D3 explore restricted in /dev too) + attachments items 1 and 5.

## Shipped
Current-checkout correction (2026-10-15): the Windows recheck found 39 tracked
docs artifacts despite the historical removal claim below. Version 0.0.216
removes them and replaces the shell allowlist after a confirmed helper write.
- **`enforceReadOnly`** (default on): every OpenCode process the bridge starts gets `OPENCODE_CONFIG_CONTENT` overriding `plan` + each `readOnlySubagents` agent: `"*": deny`, then read (`.env` denied), grep/glob/list/lsp/skill/todo, webfetch/websearch, `readOnlyTools`, inspect-only bash allowlist (+ marker `bash ocb-enforced deny`), `task` only to readOnlySubagents. New leaf `src/enforce.ts`; `spawnOpenCode` stays the only spawn site.
- **Servers the bridge did not start**: subagents allowed only where overridden (own server: agents it was spawned with; else `GET /agent` marker per agent, cached 60 s). A server you started: no subagents on read-only turns + one chat line per window. No bash/edit denies on sessions: a task child inherits the parent session's DENY rules only (measured) → would poison later /dev subagents.
- **`readOnlyTools`** (default `["git-scan_gitScan"]`): MCP tools kept on read-only turns; names re-allowing write/run/delegate tools are dropped + logged.
- **Attachments (1 + 5)**: Output logs every reference (`references (N): kept …; dropped … (kind: why)`); chat says before the answer what OpenCode won't get (image, Problems, unsaved editor, current-file chip once/window, outside-folder file on read-only turns). Untitled editors no longer sent as bogus paths.
- One-time note on the first enforced plan turn. Agent's fixes: Windows shim retarget, refused /parallel → Retry/Ping.
- Gate: `docs/released.txt` (`npm run ship -- --record`) blocks rebuilding a delivered version; no build output outside root `out/`/`dist/` (docs leftovers removed).
- Dev probes (not shipped): `probe-readonly.js`, `probe-acp.js`, `probe-model.js`.

## Evidence
- Suite `ALL 1145 CHECKS PASSED` (agent base 1117 Linux/1119 Windows). Red-first vs agent build: 22 new checks fail.
- `probe-readonly.js` real binaries: 1.19.0 **24/24**, 2.0.29 over ACP **8/8**. Against the old build: 9 rows red (plan `echo >`, explore `echo >` on cold/managed/adopted/other-window, outside read via `--auto`, no marker).
- Gate `ALL GATES GREEN` (Linux, `OCB_LEAKY`); self-check red for planted `docs/out/*.map` and a stale released line.
- VSIX 0.0.215: 48 files, 152.12 KB, sha256 `ae0dde3d0953b6fc4dd072fc46d12e3cb7b9ebb60eb4c4ae7a421b9934b9f388`.

## Apply
Extract `v215-code.tar` at repo root; delete `docs/{out,dist,.vscode,docs,media,scripts,src}` leftovers; `npm ci`; `npm run ship` on Windows; install `dist/…0.0.215.vsix`; `docs/manual-checks.md` → *This release*.

## Verify / debug
- Output › OpenCode: `read-only by permission in the processes the bridge starts: plan, explore (enforceReadOnly)` once.
- `GET http://127.0.0.1:53200/agent?directory=<folder>` → plan/explore list `bash ocb-enforced deny`.
- Plan turn `echo hi > x.txt` → no file; `/dev` → file. `git status` runs on plan.
- `references (N): …` line per turn with attachments; `explore: not read-only by permission on … — left out` when a server lacks the overrides.
- Probes: `npm run compile && node scripts/probe-readonly.js <opencode>` (control rows must be CREATED).

## Follow-ups
1. 0.0.216 hardening and cleanup: see `superpowers/plans/2026-10-15-v216-rechecked-cleanup.md`. Attachment expansion follows separately.
2. Settings changes (enforceReadOnly/readOnlySubagents/readOnlyTools) reach the managed server only after restart — auto-restart when idle?
3. Unmeasured: overrides vs global `~/.config/opencode` / `.opencode/agents/plan.md` plan override.
4. 2.x: ACP remains research; no production transport commitment for 0.0.216.
5. Adopted server: plan's shell by instruction only; a message `tools` map REPLACES session permission (measured) — possible clean reset on the server path, not on attached CLI.
6. `listAgents` has no in-flight dedupe (N lanes on an adopted server → N `GET /agent`).
7. Windows gate + manual checks with a real model.
