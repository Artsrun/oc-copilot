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
| `src/server-session.ts` | Session ids (`safeSessionId`, `sessionPath`), **permission rules** (`HEADLESS_PERMISSION`, `turnPermission`, `sessionRules`, `readOnlyReach`, `readOnlyEvidence`/`serverEnforcement` + `assertReadOnly`: effective rules judged per endpoint or cold folder, reopened refuses; a `/dev` turn re-applies the dev agent's own `task` rules after read-only ones), busy/abort (+ children), create, model, compaction. |
| `src/enforce.ts` | **Read-only by permission**: the `OPENCODE_CONFIG_CONTENT` every spawn gets (`enforcedConfigContent`: `plan` and `readOnlySubagents` overridden, `readOnlyTools`, the `ENFORCED_MARKER` rule), the one-time notice. Leaf: imports only core. |
| `src/oc-api.ts` | **Every server request**: `api(base)` is the route set of the major `base` named — 1.x, or 2.x's `/api` with `opencode2` (Basic auth, `location`, the async prompt awaited on its own run's events) — `safeSessionId`, `sessionPath`, `sessionRoot`. Callers speak 1.x's shapes. |
| `src/v2-events.ts` | **OpenCode 2's event stream read as 1.x events** (`v2Translator`, stateful per stream; `shell`→`bash`, `subagent`→`task`), plus `v2.delivered` / `v2.compaction`, which only `oc-api` reads. Leaf. |
| `src/net.ts` | Bounded HTTP, the managed `opencode serve`, shared SSE demux by session id, the not-OpenCode-1 refusal (`markNotOpenCode1`, `openCode1Refusal`), the data-folder refusal (`noteDataFolderClash`, `dataFolderRefusal`: a 1.x on a folder OpenCode 2 created), `plainError` (stderr without colour codes) and the CLI identity check (`ensureCliIdentity`: one `--version` per executable file). |
| `src/session.ts` | Session state per chat thread (`threadSession`), handoff chain and the way back after one, completion toasts, status bar. |
| `src/proc.ts` | Spawning: shim resolution (`~/` paths too), `cmd.exe` quoting, `killTree`, `PWD = cwd`, `runCapture` (a short command's output), `executableStamp` (the files a name runs, as they are on disk). §2 rule 3. |
| `src/models.ts` | Model catalog (server `GET /config/providers`, else `opencode models --verbose`), names, variant names, cache tiers, the picker, `writeModelPin`, short names, `modelResolver` (one forced refetch per turn), `effortFor` / `higherEffort`, `contextNote`. |
| `src/agents.ts` | Which agent a read-only turn runs as: `planAgent`, only once OpenCode lists it. A server's list carries each agent's own `permission` rules. |
| `src/context.ts` | Attachments/selection folding, every reference noted kept or dropped (`referenceLogLine`, `contextNotice`: what OpenCode won't get, said in chat), references, answer file pills (`createFileLinker`), `parseChatPrompt`, `splitModelPrefix`, `splitModelsFanout`. |
| `src/env.ts` | What OpenCode loaded: config, plugins, MCP, commands, skills, agents, instruction files. |
| `src/followups.ts` + `.json` | **Every word a chip or handoff sends**, the marks, pills (`createBadger`), `followupsProblems`. Leaf: imports only its JSON. |
| `src/natural.ts` | Answer-derived chips: the agent's own offer or either/or, a named step 1, the file it edited, failing tests, Dig deeper — or nothing. `laneItems` is the lanes rule for the chip and for `autoParallel: auto`. |
| `src/core.ts` | **The foundation**: imports nothing local. `config()`, `logChannel`, text helpers, status bar, folder resolution. |
| `src/extension.ts` | `activate()` (panel + guarded inline participant), the `__test` handle, `deactivate()`. |
| `src/commands.ts`, `commands-registry.ts` | Palette commands, worktree buttons, config listener. |
| `src/worktree.ts`, `chat-worktree.ts` | `/worktree`: git via `execFile`, one isolated dev run. |
| `src/format.ts`, `metrics.ts`, `prompt.ts` | Metrics → markdown; run types; timeouts and vague-prompt detection. |
| `src/context-markers.ts` | Host-free context vocabulary shared by the producer and leak gate. |
| `src/git-scan-server.ts` | Standalone newline-delimited JSON-RPC MCP server; one bounded, shell-free Git status call. |
| `src/git-scan-mcp.ts` | Trusted local first-folder MCP provider, stable global-storage server copy, config clipboard command. |

Layering has no cycles:

```
extension.ts  →  chat · chat-boot · commands-registry · git-scan-mcp · session · worktree · leaf modules (for __test)
     chat     →  agents · chat-boot · chat-commands · chat-parallel · chat-turn · chat-worktree · context · models · natural · prompt · session · core
chat-parallel →  agents · chat-boot · compose · context · models · net · runs · core
  chat-turn   →  agents · chat-boot · context · enforce · env · format · metrics · models · net · oc-api · runs · session · core
 chat-commands →  chat-boot · chat-sessions · context · env · models · net · oc-api · prompt · proc · runs · session · core
 chat-sessions →  net · sessions (→ oc-api · runs) · session · core
 chat-worktree →  chat-boot · format · net · prompt · runs · worktree · core
    compose   →  chat-boot · models · core   (used by chat-parallel and commands-registry)
  chat-boot   →  heartbeat · lanes · chips (re-exported) · core · metrics
    lanes     →  runs · format · metrics · models · core      chips → lanes · natural
      runs    →  run-cli · run-server · run-steps · asks (re-exported) · server-session · session
 run-cli, run-server →  asks · run-steps · server-session · net · proc (cli) · metrics      run-cli → enforce · run-server (2.x)
      asks    →  oc-api · net · run-steps · metrics      server-session → agents · enforce · oc-api · net · metrics
    oc-api    →  enforce · net · core   (every server request: agents, models, sessions, chat-commands, commands, run-server)
     agents   →  oc-api · net · proc      net → enforce · proc · v2-events      proc → enforce · core      enforce → core
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
`src/worktree.ts` and the standalone `src/git-scan-server.ts` (`WT4`, `GS`).

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

**Rule 9 — One version, one build.** Change code → bump the version: in
`package.json`, both `package-lock.json` fields, and `serverInfo.version` in
`src/git-scan-server.ts` (`GS`). The gate compares a `dist/` VSIX of this
version with `out/` (a local 0.0.187 rebuild differed in four modules under the
same number).

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
| 4 | package | only `ALLOWED` files ship; no internal name in any committed file — without git, the tree under `.gitignore` (private tokens from `OCB_LEAKY` or `~/.ocb-leaky`, never the repo); no tracked file is git-ignored, and that no-git walk lists exactly what git does; `package-lock.json` at the manifest version; every README claim anchored; version heading, every palette command, chat command and setting documented; every backticked code name (camelCase, SCREAMING_CASE) in AGENTS.md and the flow pages under `docs/` still exists in `src/`, `scripts/` or `tsconfig.json`, four external ones aside; absolute links; no build output (`*.map`, `*.vsix`, nested `out/`, `dist/`, `node_modules/`, `.vscode/`) outside the root `out/` and `dist/`; no dist VSIX of this version with other code, and a version `docs/released.txt` lists still builds from the code it was delivered from; no artifacts at the root |

A red check stops the gate there: a red typecheck does not build, a red build
does not run the suite.

CI runs the same gate (`.github/workflows/ship.yml`: Linux, Windows, macOS, every
push and pull request) and, nightly, the real-binary probes, one job per
OpenCode version (`probes.yml`: 1.19.0 and 2.0.29 must pass, the latest 2.x may fail).

- The suite takes well over 30 s; do not judge it by a 30 s timeout.
- It **aborts on the first exception**: fix crashes first, then red checks.
- Package into `dist/` (`npx vsce package --out dist/`). A missing `repository`
  warning is expected — removed on purpose (REFS).
- Install locally: `node scripts/update.js` installs the newest delivered VSIX
  (sha256 checked against `docs/released.txt`) into `code`/`code-insiders`.
- Deliver: `npm run ship -- --record` appends `<version> <vsix sha256> <code
  hash>` to `docs/released.txt` (commit it). From then on any change to `src/`
  or `package.json` fails the gate until the version is bumped — moving the VSIX
  out of `dist/` no longer hides a rebuild (0.0.214 was rebuilt that way).

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
| `scripts/probe-subtask-lanes.js` | Against a real server: whether a `subtask` part runs a project-local subagent (#21659), before lanes move to server-side delegation. |
| `scripts/probe-readonly.js` | Against a real binary, through `out/` (`runOpenCode`, `ensureServer`, `createServerSession`): can a read-only turn write — cold run, managed serve, an adopted one, another window's; 2.x over ACP. One line per row; control rows must be `CREATED`. `npm run compile` first. |
| `scripts/probe-acp.js` | `opencode acp` over JSON-RPC: handshake, prompt, cancel, load; the transcript as JSONL. Also the ACP client `probe-readonly.js` uses. |
| `scripts/probe-opencode2.js` | With `opencode2`, against a real 2.x through `out/`: text turn, plan writes (absent ×3), `/dev` and enforcement-off controls (`CREATED`), a subagent, Stop, `/sessions`. |
| `scripts/record-wire-fixtures.js` | Records a real 1.x and 2.x server's frames per scripted turn into `scripts/fixtures/wire-v*.json`, the `TW` fakes' input. |
| `scripts/probe-model.js` | The scripted OpenAI-compatible model both use (`[[probe:<action>]]`): every tool attempt certain, no provider, no cost. |

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
- **Rewrite a fake with `writeFake`**, never a bare write: on POSIX the fake is
  the file `spawn` runs, and without its shebang `/bin/sh` reads it. Windows
  wraps every fake in a `.cmd` that calls `node`, so such a check is green there
  and red on Linux and macOS (0.0.213).
- **`writeFake` answers `--version` with `1.19.0` itself** unless the fake's
  code mentions `--version`; and the CLI identity check is cached per
  executable file for the whole suite, across `ext.deactivate()`. A check about
  what `--version` says needs its own fake file whose code answers it: 0.0.223's
  3.x check reused a 2.0.29 identity and proved only the server half (0.0.225).
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
- **The built-in `plan` is read-only by instruction, not permission** — it runs
  `echo > f` (1.19.0 and 2.0.29). Every process the bridge starts overrides it
  through `OPENCODE_CONFIG_CONTENT` (`enforcedConfigContent`, `RE`); the README's
  `look` agent is read-only by permission on any server (`LK`).
- **`OPENCODE_CONFIG_CONTENT` is merged over the config files and the last
  matching rule wins**, while existing keys keep their earlier position in the
  permission object (1.18.35, 1.19.0 measured). So `enforcedConfigContent` sets
  scalar `"deny"` on every writing/running tool (`edit`, `write`, `patch`,
  `apply_patch`, `multiedit`, `bash`, `shell`, `execute`, `question`,
  `plan_enter`, `plan_exit`) as well as `"*": "deny"` first and top-level
  `ocb-enforced: "deny"`. A user's own value is merged, not replaced; one that
  is not a JSON object gets no overrides. Any OTHER key in a config file's
  `agent.<name>.permission` (an MCP tool `"w_*": "allow"`, `task: { general:
  allow }`) still sits after `"*": "deny"` and keeps its allow (0.0.218,
  measured: both wrote). The injected config proves nothing: read-only is
  judged on the effective rules (`readOnlyEvidence`: `GET /agent`, or `opencode
  agent list`, which prints each agent's merged rules) with an allowlist
  (`readOnlyLeaks`, `judgeReadOnly`); a reopened bridge agent refuses the turn
  (`assertReadOnly`). The cold lookup is cached by `configStamp` — never only a
  TTL: a checkout that adds an opencode.json must be listed afresh.
- **The built-in `explore` has `bash * allow`** (`shell` on 2.x): under a plan
  turn it wrote a file through the bridge's own read-only rules (1.19.0). That
  is why the overrides cover each `readOnlySubagents` agent, in `/dev` too.
- **A task child inherits its parent session's DENY rules only** — every allow
  dropped (`task allow explore`, an inspect allowlist), `todowrite`/`task` deny
  appended (1.19.0, `probe-readonly.js`). A session deny outlives its turn in
  every later subagent of that session: after a plan turn, a `/dev` turn's
  `general` could not edit. So the bridge never puts `bash`/`edit` denies on a
  session; a server without the overrides gets no subagents on read-only turns
  instead (`readOnlyReach`, `RE`).
- **A message's `tools` map REPLACES the session's permission list** (1.19.0:
  39 rules → 3). Measured, not used: an attached CLI run sends no such map.
- **Whether a server has the overrides is read from `GET /agent`**: the marker
  (`ENFORCED_MARKER`) precedes a final catch-all bash deny, and writing tools
  also end in catch-all denies. A marker alone from an older server proves
  nothing. Evidence is scoped to its endpoint, directory and selected agent (`RE`).
- **MCP tools are named `<server>_<tool>` on 1.x** (`git-scan_gitScan`); the
  overrides deny them unless `readOnlyTools` lists them. On 2.x MCP tools live
  inside Code Mode's `execute`, which can POST anywhere and create worktrees:
  denied on read-only turns, so 2.x read-only turns have no MCP tools.
- **Nobody can answer OpenCode's prompts from a chat turn**: sessions the bridge
  creates deny question/plan_enter/plan_exit, and every ask of the session and its
  subagents is answered (`HQ`).
- **A permission reply's 200 proves nothing**: OpenCode before 1.19 answers
  200/true to a reply for an ask that is not pending (#15386); 1.19.0 answers
  404 for an unknown id, and the resend stays for the older ones. The ask is
  `permission.asked` (or pre-1.1 `permission.updated`, answered at the session's
  own route); only `permission.replied` confirms it, else one resend (`HQ`).
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
  PATCHed per kind change, never per turn. A cold run has no session rules: the
  overrides limit `plan`'s own `task`.
- **`PATCH /session/:id {permission}` APPENDS, and the last match wins**,
  session rules after the agent's (1.19.0, measured; `Permission.merge` is
  `flat()`, `evaluate` is `findLast`). A rule cannot be removed, only outranked:
  a `/dev` turn after a read-only one appends the dev agent's own `task` rules
  (`GET /agent` → `permission`), and the fake models the merge (`RO`, `PM`).
- **OpenCode 2 is another program called `opencode`** (`@opencode/cli`, 2.0.27):
  its `serve` answers every path but `/api` with its web app (HTML 200) and
  prints a password; its `run` rejects `--attach --dir --variant --pure`; new
  API, new permission format. `opencode2` off: detect, refuse, redact — never
  fall back to a cold run (`OC`). On: this window's own server only (`/api/info`
  with the printed password), every turn through it, overrides in 2.x's shape
  (1.x rejects that key; given both, 2.x applied neither), an unverified plan
  turn refused (`TW`). 2.x ignores 1.x's `agent.<n>.permission` in `opencode.json`
  without a word but reads `.opencode/agents/*.md` frontmatter (2.0.29): named
  once per folder (`v1PermissionRules`). A later major runs on the 2.x adapter
  with the outside-the-tested-range notice. Both majors keep sessions in the
  same data folder, one way only: 2.x adds its tables to a 1.x `opencode.db`,
  but 1.19.3 refuses one 2.x created ("Database is not empty and has no session
  table") on every spawn. Remembered per executable file, refused before any
  spawn until `/ping` (`dataFolderRefusal`, `SE`).
- **`opencode --version` costs ~0.7 s on 1.19 (the Bun binary starting)**:
  CLI first use awaits one shared check; later sends reuse it while the file
  behind the name is unchanged (`executableStamp`, file stats): a 2.x installer
  replaces a 1.x in place, under the same name (`OC`). Prewarming can prime it,
  but disabling prewarm cannot bypass identity. `/ping` and Diagnose can lift a
  refusal after the executable is replaced with 1.x.
- **A turn refused before sending is not a failed run.** Not OpenCode 1, an
  identity `--version` could not confirm, permission rules that could not be
  set: nothing reached OpenCode, and Continue would send "continue" to a
  session that never got the task. `failTurn` marks them `notSent`: Retry (the
  user's words) with New session or Ping (`PM`, `OC`).
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
`prewarm-server`, `git-scan`, `chip-backoff`, `opencode-1-only`,
`enforced-read-only`, `opencode-2-api`.
