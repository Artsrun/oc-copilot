# (•ᴗ•) 2. One chat turn

[← big picture](01-big-picture.md) · [index](README.md) · next: [Transport →](03-transport.md)

Everything here happens in `handleChat` (`src/chat.ts`) **before** OpenCode runs; the run itself, its recovery and the answer are `runTurn` (`src/chat-turn.ts`), and `/parallel` is `runParallelTurn` (`src/chat-parallel.ts`).

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
  SS["(◕‿◕) resolveSessionState: threadSession from history"]:::bridge
  C1{{"(・ω・)? control command?"}}:::bridge
  CC["/help /new /model /ping /env /session /sessions /stop"]:::off
  WT["(っ•ω•)っ /worktree: git via execFile"]:::bridge
  EM{{"(・ω・)? empty prompt?"}}:::bridge
  NU["(-ω-)zZ nudge, no run"]:::stop
  PL{{"(・ω・)? /parallel, or autoParallel auto and a lanes-shaped list?"}}:::bridge
  LN["splitLanes, runParallelLanes (page 7)"]:::bridge
  VG{{"(・ω・)? vague first message?"}}:::bridge
  RF["(-ω-)zZ refuse, no run spent"]:::stop
  MR["modelResolver: model: prefix, pin, handoff return"]:::bridge
  EF{{"(・ω・)? effortFor: level known missing?"}}:::bridge
  ER["(-ω-)zZ typed effort refused, no run spent"]:::stop
  FB["(⌒▽⌒)ゞ fallback chain and timeouts"]:::bridge
  CX["(・o・) buildChatContext: text preamble"]:::bridge
  AG["agent: planAgent only if OpenCode lists it"]:::bridge
  HB["startHeartbeat"]:::bridge
  GO(["(•ᴗ•) transport and run"]):::bridge

  S --> W --> F --> AL --> SS --> C1
  C1 -->|yes| CC
  C1 -->|no| WT
  WT -->|not /worktree| EM
  EM -->|yes| NU
  EM -->|no| PL
  PL -->|yes| LN
  PL -->|no| VG
  VG -->|yes| RF
  VG -->|no| MR --> EF
  EF -->|typed| ER
  EF -->|no, or setting: run at default| FB --> CX --> AG --> HB --> GO
```

## The vague-prompt gate, exactly

It refuses only when **all** hold: setting `clarifyVaguePrompts` is on, it is
the **first** message of the thread (no session yet), there are **no**
references, selection or inline origin, the text is judged vague, and the user
has not insisted. The reply points to `/ping` and gives example tasks; a
"Run it" chip is the way through.

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
| Attachment bytes | Folded into text; OpenCode reads from `cwd` |
