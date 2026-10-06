# (•ᴗ•) 7. Lanes, chips, effort and context

[← trust](06-trust-and-tradeoffs.md) · [index](README.md)

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
  RES["each lane: m: model resolved, effortFor its model"]:::bridge
  RUN["runParallelLanes: one fresh session per lane, attached to the warm server"]:::oc
  STO["(◕‿◕) rememberLanes: answers in memory, 8 runs, id in metadata"]:::back
  CH{{"(・ω・)? 2+ answered? a lane failed?"}}:::back
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
  SPL --> RES --> RUN --> STO --> CH
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
chat's session only through **Merge lanes**.

## Chips: natural or none

```mermaid
flowchart TD
  classDef bridge fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef back fill:#f3e8ff,stroke:#9333ea,color:#581c87
  classDef off fill:#f3f4f6,stroke:#9ca3af,color:#6b7280,stroke-dasharray: 4 3

  F(["(•‿•) finished turn"]):::bridge
  OK{{"(・ω・)? failed, stopped, vague?"}}:::bridge
  REC["recovery chips: Retry, Continue, Ping, New"]:::back
  OF["1. the agent's own offer, or a closing either/or"]:::back
  CUE["2. concrete cues: Continue, #1, Fix #1 + Fix all, lanes, Your call, Ship it"]:::back
  DEV["3. dev edits: Review file, then Fix failing tests or Test it"]:::back
  DD["4. unsure answer + a higher effort level: Dig deeper · high"]:::back
  CAP["at most 3, offers first"]:::bridge
  NONE["no chip"]:::off

  F --> OK
  OK -->|yes| REC
  OK -->|no| OF --> CUE --> DEV --> DD --> CAP
  CAP -->|nothing matched| NONE
```

Every word a chip shows or sends is in `src/followups.json`; check `NF` holds
the answers that must get **no** chip.

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
  S["--variant level / body.variant"]:::oc
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

- Sent **every turn**: a prompt without one resets the session to `default`.
- Fallback models and each lane are checked against **their own** model.
- The model picker shows each model's levels; **Dig deeper** asks for the next
  one up (`higherEffort`).

## Context: when the session is compacted

```mermaid
flowchart LR
  classDef bridge fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef oc fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef back fill:#f3e8ff,stroke:#9333ea,color:#581c87

  SF["step_finish tokens, per step"]:::oc --> LS["RunMetrics.context = last step: total, else input + output + cache read + cache write"]:::bridge
  LS --> MD["(◕‿◕) metadata.context, /session: context 26k of 200k (13%)"]:::back
  LS --> T{{"(・ω・)? turn % N == 0, or > 60k, or >= 70% of the window?"}}:::bridge
  T -->|yes| AC["(⌒▽⌒)ゞ compactSession, in the background, logged"]:::oc
```

Before 0.0.202 the trigger summed `input` over the turn's steps: a 3-step turn
with a 25k context read as 75k, and a cached 70k context (input 100) read as 100.

## (•‿•) Evidence

| Claim | Where |
| --- | --- |
| OpenCode ignores an unknown variant | `session/llm/request.ts` (1.18.34): `model.variants[name]`, no error |
| A prompt without a variant resets the session to default | `session/prompt.ts` (1.18.34), `setAgentModel(... variant ?? "default")` |
| OpenCode sizes context by the last step, cache in | `session/overflow.ts` `isOverflow` (1.18.34) |
| `opencode run --agent <subagent>` falls back to the default agent | `cli/cmd/run.ts` (1.18.34) warns and falls back |
| Each rule above has suite checks | groups `EF` `CX` `AP` `FT` `SG` |
