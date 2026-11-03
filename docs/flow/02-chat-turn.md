# (•ᴗ•) 2. One chat turn

[← big picture](01-big-picture.md) · [index](README.md) · next: [Transport →](03-transport.md)

The first diagram is `handleChat` (`src/chat.ts`), **before** OpenCode runs. The run itself, its recovery and the answer are `runTurn` (`src/chat-turn.ts`), `/parallel` is `runParallelTurn` (`src/chat-parallel.ts`), and `/worktree` is `handleWorktree` (`src/chat-worktree.ts`).

```mermaid
flowchart TD
  classDef host fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
  classDef bridge fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef stop fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  classDef off fill:#f3f4f6,stroke:#9ca3af,color:#6b7280,stroke-dasharray: 4 3

  S(["(・o・) request from host"]):::host
  W["(・ω・)ノ chatStream: nothing after Stop, never throws"]:::bridge
  F["(・∀・) resolveFolder: attachment, editor, remembered, first root"]:::bridge
  AL["(•ᴗ•) aliases: /d to /dev, retired commands rejected"]:::bridge
  MG{{"(・ω・)? Merge chip, lanes gone after a reload?"}}:::bridge
  MGN["(-ω-)zZ LANES_GONE, no run"]:::stop
  SS["(◕‿◕) resolveSessionState: threadSession from history"]:::bridge
  C1{{"(・ω・)? control command?"}}:::bridge
  CC["/help /new /model /ping /env /session /sessions /stop /compact"]:::off
  WQ{{"(・ω・)? /worktree?"}}:::bridge
  WT["(っ•ω•)っ handleWorktree, below"]:::bridge
  EM{{"(・ω・)? empty prompt?"}}:::bridge
  NU["(-ω-)zZ nudge, no run"]:::stop
  PP["(•ᴗ•) parseChatPrompt: kind, model:, effort:, the task"]:::bridge
  PL{{"(・ω・)? /parallel, or autoParallel auto and a lanes-shaped list?"}}:::bridge
  LN["runParallelTurn: splitLanes, runParallelLanes (page 7)"]:::bridge
  MR{{"(・ω・)? model: one catalog match?"}}:::bridge
  MRN["(-ω-)zZ refused, says which, no run"]:::stop
  VG{{"(・ω・)? vague first message?"}}:::bridge
  RF["(-ω-)zZ refuse, no run spent, Run it chip"]:::stop
  FB["(⌒▽⌒)ゞ pin, handoff return, handoffChain"]:::bridge
  EF{{"(・ω・)? effortFor: level known missing?"}}:::bridge
  ER["(-ω-)zZ typed effort refused, no run spent"]:::stop
  CX["(・o・) buildChatContext: text preamble, contextNotice"]:::bridge
  GO(["(•ᴗ•) runTurn"]):::bridge

  S --> W --> F --> AL --> MG
  MG -->|yes| MGN
  MG -->|no| SS --> C1
  C1 -->|yes| CC
  C1 -->|no| WQ
  WQ -->|yes| WT
  WQ -->|no| EM
  EM -->|yes| NU
  EM -->|no| PP --> PL
  PL -->|yes| LN
  PL -->|no| MR
  MR -->|no| MRN
  MR -->|yes, or none typed| VG
  VG -->|yes| RF
  VG -->|no| FB --> EF
  EF -->|typed| ER
  EF -->|no, or setting: run at default with a note| CX --> GO
```

## (•ᴗ•) `runTurn`, in four parts

```mermaid
flowchart LR
  classDef bridge fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef oc fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef back fill:#f3e8ff,stroke:#9333ea,color:#581c87
  classDef stop fill:#fee2e2,stroke:#dc2626,color:#7f1d1d

  O["openTurn: warmServer if attached, startHeartbeat"]:::bridge
  P["prepareRun: refusals, session, server, notices, planAgent, summary wait, busy check"]:::bridge
  A["runAttempts: the recovery ladder (page 4)"]:::oc
  D["finishTurn: answer, books, autocompact, chips, metadata"]:::back
  F["failTurn: refused or failed, Retry with your words"]:::stop

  O --> P --> A --> D
  P -.->|throws| F
  A -.->|throws| F
```

`prepareRun` logs what it spent as `pre-run: server Nms · agent Nms · summary Nms · busy-check Nms`.
Stop before it ends returns `notSent`, so the chip resends your words, not Continue.

## The vague-prompt gate, exactly

It refuses only when **all** hold: setting `clarifyVaguePrompts` is on, it is
the **first** message of the thread (no session yet), there are **no**
references, selection or inline origin, the text is judged vague, and the user
has not insisted. The reply points to `/ping` and gives example tasks; a
"Run it" chip is the way through.

## (っ•ω•)っ `/worktree`

Routed before `parseChatPrompt`, so `handleWorktree` reads for itself what a chat
turn reads (`WT10`–`WT12`). Copilot keeps the command sticky, so every later
message in that chat arrives as `/worktree`.

```mermaid
flowchart TD
  classDef bridge fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef oc fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef back fill:#f3e8ff,stroke:#9333ea,color:#581c87
  classDef stop fill:#fee2e2,stroke:#dc2626,color:#7f1d1d

  T{{"(・ω・)? a task?"}}:::bridge
  L["lists this repo's worktrees, Worktrees button"]:::back
  R{{"(・ω・)? openCode1Refusal, dataFolderRefusal, ensureCliIdentity"}}:::bridge
  RN["(×﹏×) refused, no folder made"]:::stop
  C{{"(・ω・)? threadWorktree, and reopenWorktree agrees?"}}:::bridge
  V{{"(・ω・)? vague and nothing attached?"}}:::bridge
  VN["(-ω-)zZ asked first, no folder, Run it as /worktree"]:::stop
  M["model:, effort: as a chat turn; unknown short name refused"]:::bridge
  W["createWorktree: ai/slug from HEAD, says the uncommitted count"]:::bridge
  K["continue: same folder, branch and session"]:::bridge
  X["buildChatContext by repo path, underRoot; a changed file is named"]:::bridge
  G["dev agent in the worktree, attached or cold; leak and echo gates"]:::oc
  B["references, changed files, buttons; chips sent as /worktree"]:::back
  AC["autocompact by size only, contextOverflowing; the next turn waits"]:::back

  T -->|no| L
  T -->|yes| R
  R -->|refused| RN
  R -->|ok| C
  C -->|yes| M
  C -->|no| V
  V -->|yes| VN
  V -->|no| M
  M -->|continued| K --> X
  M -->|new| W --> X
  X --> G --> B --> AC
```

The metadata names the worktree, its base and `worktreeSession`, never `sessionId`
with `turns`, which bind the chat's own session. A continued session OpenCode no
longer has is replaced once, in the same worktree. `/session` and `/compact` reach
it through `threadWorktree`.

## (◕‿◕) Thread to session binding

```mermaid
flowchart LR
  classDef bridge fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef stop fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  H["context.history"] --> W["walk backwards"]:::bridge
  W --> B{{"hit a /new barrier?"}}:::bridge
  B -->|yes| N["(⌒▽⌒)ゞ no session: start fresh"]:::stop
  B -->|no| T{{"turn has sessionId and numeric turns?"}}:::bridge
  T -->|yes| ID["(•‿•) reuse that sessionId"]:::bridge
  T -->|no| W
```

Anything that re-binds a chat (`/sessions` Continue, Fork) must return that
metadata, because metadata is the only binding.

## What the host gives that is dropped

| Dropped | Why |
| --- | --- |
| `request.model` | Never read; the model is OpenCode's |
| Copilot tools | No `languageModelTools` contribution |
| History as messages | Only used to find the sessionId |
| Images, binary attachments, anything not a file on disk | Not sent, and the chat says so (`contextNotice`) |
| An unsaved file when no excerpt fits; `.env` text on a read-only turn | Path only or withheld, and said |
| VS Code's current-file chip | Implicit: said once per window. `#file` or `includeEditorSelection` sends it |
| Copilot's customizations index and instruction files | Logged only: OpenCode loads its own |

Output › OpenCode logs every reference the host sent, kept or dropped and why
(`referenceLogLine`).
