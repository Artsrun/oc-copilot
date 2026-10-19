# opencode-copilot-bridge

Run OpenCode as `@opencode` inside Copilot Chat. It works **cooperatively** in
the checkout you already have open; isolation into a Git worktree is opt-in.

1. **The VS Code extension** — a chat participant that streams an ongoing
   OpenCode session into Copilot Chat.
2. **`scripts/start-parallel-agents.*`** — one worktree + branch per agent
   (OpenCode and Copilot) from the same commit, for a side-by-side comparison.

Requires Git, OpenCode 1.x installed and authenticated (`opencode` on `PATH`,
or the `executable` setting), and VS Code with GitHub Copilot Chat. OpenCode 2
is not driven yet — see [OpenCode 2](#opencode-2) to keep both.

## The extension

```bash
npm install && npm run compile
code --extensionDevelopmentPath .
```

Pick `@opencode` in Copilot Chat and describe a task. Every message continues
**one OpenCode session per chat thread** — or one per folder, if you set
`sessionScope` to `workspace`.

```text
@opencode Inspect the login flow and find the cause of the redirect bug.
@opencode Now compare that with the signup flow.
@opencode /dev Implement the fix we discussed and run the tests.
```

The default agent is the read-only **plan** agent — read-only by permission in
every OpenCode process the bridge starts — or a stricter one of your own via
`planAgent` (see [Read-only turns](#read-only-turns-enforced-planagent-and-look)).

### Inline chat (Ctrl+I)  <!-- claim:inline-participant -->

Ctrl+I (Cmd+I) in an editor, then `@opencode`. The selection goes with the
prompt — or the file and cursor line — so `fix` is enough. Each inline widget
keeps its own session; `/plan` `/dev` `/stop` `/session` `/new` `/help` are
offered there. `/dev` edits the file on disk; there is no inline diff.

It needs the `chatParticipantAdditions` proposal. Run **Preferences: Configure
Runtime Arguments**, add this to `argv.json`, restart:

```jsonc
"enable-proposed-api": ["local.opencode-copilot-bridge"]
```

Without it the panel `@opencode` works as before, and the Extension Host log
says `CANNOT USE these API proposals` — the inline entry left out, not a failure.

### Slash commands

| Command | What it does |
| --- | --- |
| `/dev <task>` | Editing agent — may write files |
| `/plan <task>` | Read-only agent (the default): `plan`, or your `planAgent` |
| `/parallel a \| b \| c` | Independent read-only lanes at once, in isolated sessions — `/parallel` alone composes them step by step |
| `/worktree <task>` | Editing agent in a NEW git worktree + branch; your checkout is untouched <!-- claim:worktree-command --> |
| `/session` | Session id, turns, tokens and cost |
| `/sessions` | This folder's sessions: continue, fork, close or delete one |
| `/stop` | Stop a run still going on the server (closing the chat does not) |
| `/compact` | Summarise this chat's session now (one model pass), as autocompact does |
| `/new` | Fresh OpenCode session, with a button for a fresh chat |
| `/model` | The model chain, with a button to change it |
| `/ping` | Connectivity check — no model call, no cost |
| `/env` | What OpenCode loaded: config, plugins, hooks, MCP, skills |
| `/help` | This table, in chat |

Inline prefixes mean the same: `plan:`, `dev:`, `par:` / `parallel:`, and
`model:provider/id` for one turn. A slash command wins over a prefix.

**Effort.** `effort:high` (or `e:high`) in front of a message sends OpenCode's
reasoning-effort variant for that turn (`--variant` on the CLI, `variant` on
the server); the `effort` setting does it for every turn. The levels are the
model's own (`low`, `medium`, `high`, `xhigh`, `max`…, shown in the model
picker). OpenCode ignores a level the model lacks without a word, so the bridge
checks the catalog first: `effort:` is refused before anything runs, the setting
runs at the model's default with a note, and each `/parallel` lane is checked
against its own model. <!-- claim:effort -->

**Short model names.** `model:tundra` is the one listed model whose id or name
is `tundra` (any case), or starts with it (3+ letters). Two matches or none: the
turn is refused and says which. A full `provider/model` is sent as typed.
<!-- claim:model-names -->

**A model per lane.** `/parallel m:tundra review auth | m:oasis read the logs`
runs each lane on its own model. `/parallel models:tundra,oasis,aspen review auth`
runs **one** task on each model, with time and cost per lane. There is no lane
cap, and every lane is a paid run, so lanes split only on `|`, `;;` or a `---`
line (any line ending): `||` (a shell OR) is text, and so is anything inside
backticks or a table row. <!-- claim:parallel-models -->

**An agent per lane.** `/parallel a:look m:oasis read the logs | review auth`
runs that lane as your primary agent `look`. The name is checked against
OpenCode's own list first: an unknown, subagent-mode or hidden agent is refused
before anything runs, because `opencode run` would run it as `build`, which
edits. An `a:` lane runs with that agent's own permissions. <!-- claim:lane-agents -->

**Aliases.** `/p` parallel · `/d` dev · `/pl` plan · `/n` new · `/s` session ·
`/x` stop · `/m` model · `/w` worktree · `/e` env · `/ls` sessions ·
`/h` `/?` help,
plus your own in `commandAliases` (`{ "zg": "parallel" }`). Typed, not in the
`/` menu; a real command wins; an alias to a non-command is refused.
<!-- claim:command-aliases -->

Attached files (`#file:`, drag-and-drop, **Add context**) go as context, by path
(OpenCode reads them), and come back as clickable references, with every file
the agent touched. The editor selection is opt-in (`includeEditorSelection`).
What OpenCode won't get is said before the answer: an image, Problems, an
unsaved editor, VS Code's current-file chip (once per window), and on a
read-only turn a file outside the folder, which it cannot open (`/dev` can).
Output › OpenCode logs every reference VS Code sent, kept or dropped and why
(`references (3): kept …; dropped …`).

### `/parallel` alone — the lane composer  <!-- claim:parallel-composer -->

Type `/parallel` and send it (or **OpenCode: Compose Parallel Lanes**). A picker
opens per lane: type the task in its box, press Enter for the default model or
pick one from the list, and the next lane's page follows. From two lanes on, a
**Submit** button (and a last item) appears; it inserts the finished
`@opencode /parallel …` command into the chat input — nothing runs until you
press Enter; the reply's **Run lanes** chip sends it as composed. A task
that `|` or `;;` would split is refused on its page; put code in backticks.
Esc discards the lanes.

### `/sessions` — this folder's sessions  <!-- claim:sessions -->

Lists OpenCode's sessions for the folder (newest first, subagent sessions and
archived ones left out; this chat's is marked). Pick one, then:

- **Continue here** — this chat's next message continues it; its last ask and
  answer are shown.
- **Fork into this chat** — a copy (OpenCode's fork) that this chat continues;
  the original is untouched. The copy gets the bridge's headless rules back.
- **Close** — OpenCode's archive: a running turn is stopped, the session leaves
  the list, its messages are kept.
- **Delete…** — permanently, after a confirm.

Closing or deleting this chat's own session starts the chat fresh. Needs
OpenCode's server (started on demand). Debug: the output channel logs
`/sessions: …` with the server's error.

### How it behaves

- **Nothing hangs.** stdin is closed; nobody waits on an answer nobody can
  give. On the CLI `/dev` and the built-in `plan` pass `--auto`; on the server
  the bridge answers OpenCode's asks (`/dev` approves once, read-only turns
  refuse with a note, a question gets "ask in your reply"). A silent run ends
  on `idleTimeoutMs`, a running tool gets `toolQuietMs`; no wall clock by default.
- **Stop stops** — the client and the server run, `/parallel` lanes and
  `/worktree` included. The answer so far and the session are kept.
- **The folder you picked is the folder it edits**: every OpenCode process gets
  it as cwd and `PWD` (`npm run probe:pwd` measures a machine).
- **Progress stays alive**: the live line names the running tool or the latest
  thought; finished thoughts fold into accordions (`groupProgress`). A provider
  backoff (rate limit, overload) is named on it: `Provider retry 2 · next in 8s`.
- **Answers stream as they are written**, on the server and the attached `/dev`
  path alike — not a whole paragraph at a time.
- **The server is up before you ask** <!-- claim:prewarm-server -->: a trusted
  window starts (or adopts) the OpenCode server a few seconds after VS Code
  starts (`prewarmServer`), so the first message does not wait for its boot.
- **Files open on click** <!-- claim:file-links -->: a workspace file the answer
  names in inline code (`src/cart.ts:42`) becomes a pill that opens it at that
  line; an accordion row that read or edited one file opens it too.
- **Follow-ups are the answer's own next moves**: what the agent offered or
  asked ("Which do you prefer: Postgres or MySQL?"), a step 1, the file it
  edited, the tests it said fail, one more look at a higher effort when it
  said it was unsure — else none. Recovery chips appear only after a failure or a stop,
  and fit it: a rate limit or a refused model gets **Pick model**, a hung tool
  **Skip it**, a Stop before anything was sent **Retry** with your words, an
  answer cut at the output limit **Finish it**. A cue chip you pass over three
  times running steps back for a while; the agent's own offers and Resume never
  do. <!-- claim:chip-backoff -->
- **Lanes when they fit** <!-- claim:auto-parallel -->: a plan whose first
  numbered list is 2-5 read-only steps, each naming a file or call, offers
  **Run N as lanes**. With `autoParallel: auto`, a message that is itself such a
  list runs as lanes at once (`plan:` keeps it one turn); `off` stops both.
  A finished `/parallel` offers **Merge lanes** and **Retry failed lanes**.
- **Subagents are named**: a row for OpenCode's `task` tool reads
  `explore: find the auth handlers`, not only the description.
- **Two transports**: `plan` over a warm `opencode serve` (SSE), `dev` as
  `opencode run --auto` attached to it. Every call is scoped with `?directory=`.
- **Sessions are per chat thread**; a timed-out turn can hand off to the next
  model, in the same session. Long conversations compact themselves, sized as
  OpenCode sizes them (the last step's tokens, cache reads in); `/session` shows
  `context 42k of 200k (21%)`. The next message waits for that summary instead
  of stopping it.
- **The model is yours or OpenCode's**: a pin is sent every turn; with none,
  OpenCode keeps a session on the model it last ran.
- **Windows**: a sibling `opencode.exe` is preferred over the `.cmd` shim, else
  the line is hand-quoted; a kill reaps the process tree.
- **A failed run says why**: a CLI run that exits with an error and no answer
  shows the first error line of its stderr (else the exit code), with the
  debug log and chips that fit it.

Tool, timing and error detail goes to **OpenCode: Show Debug Log**, never into
the chat body.

### OpenCode 2  <!-- claim:opencode-1-only -->

OpenCode 2 (`@opencode/cli`, installed as `opencode` too) is a different
program — a new server API, permission format and `run` flags — and the bridge
drives OpenCode 1 only so far. A turn that meets 2.x says so at once and runs
nothing: the server it started answers health with a web page, `run` rejects
`--attach` or `--variant`, or `--version` says `v2` — checked once before the
first CLI run (and lanes, and `/worktree`), and again when the file behind
`executable` changes, as when a 2.x is installed over a 1.x. Its server password
stays out of the log; `/ping` and **Diagnose** mark a 2.x version ✗.

To keep OpenCode 2 and use `@opencode`, give the bridge a 1.x of its own:

```bash
npm i --prefix ~/.opencode1 opencode-ai@1
```

Set `opencodeCopilotBridge.executable` to `~/.opencode1/node_modules/.bin/opencode`
(Windows: `~/.opencode1/node_modules/.bin/opencode.cmd`) and run `/ping`. The
two share OpenCode's data folder — sessions show in both (measured: 1.19.0 and
2.0.27) — and its config files, and OpenCode's migration guide says a config
converted for 2.x is not for 1.x. `…/.bin/opencode auth list` shows whether
the 1.x has your credentials; if not, log it in as your organization says.

## Read-only turns: enforced, `planAgent` and `look`

OpenCode's built-in `plan` is read-only by instruction, not permission: on
1.19.0 and 2.0.29 it runs `echo hi > file`, and the built-in `explore` it may
hand work to runs any shell command. So with `enforceReadOnly` (on by default)
every OpenCode process the bridge starts — its server, a cold `opencode run`,
lanes, `/worktree` — gets read-only rules for `plan` and each
`readOnlySubagents` agent through `OPENCODE_CONFIG_CONTENT`, which OpenCode
merges over your config files (your own agent settings, such as a model, stay):

- no edits and no writing tools;
- no shell: inspection commands can execute writing helpers too;
- reading (`.env` files aside), searching and the web;
- MCP tools only as `readOnlyTools` lists them (default: the bridge's gitScan;
  1.x names them `<server>_<tool>`, e.g. `jira_get*`); on 2.x none, as they run
  inside Code Mode, which can send any request;
- subagents only from `readOnlySubagents`, which get the same rules — in `/dev`
  turns too: `explore` is a search agent.

**Checked where it runs, refused if reopened.** OpenCode merges your config
files into those rules key by key and keeps your file's keys in place, so a
key the bridge does not set — an MCP tool (`"github_*": "allow"`), a custom
tool, `task: { "general": "allow" }` under `agent.plan.permission` — kept its
allow (1.18.35, 1.19.0 measured). So before each read-only turn the bridge
reads the agent's effective rules where the turn runs (`GET /agent` on a
server, `opencode agent list` for a cold run, kept until a config file
changes) and allows nothing beyond the reach above. If a config file gives
something back, nothing is sent: the turn names the rule (`` `w_*: allow` ``)
and offers Retry. Remove the key, ask with `/dev`, or set
`enforceReadOnly: false`. A reopened subagent on a server is left out of
read-only turns instead (the session's rules can withhold it; a cold run
cannot, so there it refuses too).

`/dev` is unchanged: `build` keeps its own rules. Inspection uses read/search
tools and gitScan. The previous shell allowlist let a Git external helper write
on OpenCode 1.18.35; shell removal is checked by `scripts/probe-readonly.js`.
The first verified enforced plan turn says so once. Unverified turns say which
agent or server could not be verified. `enforceReadOnly: false`
restores 0.0.214: read-only by instruction. <!-- claim:enforced-read-only -->

**A server the bridge did not start.** With a fixed `serverPort` (53200 by
default) the bridge reuses an OpenCode server already listening there. If
another window of the bridge started it with the current rules, effective
permissions in `GET /agent` confirm shell removal and deny writing tools; the
marker alone is insufficient, including on older bridge servers. If you started it yourself,
its agents keep their own rules and the bridge cannot change them: read-only
turns there start no subagents, and `plan`'s shell is limited by instruction
only — each unverified turn says so. The bridge does not deny the shell on that
session instead: OpenCode copies a session's deny rules into every subagent it
starts later, so a `/dev` turn's subagents in that chat could no longer edit.
`serverPort: 0` makes each window start its own server, with the rules; `look`
below is read-only on any server.

For a read-only agent of your own — stricter than the rules above (no web, no
subagents) and read-only wherever it runs — use an agent whose permissions
enforce it:

```jsonc
"opencodeCopilotBridge.planAgent": "look"
```

Plan turns and read-only `/parallel` lanes then run as `look`; `/dev` is
unaffected. The bridge first checks OpenCode loaded the agent for the folder
(`GET /agent`, or `opencode agent list`). If not, the turn runs as `plan` and
says so: an unknown `--agent` falls back to OpenCode's default, `build`.

Save as `~/.config/opencode/agents/look.md` (Windows:
`%USERPROFILE%\.config\opencode\agents\look.md`), or `.opencode/agents/look.md`
in a repo (then ignore `.opencode/` in git):

```markdown
---
description: Read-only look. Inspects the repo and never changes it. Headless-safe (deny, never ask).
mode: primary
permission:
  "*": deny
  read:
    "*": allow
    "*.env": deny
    "*.env.*": deny
    "*.env.example": allow
  grep: allow
  glob: allow
  list: allow
  lsp: allow
  skill: allow
  todowrite: allow
  todoread: allow
  bash: deny
---

You inspect. You never change anything.
Use read, grep, glob and list; no shell.
No redirects, no subagents, no network.
If a change is needed, write the plan in chat and stop.
```

The shell is disabled rather than classified by command patterns. These are
tool permissions, not an operating-system sandbox or a confidentiality boundary.

Verify: `opencode agent list` shows `look (primary)`; restart the server after
editing it (a running server reads agents once). The debug log shows
`agent=look` or `--agent look`, and a fallback logs `planAgent "look" not usable`.

**Subagents on read-only turns.** OpenCode runs a subagent with its own
permissions, not the turn's: the built-in `general` has every tool and edits,
and `explore` runs any shell command. So on a read-only turn (plan, read-only
lanes) the session's `task` rules allow only `readOnlySubagents` (default
`["explore"]`) and deny the rest — all of them on a server without the
bridge's rules — and `enforceReadOnly` makes those agents read-only. A `/dev`
turn in the same chat gets back what its own agent allows: OpenCode keeps a
session's rules and the last match wins, so that `/dev` turn re-applies the dev
agent's `task` rules (`GET /agent`) after the read-only ones. This holds on the
server and attached paths (`transport: server`, or `auto` with
`attachDevToServer`); a cold `opencode run` has no session to set rules on, and
there the read-only `plan` itself limits `task`. <!-- claim:read-only-subagents -->

## Isolated work: `/worktree` and the parallel scripts

### `/worktree <task>` (in chat)

Creates `<parent>/<repo>.worktrees/<slug>` on branch `ai/<slug>` from `HEAD`
and runs the editing agent there. It ends with the changed files and buttons:
**Show full diff**, **Open in new window**, **Remove worktree** (asks first;
deletes the branch). The chat's own session stays on your checkout.

### `scripts/start-parallel-agents.(sh|ps1) "task"`  <!-- claim:worktrees -->

```powershell
.\scripts\start-parallel-agents.ps1 -Task "Implement the feature and add tests"
```

```bash
./scripts/start-parallel-agents.sh "Implement the feature and add tests"
```

Creates `../<repo>-opencode` (`ai/opencode`) and `../<repo>-copilot`
(`ai/copilot`) from the same commit, runs `opencode run --agent build --auto`
in the first and opens the second in a new window for Copilot.

Isolation covers tracked files only: nothing is committed, untracked files
(`.env`, `node_modules`) are not copied, ports and OpenCode's session store are
shared. Review a side with
`git -C ../<repo>-opencode add -N . && git -C ../<repo>-opencode diff main`;
clean up with `git worktree remove --force <path> && git branch -D <branch>`.

**macOS**: VS Code from the Dock does not inherit your shell's `PATH`.
`./scripts/mac-setup.sh doctor` shows what it sees, `set-executable` pins
`opencodeCopilotBridge.executable`, `install` installs the newest `dist/*.vsix`.

**Updating** (any OS): a VSIX installed by hand never updates itself.
`node scripts/update.js` installs the newest delivered VSIX into `code` and
`code-insiders` when it is newer than the installed one — only if its sha256
is the one `docs/released.txt` records for its version. `--from <folder>` takes
VSIXes from a shared folder or a download, `--editor code` limits it to one
editor, `--check` reports without installing. Reload the windows afterwards.

## Commands

### gitScan MCP

In a trusted local workspace, the default-on `gitScan` setting exposes the
read-only **gitScan** MCP server to Copilot on hosts with the MCP provider API.
It scans the first workspace folder only. Trust, folder and setting changes
refresh the definitions; an untrusted workspace offers none. <!-- claim:git-scan -->

The `gitScan` tool takes no arguments and returns branch, seven-character HEAD,
upstream, ahead/behind and Git's two-character file status. It lists at most
40 changed files plus `…N more`, quotes filenames (including rename source and
destination), and reads no file contents. Git must be on PATH. Git errors are
tool-result text; each status call has a five-second timeout, disables optional
index locks, overrides repository fsmonitor hooks, blanks every configured
filter driver and does not descend into submodules (commit changes only).

**OpenCode uses its own MCP configuration.** Run **OpenCode: gitScan config for
opencode.json** to copy and print a snippet. Merge its `mcp.git-scan` entry into
your existing `opencode.json`; it uses `node` on PATH and a server copy in the
extension's global storage, so extension updates do not invalidate its path.
The generated command pins the current first folder; rerun it to target another
repository. Quit and restart OpenCode, then reload the bridge window so its
managed server loads the configuration. `/env` offers this guidance when the
configuration has no `git-scan` entry.

`pure` applies `--pure` only to CLI runs, where it hides external MCP servers;
the server transport does not apply that flag. Your OpenCode agent's permissions
still decide whether it may call the tool (the sample `look` agent denies MCP).

### Palette entries

| Palette entry | Command id suffix |
| --- | --- |
| **OpenCode: Set Default Model** | `setModel` |
| **OpenCode: Show Debug Log** | `showLog` |
| **OpenCode: New Session** — a new chat with `@opencode ` typed; the chat you leave keeps its session | `newSession` |
| **OpenCode: Sessions** — sends `@opencode /sessions` | `sessions` |
| **OpenCode: Compose Parallel Lanes** | `composeParallel` |
| New Chat (hidden from the palette; New Session does it) | `newChat` |
| **OpenCode: Diagnose** | `diagnose` |
| **OpenCode: Quick Actions** | `quickActions` |
| Ask in Chat (hidden from the palette since 0.0.190; kept for keybindings) | `retryLast` |
| **OpenCode: Refresh Model Catalog** | `refreshModels` |
| **OpenCode: gitScan config for opencode.json** | `gitScanConfig` |
| **Show Worktree Diff** (button under a `/worktree` reply) | `worktreeDiff` |
| **Open Worktree in New Window** (button) | `worktreeOpen` |
| **Remove Worktree** (button — confirms, deletes the branch) | `worktreeRemove` |

`Ctrl+Alt+O` / `Cmd+Alt+O` opens chat with `@opencode ` (the selection rides
along); add `Shift` for `@opencode /dev `. On some Windows layouts `Ctrl+Alt`
is AltGr — rebind in **Keyboard Shortcuts**.

## Settings

All under `opencodeCopilotBridge.`.

| Setting | Default | What it does |
| --- | --- | --- |
| `executable` | `opencode` | OpenCode executable name or path; `~/` is your home folder. |
| `pure` | `false` | Run with `--pure` (no external MCP plugins) for a faster cold start. |
| `devAgent` | `build` | Agent `/dev` runs, always passed as `--agent`. |
| `planAgent` | `plan` | Agent for read-only turns and `/parallel` lanes, used once OpenCode lists it (see *Read-only turns*). |
| `readOnlySubagents` | `["explore"]` | Literal subagent names a read-only turn may start via `task`; trimmed and deduplicated, `*` and `?` rejected. With `enforceReadOnly` only agents with verified shell-free permissions are available. |
| `enforceReadOnly` | `true` | Read-only turns read-only by permission in every OpenCode process the bridge starts: no edits or shell, `readOnlyTools`, read-only subagents (see *Read-only turns*). `/dev` is unchanged. Off: 0.0.214, read-only by instruction. |
| `readOnlyTools` | `["git-scan_gitScan"]` | With `enforceReadOnly`, the MCP tools a read-only turn may use, by OpenCode permission name (`<server>_<tool>`, wildcards allowed). A name that would allow a tool that writes, runs commands or starts subagents is left out. 1.x only. |
| `attachDevToServer` | `true` | With transport `auto`, `/dev` attaches to the warm server instead of booting OpenCode per turn. |
| `prewarmServer` | `true` | Start (or adopt) the OpenCode server a few seconds after VS Code starts, so the first message does not wait for its boot. Trusted workspaces only. Transport `cli` starts no server; it only checks `--version` (OpenCode 2). |
| `toolQuietMs` | `600000` | How long a tool the server reports as running may stay silent. 0 = `idleTimeoutMs`. |
| `busySessionPolicy` | `abort` | A session still busy with an unwatched run: `abort` it first, or `queue` behind it. |
| `transport` | `auto` | `auto`: server for plan, attached CLI for dev. `cli` or `server` for all. |
| `serverStartupPollMs` | `350` | Longest gap between health polls while `opencode serve` starts. |
| `serverHostname` | `127.0.0.1` | Host of the managed `opencode serve`. |
| `serverPort` | `53200` | Port of the managed `opencode serve`. An OpenCode server already there (its health names a version) is reused; anything else on that port gets one health probe and this window starts its own server. `0` picks a free port for a server this window starts and adopts nothing. |
| `timeoutMs` | `0` | Wall-clock cap per run, ms. 0 = none; `idleTimeoutMs` stops hung runs. |
| `idleTimeoutMs` | `300000` | Stop a run after this long with no output, ms. 0 disables it. |
| `model` | — | `provider/id` sent every turn. Empty: OpenCode picks. |
| `effort` | — | Reasoning effort (an OpenCode variant: `low` … `max`) for every turn. Empty: the model's default. |
| `fallbackModels` | `[]` | Models to hand off to, in order, when a run times out (same session). |
| `modelCatalogTtlMinutes` | `360` | How long the fetched model list stays fresh. 0 = always fetch. |
| `maxHandoffAttempts` | `3` | Most models tried in one turn; each attempt is billed. |
| `includeChatReferences` | `true` | Send attached files as context and show them as references. |
| `includeEditorSelection` | `false` | Also send the editor selection. |
| `gitScan` | `true` | Expose gitScan MCP to Copilot in a trusted local first folder; OpenCode configuration is separate. |
| `progressHeartbeatMs` | `1000` | How often a silent run is checked for its next elapsed-time line (3 s, 10 s, 30 s, 1 min … then every 5 min). 0 = new lines on events only. |
| `groupProgress` | `true` | Fold finished thoughts and their steps into accordions above the answer. |
| `kaomojiBadges` | `true` | Show kaomoji marks as inline-code pills (never inside code). |
| `commandAliases` | `{}` | Your own `/` aliases on top of the built-in ones, e.g. `{ "zg": "parallel" }`. |
| `statusBar` | `true` | Status bar item with the session and turn count. |
| `showThoughtProcess` | `true` | Stream OpenCode's reasoning (`--thinking`) on the progress line. |
| `clarifyVaguePrompts` | `true` | Ask before spending a run on a bare one-word first message. |
| `autoCompact` | `true` | Summarize the session every `autoCompactEveryTurns` turns (once its context is 20k or more), or once its context passes 60k tokens or 70% of the model's window. Off: a **Compact** chip offers it at that size. |
| `autoCompactEveryTurns` | `8` | Turns between compactions. 0 = OpenCode's own only: the bridge summarizes nothing, and offers the **Compact** chip instead. |
| `editorTitleButton` | `true` | Quick Actions button in the editor title bar. |
| `sessionScope` | `thread` | `thread`: one session per chat. `workspace`: one per folder. |
| `autoParallel` | `offer` | `offer`: a lanes-shaped plan gets a **Run N as lanes** chip. `auto`: a message that is such a list runs as lanes. `off`: only typed `/parallel`. |
| `parallelAllowWrite` | `false` | Let `/parallel` lanes edit (concurrent writers can collide). |
| `worktreeDiffMaxMB` | `16` | Largest diff `/worktree` reads, MB. |
| `debugLog` | `false` | Log every reasoning and text delta (it accumulates for the window's life). |
| `notifyOnCompletion` | `true` | Notify when a slow run finishes and the window is not focused. |
| `notifyAfterMs` | `30000` | Only for runs at least this long, ms. 0 = never. |

## Changelog

The last five releases; the full history is `CHANGELOG.md` in the repository.

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

- **Read-only turns are checked on the effective rules, and refused if a config
  file reopened them.** 0.0.217 closed `edit`/`bash`, but any other key in
  `agent.plan.permission` — an MCP tool, `task` to `general` — still kept its
  allow after the bridge's `"*": "deny"`: on 1.18.35 and 1.19.0 an MCP tool and
  `general` wrote on a plan turn, and the bridge said "read-only by permission".
  Now nothing beyond the read-only reach may be allowed; otherwise nothing is
  sent and the turn names the rule. Cold runs check `opencode agent list`
  (cached until a config file changes); servers check `GET /agent`.
- An unsaved `.env` (or `.env.*`) attached to a read-only turn is no longer
  inlined: plan's read refuses it, so the excerpt would have handed it over.
  `/dev` still sends it. An outside file whose excerpt went in is no longer
  called unreadable.
- The answer filter holds a whole echoed excerpt + problems block (it let
  blocks over 64 KB through since 0.0.218).
- A custom `planAgent` that passes gets no "read-only by permission" note (it
  describes the bridge's overrides); one whose rules allow more is told which.
- `scripts/update.js`: install the newest delivered VSIX into `code` and
  `code-insiders` when it is newer, only if its sha256 matches
  `docs/released.txt` (`--from <folder>`, `--check`).

### 0.0.218

- Enforce UTF-8 byte limits on editor excerpts and bound diagnostic text.
- Report omitted unsaved editor text and potentially stale disk contents when no excerpt fits.
- Closed-file ranges remain path-based, avoiding synchronous whole-file reads on the extension host.

### 0.0.217

- **Close config merge-order bypass on enforced read-only agents:** OpenCode deep-merges config objects and keeps earlier keys in place (`opencode.json` with `edit: "allow"` or `bash: { "*": "deny", "git *": "allow" }` after `"*"`). Enforced rules now explicitly set scalar `"deny"` on every writing/running tool (`bash`, `edit`, `write`, `patch`, `apply_patch`, `multiedit`, `shell`, `execute`, `question`, `plan_enter`, `plan_exit`), replacing any earlier pattern map.
- **Attached dirty buffers, line ranges, untitled editors & `#problems`:** unsaved editor buffers, line-range file attachments, open untitled documents, and `#problems` diagnostics are now folded into bounded context sections (`Attached text excerpts:` and `Attached problems:`) and scrubbed by the leak gate.
- **Custom `planAgent` (`look`) & `/parallel` enforcement:** custom read-only agents whose rules deny writing tools are recognized without requiring the bridge's `ocb-enforced` marker; `readOnlySubagents` verifies `task * deny` and excludes primary/dev agents (`build`, `general`); read-only `/parallel` turns surface enforcement notices and deduplicate concurrent `GET /agent` lookups.
- **Server agent cache & release ledger:** `listAgents` cache keys include the server generation; the release gate verifies every delivered VSIX in `dist/` against `docs/released.txt`.

### 0.0.216

- Withhold shell on enforced read-only agents: Git inspection helpers could write.
- Validate literal subagent names and effective server rules; notices follow the actual run.
- Remove accidental docs artifacts and redundant test wrappers.
