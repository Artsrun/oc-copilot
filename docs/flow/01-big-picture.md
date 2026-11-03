# (・∀・) 1. Big picture

[← index](README.md) · next: [One chat turn →](02-chat-turn.md)

```mermaid
flowchart LR
  classDef host fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
  classDef bridge fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef oc fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef back fill:#f3e8ff,stroke:#9333ea,color:#581c87
  classDef off fill:#f3f4f6,stroke:#9ca3af,color:#6b7280,stroke-dasharray: 4 3

  U(["(・o・) User: @opencode task, in a Local chat session"]):::host
  subgraph A["A: VS Code and Copilot Chat"]
    P["(・o・) prompt and /command"]:::host
    R["(◕‿◕) references and selection"]:::host
    H["(◕‿◕) turn history"]:::host
    M["request.model"]:::off
  end
  subgraph B["B: Bridge extension"]
    HC["(•ᴗ•) handleChat"]:::bridge
    X["(・∀・) folder, parse, context, session, model, effort"]:::bridge
    T{{"(・ω・)? transport"}}:::bridge
    SP["ᕙ(⇀‸↼)ᕗ spawnOpenCode: PWD, dataHome, read-only overrides"]:::bridge
  end
  subgraph C["C: OpenCode"]
    CLI["opencode run (1.x)"]:::oc
    SRV["opencode serve (2.x: always, this window's own)"]:::oc
  end
  subgraph D["D: Back to chat"]
    EV["events: stdout JSONL or SSE (2.x read as 1.x)"]:::back
    OUT["(•‿•) progress, answer, file pills, chips"]:::back
    MD["(◕‿◕) metadata: sessionId, turns"]:::back
  end

  U --> HC
  P --> HC
  R --> X
  H --> X
  M -.->|never read| HC
  HC --> X --> T
  T -->|cli or attach| SP --> CLI
  T -->|server| SRV
  SP -->|serve| SRV
  CLI --> EV
  SRV --> EV
  EV --> OUT
  OUT --> MD
  MD -.->|host replays it next turn| H
```

## (´-ω-) Seven facts the picture hides

1. **No tool bridge.** Copilot tools are not sent to OpenCode, and OpenCode
   tools are not exposed to Copilot. gitScan is not one either: a standalone MCP
   server offered to Copilot, and to OpenCode only through a snippet you merge
   into `opencode.json`.
2. **The model comes from `model:` or settings**, not from Copilot's picker;
   so does the reasoning effort (`effort:` or the `effort` setting).
3. **History is not forwarded as messages.** It only recovers the OpenCode
   `sessionId`; OpenCode keeps the real conversation.
4. **Attachments become a text preamble.** Files go by path and OpenCode reads
   them from `cwd`. An open unsaved or ranged file, an untitled editor and
   `#problems` go as bounded text. What OpenCode will not get is said before the
   answer (`contextNotice`).
5. **Every OpenCode process goes through `spawnOpenCode()`** (`proc.ts`),
   including `serve`.
6. **Read-only is by permission, and checked.** Every spawn carries the
   overrides (`enforcedConfigContent`); before a read-only turn the effective
   rules are read back where it runs, and a reopened rule means nothing is sent
   (page 3).
7. **The front door is deprecated.** The Copilot harness has no chat
   participants, so `@opencode` answers in Local sessions only (page 8).
