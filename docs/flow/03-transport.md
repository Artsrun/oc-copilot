# ᕙ(⇀‸↼)ᕗ 3. Transport: how the request leaves and the answer returns

[← one chat turn](02-chat-turn.md) · [index](README.md) · next: [Recovery →](04-recovery.md)

## Choosing a transport

```
useServer = transport == "server" || (transport == "auto" && !isBuild)
attachDev = transport == "auto" && setting attachDevToServer (default true)
```

| Turn | Transport | Why |
| --- | --- | --- |
| Read-only (plan, look) with `auto` | server | Warm server avoids 48 to 69 s cold boots |
| `/dev` (build) with `auto` | CLI attached to the warm server | `--auto` exists only on the CLI |
| `transport: cli` | cold CLI | Explicit |
| `transport: server` | server | Explicit |

```mermaid
flowchart LR
  classDef bridge fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef oc fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef back fill:#f3e8ff,stroke:#9333ea,color:#581c87

  T{{"(・ω・)? transport"}}:::bridge
  ES["(•ᴗ•) ensureServer: health check, adopt or start"]:::bridge
  SPN["ᕙ(⇀‸↼)ᕗ spawnOpenCode: shim, cmd.exe quoting, PWD = cwd"]:::bridge

  subgraph SV["Server path"]
    SE["opencode serve"]:::oc
    PS["POST /session if none"]:::oc
    PM["POST /session/id/message"]:::oc
    SSE["SSE /global/event"]:::oc
  end
  subgraph CL["CLI path"]
    RUN["opencode run --format json"]:::oc
    ATT["plus --attach url --dir cwd"]:::oc
  end

  JL["stdout JSONL"]:::back
  DM["(◕‿◕) demux by sessionId"]:::back
  SR["StepRecord"]:::back
  OUT["(•‿•) progress lines, answer, pills"]:::back

  T -->|server| ES --> SPN --> SE
  T -->|attach| ES
  T -->|cli| SPN --> RUN
  ES -.->|attach| ATT
  SE --> PS --> PM
  SE --> SSE
  RUN --> JL
  ATT --> SSE
  PM --> SSE
  SSE --> DM --> SR
  JL --> SR
  SR --> OUT
```

## Effort on the wire

| Path | How the variant goes |
| --- | --- |
| CLI and attached CLI | `opencode run --variant <level>` |
| Server | `"variant": "<level>"` in the `POST /session/:id/message` body |

Sent every turn when set; never sent when empty. See page 7.

## SSE rules that matter

- **One shared stream, demuxed by session id.** `message.updated` carries a
  message id, not a session id; `server.heartbeat` carries none. Only a run's
  own events prove it alive.
- **Every call carries `?directory=<cwd>`.** Without it the server uses its
  own cwd, which may be another window's checkout.
- **Killing an attach client does not stop the run**, and a prompt to a busy
  session queues silently. So every stop aborts on the server, and every send
  checks busy first.

## Headless sessions

Sessions the bridge creates deny `question`, `plan_enter` and `plan_exit`
(`HEADLESS_PERMISSION`), and the bridge answers every permission or question ask
of the session and its subagents itself, keyed by `readOnly`. Nobody can answer
OpenCode's prompts from a chat turn.

## (•‿•) Post-run

```mermaid
flowchart LR
  classDef bridge fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef back fill:#f3e8ff,stroke:#9333ea,color:#581c87
  M["metrics: tokens, cost, model"]:::bridge --> A["(•‿•) answer and file pills"]:::back
  M --> R["references: Used N"]:::back
  M --> MD["(◕‿◕) result.metadata"]:::back
  MD --> SES["setActiveSession: status bar, toasts"]:::bridge
  MD --> CH["natural chips or none"]:::back
  MD --> AC["background autocompact: every N turns, past 60k context or 70% of the window"]:::bridge
```
