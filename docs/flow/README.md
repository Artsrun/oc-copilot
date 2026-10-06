# (・∀・) Chat flow: from Copilot Chat to OpenCode and back

> **One-line truth** (´-ω-)
> Copilot only routes a prompt, attachments and turn history to the `@opencode`
> participant. OpenCode then does **all** the work with its **own** tools.
> No tool bridge in either direction. Copilot's model picker is ignored.

## Pages

| # | Page | Answers |
| --- | --- | --- |
| 1 | [Big picture](01-big-picture.md) | Who talks to whom, in one diagram |
| 2 | [One chat turn](02-chat-turn.md) | Parse, gates, context, session, model |
| 3 | [Transport](03-transport.md) | CLI vs attach vs server, SSE, post-run |
| 4 | [Recovery and Stop](04-recovery.md) | What happens when things fail |
| 5 | [APIs touched](05-apis.md) | VS Code APIs, OpenCode CLI/HTTP/SSE, git |
| 6 | [Trust, pros and cons](06-trust-and-tradeoffs.md) | Risks, strengths, next steps |
| 7 | [Lanes, chips, effort, context](07-lanes-chips-effort.md) | What the next turn costs: fan-out, chips, variants, compaction |

## Marks and colours

The marks are the extension's own kaomoji (`marks` and chip `kao` in
`src/followups.json`). The project bans emoji, so the docs follow it.

| Mark | Means in these pages |
| --- | --- |
| (•‿•) | ok, a checked claim, a good outcome |
| (×﹏×) | failure |
| (°ロ°) | warning or risk |
| (-ω-)zZ | quiet, nothing sent |
| (・ω・)ノ | Stop |
| (・∀・) | folder, overview |
| (◕‿◕) | thread, session, link |
| (´-ω-) | thinking, the key idea |
| (っ•ω•)っ | worktree, git |
| (⌒▽⌒)ゞ | restart, retry, new session |
| ᕙ(⇀‸↼)ᕗ | tool, process, spawn |
| (・o・) | text, prompt, answer |
| (•ᴗ•) | a step |
| (・ω・)? | ping, a question |

| Diagram colour | Lane |
| --- | --- |
| blue | A: VS Code and Copilot Chat, what the host gives us |
| orange | B: the bridge extension (our TypeScript) |
| green | C: OpenCode, CLI or server |
| purple | D: back to chat, rendering and metadata |
| red | Failure, refusal or risk |
| grey dashed | Not consumed, or model-free |

Shapes: rounded = entry point, rectangle = step or data, hexagon = decision.

## Anchors

Anchors are **function names**, not line numbers (the version bumps on every
change and lines drift). Find one with `grep -n "function NAME" src/*.ts`.

## (•‿•) Evidence status

| Claim | Status |
| --- | --- |
| `request.model` never read | Checked: no match in `src` |
| No `languageModelTools` | Checked: absent from `package.json` |
| Selection folded only if inline or `includeEditorSelection` | Checked: `buildChatContext` |
| Vague gate: first message, no references, setting `clarifyVaguePrompts` | Checked: `handleChat` |
| Handoff only when no tool is running | Checked: `handleChat` |
| Untrusted workspaces cannot set `executable`, `serverHostname`, `serverPort` | Checked: `package.json` capabilities |
| `serve` is spawned through `spawnOpenCode` | Checked: `ensureServer` |
| A fixed `serverPort` adopts any listener saying `healthy: true`; the default is `53200`, off the common `4096`, and `0` starts a private server that adopts nothing | Measured: `scripts/probe-server-adoption.js` (the prompt and workspace path reached a fake listener) |
| Suite checks exist for the ladder | Checked: groups `HQ` `LT4` `LT5` `SP` `PA` `DM` `GP` `LT7` appear in the suite |
| Effort, context, autoParallel, subagent rows | Checked: groups `EF` `CX` `AP` `SG` `FT` in the suite (page 7) |
| Mermaid syntax | Checked: all diagrams pass `mermaid` `parse()` (a deliberately broken one fails). Visual layout not inspected |
