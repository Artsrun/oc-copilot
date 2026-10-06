# (⌒▽⌒)ゞ 4. Recovery and Stop

[← transport](03-transport.md) · [index](README.md) · next: [APIs →](05-apis.md)

## The recovery ladder

```mermaid
flowchart TD
  classDef bridge fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef oc fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef bad fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  classDef ok fill:#dcfce7,stroke:#16a34a,color:#14532d

  B{{"(・ω・)? session busy on server?"}}:::bridge
  AB["(・ω・)ノ POST abort, then send"]:::bridge
  RUN["(•ᴗ•) run attempt"]:::oc
  O{{"(・ω・)? outcome"}}:::bridge

  ST["(×﹏×) stale session id"]:::bad
  ST2["(⌒▽⌒)ゞ restartAfterMissingSession: new session"]:::bridge
  SF["(×﹏×) server transport failed"]:::bad
  SF2["CLI fallback, plan agent demoted"]:::bridge
  AF["(×﹏×) attach target dead"]:::bad
  AF2["(⌒▽⌒)ゞ cold CLI rerun"]:::bridge
  TO["(°ロ°) timed out"]:::bad
  TOA["(・ω・)ノ abort on server"]:::bridge
  SL{{"(・ω・)? a tool was running?"}}:::bridge
  NH["(°ロ°) no handoff: another model would not be faster"]:::bad
  HO["(⌒▽⌒)ゞ hand off to next fallback model"]:::bridge
  STP["(・ω・)ノ user pressed Stop"]:::bad
  STA["(-ω-)zZ nothing more sent, abort not awaited"]:::bridge
  OK["(•‿•) answer and metadata"]:::ok

  B -->|yes| AB --> RUN
  B -->|no| RUN
  RUN --> O
  O --> ST --> ST2 --> RUN
  O --> SF --> SF2
  O --> AF --> AF2
  O --> TO --> TOA --> SL
  SL -->|yes| NH
  SL -->|no| HO --> RUN
  O --> STP --> STA
  O --> OK
```

| Step | Trigger | Result |
| --- | --- | --- |
| Stale session | `isMissingSessionError` (server) or `isMissingSessionRun` (CLI exit) | New session, answer reset |
| Server failed | Thrown error on server transport | CLI takes this and later attempts. If the agent was confirmed by the server only, it runs as the built-in `plan`, with a visible warning |
| Attach dead | `isAttachFailure` | Same attempt rerun cold |
| Timeout | `timeoutMs` elapsed | Server abort awaited, then maybe handoff |
| Handoff | Model stall only | Next model in the chain; after an unpinned handoff the next turn sends the earlier model once |
| Stop | Cancellation token | Server abort **not** awaited |

## (・ω・)ノ Stop, precisely

- After Stop **nothing** arrives in the stream.
- About **1 s later the host stream throws**, so a turn must return within
  that second. This is why server aborts are fire-and-forget after Stop.
- Plain progress lines fade; task lines stay; a task open at Stop spins for
  good. So accordions are sent finished, and `stop()` waits `SETTLE_MS` after
  the last one.

## Test anchors (suite groups cited in AGENTS.md)

`HQ` headless asks · `LT4` `LT5` abort and busy checks · `LT7` liveness ·
`SP` stop · `PA` plan agent · `DM` handoff model · `GP` accordions.
