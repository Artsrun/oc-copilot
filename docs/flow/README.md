# (・∀・) Chat flow: from Copilot Chat to OpenCode and back

As of 0.0.237 (tested OpenCode: 1.18.27–1.19.5, and 2.0.18–2.2.5 with `opencode2`).

> **One-line truth** (´-ω-)
> Copilot only routes a prompt, attachments and turn history to the `@opencode`
> participant, in a Local chat session. OpenCode then does **all** the work with
> its **own** tools. No tool bridge in either direction. Copilot's model picker
> is ignored.

## Pages

| # | Page | Answers |
| --- | --- | --- |
| 1 | [Big picture](01-big-picture.md) | Who talks to whom, in one diagram |
| 2 | [One chat turn](02-chat-turn.md) | Parse, gates, context, session, model, `runTurn`, `/worktree` |
| 3 | [Transport](03-transport.md) | CLI vs attach vs server, prewarm, read-only check, SSE, post-run |
| 4 | [Recovery and Stop](04-recovery.md) | Refused before sending, the ladder, Stop |
| 5 | [APIs touched](05-apis.md) | VS Code APIs, OpenCode CLI/HTTP/SSE (both majors), git, env |
| 6 | [Trust, pros and cons](06-trust-and-tradeoffs.md) | Risks, strengths, next steps |
| 7 | [Lanes, chips, effort, context](07-lanes-chips-effort.md) | What the next turn costs: fan-out, chips, variants, compaction |
| 8 | [OpenCode 2 and the Copilot harness](08-opencode2-and-harness.md) | Which major runs, what differs, where `@opencode` can answer |

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
change and lines drift). Find one with `grep -n "function NAME" src/*.ts`. The
gate fails when a backticked code name on these pages is gone from the code.

## (•‿•) Evidence status

Re-read against 0.0.236 source on 2026-11-03. Page text describing runtime
behaviour on real OpenCode comes from REFS and the changelog, which name what
was measured; it was not re-measured for this pass.

| Claim | Status |
| --- | --- |
| `request.model` never read | Checked: no match in `src` |
| No `languageModelTools` | Checked: absent from `package.json` |
| Selection folded only if inline or `includeEditorSelection` | Checked: `buildChatContext` |
| Vague gate: first message, no references, setting `clarifyVaguePrompts` | Checked: `handleChat`; `handleWorktree` has its own, for a worktree not being continued |
| Handoff only when no tool is running | Checked: `runAttempts` (`chat-turn.ts`) |
| Refused turns get no CLI fallback | Checked: `runAttempts`, `notSent` in `chat-turn.ts` |
| Untrusted workspaces cannot set `executable`, `dataHome`, `serverHostname`, `serverPort`, `enforceReadOnly`, `readOnlyTools` | Checked: `package.json` capabilities |
| `serve` is spawned through `spawnOpenCode` | Checked: `ensureServer` |
| Every server request goes through one module | Checked: `api` in `oc-api.ts` (suite group `OA`); the SSE stream itself is `connectSse` in `net.ts` |
| A fixed `serverPort` adopts a listener only if its health names a `version`; anything else gets one health probe and the window starts its own server. The default is `53200`, off the common `4096`, and `0` starts a private server that adopts nothing | Measured before the check: `scripts/probe-server-adoption.js` (the prompt and workspace path reached a fake listener). Since: suite group `ID` |
| Suite checks exist for the ladder | Checked: groups `HQ` `LT4` `LT5` `SP` `PA` `DM` `GP` `LT7` appear in the suite |
| Effort, context, autoParallel, subagent rows | Checked: groups `EF` `CX` `AP` `SG` `FT` in the suite (page 7) |
| OpenCode 2 and the harness | Checked: groups `TW` `RX` `HR` `PV` in the suite (page 8) |
| Mermaid syntax | Checked: all 18 diagrams render with `mmdc`, re-run for this pass. Layout not reviewed page by page |
