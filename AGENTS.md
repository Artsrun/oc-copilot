# Working in this repository

Read this before changing anything. Every rule below exists because its absence
shipped a defect. The source cites sections by number (`src/proc.ts` → §2 rule
3, the suite → §4): do not renumber them.

---

## §1 · What this is, and the map

A VS Code extension: the `@opencode` chat participant, running a local OpenCode
agent behind it — one OpenCode session per Copilot chat thread. No framework,
no bundler, no test runner: plain TypeScript → `out/`, plain Node for the suite.

| Path | What lives there |
| --- | --- |
| `src/chat.ts` | **The front half of a chat turn.** `handleChat`: routing, the vague-prompt gate, context, agent and model choice, the handoff chain. Hands the turn to `chat-parallel` or `chat-turn`. |
| `src/chat-turn.ts` | **Run, recover, post.** `runTurn`: open (heartbeat, server warm-up) → `prepareRun` → `runAttempts` (the recovery ladder: handoff, CLI fallback, cold rerun, stale session) → `finishTurn` (answer, session books, autocompact, chips, metadata) or `failTurn`; `pre-run:` timings. |
| `src/chat-parallel.ts` | The `/parallel` turn: lanes split, each lane's model and agent checked, `runParallelLanes`. |
| `src/chat-boot.ts` | The command vocabulary: control/kind/routed commands, aliases, retired words, `helpMarkdown`. Re-exports `heartbeat`, `lanes` and `chips`, so the chat layer keeps one import. |
| `src/heartbeat.ts` | The live turn: heartbeat (plain live lines + milestone ticker; finished accordions with `groupProgress`; a subagent's tool over its `task` row), **`chatStream`** (nothing after Stop, never throws, one pill badger per turn), `thoughtLine`. |
| `src/lanes.ts` | `/parallel`: `splitLanes` (`\|` `;;` `---` only), `runParallelLanes`, the lane store behind Merge / Retry, `retryLanesPrompt`. |
| `src/chips.ts` | **`followupsFor`**: state chips first (Resume a subagent, Compact), then the answer's own (`suggestFollowups`, kept per turn). |
| `src/chat-commands.ts` | Control commands — `/help` `/new` `/model` `/ping` `/env` `/session` `/sessions` `/stop` `/compact`: answers without a turn (`/compact` is one summarize pass). |
| `src/chat-sessions.ts` | **/sessions**: the picker and Continue / Fork / Close / Delete; binds a chat by returning `{sessionId, turns, cwd}` metadata. |
| `src/sessions.ts` | OpenCode's session store over HTTP: list, last messages, fork (+ headless rules back), archive, delete. |
| `src/compose.ts` | **The /parallel composer**: one `createQuickPick` per lane, `laneProblem` (the real splitter), insert via `chat.open` + `isPartialQuery`. |
| `src/runs.ts` | The one import the chat layer uses for running OpenCode (re-exports), and the stale-session retry that needs both runners. |
| `src/run-cli.ts` | `opencode run --format json`, cold or `--attach`ed: kill on silence, bounded stderr (`STDERR_CAP`), the attached run's liveness from SSE. |
| `src/run-server.ts` | The server transport: POST + shared SSE, idle watchdog, abort on Stop (the subagents too). |
| `src/run-steps.ts` | Events → `StepRecord`, `stepDetail`, keyed text/reasoning deltas, the answering model, subagent spend. Pure. |
| `src/asks.ts` | **Headless asks** for a session and its subagents (`watchFamily`), and what the subagents cost. |
| `src/server-session.ts` | Session ids (`safeSessionId`, `sessionPath`), **permission rules** (`HEADLESS_PERMISSION`, `turnPermission`), busy/abort (+ children), create, model, compaction. |
| `src/net.ts` | Bounded HTTP, the managed `opencode serve`, shared SSE demux by session id. |
| `src/session.ts` | Session state per chat thread (`threadSession`), handoff chain and the way back after one, completion toasts, status bar. |
| `src/proc.ts` | Spawning: shim resolution, `cmd.exe` quoting, `killTree`, `PWD = cwd`. §2 rule 3. |
| `src/models.ts` | Model catalog (server `GET /config/providers`, else `opencode models --verbose`), names, variant names, cache tiers, the picker, `writeModelPin`, short names, `modelResolver` (one forced refetch per turn), `effortFor` / `higherEffort`, `contextNote`. |
| `src/agents.ts` | Which agent a read-only turn runs as: `planAgent`, only once OpenCode lists it. |
| `src/context.ts` | Attachments/selection folding, references, answer file pills (`createFileLinker`), `parseChatPrompt`, `splitModelPrefix`, `splitModelsFanout`. |
| `src/env.ts` | What OpenCode loaded: config, plugins, MCP, commands, skills, agents, instruction files. |
| `src/followups.ts` + `.json` | **Every word a chip or handoff sends**, the marks, pills (`createBadger`), `followupsProblems`. Leaf: imports only its JSON. |
| `src/natural.ts` | Answer-derived chips: the agent's own offer or either/or, a named step 1, the file it edited, failing tests, Dig deeper — or nothing. `laneItems` is the lanes rule for the chip and for `autoParallel: auto`. |
| `src/core.ts` | **The foundation**: imports nothing local. `config()`, `logChannel`, text helpers, status bar, folder resolution. |
| `src/extension.ts` | `activate()` (panel + guarded inline participant), the `__test` handle, `deactivate()`. |
| `src/commands.ts`, `commands-registry.ts` | Palette commands, worktree buttons, config listener. |
| `src/worktree.ts`, `chat-worktree.ts` | `/worktree`: git via `execFile`, one isolated dev run. |
| `src/format.ts`, `metrics.ts`, `prompt.ts` | Metrics → markdown; run types; timeouts and vague-prompt detection. |

Layering has no cycles:

```
extension.ts  →  chat · chat-boot · commands-registry · session · worktree · leaf modules (for __test)
     chat     →  agents · chat-boot · chat-commands · chat-parallel · chat-turn · chat-worktree · context · models · natural · prompt · session · core
chat-parallel →  agents · chat-boot · compose · context · models · net · core
  chat-turn   →  agents · chat-boot · context · format · metrics · models · net · runs · session · core
 chat-commands →  chat-boot · chat-sessions · commands · context · env · models · net · prompt · proc · runs · session · core
 chat-sessions →  sessions (→ net · runs) · session · core
    compose   →  chat-boot · models · core   (used by chat-parallel and commands-registry)
  chat-boot   →  heartbeat · lanes · chips (re-exported) · core · metrics
    lanes     →  runs · format · metrics · models · core      chips → lanes · natural
      runs    →  run-cli · run-server · run-steps · asks (re-exported) · server-session · session
 run-cli, run-server →  asks · run-steps · server-session · net · proc (cli) · metrics
      asks    →  server-session · net · run-steps · metrics      server-session → net · metrics
     all      →  core.ts · followups.ts (JSON only) · natural.ts (→ followups)
```

**One action, one channel.** A chip owns the next *message* (Retry, Run it, the
answer's own offers); a `response.button` owns an *artifact* (debug log,
diagnose, worktree diff); a toast only carries out-of-view news. The same action
in two channels is a defect (check `FU`).

**Words live in `src/followups.json`.** No prompt text in code (`KM`), no emoji
anywhere: a status line uses `mark("…")`, and a mark must be markdown-inert (no
`` _ * ` \ [ ] | < > # ~ ``). Chip checks compare against the JSON.

**A finished turn gets natural chips or none.** The half of `NF` that asserts NO
chips is what keeps this from drifting back into noise; extend it with every new
extraction rule.

---

## §2 · The rules

**Rule 1 — Measure, do not assume.** A claim in a comment, a commit or a reply
names what was run and what it printed. Findings that cost real time go in
`REFS.md`.

**Rule 2 — A red check is a blocker.** `npm run ship` is the only green light.

**Rule 3 — Every OpenCode process goes through `spawnOpenCode()`.** Shim
resolution and `cmd.exe` quoting live only in `src/proc.ts`; the one exception
is `killTree()`'s `taskkill`, which takes no user text. `BF` counts `spawn(`
call sites (`spawnLines.length === 3`) — do not raise the number. Git is not
OpenCode: `/worktree` runs `git` via `execFile` with an argument array, only in
`src/worktree.ts` (`WT4`).

**Rule 4 — A new setting is three edits.** The property in `package.json`, the
key in the suite's base `settings` object, and the same default in both (`BE`).

**Rule 5 — Nothing is written into the user's workspace.** The one exception:
`/worktree` creates `<repo>.worktrees/<slug>` next to the repo, on command.

**Rule 6 — Ignore files are LF-only.** A trailing `\r` silently stops a pattern
matching; `BG` reads the raw bytes.

**Rule 7 — `.vscodeignore` is a denylist; the gate's `ALLOWED` is the control.**
`scripts/**` is not globbed (`start-parallel-agents.*` ships), so every dev-only
script is named in `.vscodeignore`, and every new `out/*.js` in `ALLOWED`.

**Rule 8 — `noUnusedLocals` is on.** An unused local is a red typecheck.

**Rule 9 — One version, one build.** Change code → bump the version. The gate
compares a `dist/` VSIX of this version with `out/` (a local 0.0.187 rebuild
differed in four modules under the same number).

---

## §3 · The gate

```powershell
npm run ship      # the only green light: 4 ordered checks, fail-fast
npm run verify    # the suite alone
```

| # | Check | Passes when |
| --- | --- | --- |
| 1 | typecheck | `tsc --noEmit` exits 0 |
| 2 | build | `tsc` exits 0 and `out/` is newer than `src/` |
| 3 | verify | the suite exits 0 **and** prints `ALL <N> CHECKS PASSED` |
| 4 | package | only `ALLOWED` files ship; no internal name in any committed file — without git, the tree under `.gitignore` (private tokens from `OCB_LEAKY` or `~/.ocb-leaky`, never the repo); no tracked file is git-ignored, and that no-git walk lists exactly what git does; `package-lock.json` at the manifest version; every README claim anchored; version heading, every palette command, chat command and setting documented; absolute links; no dist VSIX of this version with other code; no artifacts at the root |

- The suite takes well over 30 s; do not judge it by a 30 s timeout.
- It **aborts on the first exception**: fix crashes first, then red checks.
- Package into `dist/` (`npx vsce package --out dist/`). A missing `repository`
  warning is expected — removed on purpose (REFS).

---

## §4 · Probes

A probe measures one thing on this machine and prints it. Paste its output.

| Probe | Measures |
| --- | --- |
| `scripts/probe-windows-shim.js` | Where `opencode` resolves, the shim's target, whether a hostile payload survives to argv. |
| `scripts/probe-progress-inflation.js` | How many `progress()` calls a realistic run makes. |
| `scripts/probe-sse-crosstalk.js` | That the SSE demux cannot leak another chat's text. |
| `scripts/probe-opencode-pwd.js` | Which folder `opencode run` works in: stale `PWD` vs `spawnOpenCode()`. |
| `scripts/probe-server-adoption.js` | What a listener that only answers `{"healthy":true}` (no `version`) on the server port receives from the bridge: the health probe alone. |
| `scripts/probe-plan-subagents.js` | Against a real server and model: whether a plan turn can edit through `general`, with and without the read-only `task` rules, and whether `/session/:id/children` lists the child. |

*Write to the OS temp dir, never the repo* — the suite sweeps `ocb-*` at
startup, not exit (Windows holds a just-exited child's cwd).

*Make a probe go red before trusting its green.* Fakes must be `.cmd`-wrapped
on Windows (`writeFake()` does it).

---

## §5 · Assertion style

`scripts/verify-chat-output.js` is the suite: it stubs `vscode` via
`Module._load`, loads `out/extension.js`, drives turns through fake OpenCode
binaries, and collects `add(name, ok)`. Checks carry a two-letter group code;
pick the next free one.

- **Assert the boundary, not the happy value**: a pinned setting proves nothing
  if the fixture never reaches its code.
- **Assert what the run produced** (argv read back, what reached chat), not what
  a function returned. `hostStream()` models the real host — use it for rendering.
- **Source-text tripwires are legitimate** (`BF`, `MA`); they read text, not the AST.
- **Reproduce the defect first.**
- `ext.deactivate()` runs near the end; later groups must not start a server.
  Settings keys go in the base `settings` object, never only inside a group.
- Every `__test` key is read as `ext.__test.<key>` (`MA`).

---

## §6 · Code conventions

Four-space indent, double quotes, semicolons, `strict` + `noUnusedLocals`,
ES2022 / CommonJS. Plain exported functions: no classes, no DI. `node:` imports;
settings only via `config().get<T>("key", default)`; optional-chain VS Code APIs
the stub may lack. Comments say *why* and what was measured, briefly — version
history belongs in `CHANGELOG.md`, not in the source.

---

## §7 · Known traps

- **Windows `cmd.exe` cuts at the first newline and expands `%VAR%`** — there is
  no escape for `%`. Resolve the shim's real target instead (`node_modules/<pkg>/bin/<name>.exe`).
- **`opencode serve` is multi-directory**: every call takes `?directory=`;
  without it the server uses its own cwd — another window's checkout.
- **`message.updated` carries a message id, not a session id**; `server.heartbeat`
  carries none. Only a run's own events prove it alive (`LT7`).
- **`opencode run` works in `$PWD ?? cwd`**: `spawnOpenCode()` sets `PWD = cwd`
  (`PW`, `WT1`).
- **OpenCode keys a project by its root-commit hash**: two `cp -r` copies are one
  project; `git worktree`s are fine.
- **Concurrent cold `opencode run`s serialise** on one `opencode.db`; attached
  lanes share the server and do not.
- **Plain progress lines fade; task lines stay; a task open at Stop spins for
  good.** Accordions are sent finished, and `stop()` waits `SETTLE_MS` since the
  last one (`GP`).
- **After Stop nothing arrives, and 1 s later the stream throws.** A turn returns
  within that second; server aborts are not awaited (`SP`, `HS`).
- **The host's stream methods use `this`**: call them on the stream.
- **`workbench.action.chat.open` with a `query` submits it** unless
  `isPartialQuery: true` (`QA`).
- **HTML badges cannot render in chat.** Chat sanitizes with KaTeX's `style`
  rule, which replaces the span rule: no background, colour only as a bare word
  (`#hex` → `rgb(…)` → stripped). Marks are inline-code pills; a pill never
  follows a backslash and never touches another backtick run (`KB`).
- **Every `progress()` call is a new line** (no in-place update): elapsed time
  renders only at milestones (`LF`).
- **Copilot's Thinking part and tool rows are proposed API** — not used.
- **OpenCode streams text as `message.part.delta`** (`partID`, `field`, `delta`;
  no `part`) and sends the whole part once at its end; `opencode run --format
  json` prints a part only at its end. Deltas are counted per part (`t:`/`r:` +
  id) so the whole part adds only the rest; streamed text passes the leak and
  echo gates (`DS`, `DT`, `GT`).
- **Never compact with `auto: true`**: an auto compaction ends with a synthetic
  "Continue if you have next steps" and runs a turn nobody sees. A summary keeps
  the session busy: the next turn waits for this window's own (`CQ`).
- **`opencode run --agent <unknown>` runs `build`** (exit 0, stderr warning); the
  server answers HTTP 500. `planAgent` is sent only once OpenCode lists it, and a
  server's confirmation holds for that server only (`PA`).
- **`--auto` on the CLI: `/dev` and the built-in `plan` only**; on the server the
  bridge answers asks itself, keyed by `readOnly` (`PA`, `HQ`).
- **The built-in `plan` is read-only by instruction, not permission** — the
  README's `look` agent is read-only by permission (`LK`).
- **Nobody can answer OpenCode's prompts from a chat turn**: sessions the bridge
  creates deny question/plan_enter/plan_exit, and every ask of the session and its
  subagents is answered (`HQ`).
- **A permission reply's 200 proves nothing**: OpenCode answers 200/true to a
  reply for an ask that is not pending (#15386). The ask is `permission.asked`
  (or pre-1.1 `permission.updated`, answered at the session's own route); only
  `permission.replied` confirms it, else one resend (`HQ`).
- **A running server lists a folder's agents once**: a new `look.md` needs a
  server restart. Never call `POST /instance/dispose` from the bridge.
- **OpenCode keeps a session on the model it was last sent**: after an unpinned
  handoff the next turn sends the earlier model once (`DM`).
- **Always pass `--agent`**: without it `opencode run` uses `default_agent`.
- **Copilot keeps the last participant command sticky**: chips set `command`;
  the text is only the sentence (`LC`). `request.prompt` has a declared
  `/command` stripped — replays put the kind back.
- **A file-path menu icon is a CSS `background-image`**: `currentColor` is black.
  Use a `$(codicon)` (`HA`).
- **Session ids are untrusted**: URLs via `sessionPath`, argv via
  `safeSessionId` (`MA`).
- **Killing a `run --attach` client does not stop the run**, and a prompt to a
  busy session queues silently: every stop aborts on the server, every send
  checks busy (`LT4`/`LT5`). Hand off only on a model stall, after the abort.

- **OpenCode's fork copies messages and metadata, not permission rules**
  (1.18.33 `Session.fork`): a forked session would offer the `question` tool
  again, so `forkSession` PATCHes `HEADLESS_PERMISSION` back (`SL`).
- **A chat is bound to a session only by its turns' metadata**
  (`threadSession`: `sessionId` + numeric `turns`, `/new` a barrier). Anything
  that re-binds a chat (`/sessions` Continue, Fork) returns that metadata.
- **OpenCode ignores an unknown `--variant` / `variant` without a word**
  (1.18.34 `session/llm/request.ts` looks it up in the model's variants), and
  a prompt without one resets the session to `default`: check it with
  `effortFor`, send it every turn (`EF`).
- **A session's context is its last step, not the turn**: `step_finish`
  tokens are per step and each step resends the context; cache reads are
  context too (OpenCode's `isOverflow`). Use `RunMetrics.context` (`CX`).
- **`opencode run --agent <subagent>` falls back to the default agent**
  (`build`, which edits): never send a subagent-mode agent as a lane's agent.
- **A subagent runs with its own permissions, not the turn's** (OpenCode
  docs, agents): `general` edits under a plan turn. Read-only turns put
  `task` rules on the session (`turnPermission`, `RO`); session rules are
  PATCHed per kind change, never per turn.
- **A fixed `serverPort` can be held by a listener that never answers**: the
  window's own server cannot bind and exits 1 after its boot. `ensureServer`
  starts one on a free port instead and never sends that listener a request
  but `/global/health` (`SV`). The same for one that answers `{"healthy":true}`
  with no `version`: a real server names it, and an adopted impostor received
  the prompt (`ID`).
- **A first `opencode serve` boot can take most of a minute** (config,
  plugins, MCP): the poll waits 3 s per health check and 45 s in all, a
  waiter is told after 1.5 s, and the log records each start's time (`SB`).
  **`untilStop` reads a rejection as Stop**: keep the error yourself when it
  must be reported.
- **A parent's `task` row runs as long as its subagent**: child events are the
  run's activity, or the idle cap stops a parent whose subagent works (`SU`).
- **A task result carries no cost or tokens** (OpenCode #47822): a subagent's
  spend is read from its own session's `message.updated` (`SC`).
- **A quick pick filters its list by what is typed** — the composer's model
  items are `alwaysShow`, or typing a task would hide every model.

### Claims

Every capability the README states is tagged `<!-- claim:id -->` and anchored by
`claim:id` in a comment beside the code; gate 4 fails on a tag with no anchor.
Current: `worktrees`, `worktree-command`, `inline-participant`, `model-names`,
`parallel-models`, `command-aliases`, `sessions`, `parallel-composer`,
`file-links`, `effort`, `auto-parallel`, `lane-agents`, `read-only-subagents`,
`prewarm-server`.
