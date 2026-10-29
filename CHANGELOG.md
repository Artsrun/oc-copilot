# Changelog — opencode-copilot-bridge

Full release history, newest first; releases before the last one are condensed
to their summary and headlines. The README ships the last five.

### 0.0.231

VS Code's Copilot harness, the default for new chats from 1.142, has no chat
participants. The participant API is deprecated and kept only for Local
sessions (code.visualstudio.com, AI extensibility overview and *Migrate
customizations*, 2026-10-28). Phase 0 of surviving that: say it, and keep
the rest of the extension alive without the API.

- **Fixed: a host without the chat participant API took the whole extension
  down.** `createChatParticipant` was the first thing `activate()` ran, outside
  any guard; a throw there skipped `registerCommands` and `registerGitScan`.
  Measured with the suite's stub minus `vscode.chat`: six `HR` checks red on
  0.0.230, green now. The panel registration is guarded, the inline one is no
  longer attempted, and one warning says `@opencode` cannot run.
- **Diagnose rows `chat harness` and `harness settings`**, plus one log line
  at activation: VS Code's version, `chat.defaultToCopilotHarness` and
  `chat.editor.localAgent.enabled` as the host reports them (`harnessNote`;
  read only, "unset" before 1.142), and why `@opencode` is not registered if
  it is not (`getParticipantProblem`).
- **README: *Copilot harness*** — how to pick Local and keep new chats there.

### 0.0.230

OpenCode 2.2.0 against the 2.x adapter, a data folder of the bridge's own, a
status bar that follows a run, and a 2.x hang fixed. (The Copilot-harness work
planned for this round, P1 in `docs/v230-plan.md`, is not in it.)

- **Fixed: a 2.x run that failed before its prompt was delivered hung until
  Stop** (`sessionPrompt`, `oc-api.ts`). OpenCode 2.0.18 failed a turn with
  "Instruction initialization blocked by unavailable sources: core/instructions"
  (live, 2026-10-29): the error was logged, but the wait ended only on an idle
  after delivery, so three turns ran 19–272 s until Stop. A failed run's idle now
  ends it, and the error reaches chat (179 ms; hung 8 s before). Checks `TW`.
- **OpenCode 2.2.0** (REFS 0.0.230): `wire-v2.json` re-recorded on 2.2.0 — no
  frame type or field differs from 2.0.29's. Close in `/sessions` sends 2.x's own
  `archived: true` (2.1+, read back; 2.0.x ignores it and keeps the bridge's mark)
  and no longer erases the session's title (a metadata PATCH replaces the object,
  both versions). `session.retry.scheduled` (a provider 429, recorded) shows as
  `Provider retry N` on the live line. Checks `TW`.
- **New: `dataHome`** (docs/data-folder-design.md): `XDG_DATA_HOME` for every
  process `spawnOpenCode` starts; a new value lifts a remembered 2.x clash and
  stops the managed server. The refusals name the setting. Checks `SE`.
- **New: the status bar follows a run** (`$(sync~spin) OpenCode · plan · 1m 20s`,
  at the chat line's milestones), then names the context (`ctx 42%`). Checks `ST`.
- **Gate: the last fixed timing budget** (`GT … < 200ms`) is growth plus a cap.

### 0.0.229

The worktrees `/worktree` leaves behind can be found, read and cleared.

- **New: OpenCode: Worktrees** (palette and Quick Actions; `pickWorktree`,
  `listWorktrees`). This repo's `/worktree` worktrees — `ai/*` branches under
  `<repo>.worktrees/`, never another worktree — each with what it holds
  (uncommitted entries, commits past the fork point) and Show changes, Open,
  Remove; **Remove all without changes** asks once and keeps the rest. A day of
  testing left seven idle folders (0.0.228 probe). Checks `WT14`, `WT15`, `QA`.
- **Changed: Show full diff opens VS Code's multi-file diff** (`vscode.changes`,
  `changedFiles`): a row per file against the worktree's base, added files
  against nothing. The base side is a read-only `ocb-base:` document
  (`baseText`: a commit id only, `<sha>:<path>` as one argument), so nothing is
  written; a host without `vscode.changes` gets the text diff as before.
  Checks `WT16`.
- `/worktree` with no task lists this repo's worktrees and offers
  **Worktrees…**. Checks `WT17`.

### 0.0.228

A `/worktree` chat has been a conversation since 0.0.226; its turns now read
what a chat turn reads. OpenCode 2's tested range is 2.0.18–2.2.0, and the gate
no longer fails on battery.

- **Fixed: `/worktree` sent `model:` and `effort:` to the model as words**
  (`handleWorktree`, `chat-worktree.ts`). It is routed before `parseChatPrompt`:
  `model:tundra fix X` ran on the default model with the prefix in the task and
  in the branch (`ai/model-tundra-…`), and the `effort` setting never reached
  the run (`/dev` sent `--variant high`, `/worktree` nothing; measured through
  `out/`). Now both are flags, an unknown short name is refused before a
  worktree exists, and the setting is sent. Checks `WT10`.
- **Fixed: `/worktree` dropped attachments without a word.** A `#file` reached
  `/dev` as "Files the user attached" and `/worktree` not at all; an image got
  no "Not sent" note. Attachments now go by their repo path (the worktree has
  the last commit's copy, and an attached file the checkout has changed is
  named, `uncommittedPaths`), with the same notice and references. Checks `WT11`.
- **Fixed: `/worktree fix` made a branch, a folder and a paid run.** A bare
  first word is asked about, as on a chat turn; **Run it** sends it as
  `/worktree`; a continued worktree's `go` runs. Checks `WT12`.
- **Fixed: a worktree session had no books.** `/session` names the chat's
  worktree, branch and session; `/compact` in a worktree-only chat compacts
  that session in the worktree; a slow run gets the completion toast; touched
  files come back as references and file pills open the worktree's copy; text
  passes the leak and echo gates; the session is autocompacted by size
  (`contextOverflowing`), and the next worktree turn waits for that summary
  and stops an unwatched run first. Checks `WT13`, `CP`.
- **Changed: a Review chip under a `/worktree` answer**, sent as `/worktree`:
  it reviews the worktree, where the change is. Lanes stay out. Checks `WT9`.
- `/worktree` names its folder `<repo>.worktrees/<slug>`; the log keeps the
  full path. Checks `WT13`.
- **OpenCode 2 tested on 2.0.18–2.2.0** (`TESTED_OPENCODE2`): the probe's ten
  rows passed on 2.0.18, 2.1.4 and 2.2.0 (REFS, 0.0.227); `probes.yml` pins
  2.2.0 as well. Checks `TW`.
- **Gate: the NF timing check measured the machine.** Its 500 ms failed at 824
  ms on battery with the code unchanged; the code is linear (four times the
  input, 3.5–4.4 times the time). Now four times the input must cost under ten
  times as much, and the 250 KB answer under 2.5 s; a quadratic mutant fails
  it (REFS). The file-pill check had the same 500 ms (514 ms beside a second
  suite) and gets the same. Checks `NF`, `FK`.
- Words: `/help` and the manifest say a `/worktree` follow-up continues it; the
  participant's line names `/worktree`, `/sessions` and `/compact`; `/parallel`
  names `;;` and `---`. Checks `LB`.

### 0.0.227

A review's findings get Fix chips in any layout, `/worktree` names the
uncommitted changes a new worktree does not have, and a `/worktree` answer's own
editing chips continue that worktree.

- **Fixed: a review in bullets, tags, a table or `<li>` got no chips**
  (`findingsOf`, `findingChips` in `natural.ts`). Only a numbered list was
  read (`firstOfNumbered`); the same findings as `- **High** — …`, `[HIGH]`,
  `### High` over bullets, a Severity column or an HTML list gave nothing
  (scratch probe through `out/natural.js`: 5 shapes, 0 chips; numbered: Fix #1 +
  Fix all). OpenCode 1.19.3's own `/review` prompt asks only to "communicate
  severity", so no one layout can be assumed. A severity counts where a review
  puts one: a heading over the items, a tag at an item's start ended by bold,
  brackets, a colon or a spaced dash, or a Severity/Priority column. Chips:
  **Fix High: …** (the worst finding, whole in the prompt), **Fix High (n)** for
  a group of two or more, **Fix all** when lower ones exist. Low alone, "None",
  "High-level", "**High** availability" and an explanation in bullets get none.
  Untagged bullets under a Findings heading read as a numbered issue list.
  Checks `NF`.
- **Fixed: `/worktree` did not say a dirty checkout's edits stay behind**
  (`createWorktree` counts `git status --porcelain`). The worktree starts from
  HEAD; a task about uncommitted work found nothing to do there and ended in
  "No file changes". The opening line now names the count. Checks `WT8`.
- **Fixed: no chips under `/worktree`** (`followupsFor`, `WORKTREE_TURN`). Since
  0.0.226 a follow-up continues the worktree, so the answer's own editing chips
  (its offer, Test it, Continue) are offered with `command: "worktree"` and a
  click continues the same worktree and session. Read-only chips (Review) are
  left out: they would read the checkout. A failed worktree turn keeps none.
  Checks `WT1`, `WT9`.

### 0.0.226

- **`/worktree` follow-ups continue the same worktree and session**
  (`threadWorktree` in `session.ts`, `reopenWorktree` in `worktree.ts`). Copilot
  keeps `/worktree` sticky, so every message in such a chat made a new
  `<repo>.worktrees/<slug>` and branch, and OpenCode set up each new folder from
  scratch (config, agents, instructions: 0.0.225 live). The turn's metadata now
  names the worktree, its base and its session (never `sessionId` + `turns`,
  which bind the chat's own session); the next `/worktree` turn continues it if
  it is still this repo's worktree, at its branch's path, on its branch.
  Otherwise, after `/new`, or in a new chat: a fresh one. A continued session
  OpenCode no longer has is replaced once, in the same worktree.
- **New worktree** button: a new chat with `@opencode /worktree ` typed
  (`newChat` takes a bare `/word ` prefill; nothing is sent).
- `/worktree` refuses a known data-folder clash before creating anything.
- Checks `WT5`–`WT7`.

### 0.0.225

- **A data folder OpenCode 2 created fails fast** (`noteDataFolderClash`,
  `dataFolderRefusal` in `net.ts`): once `serve`, `run` or `models` says so, every
  later turn is refused before anything is spawned, as not sent (Retry, Ping).
  0.0.224 spent 9 s per turn re-spawning into it (`serve` twice, `agent list`,
  `run`). `/ping` fails the server row and lets the next message check again.
- **`/ping` and Diagnose say why the server is not running**: the last failed
  start (`lastServeFailure`), instead of "not running (started on demand)"; a
  model list served from the **stale** tier is a warning, not a tick.
- **No colour codes in the log** (`plainError`): `[serve]`, stderr, the agent
  list and the model catalog lines.
- **The new-chat note is log-only** (`GA`): it was the first of three notes
  before any answer (0.0.223 live). Reverses v212's once-per-window chat line.
- **No `glob: {}` row** (`stepDetail`): a tool part before its input arrives
  names nothing; its row appears with the arguments.
- Checks: `TW` 3.x through its own fake file (`--version` really says 3.0.0;
  0.0.223's reused a cached 2.0.29 identity), a 1.x server stays silent about
  1.x rules, a rules file added later is named, the global config dir isolated;
  `SE`, `GA`, `SG`. AGENTS §5: what `writeFake` answers to `--version`.

### 0.0.224

- **Copilot's customizations index is the host's** (`AUTOMATIC_ID` in
  `context.ts`): `vscode.customizations.index` rides on every turn and chat said
  "Not sent to OpenCode: a text attachment" for it (live, 0.0.223). Logged only.
- **CLI errors readable** (`exitProblem`, `run-cli.ts`): ANSI colour codes
  stripped (1.19.3 colours stderr on a pipe; chat showed `[91m[1mError: [0m`),
  and a bare `Error: Unexpected error` carries the next line, the cause.
- **1.x on a data folder 2.x created**: 1.19.3 exits with "Database is not
  empty and has no session table" (REFS); the turn says OpenCode 2 created the
  folder and names `XDG_DATA_HOME`. README's *OpenCode 2* no longer says the
  folder is always shared both ways.
- Checks `SE`, `JN`.

### 0.0.223

- **1.x permission rules on OpenCode 2 are named once** (`v1PermissionRules`,
  `chat-turn`): with a 2.x server, the first turn lists each config file whose
  `agent.<name>.permission` 2.x ignores (2.0.29 left a project's plan rules
  unapplied; `.opencode/agents/*.md` frontmatter was read). Keyed by folder and
  finding, so a file added later is still named.
- **A later major is tried on the 2.x adapter** with `opencode2` on (`--version`
  ≥ 2, `/api/info` ≥ 2, `serverMajor`), with the outside-the-tested-range notice;
  off, it is refused as before. Read-only stays verified or refused.
- **CI** (`.github/workflows`): `ship.yml` runs `npm run ship` on Linux, Windows
  and macOS for every push and pull request; `probes.yml` runs, nightly and on
  demand, `probe-readonly.js` against 1.19.0 and `probe-opencode2.js` against
  2.0.29 (both must pass) and the latest 2.x (may fail), one job per version.
  Checks `TW`.

### 0.0.222

- **OpenCode 2, experimental** (`opencode2`, off by default). `oc-api` gains 2.x's
  route set: Basic auth with the password `serve` prints (captured before the log
  redacts it), `location` scoping, an async prompt that waits for its own run's
  end (`session.inbox.delivered` then `session.execution.*`), agent and model set
  per turn. `src/v2-events.ts` reads 2.x's event stream as 1.x events (text and
  reasoning deltas, tools with `shell`→`bash` and `subagent`→`task`, steps and
  spend, asks and replies, errors, idle), so run-steps, asks and the demux are
  unchanged. A 2.x executable's every turn goes through the server runner
  (`run-cli`). Read-only: overrides in 2.x's format (`agents.<n>.permissions`; 1.x
  rejects that key and 2.x given both applied neither, measured), judged on
  `GET /api/agent`; on a 2.x server an unverified plan turn is refused, not
  warned. Only this window's own server is used. Checks `TW` (a fake 2.x
  replaying `scripts/fixtures/wire-v2.json`, and 1.19.0's recorded text turn).
  `scripts/record-wire-fixtures.js` records the fixtures; `scripts/probe-opencode2.js`
  drives `out/` against a real 2.x: `ALL 9 ROWS AS EXPECTED` on 2.0.29 and 2.0.32.

### 0.0.221

- Every request to an OpenCode server now goes through one module
  (`src/oc-api.ts`): one route set per OpenCode major, chosen by the version
  the server names. Only 1.x's set exists, and it sends the same URLs and
  bodies as before; OpenCode 2's server, another API under `/api`, becomes a
  second set instead of a version check at every call site. No behaviour
  change. Checks `OA`.

### 0.0.220

- **gitScan no longer runs commands from a repository's Git config.** `git status`
  passes a stat-dirty file through its `filter.<name>.clean`/`process` driver
  and runs a status of its own in each submodule; either executed a command the
  repository's config named (git 2.43, measured: a fixture's filter created a
  file through 0.0.219's server). Every configured filter driver is now blanked
  for the scan and submodules are compared by commit only
  (`--ignore-submodules=dirty`). A filtered file whose stat changed can show
  as modified. Checks `GS`.

### 0.0.219

- **Effective-rule allowlist for read-only turns; reopened rules refuse the turn.** OpenCode merges config files into `OPENCODE_CONFIG_CONTENT` key by key and keeps the earlier file's keys in place. 0.0.217 forced scalar `"deny"` on eleven writing tools, but any other key in `agent.plan.permission` kept its allow after `"*": "deny"`: measured on 1.18.35 and 1.19.0, `"w_*": "allow"` let an MCP tool write and `task: { "*": "deny", "general": "allow" }` let `general` write on a cold plan turn, and the server path showed the same MCP write while `deniesWriters` reported "enforced". Now `readOnlyLeaks` allows nothing after the last `* * deny` but the overrides' reach (read, grep, glob, list, lsp, skill, todo, web, `readOnlyTools`, `task` to `readOnlySubagents`, `external_directory`), and `judgeReadOnly` adds the marker and withheld-writer checks. Cold runs read `opencode agent list` (it prints each agent's merged rules; cached by injected config and config-file stamps, `configStamp`); servers read `GET /agent`. A bridge-configured agent with a leak refuses the turn before anything is sent (`assertReadOnly`, `ETURNPERMISSION`: Retry, no CLI fallback); a reopened subagent is withheld on a server and refuses a cold run; a custom `planAgent` is reported, never refused. Stop interrupts the cold lookup. Checks `RX`; the `RE` marker-only and late-allow variants now refuse instead of warning.
- **Excerpts keep to plan's read rules:** an unsaved `.env`/`.env.*` is not inlined on read-only turns (`.env.example` is; `/dev` sends all); an outside file whose excerpt was sent is not called unreadable. Checks `EX`.
- **Leak gate holds a whole echoed context block:** `HOLD_CAP` is `CONTEXT_HOLD_BYTES` (excerpt + problem caps + 32 KB) instead of 64 KB, which a full block exceeded (0.0.218: a 70 KB echo leaked 71,837 characters). The selection stays unbounded (fail-open).
- A custom `planAgent` that passes no longer receives, or uses up, the bridge's one-time read-only note; one whose rules allow more is told which, once per endpoint.
- `scripts/update.js` (dev only): installs the newest delivered VSIX into `code`/`code-insiders` when newer, verified against `docs/released.txt`. Checks `UP`.

### 0.0.218

- Enforce UTF-8 byte limits on editor excerpts, including truncation markers; bound diagnostic text.
- Report omitted unsaved editor text when the excerpt budget is exhausted, and identify potentially stale disk contents.
- Keep closed-file range attachments path-based, avoiding synchronous whole-file reads on the extension host.

### 0.0.217

- **Close config merge-order bypass on enforced read-only agents:** OpenCode deep-merges config objects and preserves earlier key positions (`opencode.json` or `.opencode/agents/plan.md` with `"*": "allow"`, `edit: "allow"`, `bash: { "*": "deny", "git *": "allow" }` kept `edit` and `bash git *` after `"*"` when `OPENCODE_CONFIG_CONTENT` only set `"*": "deny"` and `bash: { "ocb-enforced": "deny", "*": "deny" }`). Enforced permissions now set scalar `"deny"` on every writing/running tool (`bash`, `edit`, `write`, `patch`, `apply_patch`, `multiedit`, `shell`, `execute`, `question`, `plan_enter`, `plan_exit`) and top-level `ocb-enforced: "deny"`, replacing any earlier pattern map on those keys (measured on 1.18.35). Same tool-set check applied to `coldEnforcement` on cold CLI runs.
- **Attached dirty buffers, line ranges, untitled editors & `#problems`:** unsaved editor buffers (`TextDocument.isDirty`), line-range file attachments, open untitled documents, and `#problems` (`ChatReferenceDiagnostic`) are folded into bounded context sections (`Attached text excerpts:` and `Attached problems:`) and scrubbed by the leak gate.
- **Custom `planAgent` (`look`), `/parallel` notices & subagent hardening:** custom read-only agents whose rules deny writing tools no longer receive a false unverified server warning; subagent verification also requires `task * deny`, `readOnlySubagents` logs and excludes wildcards and primary/dev agents (`build`, `general`, `devAgent`), read-only `/parallel` turns surface enforcement notices, and concurrent `listAgents` requests share one in-flight call.
- **Server agent cache & release ledger:** `listAgents` cache keys include `currentServerGeneration()` so server restarts/adoptions invalidate stale 60s entries; `scripts/ship-gate.js` verifies every delivered VSIX in `dist/` against `docs/released.txt`.

### 0.0.216

- Disable shell on enforced agents: Git inspection commands could execute writing helpers.
- Validate literal subagent names and effective server rules; attach enforcement notices to the actual run.
- Remove nested docs build artifacts, redundant test wrappers and stale comments.

### 0.0.215

Read-only turns are read-only by permission. Also a review of the local agent's
two fixes, which were rebuilt under 0.0.214's number: they ship here.

- **Plan turns could write.** The built-in `plan` is read-only by instruction
  only — it ran `echo hi > file` on 1.19.0 and 2.0.29 — and the built-in
  `explore`, the one subagent read-only turns allowed, has `bash * allow`: a
  plan turn's `explore` wrote a file through the bridge's own read-only session
  rules (1.19.0, the bridge's HTTP path). New setting `enforceReadOnly`
  (default on): every OpenCode process the bridge starts gets an
  `OPENCODE_CONFIG_CONTENT` that overrides `plan` and each `readOnlySubagents`
  agent with the README's `look` model — everything denied first, then reading
  (`.env` aside), searching, the web, inspect-only shell (`git status`/`log`/
  `diff`, `ls`, `cat`, `rg`, `find` without `-exec`/`-delete`, no redirects),
  `readOnlyTools`, and `task` to `readOnlySubagents` only. A user's own
  `OPENCODE_CONFIG_CONTENT` is merged. `src/enforce.ts`; `spawnOpenCode` stays
  the one place. `/dev` is unchanged: `build` keeps its rules, and `explore`
  is read-only in `/dev` too. Checks `RE`; `scripts/probe-readonly.js` against
  the real binaries (21 rows on 1.19.0, 7 on 2.0.29 over ACP).
- **A server the bridge did not start** keeps its agents' own rules. Another
  window's server on the shared port has the overrides (each overridden agent
  lists `bash ocb-enforced deny` in `GET /agent`, read at most once a minute);
  one you started has not: read-only turns there start no subagents, and the
  first says so. No shell deny on such a session instead: a subagent inherits
  every deny rule of its parent session and none of the allows (1.19.0,
  measured), so it would also stop that chat's `/dev` subagents — measured:
  `general` could not write after a plan turn. A subagent is allowed only where
  it is overridden: one added to `readOnlySubagents` after the server started
  is left out (logged) until it restarts.
- **What you attach that OpenCode won't get is said** before the answer: an
  image, Problems, an unsaved editor, VS Code's current-file chip (once per
  window), and on a read-only turn a file outside the folder — measured: plan
  cannot open it on 1.19.0 and 2.0.29, `/dev` can. Before, all of these were
  dropped or unreadable without a word. Output › OpenCode logs every reference
  VS Code sent, kept or dropped and why (`references (N): kept …; dropped …`).
  Untitled editors are no longer sent as a bogus path. Checks `JN`.
- New setting `readOnlyTools` (default `["git-scan_gitScan"]`): the MCP tools a
  read-only turn keeps (1.x names them `<server>_<tool>`; measured). A name that
  would re-allow a tool that writes, runs commands or delegates (`*`, `e*`,
  `bash`) is left out and logged.
- The first plan turn after the upgrade says what changed, once.
- **Windows shim retargeting invalidates the CLI identity too** (the local
  agent): the stamp covers the `.cmd` wrapper as well as its target and script,
  so retargeting just the wrapper resolves afresh and checks `--version`. `OC`.
- **Refused `/parallel` turns offer Retry and Ping** (the local agent): Retry
  keeps the lane text and the `/parallel` command, a cached refusal included. `OC`.
- **One version, one build, enforced.** 0.0.214 was rebuilt from other code
  under its own number after its delivered VSIX was moved out of `dist/`
  (delivered sha256 `21b8768b…0903`, rebuilt `591aab31…45d4`). The gate now
  reads `docs/released.txt` — each delivered version's VSIX and code hash,
  written by `npm run ship -- --record` — and fails when a delivered version's
  code changed. It also fails on build output outside the root `out/` and
  `dist/`: a whole extracted tree sat under `docs/` (`out/*.map`, `.vscode/`),
  past the root-anchored ignore rules. Removed.
- Dev probes, not shipped: `probe-readonly.js`, `probe-acp.js` (OpenCode 2 over
  ACP, groundwork for 0.0.216), `probe-model.js` (a scripted model: no
  provider, no cost).

### 0.0.214

A review of 0.0.213, which was pushed without a VSIX: the first package with
its safety work. No setting, command or default changed.

- 0.0.213's gate was red on Linux and macOS: a fake rewritten without its shebang.
- An internal name was still in a plan doc; generic words now.
- The CLI identity is of the file, not the name (`executableStamp`).
- Refused before sending, and says so (`notSent`: Retry, New session, Ping).
- `/parallel` confirms identity once before its lanes.

### 0.0.213

- Fail permission preparation closed: unsuccessful PATCHes and unavailable or
  malformed agent permissions block messages and CLI fallback. Cache only
  successful updates and include the restored dev agent and directory.
- Preserve restrictions when switching dev agents after a read-only turn.
- Redact complete bounded server diagnostic lines independently on stdout and
  stderr; discard oversized lines rather than exposing partial secrets.
- Await a shared first-use CLI identity check at the runner boundary, including
  attached runs, lanes and worktrees. Stop interrupts the wait; unknown identity
  fails closed and failed checks can be retried. Prewarming is optional.
- Keep commands, settings, defaults, VS Code minimum and existing 1.x transports.
  ACP remains a future developer probe, with no production routing changes.

### 0.0.212

A truth pass against OpenCode 1.19.0 and 2.0.27. No setting or command was
added, removed or renamed; no default changed.

- **Fixed: `/dev` after a plan turn kept the read-only subagent limit**:
  session rules append and the last match wins (measured on 1.19.0), so `/dev`
  re-applies the dev agent's own `task` rules. Checks `RO`, `PM`.
- **OpenCode 2 is named, and nothing runs**: a web page for a health answer,
  `Unrecognized flag`, or a 2.x `--version`; its server password is redacted;
  `executable` expands `~/`. Checks `OC`, `FX`, `C`.
- **A CLI run that exits non-zero with no error event and no text** shows its
  first stderr error line. Checks `SE`.
- **`autoCompactEveryTurns: 0`** means the bridge never compacts; a Compact
  chip instead. Checks `CP`.
- Tested range 1.18.27–1.19.0; `/help` names every inline prefix; suite honesty
  and speed (`SB`); dead code removed; the gate fails fast and checks cited names.

### 0.0.211

- Fixed context filtering after oversized blocks, unmatched inline backticks
  across blank lines, invalid fence closers, and lost separating whitespace.
- Boundary regressions cover streamed and whole-answer filtering.

### 0.0.210

- **Fixed context filtering:** selection/cursor-only preambles, literal tags in
  inline/fenced code, line-start separator detection and balanced nested tags.
  Incremental scanning bounds hidden text at 64 KiB; oversized blocks release
  as text. Prose-inline unclosed tags retain the 0.0.209 drop-at-flush behavior.
- **gitScan MCP:** zero-runtime-dependency stdio server, trusted local first-folder
  Copilot provider and default-true `gitScan` setting. One porcelain-v2 Git status
  reports HEAD, branch, upstream divergence and up to 40 changed files, with
  fsmonitor/optional locks disabled and a five-second timeout.
- **OpenCode: gitScan config for opencode.json** copies/prints a snippet using
  a stable global-storage server path. `/env` explains separate configuration
  and CLI-only pure mode. The command does not write user configuration.
- Regression groups `GT`, `DS`, `GS`; standalone server packaging check.

### 0.0.209

- **Fixed: streamed context could reach chat after a cutoff or a repeated
  block.** Incomplete context blocks are dropped at flush, and completed blocks
  are removed before looking for the next opener. Checks `GT`, `DS` cover both
  the stream gate and the chat output.

### 0.0.208

- **Tested range is 1.18.27–1.18.35.** Reported on 0.0.207: a 1.18.35 server
  got the version note. 1.18.34 → 1.18.35 was diffed (tags `v1.18.34`,
  `v1.18.35`): the only change under `packages/opencode/src` filters
  non-PNG/JPEG/WebP tool-result images for xAI models (`session/message-v2.ts`);
  server routes, events, the CLI, permissions and compaction are unchanged, and
  `sdk`, `server`, `core` changed their version only. Checks `VN`.

### 0.0.207

Speed: the autocompact collision, streaming, a prewarmed server; follow-ups that
fit the failure. One setting added (`prewarmServer`), none removed.

- **Fixed: autocompact ran an agent turn nobody saw, then fought the next
  message.** `/summarize` was sent with `auto: true`; OpenCode 1.18.32
  (`compaction.ts`) ends an auto compaction with a synthetic "Continue if you
  have next steps…" and loops once more. The summary alone keeps the session
  busy (`prompt.ts`), so the next message aborted it (`busySessionPolicy:
  abort` — warning, ≤3 s poll, summary lost, re-triggered next turn) or queued
  behind it. Now `auto: false` (OpenCode's own `/compact`), one summary per
  session at a time, and the next turn of that session waits ≤60 s for it
  (Stop-able; `pre-run: … summary Nms`). The turn-count trigger needs a 20k
  context (or an unmeasured one). Checks `CQ`, `DM`.
- **Answers stream.** 1.18.32 sends text and reasoning as
  `message.part.delta` (`partID`, no `part`) and the whole part once at its
  end; the server path read only `part.updated`, and `opencode run --format
  json` prints a part only at `time.end`. The server path now streams the
  deltas; an attached `/dev` run takes them from the SSE it already watches and
  stdout adds only the rest (a late delta is dropped). Two gates keep the
  old whole-text guarantees over deltas: leaked context blocks and a prompt
  said back. Checks `DS`, `DT`, `GT`.
- **`prewarmServer`** (default on): `onStartupFinished` activation starts or
  adopts the server 3 s later — trusted workspaces only (OpenCode loads the
  folder's config and plugins), never on `transport: cli`. A start in flight
  is shared: a first turn mid-boot joins it (one spawn) and is told it waits.
  Checks `PV`.
- **Provider retries are named**: `session.status` `retry` → `Provider retry
  2 · Rate limited · next in 8s` on the live line and in the log; the next news
  puts the opening line back quietly. Both transports. Checks `DS`, `GT`.
- **Follow-ups that fit the failure.** Rate limit / quota / overload / refused
  key / unknown model → Retry + **Pick model** (`/model`); stopped on a hung
  tool (`stuckTool` in metadata) → **Skip it** + Continue; Stop before the
  message was sent (`notSent`) → **Retry** with your words; last step finished
  `length` → one line plus **Finish it**, first and never held. Checks `FX`, `DS`.
- Not done: keeping the SSE socket open between turns. A warm socket already
  answers `connected` at once, a fresh local connect takes a few ms, and a
  lingering socket would hold fake servers open in the suite for its whole
  linger.

### 0.0.206

Chip telemetry and `natural.ts` in testable parts. No setting was added or
removed.

- **Chip telemetry.** The log gets `chips offered: <kinds>` per finished turn
  and `chip taken: <kind>` when a chip is sent next, plus the host's
  `onDidReceiveFeedback` verdict. Checks `BK`.
- **Head fallback.** When no offer, choice or cue fired, the first 3 sentences
  are scanned for the agent's offer (a long plan ending in a summary buried it).
  Checks `NF`.
- **`naturalFollowups` split** into `offerChipsIn`, `choiceChipsIn` and
  `cueChipsIn`; scan limits are named constants; `plainText` and
  `sentencesOf` moved to `core.ts`. Table-driven offer phrasings in `NF`.

### 0.0.205

Server identity on a fixed port, permission replies that are confirmed,
subagent rows in the accordion, Compare lanes, chip backoff, and `handleChat`
split. No setting was added or removed.

- **Review of 0.0.205: five fixes, all minor.** A server-transport turn that
  waits on a first boot now prints *Starting the OpenCode server…* itself
  (`/sessions`, `/stop` and `/parallel` already did). *Compare lanes* is
  offered only when the lanes can answer differently — one task, and a model
  or agent that differs; `models:a,a task` no longer claims a comparison.
  A finished subagent tool no longer names itself in the live line's ticker
  (the ticker names the parent again). A failed `task` with no child session
  is a *Rerun* chip, not *Resume*, and like Resume it is never held back.
  The `asks` module's imports (`run-steps`, `metrics`) are in the §1 graph.
  Checks `SB`, `CL`, `SU`, `RT`.

- **Fixed: an impostor on the server port received the prompt.** Measured in
  0.0.204 with `scripts/probe-server-adoption.js`: a listener answering only
  `{"healthy":true}` was adopted, and `POST /session/<id>/message` carried the
  prompt and the workspace path. A real server names its version
  (`{"healthy":true,"version":"1.18.34"}`). A fixed-port listener without a
  `version` now gets the health probe alone and the window starts its own
  server on a free port; a server this window started is used either way.
  Checks `ID`.
- **Permission replies are confirmed.** `POST /permission/:id/reply` answers
  200 for an id that is not pending (#15386), so a reply counts only when
  `permission.replied` arrives; else one resend after 3 s. The pre-1.1
  `permission.updated` ask is answered at the session's own route. Checks `HQ`.
- **Subagent rows.** On server and attached runs a subagent's tool calls nest
  under its `task` row in the finished accordion (`explore › read: src/x.ts`),
  at most 8, the last counting the rest. Checks `SU`.
- **Compare lanes.** A `/parallel` run of one task on several models offers
  *Compare lanes* (a plan turn that weighs the lane answers) before *Merge
  lanes*. Checks `CL`.
- **Chip backoff.** A cue chip kind passed over three messages running is held
  for the next 2 messages, then 4, 8 … 32; taking one clears it. Kept in
  globalState. The agent's own offers and choices and Resume are never held.
  Checks `BK`.
- **`handleChat` split** (≈ 950 lines): `chat.ts` keeps routing, gates,
  context and the handoff chain; `chat-turn.ts` runs, recovers and posts;
  `chat-parallel.ts` runs `/parallel`.
- **Probe:** `scripts/probe-subtask-lanes.js` measures whether a `subtask`
  part runs a project-local subagent on a real server (#21659), before
  subagent-mode lanes move to server-side delegation.

### 0.0.204

A slow first server start that failed `/sessions`, chips from what the run
left unfinished, `/compact`, subagents you can see, and `chat-boot.ts` split.
No setting was added or removed.

- **Fixed: `/sessions` failed while the server was still starting.**
  Reported on 0.0.203: `Could not list sessions: OpenCode server did not
  become healthy on http://127.0.0.1:61930 within 20 s`, then `/ping` healthy
  on the same port a moment later. 0.0.203 had cut each health poll to 1.5 s,
  so a booting server that answers slowly never counted as up. The review of
  0.0.203 set the deadline to 45 s and each poll to 3 s, and the error now
  says the process is still running and what it last printed. 0.0.204 adds:
  a wait past 1.5 s says *Starting the OpenCode server…* (`/sessions`, `/stop`),
  Stop ends a `/sessions` that waits on a boot, a failed start is reported
  instead of being read as Stop, the `/sessions` error is no longer cut at 120
  characters (it lost the cause), and the log records
  `serve on … answered after N.Ns` for every start. Checks `SB`.
- **Resume chip for a subagent that stopped.** A `task` call that ended in an
  error or was interrupted leaves `failedTask` in the turn's metadata (agent,
  description, child session); the first chip, *Resume explore*, asks the
  agent to call `task` again with that `task_id` (resumable since OpenCode
  1.18.20), or to rerun it when no child session was reported. Checks `RT`.
- **`/compact`**: summarise this chat's session now, with the model it runs
  on, as autocompact does (one model pass). With `autoCompact` off, a turn
  whose context reached the autocompact threshold offers a *Compact · 72%*
  chip. Checks `CP`.
- **Subagents you can see, and that keep their parent alive.** On server and
  attached runs the live line shows what a subagent is doing
  (`explore › grep redirect`, one line per 2 s at most), and its events count
  as the run's activity: a parent waiting on a long subagent is no longer
  stopped by the idle cap. Checks `SU`.
- **Version note.** A server whose `/global/health` names a version outside
  1.18.27–1.18.34 gets one line per window saying so; the turn runs. Checks `VN`.
- **State chips first.** Resume and Compact come before the answer's own
  chips; at most three as before.
- **`chat-boot.ts` split** (1,000 lines) into `heartbeat.ts` (the live turn),
  `lanes.ts` (`/parallel`) and `chips.ts` (follow-ups); `chat-boot.ts` keeps
  the command vocabulary and `/help`, and re-exports the rest.

### 0.0.203

Subagents on read-only turns, a server port held by a hung listener, an agent
per lane, and `runs.ts` split by transport. One setting added.

- **Fixed: a read-only turn could edit through a subagent** — `task` rules allow only `readOnlySubagents`. Checks `RO`.
- **Fixed: a fixed `serverPort` held by a hung listener** — the window starts its own server; exits name their cause. Checks `SV`.
- **`a:<agent>` per lane**, checked against OpenCode's list. Checks `LA`. Subagent spend and Stop. Checks `SC`, `AT`.
- **`runs.ts` split** into `run-cli`, `run-server`, `run-steps`, `asks`, `server-session`.

### 0.0.202

Reasoning effort, lanes without typing `/parallel`, and autocompact sized the
way OpenCode sizes a session. No setting was removed; two were added.

- **Effort (OpenCode model variants)**: `effort:<level>` / `e:<level>` or the `effort` setting, checked against the model's levels (OpenCode ignores a miss silently). Checks `EF`.
- **`autoParallel`** (`offer` | `auto` | `off`). Checks `AP`.
- **Fixed: autocompact measured the wrong thing** — now the last step's context, as OpenCode's `isOverflow`. Checks `CX`.
- **Chips**: *Fix failing tests*, *Dig deeper · high*. Checks `FT`. **Subagent rows** name the subagent. Checks `SG`.

### 0.0.201

- A specific Fix offer no longer hides Fix all; a merge prompt without {run} is reported.
- `serverPort` defaults to 53200 instead of 4096, so the bridge no longer adopts whatever answers `{"healthy":true}` on the common port (it received the prompt and workspace path, measured). `0` starts a private server on a free port and adopts nothing; a fixed port still reuses a healthy server there.

### 0.0.199

- A plan whose first numbered list is 2-5 read-only steps, each naming a concrete
  file or call, gets a "Run N as lanes" chip that sends them as /parallel lanes.
- A finished /parallel run offers "Merge lanes" and "Retry failed lanes". Lane
  answers are kept in memory (8 runs); after a reload the merge says so and runs nothing.
- Model rows in the default-model picker lead with a chip icon.
- Fixed: an answer ending "the parser constructor" no longer produces an inherited-key chip.
- `.vscode/settings.json` is no longer tracked (it is git-ignored).

### 0.0.198

Fixes from a Copilot review of 0.0.197, and four write-only fields found by
the same sweep. No setting was removed.

- **Fixed: `/constructor …` and `/__proto__ …` were refused** as aliases "set
  to `/function Object() { [native code] }`": the alias and retired-command
  lookups found inherited object keys. Both use `Object.hasOwn` now; the task
  runs. Checks `RM`.
- **Fixed: `/help`** had no row for `/help` (the README calls it "this table"),
  and said "one session per chat" under `sessionScope: workspace`; it says
  "per folder" there. The row check is bounded, so a `/sessions` row no longer
  stands in for `/session`. Checks `I`.
- **Gate: a tracked file that `.gitignore` names fails the gate.** Ignoring a
  tracked file does not untrack it: a checkout made from the 0.0.197 tar
  without `git rm --cached` kept `.vscode/settings.json` committed.
- **Gate: the no-git walk (`committable()`) is compared with git's own list
  on every run.** A green run on a checkout never executed it.
- **Removed, write-only:** `RunMetrics.usageKnown` (its reader went with the
  usage store), `RunMetrics.signal`, `SessionState.lastAgent`, and the `alias`
  that `resolveAlias` returned. The exit-code log line's signal suffix never
  printed: Node's `close` reports a code or a signal, never both.
- **Checks for paths no check executed**: the 1 s floor on `timeoutMs` (a
  1 ms setting shows `1s wall clock` in `/ping`), and id-less tool parts kept
  apart by tool and input on both transports. Checks `CE`, `JF`.
- REFS points at the mermaid code by a command that works in any clone, not a
  hash that only GitHub's history has.

### 0.0.197

A dead-code and stale-comment sweep, `/help` that lists every command, and
the repo stops tracking `.vscode/settings.json`. No setting was removed.

- **Removed: the live-session tracker.** Six call sites marked and dropped
  sessions, and nothing had read the tracker since the retention it served
  went away (0.0.165). Its 13 checks tested the class alone, and two of them
  pinned the dead calls in place.
- **Removed: `planTimeout`'s two parameters.** Neither was read; the budget
  is the same for every agent and kind. Checks `CG`.
- **Removed: the Diagnose "session log dir" row**, which reported a folder
  nothing has written since session logs went.
- **Fixed: `/help` lacked `/ping` and `/env`** and said "one session per
  workspace"; it is one per chat. Checks `I`.
- **Fixed: the repo tracked `.vscode/settings.json` with a model pin.** Set
  Default Model, run in this repo, writes the pick where the pin lives
  (`DM`), so your own model went into a tracked file: how a private gateway
  id reached the 0.0.195 tar. The file is deleted and git-ignored; a pick goes
  to User settings.
- **Checks back from the dead.** `JF` (two reads of one file stay two steps,
  on both transports) read a footer removed in 0.0.165 and was commented out;
  it reads the debug log's step count now. `E` ran a turn and asserted
  nothing. `CB` asserts the exit code reaches the debug log.
- **Dead code out of the suite**: unread locals, values computed only to be
  `void`ed, commented-out checks, tombstone comments. A tripwire fails on any
  empty if/else/loop block in `src/` (the `/flow` removal left one). Checks
  `ES`.
- **Gate: without git, the leak scan reads the tree under `.gitignore`** —
  the same list `git ls-files` gives on this checkout — instead of a hand-kept
  skip list. `media/logo.svg`, referenced by nothing, no longer ships (32 files
  listed, 34 entries in the .vsix).
- Stale comments corrected: catalog tiers, the status tooltip, the SSE ask
  watcher, a REFS section cited by a name it never had.

### 0.0.196

`/flow` is removed, `/parallel` lanes get your attachments, and the gate
catches two more kinds of drift. No setting was removed.

- **Removed: `/flow`** and its alias `/f` — the command, the turn trace in
  every turn's metadata, `src/flow.ts`, the mermaid probe and the docs. A
  typed `/flow` or `/f` now says it was removed and runs nothing; before, the
  `/` kept it out of the vague-prompt gate and it would have gone to the model
  as a paid task. The mermaid finding stays in REFS. Checks `RM`.
- **Fixed: `/parallel` dropped attached files.** The context was built after
  the parallel branch had returned, so `#file:` reached no lane. Every lane now
  gets the attachment after its own task, the files show as references, and
  `includeChatReferences: false` still keeps lanes bare. Checks `J`.
- **Gate: without git, every file is scanned for internal names.** The 0.0.195
  tar's `.vscode/settings.json` pinned a model on a private gateway, and the
  fallback scan read only the packaged files.
- **Gate: `package-lock.json` must carry the manifest's version** (it said
  0.0.194 in 0.0.195, as it said 0.0.187 in 0.0.189).

### 0.0.195

Fixes from a review of `/parallel`.

- **Fixed: `transport: server` ran `/parallel` lanes cold**, serialising them
  on one `opencode.db`. Lanes attach to the managed server now; `cli` stays
  cold, `auto` keeps the `attachDevToServer` opt-out. Checks `FC`.
- **Fixed: Stop waited out a cold server boot** before the turn ended. The
  three server warm-ups are raced against Stop.
- The composed-lanes text moved to `metadata.composedLanes`; `lanes` is only
  ever a count.

### 0.0.194

Files named in chat open on click.

- **File pills in the answer**: `src/cart.ts`, `src/cart.ts:42` or
  `src/cart.ts#L42` in inline code becomes an inline anchor that opens the
  file at that line. Only a file that exists inside the workspace; never inside
  a fence or a multi-backtick span; a path split across stream chunks is held
  until its span closes. Sent as `response.anchor(Location)`: VS Code 1.139
  merges it into the sentence, while an empty-text markdown link would lose the
  line on click. Checks `FK`.
- **Accordion rows open their file**: a `read`, `edit`, `write` or `patch`
  row carries its file and renders as `cart.ts  #read`; shell and search rows
  stay text.

### 0.0.193

Fixes from a review of the follow-up chips.

- **Fixed: "let me know if you want the docs updated or the tests added"
  gave one garbled chip** ("Add the docs updated or the tests", sent to
  `/dev`). Each part is its own chip now; a part that is no action ("more
  detail or …") leaves the sentence without chips.
- **"Next steps: A, B, and C"** is three chips, not one cut-off chip. ", and"
  between two actions ("run the tests, and fix any failures") stays one.
- A long path in a chip label is cut after a `/`, not inside a file name.
- A bug while reading chips from a finished answer costs the chips, not the
  turn: it no longer reports "OpenCode failed to start" under the answer.

### 0.0.192

Fixes from a review of `/sessions` and the `/parallel` composer.

- **Keep in this chat** on the chat's own session no longer resets its turn
  count and spend.
- **Fork** deletes the copy when the bridge's headless rules cannot be put back
  on it, instead of leaving a fork that could ask questions nobody can answer.
- **Close / Delete** clear the folder's session pointer only when it holds the
  session that is gone, whichever chat owns it.
- A server error listing sessions is reported as one, not as "no sessions".
- Session titles show as plain text; an excerpt cut inside a code fence is
  closed.
- The composer: a model id with a colon (`ollama/qwen2.5-coder:7b`,
  `…:free`) is kept whole; a typed task no longer reorders the list, so Enter
  keeps the model you chose; Stop ends the turn while the model list loads; it
  lists the models of the chat's folder.
- **Run lanes** and **Compose…** are chips now, not buttons: a chip
  owns the next message.

### 0.0.191

Public-repository hygiene; no behaviour change.

- Test fixtures and examples no longer name an employer's model gateway:
  provider `acme-gateway`, models Tundra / Oasis / Arbor / Aspen. Help text and
  README examples read `model:tundra`.
- The ship gate's leak scan reads every file git would commit, not only the
  package, and takes its private tokens from `OCB_LEAKY` or `~/.ocb-leaky`
  instead of from its own source.

### 0.0.190

Sessions you can see and act on, a composer for `/parallel`, and one "New
session" instead of two look-alikes. No setting was removed.

- **`/sessions`** (alias `/ls`, palette **OpenCode: Sessions**): this folder's
  OpenCode sessions from its server (`GET /session?roots=true`, newest first,
  archived left out), this chat's marked. Pick one: **Continue here** (the chat
  is bound through the turn's metadata, as a finished turn binds it; its last
  ask and answer are shown), **Fork into this chat** (`POST …/fork`; OpenCode's
  fork copies no permission rules, so the bridge's headless rules are PATCHed
  back), **Close** (OpenCode's archive, after stopping a running turn),
  **Delete…** (modal confirm). Closing or deleting this chat's own session
  starts the chat fresh. Routes read from OpenCode 1.18.33's
  `httpapi/groups/session.ts`. Checks `SL`.
- **`/parallel` alone opens a lane composer** (also **OpenCode: Compose
  Parallel Lanes** and Quick Actions). One quick pick per lane: the task is
  typed in its box, the models are its list (default first and active — all
  `alwaysShow`, so typing never hides them). From two lanes on a Submit button
  and a last item appear; Submit inserts `@opencode /parallel …` into the chat
  input (`isPartialQuery`), nothing runs. A task the splitter would cut is
  refused on its page. Stable VS Code gives a participant no form inside the
  chat; the quick pick is the native step UI. Checks `PW`, `X`.
- **"Ask OpenCode" merged into "New session"**: both opened a chat with
  `@opencode ` typed; New session now does that in a **new** chat — a new
  thread is a new session, and the chat you leave keeps its own. It used to
  submit `/new` into the current chat. "Ask in Chat" and "New Chat" stay
  registered (keybindings) but leave the palette. Checks `NS`, `QA`.
- **Investigated: chats vanishing from the sessions list while they run.** The
  bridge runs no chat command during a turn; the list is VS Code's (REFS).

### 0.0.189

A `---` line separates lanes whatever the line endings. No setting was removed.

- **Fixed: a multi-line `/parallel` prompt pasted on Windows ran as no lanes.**
  The chat input sent CRLF, and a `---` line matched only `\n---\n`:
  reproduced, a 4-lane prompt splits into 4 with LF and 1 with CRLF or CR, and
  one lane is refused. Line endings are normalised before splitting. A `---`
  line may have spaces around it, and a `---` inside backticks or a fence (YAML
  front matter) is text, like `|` and `;;` there. Checks `PL`.

### 0.0.188

`/flow`, safer lane splitting, two rendering fixes, and a gate that stops one
version number from meaning two builds. No setting was removed.

- **`/flow`** (alias `/f`): what a turn did, as a mermaid flowchart — folder,
  model, session, transport, agent, each tool step (repeats merged), handoffs,
  how it ended, and its chips. `/flow 2` the turn before, `/flow all` every
  traced turn since `/new`; `/parallel` draws a box per lane. No model call, no
  process, no request: traces live in memory, last 20 turns of the window. The
  turn's metadata carries only the trace id. Chat draws a ```` ```mermaid ````
  block with VS Code's built-in renderer (`chatMarkdownContentPart.ts` →
  `hasCodeBlockRenderer`, main@4b24360); labels were run through real mermaid
  11 in Chromium (`scripts/probe-mermaid-flow.js`): a `%%{…}%%` directive is
  honoured even inside a quoted label, so `%`, `#`, `"`, `&`, backtick, `<`, `>`
  are entity codes. Checks `FL`.
- **Lanes split on `|`, `;;` or a `---` line only.** `||` (a shell OR) and `::`
  are text — `run npm test || true` is one lane. With no lane cap, a stray split
  is a paid run. Checks `PL`.
- **Fixed: a mark after a backslash became a broken pill.** `\(•‿•)` escapes
  the `(` in CommonMark; a pill there sent an escaped backtick and a stray one.
  It is left as written, and a pill that touches a backtick run is kept apart by a zero-width space, across streamed chunks too. Checks `KB`.
- **Fixed: each unknown lane model cost a catalog fetch.** Three misspelt lanes
  spawned `opencode models --verbose` three times in a row, and Stop could not
  cut them short. One forced fetch per turn, raced against Stop. Check `PL`.
- **Kept from the local review of 0.0.187**: CommonMark fence closing (same
  character, at least the opener's length), backslash-escaped backticks and
  CRLF line endings in the badger; short names for multi-slash ids by last segment or `/`-suffix; one
  forced refetch for an unknown short name.
- **Gate**: `no packaged <version> with other code` — a VSIX of this version in
  `dist/` must hold today's `out/*.js` (a local rebuild of 0.0.187 differed in
  four modules under the same number); `every chat command is documented in the
  readme`.
- Version history left the source comments; README, AGENTS and this file are
  shorter.

### 0.0.187

Kaomoji marks finally render as badges, models show by name, each `/parallel` lane can run on its own model, and every command has a short alias. One setting was removed: `parallelMaxLanes`.

- **Kaomoji marks are inline-code pills.** Correction to 0.0.182–0.0.186: the `<span>` badges never rendered.
- **Models by name.** The catalog keeps each model's name and provider, as OpenCode shows them: `Tundra (Model-1, Code generation & refactors)` from Acme, not only…
- **Short model names.** `model:tundra`, and `m:tundra` in a lane: one match or a refusal naming the candidates.
- **`/parallel`: a model per lane, or one task on several models.**
- **Removed: `parallelMaxLanes`, and with it every lane cap.** Every lane you write runs.
- **Aliases for every command** (`/p` `/d` `/pl` `/n` `/s` `/x` `/m` `/w` `/e` `/h` `/?`), plus your own in the new `commandAliases` setting.
- From the review of the local changes: a follow-up chip with nothing to send is left out and logged, never thrown (a throw cost the turn every chip), and…

### 0.0.186

`@opencode` in inline chat (Ctrl+I), and the kaomoji badges are coloured again. No command or setting was removed.

- **Inline chat.** A second participant, also `@opencode`, is offered only in the editor's inline chat.
- **Fixed: kaomoji badges lost their colour in 0.0.185.** Its badge style was wrapped in `{…}`, which VS Code's sanitizer drops whole, so every mark rendered as plain text.

### 0.0.185

Read-only turns can run as an agent of your own, no turn waits on a prompt nobody can answer, and a turn runs on the model you chose — or, visibly, OpenCode's. No command or setting was removed.

- **`planAgent`** (new, default `plan`): plan turns and read-only `/parallel` lanes run as the agent you name — such as the `look` agent in the README, which is read-only…
- **No turn waits on a prompt nobody can answer.** When OpenCode asks during a plan turn on the server (a read outside the folder, a `.env`, a repeated call), the bridge…
- **Fixed: the idle cap never fired on the server transport.** OpenCode sends `server.heartbeat` to every client about every 10 s, and the bridge counted it as the run's…
- **Fixed: compaction used the wrong model.** With no pin it summarized with the catalog's first entry — `opencode/big-pickle` where this was measured, for a session on…
- **Fixed: a timeout handoff stuck.** OpenCode keeps a session on the model it was last sent (measured), so with no pin one stall moved the session to the fallback for…
- **Fixed: Set Default Model wrote into the repo.** It always wrote Workspace settings (`.vscode/settings.json`).
- `/model` and `/session` name the model that answered when the server names it (a cold CLI run never does); `/model` without a pin says what OpenCode does, with the…
- From Jan's review: `WT1` compares real paths (Windows 8.3 short names), and `.opencode/` is ignored by git and left out of the package.
- A `planAgent` confirmed by `opencode agent list` is re-checked after 60s, as a server's is (was 10 min: a deleted agent would have run as `build`).

### 0.0.184

Stop stops, the quick button asks instead of sending, a long tool is visible while it runs, and the brevity experiment is gone. No command or setting was removed; the prompt tail and the chip labels are back to Jan's.

- **Fixed: Stop left a spinner running.** VS Code drops everything a participant sends after Stop (`chatServiceImpl.ts`), and a progress task that never settles keeps…
- **Fixed: a slow abort could cost the thread its session.** After Stop the host waits one second for the turn, then closes the stream and keeps no result. 0.0.183 waited…
- **Fixed: Stop did not stop `/parallel` lanes or `/worktree` on the server.**
- **A long tool is visible.** An attached run reports a tool before its input exists; 0.0.183 dropped that report, so a 40 s `sleep` showed nothing until it ended.
- **Fixed: Quick Actions → Ask OpenCode sent a prompt.** It (and **OpenCode: Ask in Chat**) filled in "Continue from where you stopped…" and submitted it, so every click…
- **Removed: the concise-vs-sharp experiment** , including its probe script, its npm script and its notes.
- Removed: the inline file links after an answer.
- The suite now checks rendering against a model of the real host: chunks dropped after Stop, the one-second close, task rows gated on the header's ack.

### 0.0.183

Follow-ups that read like the next thing you'd say — or nothing — and a real directory bug found while measuring. No command or setting was removed.

- **Fixed: a CLI run could work in the wrong folder.** `opencode run` resolves its directory from `$PWD` before its spawn directory (1.18.32), and the bridge passed only…
- **Natural follow-ups.** Chips under a finished answer are what the agent itself offered or asked at its end — "Want me to draft a plan for any of these — e.g.
- **Recovery chips** only after a failure or a stop: Try again, Pick up where it stopped, Start fresh (a long session timed out), Check the connection (OpenCode…
- Prompt tail changed to `Be concise.` (back to `Be short & sharp.` in 0.0.184).
- **Grouped progress, reviewed against VS Code's renderer.** Live tool and thought lines are plain again, so they shimmer and fade as the next group or the answer arrives…
- **`withBadges` survives a class-instance stream** (0.0.182 copied `Object.keys()` and would have lost every method).
- README "How it behaves" still showed `⏹️`; fixed.

### 0.0.182

Progress that reads like Copilot's, and marks you can spot. No command, setting or default was removed; two settings were added, both on by default.

- **Thoughts are accordions.** Each reasoning sentence becomes a collapsible header; the tool steps that followed it are its rows (`(´-ω-) Let me look at the key changes…
- **Spinner lines settle in place.** "Connecting to the OpenCode server…" and "Starting the OpenCode … session" spin, then turn into a done line with the time taken — no…
- **Kaomoji badges.** Marks in the reply body (folder, new chat, stopped, warnings, `/ping`) sit on the theme's badge colour.
- How: `progress(title, task)` — a stable runtime overload with no proposed-API gate (only the stable `.d.ts` omits it); a task that reports rows renders as a collapsible…
- Settings: `groupProgress` (off = one line per step), `kaomojiBadges`.
- Checks `GP` (grouping, settling, dedupe, cap, opt-out) and `KB` (badge style vs the sanitizer regex, `supportHtml`, plain progress, opt-out).

### 0.0.181

Kaomoji, one JSON, short & sharp. No command, setting or default was removed.

- **Every emoji is a kaomoji.** Chat, progress, `/ping`, `/env`, the debug log: `(•‿•)` ok, `(×﹏×)` failed, `(°ロ°)` warning, `(-ω-)zZ` went quiet, `(・ω・)ノ` stopped.
- **`src/followups.json`** : every prompt a chip or handoff sends, every chip (kaomoji, label, prompt key, command), which chips each outcome gets (`cases`), and the marks.
- **The vague-prompt gate guards a session's first message only.**
- **Faster decisions** : follow-ups are an outcome `switch` over `cases`, the answer-aware chips a `[chip, agent, test]` rule table, a numbered plan is one regex pass…
- Checks `KM` (no emoji rendered anywhere in the suite, markdown-safe marks, no prompt text left in code) and `VG`; chip checks now compare against the shipped JSON labels.

### 0.0.180

One action, one place — and the turn does less before the model sees it. No command, setting or default was removed.

- **No duplicate follow-ups.** A clarified prompt showed "Run it anyway" as a button and a chip; a failed turn offered Retry three times (button, chip, toast).
- **Every chip names its command** , the clarify chip included (a sticky `/dev` turn kept its kind only by luck).
- **A one-word prompt with an attachment runs.** `fix` with a selected function is a task; the vague-prompt gate now skips any turn with references (`FV`).
- **One health check per server turn** (was two — `chat.ts` and `runs.ts` each asked; `FW` counts the requests on the wire).
- **`pre-run:` log line** per turn — server / session / busy-check milliseconds, so speed work starts from numbers.
- Status bar: `$(code)` instead of `$(snake)`, "N turns" instead of a bare number, and a name in the status bar's hide menu.
- Keyboard shortcuts: `Ctrl/Cmd+Alt+O` opens `@opencode `, add `Shift` for `@opencode /dev `.

### 0.0.179

Review release: a red gate fixed at its cause, two test-only survivors of the v165 removal resolved, and the harness surface pruned to what the suite reads. No commands, settings or defaults changed.

- **The ship gate was red on 0.0.178's tree.** `media/command.svg` was rebranded to the blue tile after release and failed `HA …currentColor glyph`.
- **Session ids are sanitised where they cross a boundary.** `safeSessionId` lost its only caller when v165 stopped writing transcripts, while five URL sites…
- **`escapeHtml` removed.** Dead since v165 removed the HTML briefing; `BB` now asserts it stays gone.
- **`__test` carries only what the harness reads.** 12 keys (and their imports) were re-exported to nobody; `MA` fails on any unread key.
- **`deactivate()` really runs last in the suite.** It sat mid-file, so the `KA`–`LB` groups ran turns against a torn-down extension.
- `package-lock.json` version synced (it still said 0.0.171).

### 0.0.178

Cooperative by default, isolated by command — and every isolation claim is now backed by code the ship gate can point at.

- **`/worktree <task>`** runs the editing agent in a new git worktree + branch (`<repo>.worktrees/<slug>`, `ai/<slug>`) next to the repo, from your `HEAD`.
- **`/plan`** is listed with the commands (registered in v176).
- **Parallel scripts fixed:** `start-parallel-agents.sh` is executable again (it shipped as mode 644 — `Permission denied`); both scripts run `opencode run --agent build…
- **README no longer promises what nothing implements.** `git diff main...ai/opencode` printed nothing — the agents do not commit.
- **Claim guard.** Every `<!-- claim:… -->` tag in the README must have a matching `claim:…` comment in `src/` or `scripts/`, or the ship gate fails.

### 0.0.177

Chat turns no longer crawl behind runs nobody is watching, and long MCP/tool calls are not killed for being quiet.

- **Stopping the client now stops the run.** Measured on opencode 1.18.32: killing a `run --attach` client leaves the server-side run going (`/session/status` stays…
- **A busy session is stopped before a new message is sent** (`busySessionPolicy`, default `abort`; `queue` keeps the old behaviour).
- **`/stop`** stops a run still going on the server — closing a chat or reloading a window never did.
- **Liveness comes from the server session, not from CLI stdout.**
- **No handoff while a tool is running.** Another model cannot make a Jira call faster; the log says so instead.
- **Attached runs create their session up front** , so liveness follows it from the first event.

### 0.0.176

`/dev` stays `/dev`, runs about as fast as plan, follow-ups read the answer, and the progress line stops scrolling.

- **`/dev` attaches to the warm server** (`attachDevToServer`, on by default with `transport: auto`).
- **`/dev` names its agent.** Without `--agent`, OpenCode runs your config's `default_agent`; with `default_agent: "plan"` that was "We're in plan mode — I can't execute…
- **Follow-up chips carry their command, not a text prefix.** Copilot keeps the previous command sticky, so a chip whose text began with `/dev` showed as `/dev /dev …`,…
- **`/plan` is registered.** It was in `/help` and the runtime table since v168 but not in the manifest, so there was no way out of a sticky `/dev`.
- **Answer-aware follow-ups.** "Go with your recommendation", "Do step 1 only", "Review the changes" (plan), "Run the tests" (dev), "Apply it now".
- **`/new` is one line** : which session was closed, and that the next message starts from zero. "Open a new chat" is still one click.
- **The progress line no longer scrolls.** The elapsed readout only speaks into silence, at 3/10/30/60/120s…: a 60s silent start is 5 lines, not 24.
- **The thought line shows where the reasoning got to** , not its opening "The user said…", at most once per 5s.
- **Autocompaction runs in the background** with 180s instead of holding a finished answer open for 30s and then timing out.
- **CLI events after Stop are logged as late** , not dumped raw as "bad JSON".
- **`scripts/mac-setup.sh`** (repo only, not shipped): `install` the newest `.vsix`, `doctor` (VS Code CLI, `opencode`, the Dock-launched PATH, port, logs),…

### 0.0.175

Validated the v0.0.174 fixes and tightened configuration drift checks.

- Removed the unused `liveSessionGraceMinutes` setting while retaining the in-memory live-session tracker.
- Added a release gate that catches settings declared in `package.json` but no longer read by the extension.
- Clarified that vague-prompt handling applies to a single bare word.

### 0.0.174

Lighter config: the adaptive wall-clock strategy is gone.

- **`timeoutStrategy`, `maxTimeoutMs` and `buildTimeoutMultiplier` are removed.**

### 0.0.173

Follow-up chips reworked, `/new` tells the truth, and the readme stopped shipping its own history.

- **Follow-up chips.** "Retry" and "Continue" used to carry the *identical* prompt — two pills, one behaviour, implying a choice that did not exist.
- **`/new` no longer overstates itself.** It resets the OpenCode session; it cannot clear the Copilot thread you are looking at, and Copilot keeps replaying those turns…
- **The readme is a reference, not an archive.** The full release history lives in `CHANGELOG.md` in the repository, which does not ship.
- **`media/activitybar-clear.svg` removed** — referenced by nothing: no `viewsContainers`, no code.

### 0.0.172

Crash-safety on the spawn and stream error paths, a ship-gate false alarm, and a third of the installed size removed. No settings, commands or defaults changed.

- **The ship gate reported a failure that was not one.** `verify-chat-output.js` ended with `process.exit()`.
- **`killTree` could take the window down on Windows.** The `taskkill` spawn is wrapped in `try/catch`, but `spawn` reports failure asynchronously on the child, not as a…
- **Same class, `opencode serve`.** A spawn failure that is not `ENOENT` (`EACCES`, `EAGAIN`, `EMFILE`) surfaces asynchronously on `serveProcess`, which had no `error`…
- **Response-stream errors on the three HTTP helpers.** A socket that drops *after* the headers arrive emits on the response, not on the request.
- **`metrics.stderr` is bounded at 256 KB, head-first.** 0.0.167 removed the 4 KB tail because it dropped the part of a trace that names the cause; that was right, but…
- **`opencode serve`'s log output is decoded with `setEncoding`**
- **A failed `opencode serve` start now says why.** An asynchronous spawn failure leaves `exitCode = -errno`, so the startup poll threw `OpenCode server process exited…
- **The stderr cap announces itself once** in the output channel when it is reached, so a truncated trace is never silently truncated.
- **Installed size: 222 KB → 193 KB.** The readme ships inside the `.vsix` and is installed on every machine, and two thirds of it was release history nobody reads from…

### 0.0.171

Stream-decoding correctness, bounded spawns, and a visible icon. No settings, commands or defaults changed — every fix is behaviour-preserving on the happy path.

- **Multi-byte output is no longer corrupted.** Every stdout/stderr and HTTP response stream is now decoded with `setEncoding("utf8")` instead of calling `.toString()` on…
- **`opencode models` is bounded.** The catalog spawn had no timeout, so a gateway that accepted and never answered hung everything that awaits it — `/ping`, `/diagnose`,…
- **A dropped SSE socket can no longer take down the extension host.**
- **The server transport always releases its subscription.** `sse.close()` moved into a `finally`, so a throw while walking the response parts can no longer leak a…
- **CLI tool steps show the final detail.** `applyServerPart` already replaced a tool's detail when a later event carried a fuller input; the CLI path kept the first,…
- **A failed `/parallel` lane reports its real elapsed time** , not the configured cap — which with `timeoutMs` at its `0` default was `0.0s` — and carries its error…
- **Icons.** `media/icon.png` was a black mark on transparency, so it was invisible on the dark marketplace card and in dark themes.
- Dead `attemptsRun` counter and a stray `void state` removed; `chat.iconPath` no longer builds its URI from a segment with a leading slash.

### 0.0.170

Dev-experience polish on the same single chat surface.

- **Smart follow-up chips.** The v169 `followupProvider` now keys off whether this turn actually has a session, not just its kind.
- **Failed runs raise an error notification.** `notifyIfSlow` splits its output: a timeout or hard error fires `showErrorMessage` (with a one-click `Retry`) even when the…
- **No more `/plan` redundancy.** `/plan <task>` is the default agent, so it now behaves exactly like `<task>` instead of sending the stray `/plan ` into the task…
- **Long runs are no longer cut off needing a manual restart.**
- Dead `liveGraceMs()` removed (exported but never called, in code or the suite).

### 0.0.169

Three chat-surface refinements, all on the critical chat path.

- **`response.anchor` jump links.** Files the agent touches now render as inline clickable anchors in the answer body, beside the existing bottom "used references" chips…
- **Context-aware follow-up chips.** A `followupProvider` returns host-rendered follow-ups keyed on the turn's metadata: `Continue`/`Session`/`New session` after a normal…
- **Slash-command drift guard.** The control-command table is now a single source (`SLASH_COMMANDS`) that also derives the typed-`/word` regex, and the suite (`LB`)…
- Verification suite grew to 301 checks.

### 0.0.168

One chat surface, not a tooling zoo. v168 deleted the secondary surfaces that were reachable but off the chat-critical path. `plan` and `dev` are the only agents now.

- **Live View removed.** The webview panel (`openLiveView`, `liveViewHtml`), the `showLiveView` setting, the `opencodeCopilotBridge.liveView` command, and its palette…
- **Bench removed.** `/bench`, the **OpenCode: Measure Which Model Is Best** command, and the parallel model race (`benchmarkModels`/`raceModelsInChat`) are gone.
- **Manual `/compact` removed.** Autocompaction is untouched — `autoCompact` and `autoCompactEveryTurns` still summarize the session on schedule.
- **`/build` and `/research` aliases removed.** `/dev` is the editing agent, `/plan` the read-only one; the aliases had no behaviour of their own and are gone.
- Verification suite grew to 293 checks; the Live View webview checks were deleted and the shared-SSE-socket check (`JD`) now runs two concurrent server-transport turns.

### 0.0.167

Three removals, one theme: stop the bridge from cutting a run short or cutting its output down.

- **The wall-clock timeout no longer blocks a long task.** `opencodeCopilotBridge.timeoutMs` now defaults to `0` — no wall clock at all.
- **Captured output is no longer clipped.** stderr was kept as a 4 KB *tail*, which dropped the head of a trace — the part that names the cause — in exactly the case…
- **The event-schema drift detector is gone.** 0.0.150 shipped a hardcoded allow-list of 25 OpenCode event names, a `globalState` tally of anything outside it, and three…

### 0.0.166

- Removed the unused `/usage`, `/handoff`, and `/sessions` surfaces plus their dead implementation and test code.
- Removed obsolete briefing, transcript, usage, and follow-up files from the extension source and package surface.
- Verified the cleanup with the full headless suite and prepared the VSIX under `dist/`.

### 0.0.165

Four subsystems were removed so a chat turn is the coding path and nothing else. The unused commands, settings, source chunks, and legacy test blocks are no longer shipped.

- **Nothing is written into your workspace.** The markdown transcript, the HTML briefing, the `.turns.json` sidecar, `index.json`/`index.md` and the self-ignoring…
- **Chat is the answer plus the file chips.** Working list, `🤓` metrics footer, compact status line, context-size warning, handoff notice and follow-up chips are off.
- **Usage and spend tracking are off.** No recording, no budgets, no status-bar percentage, no `/usage` table, no spend in Diagnose.
- **The unparsed-output safety net is gone.** `rawStdout` was accumulated with a 256 KB string copy *per unrecognised line* — quadratic in a run that speaks a dialect the…
- **What deliberately stayed:** `timedOut`, `stderr`, `exitCode` and `hadOutput` on `RunMetrics` (they drive the handoff retry and the v153 stale-session recovery —…
- **Coverage lost, stated plainly:** the CLI/server step-dedup guard (`JF`) read its step count out of the metrics footer.
- **Not claimed:** no end-to-end turn speedup is quoted here.

### 0.0.164

Two defects in boundedness, an engine-floor correction, and a shipped-dark capability.

- **Retention no longer disables itself.** The "session this window drove" set was add-only, so a window that touched 60 chat threads protected 60 sessions forever and…
- **The turn-store cache evicts.** It was a `Map` that only grew; now a capped LRU (16 stores), cleared on teardown.
- **The Quick Actions title-bar button is gated.** It sat in every editor's title bar with no `when` clause.
- **Virtual workspaces declared unsupported** (`capabilities.virtualWorkspaces`), because the extension spawns a local binary and writes session files.
- **Engine floor raised to `^1.104.0`** (and `@types/vscode` with it).
- The ship gate now enforces documentation: the readme must name the current version, every command, and every setting, or `npm run ship` fails.

### 0.0.163

Performance and structure, no user-visible behaviour changes:

- One refcounted SSE subscription per server instead of one per chat.
- The briefing sidecar became append-only NDJSON behind an in-memory cache.
- CLI step dedup keys on `part.id`, like the server path already did.
- The server turn resolves on the SSE `"connected"` signal (with the old 80 ms kept only as the bound).
- Per-delta reasoning/text output-channel lines are gated behind `debugLog`.

### 0.0.162

- Progress inflation fixed: a reasoning delta no longer forces a step render; the backoff ladder is actually consulted now.
- Cross-session SSE leakage fixed: a `text`/`reasoning` part not attributed to this session is dropped instead of streamed into the reply.
- The marketplace "Repository"/"homepage"/"bugs" fields were removed — they pointed at an internal host that redirected to employer SSO.
- A stale-session restart keeps its session bytes, so the context warning stopped warning about hundreds of KB a new session did not hold.

### 0.0.156

- `httpPostJson` finally got the timeout `httpGetJson` had since 0.0.147.
- The per-turn transcript is now appended, not read-modify-written whole.
- The briefing `.html` is rendered on open from the `.turns.json` sidecar, not re-rendered after every turn.
- The usage write (debounced) is flushed in `deactivate()`, so closing a window right after a run no longer loses that run's cost.
- Untrusted workspaces can no longer name the spawned executable or the host it reaches (`capabilities.untrustedWorkspaces.supported: "limited"`).

### 0.0.155

The reported defect: **a new Copilot chat continued the previous OpenCode conversation.**

- **Sessions are now scoped to the chat thread, not the folder.**
- **Retention no longer deletes a conversation you still have open.**
- **OpenCode: New Session told the truth again.** It cleared the folder pointer, which under thread scope does nothing to the chat in front of you.
- `/session` says whether a session belongs to this chat, `/sessions` marks the ones open elsewhere, and `/env` reports the scope in effect.
- New setting: `sessionScope` (`thread` default, `workspace` restores the old folder-wide sharing).
- Verification suite grew from 250 to 281 checks.

### 0.0.153

Two defects that only show up in real use: one when you open a second repository, one when a remembered session disappears.

- **One shared server ran every workspace in the wrong directory.**
- **A stale session ID broke the workspace permanently.** The ID is stored per workspace and outlives OpenCode's storage.
- `/ping` reports how many sessions the shared server holds **for this workspace**, which is also a live check that the scoping is arriving.
- `repository`, `homepage` and `bugs` metadata added, so the packaged extension links back to its source.
- Verification suite grew from 232 to 250 checks.

### 0.0.152

Restored every release-gate fix the 0.0.151 drop had reverted, and fixed a non-hermetic check it shipped.

- **`@types/vscode` was back at `^1.136.0`** against `engines.vscode ^1.90.0`, which `vsce` hard-rejects — 0.0.151 could not be packaged at all.
- **The ship gate reported that rejection as a network outage**
- **The verify step could never run on Windows** — `shell: false` had been dropped, so `process.execPath` was split at the space in `C:\Program Files\nodejs\node.exe`.
- **`DA an empty workspace discovers nothing` was not hermetic.**
- The `CK` idle-timeout checks, deleted in 0.0.151 while the fix they guard was kept, are back.

### 0.0.151

Review pass over the `fallbackModels` handoff path. Three defects, all mine, all in accounting rather than behaviour — the handoff *worked*, it just lied about what it cost.

- **A timed-out attempt's spend was discarded.** `metrics` is reassigned on every attempt, so when a run timed out and handed off, the first attempt's tokens and cost…
- **Per-model usage credited the wrong model.** `recordUsage(metrics, model, …)` used the *configured* model, so a run that timed out on A and answered on B was billed…
- **The handoff chain was unbounded.** Every entry is a full run at the full timeout, so six fallbacks under a 180s cap allowed a thirty-minute turn.
- **Handoffs are now disclosed in the reply.** Previously you saw one answer and were billed for two runs with nothing in chat to say so.
- New setting: `maxHandoffAttempts`.
- Verification suite grew from 219 to 228 checks.

### 0.0.150

Awareness of OpenCode's own extension surface, defence against schema drift, and the 0.0.149 idle fixes carried forward.

- New command: `/env`.
- Verification suite grew from 197 to 219 checks.

### 0.0.148

Fixes the "`@opencode` returns nothing" report, plus adaptive timeouts, Copilot handoff, and session retention.

- **Salvage.** If a run produces no events, its raw stdout is cleaned of ANSI and leading banner lines and shown verbatim, clearly labelled as unparsed.
- **`/ping`** — connectivity check that calls no model: executable resolution, version, server health, model catalog tier, and the timeout policy in force.
- **Adaptive timeouts.** `timeoutMs` is the read-only baseline; `buildTimeoutMultiplier` (3x) sizes editing runs and `maxTimeoutMs` bounds them.
- **Clarification.** A bare single word gets a clarifying reply and a "Run it anyway" button instead of a wasted run; sending the same prompt again always runs it.
- **`/handoff`** — a paste-ready context block (question, files touched, where it got to, transcript path) so Copilot can continue without the OpenCode session.
- **`/sessions` and session retention.** Sessions are listed with sizes and retention status; `sessionRetentionDays` (30) and `sessionMaxCount` (50) prune automatically a…
- New settings: `timeoutStrategy`, `idleTimeoutMs`, `maxTimeoutMs`, `buildTimeoutMultiplier`, `clarifyVaguePrompts`, `sessionRetentionDays`, `sessionMaxCount`,…
- Verification suite grew from 159 to 197 checks, including a direct reproduction of the reported failure.

### 0.0.147

Response to the v0.0.145 review. Ship discipline, the Windows shim fix, and five defects closed.

- **Ship gate** — `npm run ship`.
- **`npm run probe:windows`** — measures PATH resolution, sibling scan, shim contents, and a hostile-payload argv round trip.
- **Windows shim fix** ported and covered: `readShimTarget`, `tokenizeCmdLine`, `expandShimVar`, `prefixArgs` through `spawnOpenCode`.
- **Five defects closed** — session-id path traversal, `escapeHtml` attribute escaping, `httpGetJson` timeout, `timeoutMs` default drift (code said 90s, package.json said…
- **Regression tripwires** for `textContent` over `innerHTML`, nonce CSP, `enableScripts: false`, optional-chained VS Code APIs, `taskkill /T`, immediate `stdin` close,…
- `AGENTS.md` rewritten with the rules, the open-defect table, and the assertion style that catches boundary bugs.
- Verification suite grew from 125 to 159 checks.

### 0.0.146

Aligned with **VS Code 1.136** (released 2 September 2026). That release has no Extension Authoring section and no deprecations, so nothing here was broken by it — but three of its features exposed real gaps.

- **Multi-root workspaces.** 1.136 gave agent sessions multi-root support; this extension had eleven hard-coded `workspaceFolders[0]` lookups.
- **Run notifications.** Mirrors 1.136's `chat.notifyWindowOnResponseReceived`: runs over `notifyAfterMs` notify when the window is unfocused, never when it is focused,…
- **Per-model usage.** Matches the per-model chat usage tracking 1.135 added.
- **Session index.** `index.md` in the session directory, in the spirit of 1.136's readable breadcrumbs for session files.
- **`engines.vscode` raised from `^1.85.0` to `^1.90.0`.** This is a correction, not a feature: `chatParticipants[].commands` and `followupProvider` have been used since…
- New settings: `notifyOnCompletion`, `notifyAfterMs`, `writeSessionIndex`.
- Verification suite grew from 104 to 125 checks.

### 0.0.145

Two ideas worth borrowing from `ltmoerdani/opencode-copilot-chat`, adapted to a local OpenCode instead of a hosted gateway.

- **Usage tracking.** Cost, tokens, cache reads, and run counts recorded per run and rolled up over session / today / rolling 5h / 7d / 30d.
- **Tiered model catalog.** live → cached → stale → configured, with the tier named in the picker and in diagnostics.
- **Diagnostics Runtime section.** Host, trust, platform, ComSpec, PATH size, catalog tier, usage rollup.
- New settings: `showUsageStatusBar`, `usageBudget.session`, `usageBudget.daily`, `usageBudget.rolling5h`, `usageBudget.weekly`, `usageBudget.monthly`,…
- New commands: **OpenCode: Show Usage**, **OpenCode: Refresh Model Catalog**.
- Verification suite grew from 83 to 104 checks.

### 0.0.14

Fixes two bugs visible in real use, cuts chat noise, and adds parallel lanes.

- **Fixed: the raw context block printed into chat.** Copilot silently adds its own instruction-file references (`.github/copilot-instructions.md`, `AGENTS.md`,…
- **Fixed: `$(codicon)` syntax rendered literally in follow-up labels.**
- **`chatDensity`** — `minimal` / `compact` (new default) / `full` (the 0.0.13 layout).
- **`/parallel a | b | c`** — concurrent lanes in isolated sessions, read-only by default, capped by `parallelMaxLanes`.
- **Self-ignoring session directory** (`autoIgnoreSessionDir`, default on).
- New settings: `chatDensity`, `autoIgnoreSessionDir`, `parallelMaxLanes`, `parallelAllowWrite`.
- Verification suite grew from 59 to 83 checks.

### 0.0.13

Additive only — no behaviour from 0.0.12 was removed or changed by default.

- **Slash commands.** `/plan /dev /parallel /session /new /model /help` registered in `contributes.chatParticipants[].commands`, so VS Code autocompletes them.
- **Attached context.** `request.references` become a `<workspace-context>` block in the prompt plus clickable chat references.
- **Heartbeat progress.** The progress line reports elapsed time against the cap instead of freezing between events.
- **Cancellation.** Announced, partial output kept, transcript written, not reported as a timeout.
- **Dead-end recovery.** Retry / Show log / Diagnose buttons on timeout, error, and spawn failure.
- **Follow-ups.** Up to three contextual one-click suggestions per reply.
- **Multi-turn briefing.** The HTML briefing previously kept only the most recent turn and overwrote itself; it now accumulates every turn behind a `.turns.json` sidecar,…
- **Status bar + `OpenCode: Diagnose`.**
- **Session totals.** Cumulative tokens, cost, and tool bytes reported by `/session`; cache-hit rate added to the chat footer.
- **`session.error`** from the SSE stream is surfaced instead of swallowed.
- New settings: `includeChatReferences`, `includeEditorSelection`, `progressHeartbeatMs`, `workingListMax`, `followups`, `statusBar`.
- Verification suite grew from 31 to 59 checks; all 31 original assertions still pass unchanged.
