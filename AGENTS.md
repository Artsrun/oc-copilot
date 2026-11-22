# Working in this repository

Read this before changing anything. Every rule below exists because its absence
shipped a defect. The source cites sections by number (`src/proc.ts` → §2 rule
3, the suite → §4): do not renumber them.

---

## §1 · What this is, and the map

A VS Code extension: the `@oc` chat participant, running a local OpenCode
agent behind it — one OpenCode session per Copilot chat thread — and the same
engine as MCP tools for a client with no chat participants (the Copilot
harness). No framework, no bundler, no test runner: plain TypeScript → `out/`,
plain Node for the suite.

**OpenCode 1 is deprecated (0.0.243).** It runs, and a window says so once after a
finished 1.x turn (`openCode1Deprecation`, `OD`). The removal is staged: the suite's
groups move from the 1.x CLI fakes (`transport: "cli"`, `writeFake`) to the 2.x fake
(`scripts/fixtures/fake-opencode2.js`) one green commit at a time, and only then do the
CLI transport, 1.x routes and the `opencode2`/`transport` settings go. New code targets
2.x; never delete a 1.x path while a check still drives it. Ported: `S`, `GA` (end to
end), `JA`, `J`, `T`, `CA`, `CB`, `CC`. A ported group asserts what crossed 2.x's boundary, and a mutant per group
turned it red before its green was trusted.

| Path | What lives there |
| --- | --- |
| `src/chat.ts` | **The front half of a chat turn.** `handleChat`: routing, the vague-prompt gate, context, agent and model choice, the handoff chain. Hands the turn to `chat-parallel` or `chat-turn`. |
| `src/chat-turn.ts` | **Run, recover, post.** `runTurn`: open (heartbeat, server warm-up) → `prepareRun` → `runAttempts` (the recovery ladder: handoff, CLI fallback, cold rerun, stale session) → `finishTurn` (answer, session books, autocompact, chips, metadata) or `failTurn`; `pre-run:` timings. |
| `src/chat-parallel.ts` | The `/parallel` turn: lanes split, each lane's model and agent checked, `runParallelLanes`. |
| `src/chat-boot.ts` | The command vocabulary: control/kind/routed commands, aliases, retired words, `helpMarkdown`. Re-exports `heartbeat`, `lanes` and `chips`, so the chat layer keeps one import. |
| `src/heartbeat.ts` | The live turn: heartbeat (plain live lines + milestone ticker; finished accordions with `groupProgress`; a subagent's tool over its `task` row), **`chatStream`** (nothing after Stop, never throws, one pill badger per turn), `thoughtLine`. |
| `src/lanes.ts` | `/parallel`: `splitLanes` (`\|` `;;` `---` only), `runParallelLanes`, the lane store behind Merge / Retry, `retryLanesPrompt`. |
| `src/chips.ts` | **`followupsFor`**: state chips first (Resume a subagent, Compact), then the answer's own (`suggestFollowups`, kept per turn); a `/worktree` turn's editing chips, kept at `WORKTREE_TURN` and sent as `/worktree`. |
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
| `src/session.ts` | Session state per chat thread (`threadSession`), the chat's last worktree (`threadWorktree`), handoff chain and the way back after one, completion toasts, status bar, what the host's harness allows (`harnessNote`, `getParticipantProblem`, `localSessionProblem`). |
| `src/proc.ts` | Spawning: shim resolution (`~/` paths too), `cmd.exe` quoting, `killTree`, `PWD = cwd`, `dataHomeEnv` (`XDG_DATA_HOME` from `dataHome`), `otlpEndpoint` (`OTEL_EXPORTER_OTLP_ENDPOINT`: the setting, `off`, or the host's), `runCapture` (a short command's output), `executableStamp` (the files a name runs, as they are on disk). §2 rule 3. |
| `src/models.ts` | Model catalog (server `GET /config/providers`, else `opencode models --verbose`), names, variant names, cache tiers, the picker, `writeModelPin`, short names, `modelResolver` (one forced refetch per turn), `effortFor` / `higherEffort`, `contextNote`. |
| `src/agents.ts` | Which agent a read-only turn runs as: `planAgent`, only once OpenCode lists it. A server's list carries each agent's own `permission` rules. `prewarmFolder`: the server, then the folder's agent list. |
| `src/context.ts` | Attachments/selection folding, every reference noted kept or dropped (`referenceLogLine`, `contextNotice`: what OpenCode won't get, said in chat), references, answer file pills (`createFileLinker`), `parseChatPrompt`, `splitModelPrefix`, `splitModelsFanout`. |
| `src/env.ts` | What OpenCode loaded: config, plugins, MCP, commands, skills, agents, instruction files. |
| `src/followups.ts` + `.json` | **Every word a chip or handoff sends**, the marks, pills (`createBadger`), `followupsProblems`. Leaf: imports only its JSON. |
| `src/natural.ts` | Answer-derived chips: the agent's own offer or either/or, a named step 1, a review's findings by severity (`findingsOf`: headings, item tags, a Severity column, `<li>`), the file it edited, failing tests, Dig deeper — or nothing. `laneItems` is the lanes rule for the chip and for `autoParallel: auto`. |
| `src/core.ts` | **The foundation, and the engine's one seam to its host**: imports nothing local and no `vscode`. `setHost` (a host's `Settings`, folder, trust and state), `config()`, `hostFolder`, `hostTrusted`, `hostState`, `logChannel`, `Cancel` (Stop as the engine reads it), text helpers, `untilStop`, `underRoot` (a file's path under a root, links resolved). |
| `src/host.ts` | **VS Code as the engine's host**: installs itself with `setHost` when it loads (workspace configuration, the chosen folder, workspace trust, `globalState`); `extensionContext`, `vsConfig` (the whole configuration: `inspect`, `update`), the status bar (`setStatus`), folder resolution (`resolveFolder`, `relTo`, `rememberFolder`). |
| `src/extension.ts` | `activate()` (panel and inline participant, each guarded; commands and gitScan register regardless; the one warning when `@oc` cannot run or Local is hidden), the `__test` handle, `deactivate()`. |
| `src/commands.ts`, `commands-registry.ts` | Palette commands, worktree buttons, config listener. |
| `src/worktree.ts`, `chat-worktree.ts` | `/worktree`: git via `execFile`, an isolated dev run from HEAD (the uncommitted count is said); a follow-up in the same chat continues its worktree and session (`reopenWorktree` checks what the metadata names); its turns read `model:`, `effort:`, attachments and the vague-prompt gate as a chat turn does, and `/session` and `/compact` reach its session (`threadWorktree`). OpenCode: Worktrees lists them (`listWorktrees`, `pickWorktree` in `commands.ts`); Show full diff is `vscode.changes` with the base side from a read-only `ocb-base:` provider (`changedFiles`, `baseText`). |
| `src/format.ts`, `metrics.ts`, `prompt.ts` | Metrics → markdown; run types; timeouts and vague-prompt detection. |
| `src/context-markers.ts` | Host-free context vocabulary shared by the producer and leak gate. |
| `src/git-scan-server.ts` | Standalone newline-delimited JSON-RPC MCP server; one bounded, shell-free Git status call. |
| `src/git-scan-mcp.ts` | Trusted local first-folder MCP provider, stable global-storage server copy, config clipboard command. |
| `src/oc-mcp-server.ts` | **OpenCode as MCP tools: the engine's front end outside VS Code.** A standalone stdio server (newline-delimited JSON-RPC; 2025-11-25's `initialize` and 2026-07-28's per-request version): `opencode_ask` (read-only, `runOpenCodeServer` with `readOnly`), `opencode_dev` (only with `--dev`), `opencode_wait`, `opencode_cancel`. Jobs (`startJob`, `waitFor`: a call returns within `DEFAULT_WAIT_MS` or hands back a `jobId`), `callFolder` (the folder a call may name), its own host (`fileSettings`: the settings file, `serverPort` forced to 0), a stopped session settled before its job ends (`QUIET_MS`). |
| `src/oc-mcp.ts` | VS Code's side of it: `installMcpServer` (every `out/*.js` copied to global storage, marker last), `userSettings` (user-scope values only, written to `engine-settings.json`), `mcpEntry` and the **Copy MCP Config for Copilot** command, `copilotConfigNote` (Diagnose's row; the user's config is read, never written). |

Layering has no cycles:

```
extension.ts  →  chat · chat-boot · commands-registry · git-scan-mcp · oc-mcp · session · worktree · leaf modules (for __test)
     chat     →  agents · chat-boot · chat-commands · chat-parallel · chat-turn · chat-worktree · context · models · natural · prompt · session · core
chat-parallel →  agents · chat-boot · compose · context · models · net · runs · core
  chat-turn   →  agents · chat-boot · context · enforce · format · metrics · models · net · runs · server-session · session · core
 chat-commands →  chat-boot · chat-sessions · context · env · models · net · oc-api · prompt · proc · runs · session · worktree · core
 chat-sessions →  net · sessions (→ oc-api · runs) · session · core
 chat-worktree →  chat-boot · context · format · models · net · prompt · runs · session · worktree · core
    compose   →  chat-boot · models · core   (used by chat-parallel and commands-registry)
  chat-boot   →  heartbeat · lanes · chips (re-exported) · core · metrics
    lanes     →  enforce · runs · format · metrics · models · core      chips → lanes · natural
      runs    →  run-cli · run-server · run-steps · asks (re-exported) · server-session · session
 run-cli, run-server →  asks · run-steps · server-session · net · proc (cli) · metrics      run-cli → enforce · run-server (2.x)
      asks    →  oc-api · net · run-steps · metrics      server-session → agents · enforce · oc-api · net · metrics
    oc-api    →  enforce · net · core   (every server request: agents, models, sessions, chat-commands, commands, run-server)
     agents   →  enforce · oc-api · net · proc      net → enforce · proc · v2-events      proc → enforce · core      enforce → core
    models    →  context · env · net · oc-api · proc      commands → env · models · net · oc-api · proc · session · worktree
commands-registry → commands · compose · models · net · session · worktree
oc-mcp-server →  agents · format · natural · net · prompt · proc · run-server · server-session · core   (imported by nothing: its own process)
    oc-mcp    →  host · core   (used by extension and commands)
     host     →  core   (every module that needs the window: status bar, folder choice, `vsConfig`)
     all      →  core.ts · followups.ts (JSON only) · natural.ts (→ followups)
```

**The engine** is the running layer and everything it imports: `run-cli`,
`run-server`, `server-session`, `asks`, `agents`, `worktree`, `oc-mcp-server`
and, through them, `net`, `oc-api`, `v2-events`, `enforce`, `proc`, `run-steps`,
`metrics`, `format`, `context-markers`, `prompt`, `followups`, `core`. It imports
no `vscode`, not even a type, and loads in a plain Node process (`EN`): the MCP
server runs there, and an Agent Host would. What it needs from a window comes
through `setHost`; a probe or a standalone server installs its own. A new import
from an engine module pulls its target into the engine, and `EN` reads that from
the source. `oc-mcp.ts` copies every `out/*.js`, so nothing lists the engine's
files by hand.

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
`package.json`, both `package-lock.json` fields, `serverInfo.version` in
`src/git-scan-server.ts` (`GS`) and `VERSION` in `src/oc-mcp-server.ts` (`MP`). The gate compares a `dist/` VSIX of this
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
OpenCode version (`probes.yml`: 1.19.0, 1.19.5, 1.19.6, 2.0.29, 2.2.5, 2.2.7, 2.3.0 and 2.3.2 must pass, the latest 2.x may fail;
one job per 2.x for `probe-data-folder.js`; `probe-mcp.js` on 1.19.5, 1.19.6, 2.3.0 and 2.3.2),
and the chat participant API (`api-watch.yml`: `scripts/check-vscode-api.js` on
`vscode.d.ts`'s main branch, and a typecheck against the newest `@types/vscode`).

- The suite takes well over 30 s; do not judge it by a 30 s timeout.
- It **aborts on the first exception**: fix crashes first, then red checks.
- Package into `dist/` (`mkdir -p dist && npx vsce package --out dist/`): with no
  folder there, vsce fails and leaves an empty file named `dist`. A missing
  `repository` warning is expected — removed on purpose (REFS).
- Install locally: `node scripts/update.js` installs the newest delivered VSIX
  (sha256 checked against `docs/released.txt`) into `code`/`code-insiders`.
- Deliver: `npm run ship -- --record` appends `<version> <vsix sha256> <code
  hash>` to `docs/released.txt` (commit it). From then on any change to `src/`
  or `package.json` fails the gate until the version is bumped — moving the VSIX
  out of `dist/` no longer hides a rebuild (0.0.214 was rebuilt that way).
- What a cloud session cannot do (package and install into a real VS Code, a
  chat that renders, Windows and macOS) is written for a coding agent on the
  owner's machine in `docs/local-agent.md`: the release steps above, and the
  two route measurements (REFS 0.0.239).

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
| `scripts/probe-readonly.js` | Against a real binary, through `out/` (`runOpenCode`, `ensureServer`, `createServerSession`): can a read-only turn write — cold run, managed serve, an adopted one, another window's; 2.x over ACP. One line per row; control rows must be `CREATED`. `npm run compile` first. No `vscode` stub: the engine runs as a plain Node process would (`EN`). |
| `scripts/probe-acp.js` | `opencode acp` over JSON-RPC: handshake, prompt, cancel, load; the transcript as JSONL. Also the ACP client `probe-readonly.js` uses. |
| `scripts/probe-opencode2.js` | With `opencode2`, against a real 2.x through `out/`: text turn, plan writes (absent ×3), `/dev` and enforcement-off controls (`CREATED`), a subagent, Stop, `/sessions`; reads outside the folder and `.env` (refused), `/dev` outside (known), MCP only via `readOnlyTools`, plan first on a fresh server, effort with no model named. Expectations that differ by version name the version measured. |
| `scripts/probe-data-folder.js` | Two real binaries, one data folder, through `out/`: does 2.x import a 1.x folder, does a chat bound to a 1.x session go on, does 1.x still open it, and what each sees afterwards. Row counts from a copy of the database. |
| `scripts/probe-mcp.js` | Against a real binary, `out/oc-mcp-server.js` driven over stdio as an MCP client drives it (`scripts/fixtures/mcp-client.js`): `opencode_ask` writes (absent ×3), reads outside the folder and `.env` (refused), a session continued by `sessionId`, a job handed back and collected, `opencode_cancel` and the client's own cancel, the same session answering at once after a stop, `--dev` and its control (`CREATED`), stdin closed (the server and its OpenCode gone). |
| `scripts/probe-ahp.js` | Route H: the third-party `opencode-ahp` plugin (an AHP listener inside `opencode serve`; `npm install` it into a temp prefix and read it first) against a real 2.x, a raw AHP 1.0.0 client: listener after a location boot, `initialize`, `createSession`, the agent picker; plan writes (shell, write, through `explore`: absent ×3 on the bridge's server, recorded on a stock one) and the build control (`CREATED`); Stop, and the next turn. Stock server, the bridge's, and the bridge's with the plugin in `OPENCODE_CONFIG_CONTENT` (nothing in the workspace). |
| `scripts/record-wire-fixtures.js` | Records a real 1.x and 2.x server's frames per scripted turn into `scripts/fixtures/wire-v*.json`, the `TW` fakes' input. |
| `scripts/probe-model.js` | The scripted OpenAI-compatible model both use (`[[probe:<action>]]`): every tool attempt certain, no provider, no cost. |

`probes.yml` runs on Linux only. Open on Windows (0.0.236, 2.2.5): `probe-opencode2.js`
is 21 of 22. The red row is the control `first turn, no agent list read before it`:
the turn's own read-only read took ~900 ms there, long enough to start MCP, so the
prewarm row's green proves nothing on that machine. Not a safety finding (REFS).

*Write to the OS temp dir, never the repo* — the suite sweeps `ocb-*` at
startup, not exit (Windows holds a just-exited child's cwd).

*Make a probe go red before trusting its green.* Fakes must be `.cmd`-wrapped
on Windows (`writeFake()` does it).

*A path in a shell command is the shell's to parse*: OpenCode 2's shell on
Windows is Git Bash, which drops an unquoted `\`, so a probe writes `C:/…`
(REFS, 0.0.227: a control read "absent" for a file that landed renamed).

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
- **Record a passing value at its writer, never by polling** (`statusWrites`): a poll
  measures the machine (`ST`, 0.0.237).
- **Reproduce the defect first.**
- **Rewrite a fake with `writeFake`**, never a bare write: on POSIX the fake is
  the file `spawn` runs, and without its shebang `/bin/sh` reads it. Windows
  wraps every fake in a `.cmd` that calls `node`, so such a check is green there
  and red on Linux and macOS (0.0.213).
- **A file git checks out is CRLF on Windows** (`core.autocrlf`): compare its
  text without line endings (`WT8` read `v1\r\n` and went red).
- **`writeFake` answers `--version` with `1.19.0` itself** unless the fake's
  code mentions `--version`; and the CLI identity check is cached per
  executable file for the whole suite, across `ext.deactivate()`. A check about
  what `--version` says needs its own fake file whose code answers it: 0.0.223's
  3.x check reused a 2.0.29 identity and proved only the server half (0.0.225).
- `ext.deactivate()` runs near the end; later groups must not start a server.
  Settings keys go in the base `settings` object, never only inside a group.
- Every `__test` key is read as `ext.__test.<key>` (`MA`).
- **A group on OpenCode 2**: `oc2Use(async () => …)` runs it on the 2.x fake (its own
  request record, its server stopped after, the 1.x settings put back); `oc2Prompts()` is
  each posted prompt's session and text, `oc2Created()` the sessions made. A custom stream
  is `oc2Script(name, { paceMs, hold, events })` and `[[script:name]]` in the prompt:
  reasoning, tool and text events become 2.x frames inside the recorded text turn.

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
  overrides deny them unless `readOnlyTools` lists them. On 2.0.x MCP tools live
  inside Code Mode's `execute`, which can POST anywhere and create worktrees:
  denied on read-only turns, so before 2.2.0 read-only turns have no MCP tools.
  From 2.2.0 plan is offered a `readOnlyTools` MCP tool by name, and no other
  (2.0.29, 2.1.4 none; 2.2.0, 2.2.5 by name; `probe-opencode2.js`). A folder's
  MCP servers start with its first request, and their tools reach a turn 0.5–1 s
  later: prewarm reads the folder's agents for that (`prewarmFolder`, `PV`).
- **A folder's agent list can load in stages**, started by its first
  `GET /agent`: `[]`, then the stock rules alone for ~200–430 ms, then with the
  injected overrides (2.0.29: plan 7 → 39 rules). Which versions stage is not
  stable: 2.0.29 and 2.1.4 did, 2.2.0–2.2.6 answered loaded, 2.2.7, 2.3.0 and 2.3.2 stage
  again (2.3.0's stock stage lasts until 613–751 ms, under the 1000 ms settle).
  Taking the first non-empty list judged plan `unverified` and refused the
  default first turn — never the unsafe way. So no version is trusted to answer
  loaded: every 2.x list is read until it holds for `AGENTS_SETTLE_MS`, once per
  server start and folder (`TW`, REFS 0.0.233, 0.0.239, 0.0.240). Never key this on a
  version again: 0.0.233 read 2.2.0+ once, and 2.2.7 broke it within two weeks.
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
  `/command` stripped — replays put the kind back. After one `/worktree`,
  every message in that chat is `/worktree`, and a sticky one cannot be told
  from a typed one: so a follow-up continues the chat's worktree, and a fresh
  one is an explicit action (New worktree, a new chat, `/new`) (`WT5`).
- **`/worktree` is routed before the chat turn's own parsing** (`chat.ts`):
  whatever a chat turn reads from the request — `model:`, `effort:`, the
  `effort` setting, attachments, the vague-prompt gate — `handleWorktree` must
  read too, or it reaches the model as words or not at all (0.0.228, `WT10`–`WT12`).
- **git names a repo by its real path, VS Code a file by the path it was opened
  by**: through a link (macOS's `/var` → `/private/var`, Windows' `RUNNER~1`, a
  symlinked checkout) `path.relative` against `--show-toplevel` climbs out with
  `..`. Map a file under a git root with `underRoot` (`WT11`, `WT18`).
- **A worktree starts from HEAD**: uncommitted edits stay in the checkout, and
  a task about them ends in "No file changes". A new worktree says the count
  (`WT8`). A chip under a `/worktree` turn carries `command: "worktree"`: a
  `dev` or `plan` chip would run in the checkout. A Review chip goes as
  `/worktree` too (it reads the worktree); a lanes chip is left out, since
  lanes run read-only in the checkout (`WT9`).
- **A review has no one layout**: OpenCode 1.19.3's `/review` prompt says only
  "communicate severity". A severity counts as a heading, an item's leading
  tag or a Severity column, never as a word in a sentence (`NF`).
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
  API, new permission format. `opencode2` off (on by default since 0.0.238): detect,
  refuse, redact — never fall back to a cold run (`OC`). On: this window's own server only (`/api/info`
  with the printed password), every turn through it, overrides in 2.x's shape
  (1.x rejects that key; given both, 2.x applied neither), an unverified plan
  turn refused (`TW`). 2.x applies `opencode.json`'s `permission` and
  `agent.<n>.permission` (`bash` → `shell`) and `.opencode/agents/*.md` frontmatter
  (2.0.29–2.3.2, settled list and a real turn); 0.0.223 said "ignored" from a stock-stage
  read and warned on every such folder until 0.0.242 (REFS). A later major runs on the 2.x adapter
  with the outside-the-tested-range notice. Both majors keep sessions in the
  same data folder. 2.x imports a 1.x folder once and 1.x still opens it afterwards,
  then each sees only what it wrote (`probe-data-folder.js`, REFS 0.0.238); but 1.19.3
  refuses a folder 2.x created ("Database is not empty and has no session table") on
  every spawn. Remembered per executable file, refused before any
  spawn until `/ping` (`dataFolderRefusal`, `SE`).
- **On 2.x a variant goes only inside a model ref, and a session keeps both**
  (`POST …/model`: `id` and `providerID` required; 2.2.5 source). A prompt takes
  neither, so with no model named `unpinnedModel` sends the one the run would use,
  and a turn without a level puts the default back: 1.x resets by itself, 2.x does
  not. A level the model lacks fails the run on 2.x, where 1.x ignores it: read
  the catalog first (`TW`, REFS 0.0.237).
- **`opencode --version` costs ~0.7 s on 1.19 (the Bun binary starting)**:
  CLI first use awaits one shared check; later sends reuse it while the file
  behind the name is unchanged (`executableStamp`, file stats): a 2.x installer
  replaces a 1.x in place, under the same name (`OC`). Prewarming can prime it,
  but disabling prewarm cannot bypass identity. `/ping` and Diagnose can lift a
  refusal after the executable is replaced with 1.x.
- **A turn refused before sending is not a failed run.** Not OpenCode 1, an
  identity `--version` could not confirm, permission rules that could not be
  set, a data folder this 1.x cannot open: nothing reached OpenCode, and
  Continue would send "continue" to a session that never got the task. `failTurn` marks them `notSent`: Retry (the
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
- **A server just stopped can still hold its data folder**: a real 2.2.5 started
  right after a stop exited "SQLiteError: database is locked" (nightly probe). A
  start waits for the stopped server's exit, at most `STOP_WAIT_MS` (`serveGone`,
  `SV`). Stop invalidates a start still waiting for that exit; it must not spawn
  afterward (`SB`). Two servers on one folder are otherwise fine (2.2.5, 2.2.7:
  together, or one after the other, 0 of 12 each), except on a brand-new folder's
  first run:
  started together, one exits "table `account_state` already exists" (9 of 12).
  The next start works; the bridge does nothing about it (REFS 0.0.239).
- **A parent's `task` row runs as long as its subagent**: child events are the
  run's activity, or the idle cap stops a parent whose subagent works (`SU`).
- **From 2.3.0 a subagent runs in the background.** The tool returns "working in the
  background" at once (2.2.7 offered a `background` flag and waited by default; 2.3.2
  has no flag), the parent answers, and the turn ends while the child works: 1.7 s for
  a ~10 s child that 2.2.7 waited 10.6 s for (2.3.2, scripted model). No parent turn ran
  in the 30 s after it went idle. The child's result is put in the parent session as a
  `<subagent sessionID=… state="completed">` user message, read with the NEXT prompt (2.3.2):
  so the child id is read from "(sessionID: …)" (`v2Translator`), the turn keeps
  `backgroundTask`, and the Collect chip (`BT`) and the MCP result's next steps send that prompt.
  Whether its spend reaches the turn is not measured (REFS 0.0.242, 0.0.243).
- **A task result carries no cost or tokens** (OpenCode #47822): a subagent's
  spend is read from its own session's `message.updated` (`SC`).
- **The Copilot harness has no chat participants** (VS Code 1.142+; the API
  is "deprecated", kept for Local sessions). `@oc` answers in a Local
  session only, and VS Code's docs give Local an end: "will be removed in
  February 2027" (1.146 notes, 2026-11-11; REFS 0.0.239). Registering it can throw on a host without the API, so it is
  guarded: activation must still register the commands and gitScan, and
  Diagnose names the harness settings (`harnessNote`, `getParticipantProblem`, `HR`).
  With `chat.editor.localAgent.enabled` false VS Code offers no Local session
  (1.144.0 bundle), Send stays disabled and no turn of ours runs: activation says
  so once, outside chat (`localSessionProblem`). Nightly, `api-watch.yml` fails
  when `createChatParticipant` gains `@deprecated` or this code stops typechecking.
- **A quick pick filters its list by what is typed** — the composer's model
  items are `alwaysShow`, or typing a task would hide every model.
- **The engine's `Cancel` is VS Code's token, late listeners included**: a
  listener added after Stop is still called on the next tick, and the engine's
  waits are written against that (`httpRequestJson`, `watch`). A host's own token
  that drops late listeners runs the whole turn after Stop (`cancelSource`, `MP`).
- **An unhandled rejection ends a plain Node process**; the extension host only
  logs it. OpenCode 2's prompt wait rejected before anyone awaited it when Stop
  came first, and the prompt went out after it: `sessionPrompt` handles the
  rejection and sends nothing after Stop, and `oc-mcp-server` logs both kinds and
  keeps serving (`MP`).
- **An MCP job can be cancelled before OpenCode is sent a prompt.** Race server
  startup and plan-agent lookup against the job token, but leave their shared
  server boot/cache work alive for other calls; preserve lookup errors (`MP`).
- **A stopped session is not ready when its abort returns.** The engine does not
  await a Stop's abort (a chat has one second); a prompt sent to that session
  within ~100 ms read the stopped run's last events as its own: "Step
  interrupted" on 2.3.0, the old run's text on 1.19.5, 6 of 8 times with idle
  alone awaited. A person cannot type that fast and a model can: the MCP server
  ends a stopped job only after the abort, idle, and `QUIET_MS` without an event
  (`probe-mcp.js`, `MP`).
- **OpenCode 1 sends the prompt back as a text part of its own** on the server
  path. Chat drops it with `createEchoGate`; any other reader of `onText` must
  too (`probe-mcp.js`).
- **MCP 2026-07-28 is stateless and deprecates roots**: no `initialize`, the
  version in each request's `_meta`, `server/discover`, `resultType` on results;
  folders go in tool arguments or server configuration. So the MCP server takes
  `folder`, `sessionId` and `jobId` as arguments and keeps nothing by connection
  (REFS 0.0.241). Which revision Copilot's harness speaks is not measured.
- **The Copilot harness does not get an extension's MCP servers** (vscode#343729):
  it reads the user's `mcp-config.json`. The bridge copies the entry for the user
  and never writes that file; the server it names lives in global storage, since
  the extension's own folder is named by its version.
- **OpenCode 2 exports OTLP whenever `OTEL_EXPORTER_OTLP_ENDPOINT` is set**, traces
  and logs together (JSON over HTTP), and its logs carry each prompt's text. No other
  variable turns either off, a per-signal endpoint alone exports nothing, and 1.x's
  `experimental.openTelemetry` key is dropped by 2.x (2.3.2). An endpoint in VS Code's
  environment, set for another tool, gets OpenCode's prompts: `otlpEndpoint` decides,
  and Diagnose says where they go (`OT`, REFS 0.0.244). A turn's requests join a
  `traceparent` it sends; its model work runs in a trace of its own, joined by `session.id`.
- **Through an AHP host, read-only is the bridge's rules or nothing.** `opencode-ahp` in
  a stock `opencode serve`: plan ran `echo > f`, and so did `explore` under it; in the
  bridge's own server (`ensureServer`, the overrides) plan was offered no writing tool.
  The plugin can come in through `OPENCODE_CONFIG_CONTENT` (§2 rule 5), and its listener
  exists only while the folder's location is up (`scripts/probe-ahp.js`, REFS 0.0.244).

### Claims

Every capability the README states is tagged `<!-- claim:id -->` and anchored by
`claim:id` in a comment beside the code; gate 4 fails on a tag with no anchor.
Current: `worktrees`, `worktree-command`, `inline-participant`, `model-names`,
`parallel-models`, `command-aliases`, `sessions`, `parallel-composer`,
`file-links`, `effort`, `auto-parallel`, `lane-agents`, `read-only-subagents`,
`prewarm-server`, `git-scan`, `chip-backoff`, `opencode-1-only`,
`enforced-read-only`, `opencode-2-api`, `mcp-tools`.
