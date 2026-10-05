# opencode-copilot-bridge

Run OpenCode as `@opencode` inside Copilot Chat. It works **cooperatively** in
the checkout you already have open; isolation into a Git worktree is opt-in.

1. **The VS Code extension** — a chat participant that streams an ongoing
   OpenCode session into Copilot Chat.
2. **`scripts/start-parallel-agents.*`** — one worktree + branch per agent
   (OpenCode and Copilot) from the same commit, for a side-by-side comparison.

Requires Git, OpenCode installed and authenticated (`opencode` on `PATH`), and
VS Code with GitHub Copilot Chat.

## The extension

```bash
npm install && npm run compile
code --extensionDevelopmentPath .
```

Pick `@opencode` in Copilot Chat and describe a task. Every message continues
**one OpenCode session per chat thread**.

```text
@opencode Inspect the login flow and find the cause of the redirect bug.
@opencode Now compare that with the signup flow.
@opencode /dev Implement the fix we discussed and run the tests.
```

The default agent is the read-only **plan** agent, or a stricter one of your
own via `planAgent` (see [Read-only turns](#read-only-turns-planagent-and-look)).

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
| `/new` | Fresh OpenCode session, with a button for a fresh chat |
| `/model` | The model chain, with a button to change it |
| `/ping` | Connectivity check — no model call, no cost |
| `/env` | What OpenCode loaded: config, plugins, hooks, MCP, skills |
| `/help` | This table, in chat |

Inline prefixes mean the same: `plan:`, `dev:`, `par:` / `parallel:`, and
`model:provider/id` for one turn. A slash command wins over a prefix.

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

**Aliases.** `/p` parallel · `/d` dev · `/pl` plan · `/n` new · `/s` session ·
`/x` stop · `/m` model · `/w` worktree · `/e` env · `/ls` sessions ·
`/h` `/?` help,
plus your own in `commandAliases` (`{ "zg": "parallel" }`). Typed, not in the
`/` menu; a real command wins; an alias to a non-command is refused.
<!-- claim:command-aliases -->

Attached files (`#file:`, drag-and-drop, **Add context**) go as context and come
back as clickable references, with every file the agent touched. The editor
selection is opt-in (`includeEditorSelection`).

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
  thought; finished thoughts fold into accordions (`groupProgress`).
- **Files open on click** <!-- claim:file-links -->: a workspace file the answer
  names in inline code (`src/cart.ts:42`) becomes a pill that opens it at that
  line; an accordion row that read or edited one file opens it too.
- **Follow-ups are the answer's own next moves**: what the agent offered or
  asked ("Which do you prefer: Postgres or MySQL?"), a step 1, the file it
  edited — else none. Recovery chips appear only after a failure or a stop.
- **Two transports**: `plan` over a warm `opencode serve` (SSE), `dev` as
  `opencode run --auto` attached to it. Every call is scoped with `?directory=`.
- **Sessions are per chat thread**; a timed-out turn can hand off to the next
  model, in the same session. Long conversations compact themselves.
- **The model is yours or OpenCode's**: a pin is sent every turn; with none,
  OpenCode keeps a session on the model it last ran.
- **Windows**: a sibling `opencode.exe` is preferred over the `.cmd` shim, else
  the line is hand-quoted; a kill reaps the process tree.

Tool, timing and error detail goes to **OpenCode: Show Debug Log**, never into
the chat body.

## Read-only turns: `planAgent` and `look`

OpenCode's built-in `plan` is read-only by instruction, not permission: on
1.18.32 it may run any shell command and hand work to a subagent. For turns
that must not change anything, use an agent whose permissions enforce it:

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
  bash:
    "*": deny
    "ls": allow
    "ls *": allow
    "pwd": allow
    "cat *": allow
    "head *": allow
    "wc *": allow
    "grep *": allow
    "rg *": allow
    "find *": allow
    "git status": allow
    "git status *": allow
    "git show *": allow
    "git log *": allow
    "git diff *": allow
    "git rev-parse *": allow
    "git branch": allow
    "git branch --list*": allow
    "find *-delete*": deny
    "find *-exec*": deny
    "find *-ok*": deny
    "find *-fprint*": deny
    "find *-fls*": deny
    "rg *--pre*": deny
    "git * --output*": deny
    "*>*": deny
---

You inspect. You never change anything.
Use read, grep, glob and list first; bash only for the allowed inspect commands.
No redirects, no subagents, no network.
If a change is needed, write the plan in chat and stop.
```

Held all 10 write attempts of a real model on OpenCode 1.18.32 (redirects,
`find -fprint`, `git log --output`, a `task` subagent, `sed -i` via `xargs`,
`.env`). Read-only, not secret-proof: `cat` can print a file `read` refuses.

Verify: `opencode agent list` shows `look (primary)`; restart the server after
editing it (a running server reads agents once). The debug log shows
`agent=look` or `--agent look`, and a fallback logs `planAgent "look" not usable`.

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

## Commands

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
| `executable` | `opencode` | OpenCode executable name or absolute path. |
| `pure` | `false` | Run with `--pure` (no external MCP plugins) for a faster cold start. |
| `devAgent` | `build` | Agent `/dev` runs, always passed as `--agent`. |
| `planAgent` | `plan` | Agent for read-only turns and `/parallel` lanes, used once OpenCode lists it (see *Read-only turns*). |
| `attachDevToServer` | `true` | With transport `auto`, `/dev` attaches to the warm server instead of booting OpenCode per turn. |
| `toolQuietMs` | `600000` | How long a tool the server reports as running may stay silent. 0 = `idleTimeoutMs`. |
| `busySessionPolicy` | `abort` | A session still busy with an unwatched run: `abort` it first, or `queue` behind it. |
| `transport` | `auto` | `auto`: server for plan, attached CLI for dev. `cli` or `server` for all. |
| `serverStartupPollMs` | `350` | Longest gap between health polls while `opencode serve` starts. |
| `serverHostname` | `127.0.0.1` | Host of the managed `opencode serve`. |
| `serverPort` | `4096` | Port of the managed `opencode serve`; a healthy server there is reused. |
| `timeoutMs` | `0` | Wall-clock cap per run, ms. 0 = none; `idleTimeoutMs` stops hung runs. |
| `idleTimeoutMs` | `300000` | Stop a run after this long with no output, ms. 0 disables it. |
| `model` | — | `provider/id` sent every turn. Empty: OpenCode picks. |
| `fallbackModels` | `[]` | Models to hand off to, in order, when a run times out (same session). |
| `modelCatalogTtlMinutes` | `360` | How long the fetched model list stays fresh. 0 = always fetch. |
| `maxHandoffAttempts` | `3` | Most models tried in one turn; each attempt is billed. |
| `includeChatReferences` | `true` | Send attached files as context and show them as references. |
| `includeEditorSelection` | `false` | Also send the editor selection. |
| `progressHeartbeatMs` | `1000` | How often the progress line re-renders. 0 = on events only. |
| `groupProgress` | `true` | Fold finished thoughts and their steps into accordions above the answer. |
| `kaomojiBadges` | `true` | Show kaomoji marks as inline-code pills (never inside code). |
| `commandAliases` | `{}` | Your own `/` aliases on top of the built-in ones, e.g. `{ "zg": "parallel" }`. |
| `statusBar` | `true` | Status bar item with the session and turn count. |
| `showThoughtProcess` | `true` | Stream OpenCode's reasoning (`--thinking`) on the progress line. |
| `clarifyVaguePrompts` | `true` | Ask before spending a run on a bare one-word first message. |
| `autoCompact` | `true` | Summarize the session every `autoCompactEveryTurns` turns. |
| `autoCompactEveryTurns` | `8` | Turns between compactions. 0 = OpenCode's own only. |
| `editorTitleButton` | `true` | Quick Actions button in the editor title bar. |
| `sessionScope` | `thread` | `thread`: one session per chat. `workspace`: one per folder. |
| `parallelAllowWrite` | `false` | Let `/parallel` lanes edit (concurrent writers can collide). |
| `worktreeDiffMaxMB` | `16` | Largest diff `/worktree` reads, MB. |
| `debugLog` | `false` | Log every reasoning and text delta (it accumulates for the window's life). |
| `notifyOnCompletion` | `true` | Notify when a slow run finishes and the window is not focused. |
| `notifyAfterMs` | `30000` | Only for runs at least this long, ms. 0 = never. |

## Changelog

The last five releases; the full history is `CHANGELOG.md` in the repository.

### 0.0.198

- `/constructor …` and `/__proto__ …` run as tasks; they were refused as
  broken aliases.
- `/help` lists itself and names the session scope you set.
- The ship gate fails on a tracked file that `.gitignore` names, and checks its
  no-git file walk against git on every run.

### 0.0.197

- **`/help` lists every command**, `/ping` and `/env` included.
- The repo stops tracking `.vscode/settings.json`: a model picked in this
  repo went into it. Picks go to User settings.
- Dead code removed (a write-only session tracker, unused parameters, a stale
  Diagnose row); four checks that asserted nothing assert again.

### 0.0.196

- **Removed `/flow`** (and `/f`); typed from habit, it runs nothing.
- **`/parallel` lanes get your attachments** — `#file:` reached no lane before.
- The ship gate scans every file for internal names even without git, and
  checks the lock file's version.

### 0.0.195

Review fixes for `/parallel`: with `transport: server` the lanes attach to the
warm server instead of running cold, and Stop no longer waits out a cold server
boot.

### 0.0.194

- **Files open on click**: a workspace file the answer names in inline code
  (`src/cart.ts:42`) is a pill that opens it at that line; an accordion row
  that read or edited one file opens it too.
