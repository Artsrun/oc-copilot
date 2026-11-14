# For a coding agent on the owner's machine

A cloud session can run the gate and the probes on Linux. It cannot package and
install a VSIX into a real VS Code, see a chat render, or run on Windows or
macOS. Those steps are written here for a coding agent working in the owner's
local checkout. "You" is that agent; "the owner" is the person at the keyboard.

To start, the owner says one of:

```text
Read docs/local-agent.md and do task 1 (release).
Read docs/local-agent.md and do task 2 (route measurements).
```

Read `AGENTS.md` first. It outranks this page.

## Rules for both tasks

- `npm run ship` is the only green light (AGENTS §2 rule 2). If a step goes
  red, stop: paste the failing lines as printed and say so. Never edit `src/`,
  `scripts/` or a test to make a check pass.
- Ask before every commit and every push.
- Ask before installing or running third-party code (task 2, part B).
- Work only in this checkout and the OS temp folder. Back up a settings or
  config file before editing it, and restore it at the end.
- Report each command with the lines that matter (version, PASS or FAIL,
  sha256). "Not tested" is a valid result; a guess is not (AGENTS §2 rule 1).
- The owner does the clicking in VS Code and tells you what they see.

The commands below run the same in PowerShell, bash and zsh.

## Task 1: release

Goal: the newest code, proved by the gate, packaged, recorded, installed and
checked in a real VS Code.

### 1. Get the code

```text
git fetch origin
git status
```

The tree must be clean; if not, stop and show it. Check out `main`, or the
branch of the pull request the owner names if it is not merged yet, and pull.
Then report:

```text
node -p "require('./package.json').version"
node --version
code --version
opencode --version
```

Node is 22 in CI. The tested OpenCode ranges are in the "As of" line at the
top of `docs/flow/README.md`. A version outside them still runs and says once
that it "is outside the versions this bridge was tested with"; report it, do
not treat it as a failure.

### 2. Gate

```text
npm ci
npm run ship
```

Expect `ALL <N> CHECKS PASSED` and `ALL GATES GREEN`. The suite takes several
minutes; do not judge it by a 30 s timeout.

### 3. Package

```text
node -e "require('fs').mkdirSync('dist',{recursive:true})"
npx vsce package --out dist/
```

The folder comes first: without it vsce fails and leaves an empty file named
`dist`. A warning about a missing `repository` field is expected. Expect
`dist/opencode-copilot-bridge-<version>.vsix`.

### 4. Record the delivery

```text
node scripts/ship-gate.js --record
npm run ship
```

The first runs the gate and, when green, appends `<version> <vsix sha256>
<code hash>` to `docs/released.txt` (it is `npm run ship -- --record` without
the `--` that PowerShell can swallow). The second must still be green. Show
`git diff docs/released.txt` and ask before committing it.

Only the version in `package.json` can be recorded. A version that was merged
but never packaged from its own commit stays out of the ledger; that is
expected, not a gap to fill by hand.

### 5. Install

```text
node scripts/update.js --check
node scripts/update.js
```

It installs only a VSIX whose sha256 is the one `docs/released.txt` records.
Then the owner reloads every VS Code window.

### 6. Check in VS Code

OpenCode 2 needs no setting: `opencodeCopilotBridge.opencode2` is on by
default. If the owner's settings turn it off, a 2.x is refused as "not
OpenCode 1"; report that instead of changing it.

1. **OpenCode: Diagnose**. Report the rows `version`, `server`, `chat harness`
   and `harness settings`.
2. A new chat with **Local** as the session target: `@opencode /ping`. If Local
   is not offered, report that and any warning shown outside chat.
3. Reload the window and at once send, in a Local chat,
   `@opencode explain what src/core.ts does`. It must answer, not say "Nothing
   was sent". This is the first-turn check: it only tests the fix on an
   OpenCode that lists agents in stages (2.0, 2.1, 2.2.7, 2.3.0), so report
   the version with the result.
4. The release's quick pass in `docs/manual-checks.md`, if the owner wants it.

### 7. Real-binary probes (optional, most wanted on Windows and macOS)

```text
npm run compile
node scripts/probe-opencode2.js opencode
node scripts/probe-readonly.js opencode
```

Paste every `ok` and `FAIL` line and the `ROWS` summary. Change nothing if a
row fails. For comparison, on Linux at 0.0.239 the first probe
prints `ALL 26 ROWS AS EXPECTED` on 2.0.29, 2.2.5, 2.2.6, 2.2.7 and 2.3.0; the
only earlier Windows run (0.0.236, 2.2.5) was 21 of 22 (REFS).

Finish with a short table: step, result, anything the owner has to decide.

## Task 2: route measurements

Why: `@opencode` answers in a Local chat session only, and VS Code's docs say
Local "will be removed in February 2027". Two routes could replace it, and
neither has been run in a real VS Code (REFS 0.0.239). These measurements
decide between them. Do task 1 first, so the installed extension is current.

Everything you create goes in a temp folder outside the repo. The only change
to the repo is one dated entry in `REFS.md` at the end.

### Part A. Route T: an MCP server that Copilot's own agent calls (about 20 minutes)

Questions: does a natively configured MCP server reach a Copilot-harness chat,
how long may one tool call run, and which protocol does the client speak?

- **A1.** In the temp folder write a stdio MCP server in plain Node
  (newline-delimited JSON-RPC, no dependencies) with two tools: `sleep`
  (argument `seconds`; waits, then returns "slept N") and `echo`. It answers
  `initialize`, `tools/list`, `tools/call` and `server/discover`, and appends
  every line it receives, with a timestamp, to a log file.
- **A2.** Add it to the user's `.copilot/mcp-config.json` (in the home folder)
  under `mcpServers` as
  `"probe": {"type":"stdio","command":"node","args":["<path>"],"timeout":600000}`.
- **A3.** The owner opens a new chat on the Copilot harness (not Local) and
  asks "call the sleep tool with 30", then "call the sleep tool with 240".
  Record for each: was the tool offered, did it return, after how many seconds,
  any error text (look for `-32001`).
- **A4.** Remove `timeout` from the config, restart VS Code, repeat the 240 s
  call. Record when and how it fails. `timeout` is not documented; one public
  report says it lifts a limit of about 180 s.
- **A5.** The owner presses Stop in the middle of a call. From the log: did
  `notifications/cancelled` arrive?
- **A6.** From the log: the first method the client sent (`initialize` or
  `server/discover`) and the protocol version it named.
- **A7.** gitScan, this extension's own MCP server: in a fresh window, is
  `gitScan` in the Copilot chat's tool list? The owner runs **MCP: List
  Servers** once; is it there now?

### Part B. Route H: a separate Agent Host that the Agents window connects to (about 15 minutes)

This runs third-party code (`ahp-acp-gateway`, MIT, needs Node 24 or newer).
Ask the owner first, and skip part B on a no.

- **B1.** In a terminal outside the repo: `npx --yes ahp-acp-gateway`. It
  should print `ws://127.0.0.1:8765/ahp`.
- **B2.** Add to user settings:
  `"chat.remoteAgentHosts": [{"name": "AHP-ACP Gateway", "address": "127.0.0.1:8765/ahp"}]`.
- **B3.** The owner runs **Chat: Open Agents Window**, starts a new session,
  and picks the gateway host and the OpenCode agent. Record: does the session
  start; does text stream; is a confirmation shown before an edit; does Stop
  end the run; does a window reload reconnect; is there a plan or build mode
  control; which `opencode` version it started.
- **B4.** In plan mode, if there is one, ask it to create a file. Record
  whether the file exists afterwards: that is what read-only means there
  without this extension's rules.
- **B5.** Stop the gateway and remove the settings entry.

### Finish

- Restore every file you backed up and delete the temp folder.
- Add one dated entry to `REFS.md`: a table of each step, what happened, and
  the VS Code and OpenCode versions. Show the diff and ask before committing.
- End with a short table: question, answer, evidence.
