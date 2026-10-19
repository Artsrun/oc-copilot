# ᕙ(⇀‸↼)ᕗ 5. APIs touched

[← recovery](04-recovery.md) · [index](README.md) · next: [Trust and trade-offs →](06-trust-and-tradeoffs.md)

```mermaid
flowchart LR
  classDef host fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
  classDef bridge fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef oc fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef risk fill:#fee2e2,stroke:#dc2626,color:#7f1d1d

  VS["VS Code API"]:::host
  BR(("Bridge")):::bridge
  CLI["OpenCode CLI"]:::oc
  HTTP["OpenCode HTTP and SSE"]:::oc
  GIT["(っ•ω•)っ git"]:::bridge
  FS["(・∀・) config files"]:::oc
  PR["(°ロ°) proposed API: chatParticipantAdditions"]:::risk

  VS <--> BR
  PR -.-> VS
  BR --> CLI
  BR --> HTTP
  BR --> GIT
  BR --> FS
```

## VS Code

| Area | APIs |
| --- | --- |
| Chat | `chat.createChatParticipant` (panel and inline), `followupProvider` |
| Response stream | `markdown`, `progress`, `anchor`, `reference`, `button`, `filetree`; task-progress overload feature-detected |
| Commands | `registerCommand`, `executeCommand("workbench.action.chat.open")` with `isPartialQuery: true` |
| Window | output channel, status bar, `showQuickPick`, `createQuickPick`, messages, `withProgress`, `showTextDocument` |
| Workspace | `getConfiguration`, folders, trust, `onDidChangeConfiguration`, `openTextDocument` |
| Env | `appName`, `remoteName`, `uiKind`, `clipboard` |
| MCP (gitScan) | `lm.registerMcpServerDefinitionProvider`, `McpStdioServerDefinition`; its server copy via `workspace.fs` into `globalStorageUri`; `onDidGrantWorkspaceTrust` refreshes it |
| Proposed | `chatParticipantAdditions` (needs `--enable-proposed-api` or Insiders) |
| Activation | `onChatParticipant:*` and `onStartupFinished` (the prewarm, 3 s later); `deactivate()` kills the managed server |

## OpenCode CLI (always via `spawnOpenCode`)

| Command | Used for |
| --- | --- |
| `run [--attach url --dir cwd] [--agent] [--model] [--variant] [--session] [--pure] [--auto] [--format json] [--thinking]` | A turn |
| `serve --port --hostname` | Managed server |
| `agent list` | Which agents exist (`planAgent` is sent only once listed) |
| `models [--verbose]` | Catalog fallback |
| `--version` | Is it OpenCode 2? `/ping`, Diagnose, the `transport: cli` prewarm, and once before a window's first CLI run (`ensureCliIdentity`; again only when the file behind `executable` changes, `executableStamp`) — ~0.7 s on 1.19 |

(°ロ°) `opencode run --agent <unknown>` silently runs `build` (exit 0). Always pass `--agent`.

(°ロ°) OpenCode 2 is also `opencode`: its health is a web page and its `run`
rejects `--attach --dir --variant --pure`. Seen once, that executable runs
nothing more in the window (`markNotOpenCode1`); see REFS.

## OpenCode HTTP (every call has `?directory=`)

| Method and path | Used for |
| --- | --- |
| `GET /global/health` | Is a server there, and is it OpenCode (`version`) |
| `GET /global/event` | Shared SSE stream |
| `POST /session` | Create, with headless permissions |
| `GET /session?roots=true&limit=50` | `/sessions` picker |
| `POST /session/:id/message` | Send a turn |
| `GET /session/:id/message?limit=` | Last messages |
| `GET /session/status` | Busy check |
| `POST /session/:id/abort` | Stop, timeout, busy |
| `POST /session/:id/summarize` | Autocompact |
| `POST /session/:id/fork`, `PATCH` and `DELETE /session/:id` | Fork, archive, delete, permission re-PATCH (a PATCH appends; the last match wins) |
| `GET /session/:id` | Whether a session from another window carries read-only `task` rules, before a `/dev` turn |
| `GET /session/:id/children` | The subagent sessions to abort with their parent |
| `GET /agent`, `GET /config/providers` | Agents (and the dev agent's own rules; on a server this window did not start, which agents carry the read-only overrides' marker rule), model catalog |
| `POST /permission/:id/reply`, `POST /question/:id/reply` | Headless answers |
| `POST /session/:id/permissions/:permissionID` | The same answer for a pre-1.1 server (docs, not measured) |

SSE events consumed: `message.part.delta` (streamed text and reasoning),
`message.part.updated`, `message.updated`, `session.status` (provider retries),
`session.error`, `session.created`, `session.updated`, `permission.asked`,
`question.asked`;
`permission.updated` (pre-1.1) is answered like `permission.asked`, and
`permission.replied` confirms a reply (a 200 alone proves nothing, #15386).
`server.heartbeat` is ignored for liveness.

> Checked in source (`net.ts`, `sessions.ts`, `run-server.ts`, `server-session.ts`, `asks.ts`, `models.ts`):
> `/global/health`, `/global/event`, `/session/status`, `/agent`,
> `/config/providers`, `roots=true`, and `message`, `abort`, `fork`,
> `summarize` via `sessionPath(id, "...")`. Only matched by name, not read
> call by call: `/permission`, `/question`, `PATCH`, `DELETE`, and the
> `limit=50` value.

## (っ•ω•)っ git (only `src/worktree.ts` and `src/git-scan-server.ts`)

`execFile("git", argsArray)`: worktree add, list, remove, branch, diff; and the
gitScan server's one `status --porcelain=v2`. Never through the `cmd.exe` path. The one thing written outside OpenCode:
`<repo>.worktrees/<slug>`, on command.

## (・∀・) Files read (read-only)

`opencode.json(c)`, global config, instruction files such as `AGENTS.md`, and
agent, plugin, MCP, command and skill listings, for `/env` and `/ping`.
Nothing is injected.
