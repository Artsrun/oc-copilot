# v213 Safety and ACP Spike Implementation Plan

> **For agentic workers:** Follow the repository instructions and execute this plan task-by-task inline. Steps use checkbox (`- [ ]`) syntax for tracking. Delegate only when explicitly authorized by the user or applicable repository instructions.

**Goal:** Release 0.0.213 with the identified v212 safety gaps closed. The ACP evidence work below is deferred follow-up, outside this release.

**Architecture:** Keep the existing 1.x transports and OpenCode 2 refusal during v213. Add a developer-only, bounded stdio ACP probe using the existing process launcher; capability discovery and real-model experiments decide the subsequent transport design. Do not connect the probe to chat routing.

**Tech Stack:** Plain TypeScript, Node.js, ES2022/CommonJS, VS Code chat APIs, newline-delimited JSON-RPC 2.0, ACP protocol 1; existing Node verification suite.

## Execution scope (2026-10-13)

The user selected a safety-only 0.0.213 release and requested a push without a
VSIX. Tasks 1–4 guide the safety implementation; tasks 5 onward remain future
ACP work. No production ACP support is included. The first regression run
printed `8 CHECK(S) FAILED`; the subsequent ship gate printed
`ALL 1105 CHECKS PASSED` and `ALL GATES GREEN — safe to package`.

## Global Constraints

- Every OpenCode process goes through `spawnOpenCode()`; do not add production `spawn(` call sites.
- Nothing is written into the user's workspace. Probe fixtures and raw transcripts go under the OS temp directory.
- New settings require manifest, suite base settings and matching defaults. v213 needs no new setting or transport enum.
- Words live in `src/followups.json`; no emoji; reuse existing marks and chips.
- Reproduce defects first and assert wire effects, not only returned values.
- `npm run ship` is the only green light; a red check is a blocker.
- Ignore files are LF-only. A new developer script must be named in `.vscodeignore`.
- Change code only after bumping the manifest, both lockfile version fields and standalone Git server version together.
- Internal login endpoints, credentials and raw company model catalogs stay out of repository documents and fixtures.
- No commits without the user's explicit request. Each task below is a review checkpoint, not permission to commit.

## Review baseline and validation

Reviewed the working changes against `af13f46` (`v211`), including source, suite, gate, package configuration and the two supplied documents. The working manifest is 0.0.212; no changes were staged.

Run on this Windows checkout:

```text
npm run ship
ALL 1087 CHECKS PASSED
ALL GATES GREEN — safe to package
git diff --check
exit 0
```

The gate printed 45 prospective extension files, 116 committable files, 17 anchored README claims and 90 cited code names. It also printed that no private leak tokens were configured. This run validates the local build and fake-agent suite; it does not reproduce the release document's sandbox, delivered-tar, VSIX or real-model measurements.

### Findings to resolve before the ACP work

| Priority | Location | Finding and evidence |
| --- | --- | --- |
| High | `src/net.ts:473-476` | Password redaction is per stream chunk. Feeding `server pass` then `word sampleSecret` leaves the complete secret visible; splitting the secret after `sample` leaves `Secret` visible. Current OC coverage emits the password as one write. |
| High | `src/server-session.ts:74-77` | Missing agent discovery becomes an unconditional session `task allow *`, which outranks the dev agent's restrictions. A mocked discovery failure produced exactly that rule. |
| High | `src/server-session.ts:94-98` | The applied-rules cache records only the read-only/headless rules. Plan → build → strict sends zero additional PATCHes on the final switch, leaving `general=allow` where strict requires deny. |
| High | `src/net.ts:565-579`, `src/run-cli.ts:45-77` | CLI identity detection depends on optional prewarming and is fire-and-forget. With prewarming off, or a turn arriving before detection, a V2-compatible plain run can be launched before refusal. The existing OC test waits for detection before prompting. |
| High | `docs/v212-release.md:38-42`, `docs/v213-opencode2-plan.md:3-11` | Both untracked documents contain an internal login endpoint despite instructing that it stay out of the repo. The gate was green because private tokens were absent and the generic hostname scan does not cover this endpoint. |
| Low | `docs/v212-release.md:3`, `docs/v213-opencode2-plan.md:83-85` | References point to absent `claude/` and `scratchpad/` paths. No ACP file exists in this checkout; start the probe from the existing process/probe conventions. |

The permission findings were reproduced against the compiled implementation with mocked HTTP/agent boundaries, not a live OpenCode server. The redaction finding used the exact source expression. Keep those distinctions in the evidence record.

## File map

| File | Responsibility in v213 |
| --- | --- |
| `src/net.ts` | Chunk-safe server diagnostics and transport-independent executable identity checking. |
| `src/server-session.ts` | Agent-aware task restoration and discovery-failure behavior. |
| `src/agents.ts` | Only if restoration needs an explicit distinction between discovered rules and unavailable discovery. |
| `src/chat-turn.ts`, `src/chat-parallel.ts`, `src/chat-worktree.ts`, `src/run-cli.ts` | Await identity before any CLI send; preserve Stop and existing server adoption behavior. |
| `scripts/verify-chat-output.js` | Boundary regressions and fake ACP process checks using Windows-wrapped fakes. |
| `scripts/probe-acp.js` (new) | Developer-only ACP client, scenarios, bounded recording and cleanup; no chat integration. |
| `.vscodeignore` | Explicitly exclude the new probe. |
| `package.json`, `package-lock.json`, `src/git-scan-server.ts` | Consistent 0.0.213 version. |
| `README.md`, `CHANGELOG.md`, `AGENTS.md`, `REFS.md`, `docs/manual-checks.md` | Honest release copy, probe entry and measured evidence. |
| `docs/v212-release.md`, `docs/v213-opencode2-plan.md` | Remove the endpoint and repair historical/prospective references. |
| `out/*.js` | Compiler output only, rebuilt by the gate. |

## Task 1: Establish the release boundary and fix document exposure

**Files:** The four version locations, release documents, README, CHANGELOG and REFS.

**Interfaces:** No runtime API change. The proposed release is 0.0.213; 0.0.212 artifacts remain immutable.

- [ ] Replace each internal login endpoint with `https://opencode.example.com`; make the command explicitly a template whose real value is obtained privately.
- [ ] Point the release document at the actual `docs/v213-opencode2-plan.md`; remove references to nonexistent source plans. State that the ACP probe will be created rather than extended from an absent scratchpad.
- [ ] Bump all four version locations before implementation. Add a 0.0.213 changelog heading describing safety work and a developer ACP spike, without claiming product V2 support.
- [ ] Run the leak gate with a private host/token supplied externally through `OCB_LEAKY` or `~/.ocb-leaky`. A green generic-only run is insufficient to verify removal of this known endpoint.
- [ ] Review the diff: only intended documents and version locations should change at this checkpoint.

## Task 2: Make server diagnostic redaction independent of chunking

**Files:** `src/net.ts`, `scripts/verify-chat-output.js`.

**Interfaces:** Preserve existing log and server-tail consumers. Maintain separate bounded line buffers for stdout and stderr; sanitize a complete line before it enters either the log or the failure tail.

- [ ] Add OC boundary cases that split `password`, its separator, and the secret across writes. Include CRLF split across writes, an unterminated final line, interleaved stderr and an oversized line.
- [ ] Use these exact fixture pairs, with delayed writes so the stream actually delivers separate chunks:

```javascript
const splits = [
    ["server pass", "word sampleSecret\n"],
    ["server password sample", "Secret\n"],
    ["server password ", "sampleSecret\r\n"]
];
```

- [ ] Run `npm run compile` then `npm run verify`; record the red cases before changing redaction.
- [ ] Buffer until line termination and flush on stream end. At a fixed 8 KiB line cap, discard the oversized line with a fixed diagnostic rather than logging an unsanitized prefix; reset at the next newline. Do not combine stdout and stderr partial lines.
- [ ] Assert that the full secret and every deliberately split secret fragment are absent from both log and chat; sanitized diagnostics and ordinary server messages still appear.
- [ ] Run `npm run ship` and inspect the diff before proceeding.

## Task 3: Preserve the active dev agent's task restrictions

**Files:** `src/server-session.ts`, optionally `src/agents.ts`, `scripts/verify-chat-output.js`.

**Interfaces:** Preserve `applyTurnPermission(base, cwd, sessionId, readOnly, agent)` and `noteTurnPermission(base, sessionId, readOnly)`. Internally distinguish kind state from the identity of the agent whose task rules were restored.

- [ ] Extend PM with plan → build → strict and plan → strict → build in the same session. Inspect the fake server's appended rules using its last-match evaluator.
- [ ] Add discovery-unavailable, missing-agent, absent-permission and malformed-permission cases after a read-only turn. Assert that none appends blanket task permission or sends an editing message with unverified restoration.
- [ ] Add same-agent repeated dev turns and untouched fresh dev sessions: no redundant restore PATCH, and no new session task rule respectively.
- [ ] Run the suite against the current implementation and record failures.
- [ ] Include the restored dev agent identity in cache validity. On dev-agent changes, append the newly verified task rules after previous session overrides. Keep the existing rule order so specific denies remain last.
- [ ] If authoritative task permissions are unavailable, fail preparation with a specific error instead of substituting `task allow *`. Do not reuse the old agent's cached restoration as proof for a new agent. Keep genuinely rule-free new dev sessions on their existing path.
- [ ] Propagate permission PATCH failures from `applyTurnPermission()` to turn preparation instead of logging and continuing. Update the applied-rules cache only after a successful PATCH. Prevent recovery or CLI fallback from sending the turn after a permission failure.
- [ ] Add failed-PATCH regressions for read-only application and dev restoration. Assert zero message sends and zero CLI run invocations after each failure; a subsequent successful retry must PATCH again before sending. Run these cases red against the current catch-and-continue implementation before changing it.
- [ ] Run `npm run ship`; record effective wire decisions, not just the PATCH array's shape.

## Task 4: Close the CLI identity-detection race

**Files:** `src/net.ts`, CLI entry/preparation paths, `scripts/verify-chat-output.js`.

**Interfaces:** Add one shared executable identity check returning `Promise<"v1" | "unsupported">`; key it by executable and retain one in-flight check. Keep explicit `/ping` able to refresh a refusal after the executable is replaced. A timeout, failed spawn or unparseable version is an error, not permission to run.

- [ ] Add OC scenarios with `prewarmServer: false`, an immediate turn during a delayed version response, `attachDevToServer: false`, CLI lanes, and a CLI worktree run. Use a V2 fake that accepts all plain-turn flags and records every invocation.
- [ ] Assert zero `run` invocations on V2; simultaneous callers share one version check; Stop during checking returns inside the host's one second and starts no run.
- [ ] Verify that a genuine 1.x server can still be adopted for HTTP turns even when the configured CLI is V2. Attached clients still need a compatible CLI; server adoption alone cannot authorize them.
- [ ] Run the suite red, then await the shared check before each CLI send boundary. Prewarming may prime the check but cannot be required for safety. Keep cached checks off the steady-state turn path.
- [ ] Document the first cold CLI check's measured latency. The existing prohibition on per-turn `--version` should remain true for subsequent turns; a one-time first-use wait is the explicit tradeoff for correct refusal.
- [ ] Run `npm run ship` and confirm `/ping` recovery still works after replacing the executable with 1.x.

## Task 5: Build a deterministic ACP probe, then validate its fakes

**Files:** Create `scripts/probe-acp.js`; modify `.vscodeignore`, suite and AGENTS probe table.

**Interfaces:** CLI below; emit JSON records with scenario, major/version, session identifier, update kind, elapsed time and outcome. Never emit auth answers, environment contents, raw model catalogs or unsanitized stderr by default.

```powershell
node scripts/probe-acp.js --self-test
node scripts/probe-acp.js --executable "C:\path\to\opencode.cmd" --scenario handshake
node scripts/probe-acp.js --executable "C:\path\to\opencode.cmd" --scenario prompt --model "provider/model"
```

- [ ] Use the existing probe's minimal VS Code stub to load `out/proc.js`; launch `spawnOpenCode(executable, ["acp"], tempCwd)`. Keep stdin open for JSON-RPC. Use `killTree()` for final cleanup.
- [ ] Implement a pending-request map, monotonic request IDs, newline framing across arbitrary chunks, separate stderr, and explicit handling for responses, notifications and agent-to-client requests. Reject malformed protocol frames and settle all pending requests on child exit.
- [ ] Set bounds: 1 MiB per frame, 4 MiB total diagnostic recording, 15 s ordinary request timeout, 120 s live prompt timeout, 2 s cancellation settlement before forced cleanup. Print which bound caused termination.
- [ ] Initialize with `protocolVersion: 1`, client information and no filesystem or terminal execution capability. Do not advertise client operations the probe cannot serve. Unknown agent requests receive JSON-RPC `-32601` rather than hanging.
- [ ] Inspect capabilities before calling optional methods. Discover configuration option IDs and values from the agent; do not hard-code effort or model option IDs from one build.
- [ ] For permission requests, select the supplied `reject_once` option by its actual `optionId`; if none exists, return `cancelled`. When cancelling a turn, settle pending permission requests with `cancelled`.
- [ ] Implement `session/cancel` as a notification, not an awaited request. Measure time until the pending `session/prompt` response settles and whether subsequent updates arrive.
- [ ] Fake-agent self-tests must cover split/coalesced JSON, Unicode across chunks, permission requests while a prompt is pending, unknown requests, child exit, timeout, absent capabilities and cancellation. Use the existing Windows fake-wrapper convention.
- [ ] Prove a broken fixture goes red: deliberately ignore cancel or omit a permission reply, and assert timeout/nonzero result. Do not treat an untriggered permission/cancel scenario as PASS.
- [ ] Explicitly exclude `scripts/probe-acp.js` from VSIX packaging. Run `npm run ship`; retain the current OC product-refusal assertions.

## Task 6: Run the ACP evidence matrix and make the transport decision

**Files:** Probe scenarios, `REFS.md`, `docs/v213-opencode2-plan.md`, `docs/manual-checks.md`.

**Interfaces:** Scenario names are `handshake`, `prompt`, `permission`, `cancel`, `load`, `readonly`, `isolation`, `metrics`, `compact`. Each prints PASS, FAIL, INCONCLUSIVE or UNSUPPORTED; unsupported capability is not a protocol failure and not product parity.

- [ ] Start with isolated HOME/config/data locations in OS temp directories. Record exact binaries and versions on 1.19.0 and the locally installed 2.x; do not extrapolate all ACP behavior from protocol version 1.
- [ ] Run handshake without a model. Record agent capabilities, auth method identifiers, model/mode/effort option availability and whether custom primary agents appear. Record lists of update kinds rather than raw private catalogs.
- [ ] With an authenticated model, run one short prompt and capture text/thought/tool update shapes. Authentication availability is evidence; a login method advertisement alone does not prove credentials work.
- [ ] Force a permission request in a disposable agent configuration, reject it and verify the target file is unchanged. Repeat with an automatically allowed edit to determine whether operations can bypass client permission requests. Changing OpenCode configuration requires its applicable configuration skill at implementation time.
- [ ] Test read-only direct edits, shell writes, writable MCP tools, subagent edits, mode switching and questions. Require evidence of attempted operations; a model declining to attempt the fixture is INCONCLUSIVE. Check files and child sessions, not just the parent's answer.
- [ ] Test plan → dev → plan on one session and with custom agents. Rejecting only received permission requests is insufficient if the agent can auto-allow an operation without sending one.
- [ ] Cancel during reasoning, a tool and a subagent. Check parent and children stop; updates for another live session must continue. Test two sessions with different directories and distinct markers in one ACP child.
- [ ] Test load versus resume. ACP load replays history before its response; record replay separately from new-turn output. Prefer advertised resume for reconnection if its real behavior matches the contract.
- [ ] Create a 1.x session in an isolated data folder, back up that folder under temp, then load it using 2.x and continue. Listing a migrated session is not proof that it loads or preserves context. Do not use the user's existing session database for this experiment.
- [ ] Measure usage/context/cost, root versus child accounting, model selection and effort reset, and compaction. An advertised `compact` slash command is not proof of a summary-only operation; detect any hidden continuation turn.
- [ ] Record company authentication and 1.x access separately on the intended machine, with endpoint and credentials kept private. If access is unavailable, record BLOCKED for that environment and do not fabricate a result.
- [ ] Decide from the matrix: proceed with ACP only if read-only enforcement, questions, cancellation/isolation and continuation are demonstrated. Record exact missing capabilities and whether a bounded ACP extension or separately scoped V2 HTTP investigation is needed.

## Release and later-version gates

- [ ] Self-review every task against the review findings and original v213 spike requirements. Every experiment must have a stated observable outcome.
- [ ] Run `git diff --check`, then `npm run ship` with private leak tokens configured. Paste the actual final pass count and gate output into REFS.
- [ ] If packaging is requested, use `npx vsce package --out dist/`, then run the gate's version-drift check. Do not rebuild an already-delivered version under the same number.
- [ ] Perform the existing v212 manual checks plus agent switching, prewarm-disabled V2 refusal and chunked diagnostic checks. Record host/model-dependent results separately from suite results.

**v213 acceptance:** Safety regressions pass; the probe is excluded from the extension; the evidence matrix accurately labels absent observations; the product continues to refuse V2; full ship gate green. Real-model evidence is required before approving the next ACP transport phase.

**v214 proposal:** Opt-in ACP only after the critical matrix gates pass. Include model/catalog and agent discovery, session controls, compaction, busy handling, permissions, cancellation, handoff, worktrees and lanes in parity scope; adding only `run-acp.ts` is insufficient. Preserve OC refusal tests for legacy transports and add ACP-specific running tests instead of globally flipping refusal assertions.

**v215 proposal:** Default selection only after opt-in results demonstrate parity. Define per-thread transport/major metadata and behavior when executables or transports change; avoid silently reinterpreting existing session IDs. A shared ACP child is a hypothesis until concurrent cancellation and crash recovery are measured.

## Public protocol references consulted

- <https://agentclientprotocol.com/protocol/initialization>
- <https://agentclientprotocol.com/protocol/session-setup>
- <https://agentclientprotocol.com/protocol/tool-calls>

These confirm capability negotiation, load replay versus resume, optional client filesystem/terminal operations, and permission responses using supplied option IDs. They describe the protocol; the target OpenCode versions still need the experiments above.
