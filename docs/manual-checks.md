# Manual checks after installing a VSIX

`npm run ship` proves behaviour against fake OpenCode binaries. These checks
cover what it cannot: the real host, a real OpenCode, a real model. Record each
as PASS, FAIL, INCONCLUSIVE (the model did not do what was asked) or NOT
OBSERVED — an unobserved condition is never a pass.

## Setup

1. **Extensions: Install from VSIX…** → `dist/opencode-copilot-bridge-<version>.vsix`,
   reload, and confirm the version in Extensions.
2. A trusted, disposable Git repository with OpenCode configured and a model
   available (`/dev` checks edit files).
3. **View › Output › OpenCode**, kept visible. Record the VS Code, Node, Git and
   OpenCode versions (`opencode --version`).
4. Start from `transport: auto`, `prewarmServer: true`, `attachDevToServer: true`;
   note what you change and restore it afterwards.

## Core

1. **Connectivity and continuity.** `@opencode /ping` is healthy, its version
   row ✓. `Remember this test label: BRIDGE-CHECK. Reply briefly.`, then
   `What test label did I ask you to remember?` → `BRIDGE-CHECK`; `/session`
   shows the session.
2. **Prewarm.** Reload, wait a few seconds: the log says `prewarming the
   OpenCode server`. A prompt sent mid-boot joins that start (one `serve`
   spawn) and says it is starting. A first boot can take most of a minute.
3. **Streaming, server path.** `transport: server`, a new chat:
   `Explain how HTTP caching works in 12 short numbered paragraphs.` Text
   arrives while the turn runs; nothing is repeated when the final part lands.
4. **Streaming, attached `/dev`.** `transport: auto`: `/dev Explain how HTTP
   caching works in 12 short numbered paragraphs. Do not edit files or run
   commands.` The log shows an attached run; text streams; no repeats.
5. **Stop.** Stop a long answer after text or tools appear: nothing arrives
   later and nothing keeps spinning; Continue is offered. Stop before anything
   was sent (a cold server helps): Retry resends your words, not Continue.
6. **Compaction.** `/compact` in a chat with history: one summary pass, no
   hidden agent turn. A message sent while a background summary runs waits for
   it, and Stop still cancels that wait.

## Context filter

Ask for controlled output with harmless markers, on `transport: server` and
again on `auto` with `/dev`. If the model alters the text, record INCONCLUSIVE.

1. `Output exactly the following raw text, with no code fence or explanation:
   BEGIN-C <workspace-context>FIRST</workspace-context><workspace-context>SECOND</workspace-context> END-C`
   → `BEGIN-C` and `END-C` visible; the tags, `FIRST` and `SECOND` never shown,
   not even while streaming.
2. `Output exactly … and stop immediately after UNCLOSED: BEGIN-C <workspace-context>UNCLOSED`
   → `BEGIN-C` visible; the opener and `UNCLOSED` never shown.
3. `Output exactly this raw text and nothing else: BEGIN-C <workspace-` → the
   partial opener stays visible.
4. A literal sentence with inline code — ``Wrap it in a `<workspace-context>` tag.``
   — stays whole; so does a fenced XML example.
5. Inline chat (Ctrl+I) with a selection, then with only a cursor: no context
   preamble in the answer.

## gitScan

**Copilot:** the MCP server list shows gitScan; in agent chat its output
matches `git status` (branch, HEAD, upstream, XY), with at most 40 file rows
and the omitted count. `gitScan: false` removes it; an untrusted window has
none until trust is granted; a host without the MCP provider API still
activates `@opencode`.

**OpenCode:** **OpenCode: gitScan config for opencode.json** copies a snippet
(`node`, a global-storage `git-scan-server.js`, the first folder). Merge its
`mcp.git-scan` entry, restart OpenCode, reload the window: git-scan is
connected. Without that entry `/env` shows the guidance (with `gitScan` on).

## Recovery (only when it happens)

- Rate limit, quota, refused key, unknown model → Retry and **Pick model**.
- Provider backoff → `Provider retry N · next in Ns` on the live line.
- A tool silent past `toolQuietMs` → **Skip it** and Continue.
- An answer cut at the output limit → the cut-off note and **Finish it** first.
- A CLI run that exits with an error → its first stderr error line, the debug
  log button, and chips that fit it.

## This release: 0.0.219

Use a real model; a turn whose model does not try the command is INCONCLUSIVE.
New in 0.0.219 (A–D), then 0.0.217/0.0.218's attachments (E), never observed
in a real VS Code yet, then the read-only checks that still apply (1–10).

A. **A reopened MCP tool refuses the turn.** In the repo's `opencode.json` add
   `"agent": { "plan": { "permission": { "*": "allow", "github_*": "allow" } } }`
   (any MCP server you have; the name only has to match). Restart the server
   (reload the window). A plan turn: nothing runs, the chat says "Nothing was
   sent: OpenCode's configuration gives `plan` back … `github_*: allow`"
   with Retry; Output › OpenCode logs `plan: read-only rules reopened by config
   on … — not sent`. `/dev` still runs. Remove the key → plan turns run again.
B. **The same on the CLI.** `transport: "cli"`, same key: the same refusal, after
   one `$ … opencode agent list` in the log. A second plan turn does not list
   again; edit `opencode.json` (any change) → the next turn lists again.
C. **Task to general.** `"plan": { "permission": { "*": "allow", "task": { "*":
   "deny", "general": "allow" } } }` with `transport: "cli"` → refused, naming
   `task general: allow`. On the server transport the turn runs (the session's
   task rules come last) — and `general` never starts.
D. **A custom planAgent.** `planAgent: "look"` (README recipe): plan turns run,
   no warning, no `read-only by permission now` note. Add `"github_*": "allow"`
   to look's permission and restart: the turn runs and says once that its own
   rules allow `github_*: allow`.
E. **Attachments (0.0.217/0.0.218).** Record what your VS Code sends (Output ›
   OpenCode `references (N): …`): an unsaved file (the prompt carries its
   buffer), a line range of an open file (the slice), an untitled editor, and
   `#problems`. An unsaved `.env` on a plan turn: "Text of `.env` not sent: a
   read-only turn keeps `.env` files out"; on `/dev` it is sent.

1. **Plan turns cannot write.** `Run this exact shell command and nothing else:
   echo hi > ro-check.txt` → no `ro-check.txt` (`git status` clean); the answer
   says a rule prevented it. The same with `/dev` → the file exists (delete it).
2. **Inspection still runs.** Read README and search for a symbol; use gitScan
   for Git status. The model's offered tools must omit bash/shell.
3. **Explore cannot write.** `Use the task tool with the explore subagent to run
   exactly: echo hi > ro-explore.txt` → no file. If the model says it has no
   such tool, confirm its offered tool list omits shell; refusal without tool
   evidence is INCONCLUSIVE.
4. **The overrides are on the server.** `GET
   http://127.0.0.1:53200/agent?directory=<folder>` (or the port the log names):
    `plan` and `explore` list `{"permission":"ocb-enforced","pattern":"*","action":"deny"}`
    and `{"permission":"bash","pattern":"*","action":"deny"}`. A marker alone proves nothing.
   The log once: `read-only by permission in the processes the bridge starts:
   plan, explore (enforceReadOnly)`.
5. **The one-time note.** The first plan turn after installing ends with
   `Plan turns are read-only by permission now: …`; the next turn, and a new
   window, do not repeat it.
6. **A server you started.** Stop VS Code, run `opencode serve --port 53200` in
   the repo yourself, open VS Code: the first plan turn ends with `The OpenCode
    server at http://127.0.0.1:53200 has no verified shell-free read-only rules
   …`; the log shows `explore: not read-only by permission on … — left out of
   read-only turns`. A plan turn then `/dev` asking a `general` subagent to
   write a file: the file is written (no deny left on the session).
7. **Two windows.** Window A starts the server; open the same repo's sibling in
   window B (same port): B's plan turns show no `no verified shell-free read-only rules` line, and the log
   of B shows one `GET /agent` per minute at most.
8. **gitScan on plan turns** (with the gitScan entry merged): `Use the gitScan
   tool` on a plan turn → its output. Another MCP tool → refused unless
   `readOnlyTools` lists it (e.g. `["git-scan_gitScan", "jira_get*"]`, then
   reload the window).
9. **Attachments.** Attach a screenshot and a file from outside the folder, plan
   turn: before the answer `Not sent to OpenCode: an image …` and ``…` is
   outside this folder: a read-only turn cannot open it (`/dev` can)``. Output ›
   OpenCode: `references (2): kept … (file, outside the folder); dropped …
   image/png (image: not a file)`. Record the ids your VS Code sends (the
    later attachment work can use them).
10. **Windows shim** (from the local agent): repoint `opencode.cmd` at another
    1.x; the next CLI message logs the changed-on-disk line and one `--version`.

## Report

Per case: extension and OpenCode versions, model, transport and the settings
you changed, the exact prompt, expected versus actual, and the log lines. A
short screen recording shows transient streaming output best.
