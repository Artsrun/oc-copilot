# (•ᴗ•) 7. Lanes, chips, effort and context

[← trust](06-trust-and-tradeoffs.md) · [index](README.md) · next: [OpenCode 2 and the harness →](08-opencode2-and-harness.md)

Four things that decide **what the next turn costs**: whether a message fans
out into lanes, which chips a finished turn offers, how hard the model thinks,
and when the session is compacted. Anchors are function names.

## Lanes: from a message to merged answers

```mermaid
flowchart TD
  classDef host fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
  classDef bridge fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef oc fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef back fill:#f3e8ff,stroke:#9333ea,color:#581c87
  classDef stop fill:#fee2e2,stroke:#dc2626,color:#7f1d1d

  M(["(・o・) message"]):::host
  TY{{"(・ω・)? typed /parallel, par: or a lanes chip?"}}:::bridge
  AP{{"(・ω・)? autoParallel is auto, no kind typed, not inline?"}}:::bridge
  LI{{"(・ω・)? laneItems: 2-5 read-only steps, each naming a file or call?"}}:::bridge
  ONE["(•ᴗ•) one plan turn in this chat's session"]:::bridge
  SPL["splitLanes: | ;; or a --- line, never inside backticks"]:::bridge
  RES["each lane: m: model resolved, a: agent checked, effortFor its model"]:::bridge
  RO{{"(・ω・)? read-only rules hold for each lane's agent?"}}:::bridge
  REF["(×﹏×) assertReadOnly: nothing runs, Retry and Ping"]:::stop
  RUN["runParallelLanes: one fresh session per lane, attached to the warm server"]:::oc
  STO["(◕‿◕) rememberLanes: answers in memory, 8 runs, id in metadata"]:::back
  CH{{"(・ω・)? one task on several models? 2+ answered? a lane failed?"}}:::back
  CP["(°ー°〃) Compare: a plan turn that weighs them"]:::back
  MG["(=^‥^)ノ Merge lanes: a plan turn with the stored answers"]:::back
  RT["(ﾉ´･ω･)ﾉ Retry lanes: only the failed ones, m: kept"]:::back
  GONE["(-ω-)zZ window reloaded: LANES_GONE, nothing runs"]:::stop

  M --> TY
  TY -->|yes| SPL
  TY -->|no| AP
  AP -->|no| ONE
  AP -->|yes| LI
  LI -->|no| ONE
  LI -->|yes, with a line saying so| SPL
  SPL --> RES --> RO
  RO -->|no| REF
  RO -->|yes, or lanes may write| RUN --> STO --> CH
  CH -->|differ by model or agent| CP
  CH -->|2+ answered| MG
  CH -->|failed| RT
  MG -.->|after a reload| GONE
```

| `autoParallel` | Plan answer shaped like lanes | Message shaped like lanes |
| --- | --- | --- |
| `offer` (default) | **Run N as lanes** chip | one turn |
| `auto` | chip | runs as lanes; `plan:` keeps one turn |
| `off` | nothing | one turn |

Why not always automatic: every lane is a paid run, and lane answers reach the
chat's session only through **Merge lanes**. Lanes are read-only unless
`parallelAllowWrite` is on; an `a:` lane runs with that agent's own permissions.

## Chips: natural or none

```mermaid
flowchart TD
  classDef bridge fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef back fill:#f3e8ff,stroke:#9333ea,color:#581c87
  classDef off fill:#f3f4f6,stroke:#9ca3af,color:#6b7280,stroke-dasharray: 4 3

  F(["(•‿•) finished turn"]):::bridge
  OK{{"(・ω・)? failed, stopped, vague?"}}:::bridge
  REC["recovery chips that fit it (page 4)"]:::back
  ST["0. state, from metadata: Finish it, Resume or Rerun, Compact"]:::back
  OF["1. the agent's own offer, or a closing either/or"]:::back
  CUE["2. concrete cues: Continue, #1, Fix High + Fix High (n) or Fix #1, Fix all, lanes, Your call, Ship it"]:::back
  DEV["3. dev edits: Review file, then Fix failing tests or Test it"]:::back
  DD["4. unsure answer + a higher effort level: Dig deeper · high"]:::back
  HEAD["nothing fired: the head of the answer, scanned for an offer"]:::back
  HOLD["backoff: a cue kind passed over 3 times is held 2, then 4 … 32 messages"]:::bridge
  CAP["at most 3, state first, then offers"]:::bridge
  NONE["no chip"]:::off

  F --> OK
  OK -->|yes| REC
  OK -->|no| ST --> OF --> CUE --> DEV --> DD --> HEAD --> HOLD --> CAP
  CAP -->|nothing matched| NONE
```

Every word a chip shows or sends is in `src/followups.json`; check `NF` holds
the answers that must get **no** chip. A review's findings are read by
severity where a review names one (a heading over the items, a tag at an
item's start, a Severity column), never from the word in a sentence. The
agent's own offers and choices, Resume, Rerun and Finish it are never held
(`NEVER_HELD`); the log records `chips offered:` and `chip taken:`.

Under a `/worktree` turn the answer's own chips are kept at `WORKTREE_TURN` and
sent as `/worktree`, a Review too (it reads the worktree, where the change is);
lanes stay out, and a failed worktree turn has its buttons instead (`WT9`).

## Effort: which variant is sent

```mermaid
flowchart LR
  classDef bridge fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef oc fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef stop fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  classDef off fill:#f3f4f6,stroke:#9ca3af,color:#6b7280,stroke-dasharray: 4 3

  A{{"(・ω・)? effort: typed, or the effort setting?"}}:::bridge
  N["no variant: the model's default"]:::off
  C{{"(・ω・)? catalog lists the model's levels?"}}:::bridge
  P["sent as asked"]:::oc
  H{{"(・ω・)? level among them?"}}:::bridge
  S["--variant level / body.variant / 2.x model.variant"]:::oc
  R["(×﹏×) typed: refused, nothing runs"]:::stop
  D["(°ロ°) setting: default, with a note"]:::off

  A -->|neither| N
  A -->|yes| C
  C -->|no| P
  C -->|yes| H
  H -->|yes| S
  H -->|no, typed| R
  H -->|no, setting| D
```

- Sent **every turn**: on 1.x a prompt without one resets the session to `default`.
  2.x keeps the last level, so the bridge puts the default back.
- Fallback models and each lane are checked against **their own** model; a
  `/worktree` turn reads `effort:` and the setting too.
- With no model named on 2.x the level goes on the model the run would use, and one
  that model does not list is not sent: 2.x would fail the run (`unpinnedModel`).
- The model picker shows each model's levels; **Dig deeper** asks for the next
  one up (`higherEffort`).

## Context: when the session is compacted

```mermaid
flowchart LR
  classDef bridge fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef oc fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef back fill:#f3e8ff,stroke:#9333ea,color:#581c87
  classDef off fill:#f3f4f6,stroke:#9ca3af,color:#6b7280,stroke-dasharray: 4 3

  SF["step_finish tokens, per step"]:::oc --> LS["RunMetrics.context = last step: total, else input + output + cache read + cache write"]:::bridge
  LS --> MD["(◕‿◕) metadata.context, /session: context 26k of 200k (13%), status bar ctx 13%"]:::back
  LS --> B{{"(・ω・)? autoCompact on, autoCompactEveryTurns above 0?"}}:::bridge
  B -->|no| CH["Compact chip, once past the size trigger"]:::off
  B -->|yes| T{{"(・ω・)? turn % N == 0 at 20k+ or unmeasured, or > 60k, or >= 70% of the window?"}}:::bridge
  T -->|yes| AC["(⌒▽⌒)ゞ compactSession, auto false, in the background, logged"]:::oc
  AC --> W["the next turn of that session waits for it, up to 60 s"]:::bridge
```

The size trigger is `contextOverflowing`; `COMPACT_MIN_TOKENS` is the 20k floor,
so summarising a small session does not cost a model pass. Never `auto: true`: an
auto compaction ends with a synthetic "Continue if you have next steps" and runs a
turn nobody sees (`CQ`). A `/worktree` session compacts by size only.

Before 0.0.202 the trigger summed `input` over the turn's steps: a 3-step turn
with a 25k context read as 75k, and a cached 70k context (input 100) read as 100.

## (•‿•) Evidence

| Claim | Where |
| --- | --- |
| OpenCode ignores an unknown variant | `session/llm/request.ts` (1.18.34): `model.variants[name]`, no error |
| A prompt without a variant resets the session to default | `session/prompt.ts` (1.18.34), `setAgentModel(... variant ?? "default")` |
| OpenCode sizes context by the last step, cache in | `session/overflow.ts` `isOverflow` (1.18.34) |
| `opencode run --agent <subagent>` falls back to the default agent | `cli/cmd/run.ts` (1.18.34) warns and falls back |
| Each rule above has suite checks | groups `EF` `CX` `AP` `FT` `SG` `CP` `CQ` `BK` `CL` |
