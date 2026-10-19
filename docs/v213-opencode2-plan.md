# v218+ plan — Smooth Switch to OpenCode 2 (Instructions for Opus 5.5)

Dated 2026-10-16 (updated after 0.0.217). Trigger: company transition to OpenCode 2:

```bash
opencode auth login opencode --method device --answer server=https://opencode.example.com
```

(Template only: obtain the real server address privately. No internal endpoint
belongs in the repository.)

## Where 0.0.217 leaves us

- **0.0.217** closed all six findings from the 0.0.216 review:
  1. **Config merge-order bypass closed (`src/enforce.ts`, `src/server-session.ts`, `src/run-cli.ts`):** OpenCode deep-merges config objects (`opencode.json`, `.opencode/agents/*.md`, `OPENCODE_CONFIG_CONTENT`), preserving earlier key positions and appending new keys. `readOnlyPermission` now explicitly sets scalar `"deny"` on every writing/running tool (`edit`, `write`, `patch`, `apply_patch`, `multiedit`, `bash`, `shell`, `execute`, `question`, `plan_enter`, `plan_exit`) plus top-level `"ocb-enforced": "deny"` and `"*": "deny"` first. Because scalar `"deny"` replaces any earlier pattern map on that key, project/global configs with `"*": "allow"`, `edit: "allow"`, and `bash: { "*": "deny", "git *": "allow" }` are completely neutralized (`tools: { bash: false, edit: false, write: false }`, verified by 43/43 rows in `scripts/probe-readonly.js`).
  2. **Custom `planAgent` (`look`) verification (`src/server-session.ts`, `src/enforce.ts`):** Non-built-in primary agents are checked via `deniesWriters(rules)` without requiring `ENFORCED_MARKER`; if their own rules deny writers, `serverEnforcement` returns `enforced` (no false warning).
  3. **Server generation cache key (`src/net.ts`, `src/agents.ts`):** `listAgents` includes `currentServerGeneration()` in its cache key so starting, adopting, or stopping a server invalidates the 60s `GET /agent` cache.
  4. **Subagent name validation (`src/enforce.ts`):** `readOnlySubagents()` rejects and logs wildcards (`*`, `?`) and primary/dev agents (`plan`, `build`, `general`, `devAgent`).
  5. **Subagent `task` rule check (`src/server-session.ts`):** `overriddenOn` verifies that subagents also end with `task * deny`.
  6. **Release ledger check (`scripts/ship-gate.js`):** Gate 4 verifies that every delivered VSIX present in `dist/` matches its SHA-256 in `docs/released.txt`.

## Measured (1.19.0 vs 2.0.27 / 2.0.29) — details in REFS.md

| Surface | OpenCode 1.19.0 | OpenCode 2.0.27 / 2.0.29 |
| --- | --- | --- |
| `serve` health | `{"healthy":true,"version":"1.19.0"}` | Web app, HTML 200; prints `server password …` |
| `run` flags | `--attach --dir --variant --pure …` | `--server` (not `--attach`), `--model p/m#variant`, no `--dir --pure`; takes `--agent --format json --thinking --auto --session --fork --title --file` |
| `--version` | `1.19.0`, ~0.7 s | `opencode v2.0.27`, ~0.1 s |
| Data folder | `~/.local/share/opencode/opencode.db` | Same file; 2.x adds tables, lists 1.x sessions; 1.x still reads its own after |
| **ACP** (`opencode acp`) | Protocol 1; session close/fork/list/resume; `configOptions`: model, mode (`build`/`plan`) | Protocol 1; + delete, additionalDirectories; `configOptions` + **effort**; `_meta.opencode/child-session-updates` |
| Tool names | `bash`, `task`, MCP `<server>_<tool>` (`git-scan_gitScan`) | `shell`, `subagent`, Code Mode `execute` (wraps MCP tools and can POST anywhere / create worktrees) |
| Login | `auth login [url] -p -m` | `auth login <target> --method --answer k=v` |

## Architecture for the Smooth V2 Switch (Next Iterations for Opus 5.5)

ACP (Agent Client Protocol, JSON-RPC 2.0 over stdio via `opencode acp`) is spoken by both OpenCode 1.x and 2.x (`scripts/probe-acp.js`). One `opencode acp` process per window (or per workspace folder) avoids ports, passwords, `?directory=` scoping, and per-turn CLI startup overhead.

### Iteration 1 — `0.0.218`: Opt-in `transport: "acp"` on 1.x

1. **Add `"acp"` to `opencodeCopilotBridge.transport` enum** (three-place rule, AGENTS §2 rule 4: `package.json`, base `settings` in `scripts/verify-chat-output.js`, and `README.md`). Keep default `"auto"` unchanged on 1.x.
2. **Create `src/run-acp.ts`** (and register `out/run-acp.js` in `ALLOWED` in `scripts/ship-gate.js`, AGENTS §2 rule 7):
   - Spawn `opencode acp` exclusively through `spawnOpenCode()` (`src/proc.ts`) so `OPENCODE_CONFIG_CONTENT` (`enforcedConfigContent`) is injected into the ACP child process. Do **not** add a new `spawn(` call site (`BF` enforces `spawnLines.length === 3`).
   - Reuse the newline-delimited JSON-RPC framing proven in `scripts/probe-acp.js`:
     - Handshake: `initialize { protocolVersion: 1, clientCapabilities: {} }`.
     - Session lifecycle: `session/new { cwd, mcpServers: [] }` or `session/load { sessionId, cwd, mcpServers: [] }`.
     - Mode & model configuration: `session/set_config_option` for `mode` (`plan` or `build` / custom primary agent), `model` (`provider/model`), and `effort` (when supported by `configOptions`).
     - Prompt: `session/prompt { sessionId, prompt: [{ type: "text", text }] }`.
     - Streaming updates (`session/update`): map `agent_message_chunk` → text deltas (through `createLeakGate` / `createEchoGate`), `agent_thought_chunk` → `thoughtLine`, `tool_call` / `tool_call_update` → `StepRecord` and heartbeat accordions, `_meta.opencode/child-session-updates` → subagent rows.
     - Permission asks (`session/request_permission`): on read-only turns (`readOnly: true`), **always respond with the reject option** (`reject_once`); on `/dev` turns (`readOnly: false`), respond with `allow_once` (except `question` / `plan_enter` / `plan_exit`, which remain denied).
     - Cancellation: on `token.onCancellationRequested` or idle/wall timeout, send `session/cancel { sessionId }` without blocking past the 1 s host deadline (`SP`, `HS`).
3. **Pre-send read-only verification for ACP & cold CLI:**
   - Before sending a read-only turn when `enforceReadOnly: true`, verify effective rules (or ensure `enforcedConfigContent` was applied and `request_permission` rejects all asks). If `OPENCODE_CONFIG_CONTENT` could not be constructed (e.g., user's env var is non-object JSON), refuse before sending (`notSent: true`) rather than running unverified.
4. **Suite coverage (`scripts/verify-chat-output.js`):**
   - Add a fake stdio ACP mode to `writeFake` (handling `initialize`, `session/new`, `session/load`, `session/set_config_option`, `session/prompt`, `session/cancel`, and `session/request_permission`).
   - Add check group `AC` testing `transport: "acp"` for plan turns, `/dev` turns, permission ask rejection on read-only turns, streaming deltas, tool steps, and Stop cancellation within 1 s.

### Iteration 2 — `0.0.219`: Enable Opt-in ACP on OpenCode 2.x

1. **Pre-implementation measurements on real OpenCode 2.0.29+ (`scripts/probe-readonly.js` & `scripts/probe-acp.js`):**
   - Run the Finding 1 merge-order matrix (`opencode.json` and `.opencode/agents/plan.md` with `"*": "allow"`, `edit: "allow"`, `shell: { "*": "deny", "git *": "allow" }`, `execute: "allow"`) against real 2.x in `scripts/probe-readonly.js` to confirm `readOnlyPermission`'s scalar denies (`shell: "deny"`, `execute: "deny"`, `edit: "deny"`, `write: "deny"`, `subagent: ...`) hold on 2.x.
   - Verify whether 2.x subagent delegation uses permission key `subagent` in addition to `task`; if so, emit `subagent: subagents ? { "*": "deny", ... } : "deny"` alongside `task` in `readOnlyPermission` (`src/enforce.ts`).
   - Measure `session/load` with a 1.x session ID on 2.x: if 2.x returns an error on a 1.x session, catch it in `isMissingSessionError` (`src/runs.ts`) so `restartAfterMissingSession` cleanly opens a fresh 2.x session and notifies the user.
   - Measure how 2.x reports token usage and cost in `session/prompt` response or `session/update` so `RunMetrics.tokens`, `RunMetrics.cost`, and `RunMetrics.context` populate for autocompact and `/session`.
2. **Lift the 2.x refusal when running over ACP (`src/net.ts`, `src/chat-turn.ts`):**
   - Keep `markNotOpenCode1` / `ENOTOPENCODE1` active for HTTP `serve` and `opencode run` (since 2.x `serve` is a web app and 2.x `run` rejects `--attach`, `--dir`, `--variant`, `--pure`).
   - Allow 2.x executables when the turn routes through `runOpenCodeAcp`.
   - Update `/ping` and `opencodeCopilotBridge.diagnose` (`src/chat-commands.ts`, `src/commands.ts`): when `--version` prints `2.x`, report `2.x (ACP)` and check `opencode auth list`; if unauthenticated, display the device login command template.

### Iteration 3 — `0.0.220`: Auto-Switch `transport: "auto"` to ACP on OpenCode 2.x

1. **Automatic version-based routing (`src/net.ts`, `src/chat-turn.ts`, `src/chat-parallel.ts`, `src/chat-worktree.ts`, `src/chat-sessions.ts`):**
   - In `ensureCliIdentity` (`src/net.ts`), record the detected major version (`1` vs `2`) per `executableStamp`.
   - When `transport === "auto"`:
     - If major is `1`: keep the existing battle-tested 1.x path (`opencode serve` + SSE + `--attach` for `/dev` and `/parallel`).
     - If major is `2`: automatically route plan turns, `/dev` turns, `/parallel` lanes (concurrent `session/new` + `session/prompt` over ACP), `/worktree` (ACP session with `cwd` set to the worktree), `/compact`, and `/sessions` (`session/list`, `session/fork`, `session/close`, `session/delete`) through ACP; skip `prewarmServer()` when major is `2`.
2. **Hot-upgrade resilience:**
   - Because `executableStamp` checks file mtime/size on every turn, if a user runs `opencode upgrade --major` while VS Code is open, the very next turn detects the binary change, re-runs `--version`, sees `2.x`, stops any 1.x `serveProcess`, and switches seamlessly to ACP without requiring a window reload.
3. **Documentation & Claims:**
   - Update `README.md` (`<!-- claim:opencode-1-only -->` → `<!-- claim:opencode-2-acp -->` or updated anchor in `src/net.ts`), `AGENTS.md`, `REFS.md`, and `docs/manual-checks.md`.
   - Run `node scripts/probe-readonly.js` against both 1.18.35/1.19.0 and 2.0.29+, then `npm run ship`.
