# References and closed investigations

Findings that cost real time to establish. Each is dated and names what was
actually measured, so nobody re-derives it.

---

## Agent Host Protocol — no third-party harness adapter

**Dated 2026-09-09. Closed. Do not re-investigate.**

The question: can OpenCode be plugged into VS Code's Agent Host as a harness, so
the bridge stops being a chat participant and becomes a first-class backend?

**No.** The provider set is closed and host-internal.

| Want | Available today |
| --- | --- |
| 3P AHP **client** | Yes — official SDKs + AHPX |
| 3P AHP **host** package | No — spec only; the server is VS Code |
| 3P **harness adapter** inside VS Code's Agent Host | **No** |
| Tools / plugins / MCP / persona agents | Yes — but not a new runtime |
| Custom client transport | Yes (`AhpTransport` / `Transport`) |

What was checked:

- The providers are `CopilotAgent` (always), `ClaudeAgent` (default on) and
  `CodexAgent` (default off), registered only via
  `providerService.registerProvider(...)` in `agentHostMain.ts` /
  `agentHostServerMain.ts`.
- There is no `contributes.agentHostAdapter` contribution point.
- There is no `IAgent` in `vscode.d.ts`.
- `agentHostExtensionProtocol.ts` is debug/worktree/trust RPC. It is not an
  adapter surface.
- The proposed `chatSessions` API is extension-host session listing, not AHP.

**Where the earlier error came from — a diagram is not an API.** The architecture
diagram on <https://microsoft.github.io/agent-host-protocol> shows
"Copilot / Claude / Codex / ACP" as agent backends. That is a description of what
the first-party host happens to contain, not an extensibility contract. Verify
against `src/vs/platform/agentHost/**` before believing any claim of
pluggability.

**Consequence.** The session, handoff, retention and briefing machinery in
`extension.ts` is permanent code, not transitional code. It has to be correct,
not merely adequate.

---

## The marketplace repository link was SSO-walled, not merely dead

**Dated 2026-09-09. Fixed in 0.0.162.**

`package.json` shipped
`https://github.com/<employer-org>/opencode-copilot-connect.git` as
`repository.url`, with `homepage` and `bugs` pointing at the same place.

Measured: the URL does **not** 404. It redirects to *"Single sign-on to <employer>
LLC"*. So the rendered "Repository" link was simultaneously useless to everyone
outside the enterprise and an advertisement for the employer.

All three fields were removed — an absent link is honest, a dead one is not. The
ship gate's `LEAKY` scan was widened to the bare org token, and a new check
requires `repository`/`homepage`/`bugs` to be absent or on a public host.

---

## `process.exit()` truncates the ship gate's view of the verify suite

**Dated 2026-09-22. Fixed in 0.0.172.**

`scripts/verify-chat-output.js` ended with `process.exit(failed === 0 ? 0 : 1)`.
When stdout is a **pipe** — which it is whenever `ship-gate.js` spawns it —
`process.stdout.write` is asynchronous and `process.exit` does not drain the
pending writes.

Measured on the same all-green run, same machine, same build:

| stdout is | bytes captured | banner present |
| --- | --- | --- |
| a file (`> verify.out`) | 16,125 | yes |
| a pipe (`spawnSync`, `encoding: "utf8"`) | 9,124 | **no** |
| a pipe, after `process.exitCode` | 16,115 | yes |

The gate greps that capture for `/ALL \d+ CHECKS PASSED/`, so a run where all
305 checks passed was reported as `3/4 verify printed the pass banner: FAIL`,
with `3/4 verify` itself green beside it. The danger was never the red line —
it was that the obvious way to silence it is to delete the check.

`process.exitCode` lets the event loop drain and exit with the same status. It
also means the suite now has to exit on its own: if it ever leaves a handle
open the run hangs instead of exiting 0, which is a better failure than a
silent force-kill.

**Not measured, chosen:** `STDERR_CAP = 256 KB` in `runs.ts` is a bound, not a
finding. No trace was observed anywhere near it; it exists so an unbounded `+=`
cannot grow without limit, and 256 KB is simply far above anything real.

## `opencode run` works in `$PWD`, not the spawn cwd

**Dated 2026-09-27. Fixed in 0.0.183.**

The 1.18.32 binary's `run` handler resolves its directory as
`F = resolve(process.env.PWD ?? process.cwd())` and uses `F` unless `--dir` is
given (the TUI: `U1(D, u = process.env.PWD, F = process.cwd())`). Node's `cwd`
spawn option does not touch `PWD`, so every CLI run inherited the extension
host's — the folder VS Code was launched from.

`scripts/probe-opencode-pwd.js` (no model call — an unresolvable model id makes
`run` log its session directory and exit in ~2.5s), Linux, OpenCode 1.18.32:

| case | spawn cwd | PWD | session directory |
| --- | --- | --- | --- |
| A raw spawn (≤ 0.0.182 shape) | target | stale | **stale** |
| B `spawnOpenCode()` 0.0.183, host PWD stale | target | set by bridge | target |
| C control | target | target | target |
| B with 0.0.182's `out/proc.js` | target | stale (inherited) | **stale** |

With a real model the agent's own `bash pwd` printed the stale folder, and its
edits landed there. Exposure: cold `/dev` runs, the server-unreachable
fallback, a no-server `/worktree`, cold `/parallel` lanes — whenever `PWD` is
set and differs from the chosen folder (`code ~/proj` launched from `$HOME`,
multi-root, Git Bash on Windows where `PWD=/c/Users/…`). Attached and server
runs pass `--dir` / `?directory=` and were never affected. WT1 checked the
fake's `process.cwd()` and passed throughout; checks `PW` and `WT1 …PWD` read
the `PWD` the fake received.

## OpenCode keys projects by root commit; one data dir serialises CLI runs

**Dated 2026-09-27. Measured on 1.18.32; nothing to fix in the bridge.**

- Project id = the repo's root-commit hash (`project.id` in `opencode.db`).
  Plain copies of one repo (`cp -r` with `.git`) became one project, and runs
  in later copies resolved into the first's world. A `git worktree` is
  registered as the project's `sandboxes` entry: a relative `write` from a run
  in the worktree landed in the worktree, main checkout clean. `/worktree` and
  `start-parallel-agents.*` isolation holds.
- Six concurrent `opencode run`s on one model and one data dir completed ~45s
  apart; three with separate `XDG_DATA_HOME`s finished together in 11s. The
  lock is `opencode.db`, not the provider. Attached lanes share one server
  process and are not affected.

## What VS Code does after Stop (and why 0.0.182–0.0.183 kept spinning)

**Dated 2026-09-28. Fixed in 0.0.184.** Source: microsoft/vscode main@75f204b.

- `chatServiceImpl.ts` `progressCallback` returns early once the request's
  token is cancelled: every chunk sent after Stop is dropped.
- `chatModel.ts` `cancel()` settles tool invocations, plan reviews and question
  carousels — not progress tasks. `chatTaskContentPart.ts` renders a task with
  no rows and `!isSettled` with a spinner and keeps that part while its
  settledness is unchanged: a task open at Stop spins until the view re-renders.
- `extHostChatAgents2.ts` `$invokeAgent` races the handler against Stop +
  1000ms, then `stream.close()`: every later `markdown()`/`progress()`/`button()`
  throws "Response stream has been closed". `chatServiceImpl.ts` then keeps no
  result (`token.isCancellationRequested && !rawResult → return`), so the turn's
  metadata — the session id the next message continues — is lost too.

Reproduced end to end with the real CLI (OpenCode 1.18.32, the free
`opencode/nemotron-3-ultra-free` model, managed server, attached `/dev`) and a
model of the host above (the suite's `hostStream()`):

| build | Stop at | after Stop | task left spinning |
| --- | --- | --- | --- |
| 0.0.183 `/dev`, model still thinking | 12.1s | returned 348ms | "Starting the OpenCode dev session…" |
| 0.0.183 `/dev`, mid-tool | 14.9s | 197ms | the open thought group |
| 0.0.183 plan (server transport) | 9.0s | 313ms | "Starting the OpenCode plan session…" |
| 0.0.184 `/dev`, mid-tool | 29.0s | 6ms | none |
| 0.0.184 plan | 9.0s | 4ms | none |

In every case the server run itself was aborted (status idle, no client left);
what kept moving was the spinner. With a server slow to answer the abort (the
suite's `SP` fake: 3s), 0.0.183 returned after the one-second close, so its
result was dropped and its late writes threw into the error path.

The same runs showed the attached-CLI gap: a tool is reported `pending` before
its input exists. 0.0.183 dropped that report, so a `sleep 40` produced no line
for 40 s. 0.0.181 showed `bash: running · 12s` and a ticker; 0.0.184 shows
`bash: sleep 40 && echo finished · 6s` → `· 10s` → `· 30s` → `· 47s`.

## Grok and follow-up suggestions

**Dated 2026-09-26.** Every published version of xAI's Grok prompts
(github.com/xai-org/grok-prompts, through 2025-11-17) was searched: none asks
the model to suggest follow-up questions. The "suggest 2-3 follow-up questions"
line quoted online comes from an unofficial gist. Grok 3's brevity rule:
"You provide the shortest answer you can, while respecting any stated length
and comprehensiveness preferences of the user." Hence 0.0.183: chips come from
the answer or not at all.

## Read-only turns: `planAgent`, `look.md`, and prompts nobody can answer

**Dated 2026-09-28. Shipped in 0.0.185.** OpenCode 1.18.32, real server and
CLI, free `opencode/nemotron-3-ultra-free` model; probes in the session notes.

**An unknown agent is not an error on the CLI.** `opencode run --agent ghost
--auto "…"` printed `agent "ghost" not found. Falling back to default agent`
on stderr, exited 0, and the session's messages say `agent: build` — a
read-only turn with a typo would have edited. A subagent name falls back the
same way. `POST /session/:id/message` with `agent: "ghost"` answers HTTP 500
"Unexpected server error"; the `session.error` event carries `Agent not
found: "ghost". Available agents: build, explore, general, look, plan`.

**Where to ask instead.** `GET /agent?directory=` lists the loaded agents
(`name`, `mode`, `hidden`, `permission` rules in order); `opencode agent list`
prints `name (mode)` plus the rules as JSON: 1.4s, or 14s the first time in a
fresh config dir (it installs OpenCode's plugin SDK there). A running server
builds the list once per directory: an edited `look.md` showed the old rules
5s later and the new ones only after `POST /instance/dispose?directory=`.

**The built-in `plan` is read-only by instruction.** Its rules: `* allow`,
`edit` denied except `.opencode/plans/*.md`, `question` and `plan_exit` allowed,
`task` denied for `general` only, asks for `external_directory`, `*.env` reads
and `doom_loop`. Any bash command runs.

**Two `look.md` drafts against 10 real write attempts** (one session each, the
model told to run the command; `git status` in the repo after each):

| attempt | draft 1: bash allow-list | draft 2: `"*": deny` + redirects denied |
| --- | --- | --- |
| `cat a.txt > r1.txt` | **written** (matches `cat *`) | refused; `tee`, `cp`, `echo >` also refused |
| `cat a.txt >> r2.txt` | **written** | refused |
| `ls $(touch r3.txt)` | refused (each command is checked) | refused |
| `git status; touch r4.txt` | refused | refused |
| `find . -name a.txt -fprint r5.txt` | **written** | refused |
| write tool | not offered (`edit: deny`) | not offered |
| `task` → `general` subagent | **written** by the subagent | tool not offered |
| `git log -1 --output=r8.txt` | refused, then `git log -1 > r8.txt` **written** | both refused |
| `… \| xargs sed -i` | refused | refused |
| read `.env` | asked (hangs headless), then `cat .env` printed it | read refused; bash `cat` is not stopped |

A command's matched text includes its redirect (`redirected_statement`), so a
trailing `"*>*": deny` catches `>`, `>>` and `2>`.

**Prompts nobody can answer.** On the server path the bridge is the only
client:

| probe | result |
| --- | --- |
| plan turn, model calls `question` | waited 45s, until aborted |
| same, session created with `question`/`plan_enter`/`plan_exit` denied (what `opencode run` does) | tool not offered; answered in text, 10.7s |
| same, bridge answers the question "ask in your reply" | tool completes; the model asks in its reply, 20.6s |
| plan turn reads `/etc/hostname` (`external_directory` ask) | waited 45s, until aborted |
| same, reply `reject` | turn ends with no answer (3.9s): `PermissionRejectedError` breaks the loop |
| same, reply `reject` with a message | the model is told why and carries on (30.7s): `PermissionCorrectedError` |

The attached CLI answers permission asks itself (`--auto`: `once`; without:
`reject`) and tracks subagent sessions by `session.created` → `parentID`; it
never answers a question.

## Which model answers a turn

**Dated 2026-09-28. Shipped in 0.0.185.** OpenCode 1.18.32, `POST
/session/:id/message`, three turns per session:

| sent | answered by |
| --- | --- |
| turn 1 `nemotron-3.5-lightning-free`, turn 2 no model | turn 2: lightning (sticky) |
| turn 1 lightning, turn 2 `nemotron-3-ultra-free`, turn 3 no model | turn 3: ultra |
| fresh session, no model | `github-copilot/claude-sonnet-4.6` (OpenCode's default here) |

The prompt handler resolves `input.model ?? agent.model ?? sessionModel`,
where the session row's `model` moves with every explicit model (and the
newest user message's model backs it up); `Provider.defaultModel()` —
`config.model`, then the recent list, then the first provider — applies only to
a session that never had one. `GET /config/providers` returns a default PER
PROVIDER, and `opencode models` listed `opencode/big-pickle` first, so the
bridge's old compaction fallback (`catalog.models[0]`) would summarize a
claude-sonnet session with big-pickle. The CLI's `--format json` stream names
no model at all (`step_start`, `text`, `step_finish` only); the server's
response `info` and `message.updated` events (`{ sessionID, info }`) do.
`GET /session/:id/message?limit=N` returns the session's LAST N messages,
oldest first (an 8-message session: `limit=2` gave messages 7 and 8), so the
bridge reads them from the end.

## `server.heartbeat` kept the server-path idle cap from firing

**Dated 2026-09-28. Fixed in 0.0.185.** OpenCode 1.18.32's `/global/event`
sends `{"type":"server.heartbeat","properties":{}}` about every 10s (3 in a
35s capture of an idle server) — no session id. The bridge's shared SSE demux
hands unattributed, non-content events to every subscriber, and the server
transport treated everything it received as its own run's activity. Real
runs, `transport: server`, `/dev`, "run `sleep 120 && echo done`",
`idleTimeoutMs` 30000:

| build | outcome |
| --- | --- |
| 0.0.184 | ran to completion: 142.9s |
| 0.0.185 | "went quiet for the whole idle window and was stopped after 40.6s" |

The same 0.0.184 build, on a plan turn blocked on an `external_directory` ask
with `idleTimeoutMs` 60000, was still waiting at 150s when the probe killed it.
The attached-CLI listener had filtered by session id since v177; the server
path now does too, and gives a tool it reports as running `toolQuietMs`: the
packaged 0.0.185 with `toolQuietMs` 45000 stopped the same `sleep 120` at
57.7s, naming `bash`; 0.0.184 ran it for 141.3s. The server answers the
bridge's own abort with `session.error` `MessageAbortedError`, which 0.0.185
no longer reports as OpenCode's error.

## Badges: chat's KaTeX `style` rule replaces the span rule

Measured 2026-09-29 against microsoft/vscode main, sanitizer run in Chromium.
`chatMarkdownContentPart.ts` renders with
`MarkedKatexSupport.getSanitizerOptions(…)`, which appends KaTeX's own `style`
predicate; `domSanitize.ts` keeps one predicate per attribute name, so it
replaces the span rule. KaTeX allows no `background-color`, no `border-radius`,
and a colour only as a bare word — `#4daafc` arrives as `rgb(77, 170, 252)` and
fails. Every `<span style>` badge of 0.0.182–0.0.186 rendered as `style=""`, and
each `supportHtml` part refused to merge with its neighbours. Since 0.0.187
marks are inline-code pills. In CommonMark `\(` escapes the `(` and a pill
touching another backtick run fuses the runs, so the badger skips an escaped
mark and puts a zero-width space between a pill and a backtick (0.0.188).

## Mermaid in chat (from `/flow`, removed in 0.0.196)

Chat draws a ```` ```mermaid ```` block from any participant through the
built-in `mermaid-markdown-features` renderer (microsoft/vscode main@4b24360).
Mermaid takes `%%{…}%%` inside a quoted label as a directive and rejects
`[""]`; label escaping and the Chromium probe are in git at `23ef0f2`
(`src/flow.ts`, `scripts/probe-mermaid-flow.js`).

## OpenCode's session store over HTTP (1.18.33)

Read from `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`
and `src/session/session.ts` at tag v1.18.33 (2026-09-30):

- `GET /session?directory=&roots=true&limit=` — sorted by most recently updated;
  archived sessions are excluded (`isNull(time_archived)` unless `archived`);
  `roots` drops subagent children.
- `GET /session/:id/message?limit=N` — the newest N, paged with a `before`
  cursor. `DELETE /session/:id` — removes it and its messages, returns `true`.
- `PATCH /session/:id` — `title`, `metadata`, `permission`, `time.archived`:
  archiving is how OpenCode "closes" a session.
- `POST /session/:id/fork` — empty body forks the whole session; `messageID`
  forks up to that message. The copy gets the messages and metadata, **not the
  permission rules** — the bridge PATCHes its headless rules back.

## Chats vanish from the sessions list while they run (investigated, not ours)

Reported 2026-09-30: with several chats working, a running chat drops out of the
Chat sessions list and comes back when it finishes.

- The bridge runs no chat command during a turn: `workbench.action.chat.open` is
  called only from a toast's **Open Chat** (on click), the composer and New
  session (user actions). Checked with `grep executeCommand src/*.ts`.
- The list is VS Code's (microsoft/vscode main@4b24360):
  `localAgentSessionsController.ts` shows loaded chat models ∪ stored index
  entries not loaded (`chatServiceImpl.ts` `getLiveSessionItems` /
  `getHistorySessionItems`), hiding a loaded model without requests. The compact
  list shows pinned + the top 3 (`CAPPED_SESSIONS_LIMIT = 3`), the rest under
  **More**; the date groups place a chat by `lastRequestEnded ?? created`, so a
  running chat whose last turn ended on an earlier day sits in that day's group
  until it finishes, then jumps to Today.
- Unmeasured which of these Jan sees. To tell: reproduce with two plain Copilot
  chats (no `@opencode`) — if they vanish too, it is the host. Pinning a chat
  keeps it visible in the compact list. **Developer: Set Log Level → Trace**
  then the Window log shows `Disposing chat session …` if a model is unloaded.

---

## A `node.cmd` ahead of `node.exe` on PATH sends every fake through cmd.exe

**Dated 2026-10-02. Environment, not product.** Six suite checks (J, JC, FV,
IL) failed on every run: each one sends a multi-line prompt. Cause: `npx node@22`
run inside the repo installed the `node` npm package as a dependency, so
`node_modules/.bin/node.cmd` came first on PATH under `npm run`. The fakes'
shim reads `node "<file>" %*`; `readShimTarget` resolved `node` to that
`node.cmd`, correctly refused to chain into a second shim, and fell back to
cmd.exe, which cuts the prompt at its first newline (§7). After removing the
package, the suite printed `ALL 766 CHECKS PASSED` on Node 20.6.1 and on Node
22.23.2. Never run `npx node@…` in this folder. In production this needs a
shim whose head is `node` and a `node.cmd` earlier on PATH: unmeasured, and
rare.

## `@vscode/vsce` 4 needs Node 22; the gate's fallback list was wrong

**Dated 2026-10-02. Fixed in the gate.** `vsce ls` on Node 20.6.1 died with
`util.styleText is not a function` (vsce 4.0.0 declares `engines.node >= 22`),
so the gate used `simulatePackageList`. That listed 69 files, `dist/*.vsix` and
`.vscode/*` among them: `toRe` turned `**` into `(.*/)?` and then rewrote that
group's own `*` and `?`. With placeholders, the simulation matches `vsce ls`
(Node 22) file for file: 34 = 34. Use Node 22 for the gate.

## File links in chat: anchor parts, not empty-text links (VS Code 1.139.1)

**Dated 2026-10-02. Read from the installed `workbench.desktop.main.js`
(1.139.1, 04c0d99).** Three ways a participant can make a file clickable:

- **A reference row** `{ variableName, value: uri | Location }`: the list
  renders the file's basename with `#<variableName>` as its description and
  opens `value` on click (with the Location's range). Without `value` the row
  is a plain label. Used for accordion rows that name one file.
- **An empty-text markdown link** `[](file:///…)`: becomes an inline file
  pill, but its click passes `editorOptions.selection = undefined`, which is
  spread over the selection the opener parsed from `#L42`: the line is lost.
  A link with text stays an ordinary link.
- **`response.anchor(Location)`** (an `inlineReference` part): merged into the
  preceding markdown part as a link (`http://_vscodecontentref_`), so it sits in
  the sentence; the pill reads `cart.ts:42` and opens at the line. The answer's
  file pills use this. (0.0.184 removed anchors only because they were called
  unbound; `chatStream` calls every method on the stream.)
