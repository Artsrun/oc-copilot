# 0.0.248 review: the `oc-copilot-247.tar` change set

**Dated 2026-11-26.** Linux, Node 22.23.5, the suite's 2.x fake. Base: `main` at
`9b50872` (0.0.247). The tar (sha256 `ee07d213…7e017c`, 216 entries) was extracted over
that checkout and committed as-is (`0f8256d`); everything below is measured on compiled
trees, never read off the source.

## What the tar changes

Four tracked files beyond `out/` (whose `trace.js` and `run-server.js` rebuild
byte-for-byte from the tar's `src/`):

| File | Change |
| --- | --- |
| `src/trace.ts` | Span status drops the error message; a non-`http(s)` scheme is a log line; the request is wrapped in `try`. |
| `src/run-server.ts` | `endRun` is no longer passed the error text. |
| `scripts/verify-chat-output.js` | `TP`: an error turn (`fail` script), "no span carries error text", "an error span has no message", "an unsupported protocol warns without throwing" (calls `endRun` directly). |
| `README.md` | Trailing blank line removed. |

No version bump, no CHANGELOG, README or REFS entry.

## Gate runs

| Tree | `npm run ship` | Checks |
| --- | --- | --- |
| `main` 0.0.247 | green, 3m44s | 1413 |
| tar as delivered (0.0.247) | green, 3m43s | 1415 |
| `main`'s code + this branch's suite | **4 red** | 1416 |
| this branch, 0.0.248 | green, 3m41s | 1416 |

## Verdict

| Change | Verdict |
| --- | --- |
| No error text in the span's status | **Keep** (fixes F2) |
| Scheme guard before `http.request` | **Keep** (fixes F1) |
| `try` around the request only | **Fix** (F3): one `try` around the whole export |
| `run-server.ts` passes no error | **Keep** |
| `TP` error-span checks | **Keep** |
| `TP` "warns without throwing" (direct `endRun` call) | **Keep**, plus F4's turn-level check |
| Same version, 0.0.247 | **Fix** (F0) |
| README trailing newline | Keep (cosmetic) |

## Findings

### F0 · Rule 9: other code under 0.0.247

`out/trace.js` and `out/run-server.js` differ between `main`'s 0.0.247 and the tar's.
0.0.247 is not in `docs/released.txt`, so the gate stays green, but a VSIX built from
either is "0.0.247". **Fix:** 0.0.248 in `package.json`, both `package-lock.json` fields,
`serverInfo.version` (`src/git-scan-server.ts`), `VERSION` (`src/oc-mcp-server.ts`), with
CHANGELOG and README entries (README keeps five: 0.0.243 dropped).

### F1 · high · `main`: an endpoint the bridge cannot post to reruns the prompt

`localhost:4318` parses as the scheme `localhost:`; `http.request` throws synchronously
on any scheme but its own. `endRun` runs inside `runOpenCodeServer`'s `try`, after the
finished run, so the throw read as a server failure; `runAttempts`' fallback ran the turn
again, on 2.x back through `runOpenCodeServer`, which threw the same way.

`endRun` on each compiled tree (`probe-endrun.js`, scratch):

```
=== main                                        === tar / 0.0.248
"ftp://127.0.0.1:4318"   threw Protocol "ftp:"…   no throw: unsupported protocol ftp: (log)
"localhost:4318"         threw Protocol "local…   no throw: unsupported protocol localhost:
"127.0.0.1:4318"         no throw: not a URL      no throw: not a URL
"grpc://127.0.0.1:4317"  threw Protocol "grpc:"…  no throw: unsupported protocol grpc:
"file:///tmp/x"          threw Protocol "file:"…  no throw: unsupported protocol file:
```

One 2.x turn, `otlpEndpoint: localhost:4318`, `main`'s code:

```
prompts: POST /api/session/ses_fakeTwo0005…/prompt, POST /api/session/ses_fakeTwo0006…/prompt
chat:    Hello from the scripted model.Hello from the scripted model.
         OpenCode failed to start: Protocol "localhost:" not supported. Expected "http:"
log:     server failed, falling back to CLI: TypeError [ERR_INVALID_PROTOCOL]: Protocol "localhost:" …
```

Two paid runs (a `/dev` task done twice), the turn reported failed, its metadata bound to
neither session. The same from VS Code's `OTEL_EXPORTER_OTLP_ENDPOINT`. **Fixed by the
tar**; pinned at the boundary by F4.

### F2 · medium · `main`: an error span carried the error message

`status: { code: 2, message: truncate(end.error, 200) }`. A provider's error can quote
the prompt; 0.0.247's CHANGELOG and README say no prompt text reaches a span, and AGENTS
§7 says never put any there.

```
main:     error span status={"code":2,"message":"provider said: PROMPT_SENTINEL is too long"}
tar:      error span status={"code":2}
```

**Fixed by the tar.** Checks: "no exported span carries prompt or error text", "an error
span keeps its error status without the raw error message".

### F3 · low · the "never throws" contract held only where a throw was known

The tar guarded the scheme and wrapped the request. Anything else that throws in
`endRun` (now or after a later edit) still fails a finished run and reruns its prompt.
**Fix:** `endRun` puts the whole export (`exportSpan`) in one `try`; the guard stays for
its message. Mutant M2 (guard kept, outer `try` removed) survives: 18 odd `http(s)`
endpoints (`http://`, `:0`, zone ids, NULs, 300-char hosts, `http:127.0.0.1:1`, …), none
throws past the guard. Equivalent for every input found: it is the contract, not a path.

### F4 · tests: the tar's check asserts a function, not the run (§5)

"warns without throwing" calls `endRun` directly; nothing asserts what the run produced.
**Fix:** a turn with `localhost:4318`: one prompt posted, its answer in chat, the warning
in the log. Red on `main`'s code (2 prompts). Also removed: a redundant
`settings.otlpEndpoint = endpoint` and the `exported: withError` alias.

| Mutant | Result |
| --- | --- |
| no scheme guard (M1) | 2 red: both warning rows. 1 prompt: the outer `try` held the run |
| status message back (M4) | 2 red: both span-text rows |
| neither guard nor `try` (= `main`) | 4 red, 2 prompts |
| outer `try` removed, guard kept (M2) | survives; equivalent (F3) |

### F5 · docs: nothing recorded what was measured (Rule 1)

**Fix:** CHANGELOG and README 0.0.248, REFS 0.0.248, AGENTS §7 ("`endRun` never
throws", no error text), `docs/local-agent.md` C5.

## Decisions

### D1 · say it before the first turn: an endpoint the bridge cannot post to

**Done in 0.0.249, (a):** Diagnose's row adds "the bridge cannot post its own spans
there: it needs http:// or https:// (unsupported protocol localhost:)"; one check,
`otlpUnpostable` (`src/proc.ts`), serves the row and the export. `OT`, red on 0.0.248.

- **(a) recommended:** Diagnose's `opentelemetry` row adds "the bridge cannot post spans
  to `localhost:4318`: it needs `http://` or `https://`". Today the only sign is one log
  line per window.
- (b) `pattern` on the setting in `package.json` (`^$|^off$|^https?://`): the Settings UI
  flags `localhost:4318` as typed; an environment value is still unchecked.
- (c) leave it: one log line.

What OpenCode 2 itself does with `OTEL_EXPORTER_OTLP_ENDPOINT=localhost:4318` is not
measured; (a) and (b) should say only what the bridge does.

### D2 · rerun a 2.x turn whose prompt already went out?

**Done in 0.0.249, (a), on both majors:** `oc-api` marks a failure once the prompt
request is written (`markPromptSent`: 1.x `/message`, 2.x `/prompt` and its wait); only
`ECONNREFUSED` or a 4xx answer stays unmarked. `runAttempts` does not rerun a marked
error, and `failTurn` binds the chat to its session. On 0.0.248, a server that queues the
run and drops the connection: 2 prompts, "OpenCode failed to start: socket hang up", and
Continue went to a third, new session. `PS`, red on 0.0.248: 6 of 6. `PA`'s
fallback check now fails the POST with a 400, since a 500 on 1.x (whose POST answers
when the turn ends) is no longer rerun.

`runAttempts`' server-failed fallback reruns the turn. On 2.x the "CLI" is the same
server, so it is a retry, and after the prompt was posted it is a second paid run. F1 was
one way in; any other throw out of `runOpenCodeServer` after the POST is another (not
enumerated).

- **(a) recommended:** `runServer` marks an error thrown after the prompt was delivered
  (`posted`); `runAttempts` does not rerun such a turn and reports it with the session id
  kept, so Continue reaches the session that did the work.
- (b) no fallback on 2.x at all: a server that fails before the POST (boot, permission
  PATCH) is not retried either.
- (c) leave it.

### D3 · record 0.0.248 as delivered

`npm run ship -- --record` appends it to `docs/released.txt`; from then on any change to
`src/` or `package.json` needs a bump. The VSIX is built (`dist/`), not recorded: the
owner's call, after a real window (C5).

## The local agent's report (2026-11-27)

It reviewed "the current uncommitted changes" of its checkout and found: `trace.ts`
throws on `localhost:4318`, the span carries error text, the README has no 0.0.248
heading, and the regression checks are gone (1415 checks). Measured on `main` after
#22 merged (`7d11c55`): `endRun` threw for none of the five endpoints, the error span was
`{"code":2}`, the README had `### 0.0.248`, and the suite had the turn-level `TP` check
(1416 checks, green). Those uncommitted changes put 0.0.247-era files back over 0.0.248.
`docs/local-agent.md` already said the tree must be clean; it now says why.

## Order

1. F0, F1–F5 (this branch).
2. D2 (a): the larger safety fix; it needs a check that throws after the POST.
3. D1 (a).
4. D3 after `docs/local-agent.md` C4–C5 in a real window.

## Noticed, not changed

- The failure message reads "OpenCode failed to start: …" for a run that finished; the
  phase line says "retrying via cli" on 2.x, where it goes back to the server.
- On 1.x with `transport: server`/`auto`, the same wrapper threw; its fallback is a
  cold CLI run, which answers: two paid runs. Same code path, not measured.
- CHANGELOG's "releases before the last one are condensed" is not kept (0.0.244,
  0.0.247 are full).

## Unmeasured live

- OpenCode 2's own exporter with a scheme-less endpoint.
- A real collector (Aspire, Jaeger) receiving an error span with code 2 and no message.
- Windows and macOS: CI's `ship.yml` runs them on push.

## Debug

`docs/local-agent.md` C5: `otlpEndpoint` = `localhost:4318`, one `@oc` message. Expect one
answer, one `trace export to localhost:4318 failed: unsupported protocol localhost:` line,
no `server failed, falling back to CLI` line. On 0.0.247 the same message shows the answer
twice and "OpenCode failed to start".
