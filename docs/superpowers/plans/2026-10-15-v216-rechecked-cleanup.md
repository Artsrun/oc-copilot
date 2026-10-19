# v216 Rechecked Hardening and Dead-code Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver 0.0.216 with the confirmed shell write closed, honest enforcement notices, and removal of demonstrably redundant code and stale comments.

**Architecture:** Disable the shell tool for bridge-enforced agents rather than trying to classify arbitrary commands. Keep permission construction in `enforce.ts`, effective server rules in `server-session.ts`, and carry current-run enforcement evidence in existing metrics. Remove redundant wrappers and obsolete allowlist machinery without restructuring unrelated modules.

**Tech Stack:** Strict TypeScript/CommonJS, VS Code API, existing plain Node suite, existing scripted-model probes, real OpenCode 1.x, vsce.

## Execution status — 2026-10-15

Implementation completed inline for 0.0.216. Windows ship gate: 1,153 passing
checks; expanded installed OpenCode 1.18.35 probe: all 39 rows as expected.
Actual permission discovery preserves OpenCode's appended tool-output directory
read allow; writing/running tools still require final catch-all denies.
The gate's nested-artifact scan now excludes paths already deleted from disk,
consistent with its no-git parity check. Details and exact evidence: REFS.md.
Cross-version real-binary, POSIX and interactive VS Code manual checks remain
NOT OBSERVED in this environment; the checkboxes below retain their original
acceptance requirements rather than claiming those checks ran.

## Global Constraints

- Supersedes `2026-10-15-v216-hardening.md`; pending implementation, not a delivered release.
- Execute inline unless the user explicitly chooses delegation; named skills in the standard header must be available before use.
- Existing user changes are preserved. No commits, publishing, or artifact deletion without first inspecting the exact target.
- Version `0.0.216`: manifest, both lockfile fields, standalone server version; if already delivered when execution begins, select the next unused patch version.
- `npm run ship` is the only green light; never weaken it to hide the current blocker.
- All OpenCode processes use `spawnOpenCode()`. New probe workspaces and sentinels use the OS temp directory.
- Four-space indent, double quotes, semicolons; no new dependencies/settings/modules needed.
- Keep claim anchors, section numbers, permission inheritance rationale, and existing OpenCode 2 refusal.
- Keep useful tests. Removal requires an equivalent boundary assertion or evidence the behavior is gone.
- User-facing prompt/chip vocabulary remains in `src/followups.json`; update documentation and configuration descriptions alongside changed behavior.

---

## 1. Recap and evidence classification

| Finding | Rechecked evidence | Release action |
| --- | --- | --- |
| Package gate red | Fresh `npm run ship`: 1,147 passing checks; 39 tracked docs artifacts; 1 blocker | Inspect and remove exact artifacts |
| Enforced plan can write via Git helper | Real OpenCode 1.18.35 through `runOpenCode`: helper sentinel created, bash step done, exit 0 | Withhold shell tool |
| Current probe misses this | Fresh `node scripts/probe-readonly.js`: `ALL 24 ROWS AS EXPECTED` | Add helper and tool-absence regressions |
| Shell removal viable on cold CLI | Temporary scalar-deny experiment: no bash tool offered, no sentinel, zero steps | Validate final marker-bearing representation on every transport |
| Wildcard subagent mismatch | Generated override names `plan,*`; generated task rule `allow *` | Accept literal names only |
| Success notice can lack evidence | Invalid config returns undefined; notice still returns success text | Derive notice from actual run |
| Broad unused-code claim unsupported | TypeScript symbol scan found only intentional externally consumed entry points wholly unreferenced in src | Limit cleanup to proven redundant wrappers and replaced machinery |

### Corrections to the previous plan

1. A shell map ending in the marker rule can leave bash offered. Use marker first, catch-all deny last; test tool absence, not just pattern evaluation.
2. Scalar deny was experimentally effective on cold CLI; production needs the marker for cross-window discovery. Validate the ordered map before adopting it.
3. Current V2 documentation and retrieved V1.1.35 source do not establish local V1.18.35 parser parity. Keep exact version labels in evidence.
4. A successful `cat .env` policy match establishes another read path, not a general confidentiality guarantee. Allowed grep, web, user-approved MCP, and plugins need their own scope; this release promises tool permissions, not an OS sandbox.
5. Do not claim `git rev-parse --output` writes files; that Perplexity claim was not supported by the retrieved official manual.
6. Source comments are stripped by the build already (`removeComments: true`). Comment cleanup improves maintainability, not VSIX size.

### Research sources

- [Git diff options](https://git-scm.com/docs/diff-options/2.45.0): external diff and textconv execute helpers; disabling flags are not a general sandbox.
- [V1.1.35 permission engine](https://raw.githubusercontent.com/anomalyco/opencode/v1.1.35/packages/opencode/src/permission/next.ts): ordered matching and disabled-tool calculation.
- [V1.1.35 shell parser](https://raw.githubusercontent.com/anomalyco/opencode/v1.1.35/packages/opencode/src/tool/bash.ts): parsed command patterns differ from raw shell strings.
- [V1.1.35 wildcard implementation](https://raw.githubusercontent.com/anomalyco/opencode/v1.1.35/packages/opencode/src/util/wildcard.ts): `*`, `?`, and optional trailing ` *`.
- [Upstream report 39931](https://github.com/anomalyco/opencode/issues/39931): parser bypass report; regression inspiration, not independently confirmed on this machine.

## 2. File map

| Files | Responsibility/change |
| --- | --- |
| `src/enforce.ts` | Remove inspect classifier, sanitize literal subagents, require evidence for notice |
| `src/server-session.ts` | Validate effective deny ordering, carry current endpoint evidence, remove obsolete notice state/wrapper |
| `src/net.ts` | Remove spawn-intent enforcement shortcut when effective agent discovery replaces it |
| `src/metrics.ts`, `src/run-cli.ts`, `src/run-server.ts`, `src/chat-turn.ts` | Evidence for actual selected agent/transport, including fallback |
| `src/followups.ts`, `src/extension.ts`, `src/runs.ts` | Remove two test-only forwarding wrappers and their wiring |
| `scripts/verify-chat-output.js` | Boundary regressions, keep timing/reset test hooks |
| `scripts/probe-readonly.js` | Helper fixtures, tool-absence evidence, positive controls, accurate labels |
| `src/natural.ts`, `src/core.ts`, `scripts/ship-gate.js` | Shorten historical/redundant comments; preserve operational explanations |
| `README.md`, `CHANGELOG.md`, `AGENTS.md`, `REFS.md`, `docs/manual-checks.md`, `docs/v215-release.md` | Claims, code-name references, measured evidence, current instructions |
| `package.json`, `package-lock.json`, `src/git-scan-server.ts` | Version and setting description consistency |
| `docs/.vscode/settings.json`, `docs/out/*.js.map` | Inspect and remove confirmed accidental artifacts |

## 3. Implementation sequence

### Task 1: Establish next-version baseline and remove accidental artifacts

**Interfaces:** Existing runtime APIs unchanged; release ledger remains append-only.

- [ ] Read `docs/released.txt` and manifest; select the next unused patch version.
- [ ] Use `git ls-files docs` and the gate report to enumerate the exact 39 files. Inspect `docs/.vscode/settings.json` for intentional settings and the source-map metadata before deleting; preserve intentional content if found.
- [ ] Delete confirmed artifacts with explicit patches. Keep the current gate that detects nested build output.
- [ ] Bump all four version fields and add README/CHANGELOG version headings in the same change. Do not rewrite delivered version hashes.
- [ ] Run `npm run ship`; expected baseline: all checks green after artifact cleanup. Record exact count and result.

### Task 2: Replace inspect shell machinery with actual tool removal

**Files:** `src/enforce.ts`, suite/probe, README `look` example and enforced-turn sections, setting descriptions/manual checks.

**Consumes:** `enforcedConfigContent(existing?: string): string | undefined`.
**Produces:** Same API, with shell disabled for each generated enforced agent.

- [ ] Add failing suite assertions through existing `ext.__test.enforcedConfigContent`:

```javascript
const generated = JSON.parse(ext.__test.enforcedConfigContent("{}"));
for (const name of ["plan", "explore"]) {
    const entries = Object.entries(generated.agent[name].permission.bash);
    add(`RE ${name}: final bash rule disables tool`,
        JSON.stringify(entries.at(-1)) === JSON.stringify(["*", "deny"]) &&
        entries.every(([, action]) => action === "deny"));
}
```

- [ ] Run `npm run compile` then `npm run verify`; new assertions must fail before editing the generator.
- [ ] Replace `shellRules()` and its two arrays with one ordered map in `readOnlyPermission`:

```typescript
bash: { [ENFORCED_MARKER]: "deny", "*": "deny" }
```

- [ ] Delete `INSPECT_COMMANDS`, `NEVER_COMMANDS`, `shellRules`, and the loop constructing the old bash map. Keep `ENFORCED_MARKER`; it is discovery metadata, not a promise no command could have that name.
- [ ] Change README's recommended `look` agent to `bash: deny`; remove its command allowlist and revise LK suite expectations to preserve useful read/search and denied-write coverage.
- [ ] Extend the real probe with a temporary Git repo containing differing `a`/`b` and a platform-appropriate external helper writing a sentinel. Set `GIT_EXTERNAL_DIFF` only for the fixture and restore it in `finally`. Script `bash:git diff --no-index --ext-diff a b`; check absence of bash in the model tool list and absence of sentinel. `/dev` control must create it.
- [ ] Add cases for redirect-only input and standalone `--`, using only temporary sentinel writes, and verify bash is never offered. Include a denied attempt by an explore child. Do not use full-string wildcard simulation as parser proof.
- [ ] Replace old shell-positive probe rows with read/search/gitScan positive rows. Keep `/dev` and enforcement-off controls. Require evidence of a model request; an empty tool list from no request is not success.
- [ ] Run `npm run ship`, then `node scripts/probe-readonly.js`. Acceptance: helper controls write, enforced rows do not, actual tool lists omit shell on cold/managed/shared paths, inspection remains usable.

### Task 3: Sanitize subagent names at the shared input boundary

**Files:** `src/enforce.ts`, suite, probe.
**Consumes/produces:** Preserve `readOnlySubagents(): string[]`; output contains deduplicated, trimmed literal names.

- [ ] Add failing fixtures for `["*", "gen?ral", " explore ", "explore", "team/look"]`. Assert generated config keys and actual session POST/PATCH rules, not only the helper return value. Expected allowed list is `explore, team/look` once each.
- [ ] Filter and deduplicate once in `readOnlySubagents`:

```typescript
const listed = config().get<string[]>("readOnlySubagents", ["explore"]) ?? [];
return [...new Set(listed
    .filter((name) => typeof name === "string")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !/[*?]/.test(name)))];
```

- [ ] Test empty results deny all delegation and literal nested names are preserved. Restore shared suite settings after each fixture.
- [ ] Run `npm run compile` and `npm run verify`. In the real probe, attempt a general-child write with `readOnlySubagents: ["*"]`; require no write and a working `/dev` control.

### Task 4: Replace global notice state with evidence from the actual run

**Files:** metrics, enforce, server-session, net, runners, chat-turn, suite.

**Produces:** Add this type and optional field in `src/metrics.ts` (no new module):

```typescript
export type ReadOnlyEnforcement =
    | { kind: "enforced"; agent: string }
    | { kind: "disabled" }
    | { kind: "unverified"; agent: string; base?: string };
// In RunMetrics:
// readOnlyEnforcement?: ReadOnlyEnforcement;
```

- [ ] Add red host-stream cases: malformed inherited config; unenforced adopted server twice; unenforced then enforced endpoint; custom configured planAgent falling back to actual `plan`; and server-to-cold fallback. Success notice must never consume its once-per-install marker on an unverified run.
- [ ] Set cold-run evidence from the exact config injected into the actual process and actual selected agent. Capture the config once; avoid recomputing it only to claim a spawn succeeded. Do not change `spawnOpenCode`'s process ownership rules.
- [ ] Extend `readOnlyReach(base, cwd)` to verify effective ordered agent permissions using `GET /agent`: catch-all denies, no later allows for write/run tools, final bash tool rule catch-all deny, and marker. Treat old inspect-allowlist servers as unverified rather than accepting the marker alone.
- [ ] Remove `ownBase`, `ownOverrides`, `serverOverrides`, and `enforcedAgents` only after replacing every consumer with effective discovery. Retain agent-list cache behavior and test endpoint/directory scoping; no automatic server restart in this task.
- [ ] Carry evidence through both runners and fallbacks; final notice uses the agent that ran, not `planAgentSetting()` alone.
- [ ] Change `enforcedReadOnlyNotice` to accept evidence. Replace `withheldOn`/`withheldNoted`/`withheldNotice` with current-run unverified evidence and existing presentation suppression as needed; delete old exports/imports/re-exports together. Preserve accurate adopted-server limitations without implying this release secured servers it did not configure.
- [ ] Run `npm run ship`. Acceptance: old/unenforced servers never earn the new enforcement success notice or unrestricted delegation based on a stale marker; `/dev` rule restoration still passes.

### Task 5: Remove redundant wrappers and stale comments

**Files:** followups, server-session, runs, extension, suite, core, natural, enforce, ship gate, docs.

**Interfaces:** Keep `createBadger`, `readOnlyReach`, `setStartupDeadline`, `setReplyConfirmWait`, and `resetChipBackoff` available to existing tests.

- [ ] Replace suite use of `ext.__test.badgeMarks` with `(text) => ext.__test.createBadger()(text)` so each assertion retains fresh state. Delete only the one-line `badgeMarks` wrapper, its extension import, and test-hook property.
- [ ] Replace the three `subagentsWithheld` assertions with the underlying production result: `!(await ext.__test.readOnlyReach(base, work)).planEnforced` when enforcement is on. For enforcement-off fixture assert the returned allowed list and `planEnforced: false`. Delete the wrapper, runs re-export, extension import and hook; update AGENTS code-name references.
- [ ] Keep timing/reset hooks: tests actively call all three. Keep `activate`, `deactivate`, and `__test`: VS Code/Node consume them externally. Keep legacy permission handling and retired-command replies: current suite exercises both.
- [ ] Replace `enforce.ts` header/marker/notice comments with current invariants and a REFS pointer; remove the now-false claim that known inspect patterns close all writes.
- [ ] Shorten `natural.ts:4–15` research/history to a concise rule: answer-derived next asks, no model call, no cue means no chips. Move any unique useful evidence to REFS first. Correct lines 17–19: importing core imports vscode, so do not call it host-free.
- [ ] Shorten `core.ts:44–47` to explain own-property lookup preventing inherited-key matches; keep the reason, remove release-history narration.
- [ ] Remove version-prefix comments from the `scripts/ship-gate.js` ALLOWED list while keeping each allowed entry and the CHANGELOG exclusion explanation. Remove the stale `0.0.216 transport` promise in `scripts/probe-readonly.js:15`; label ACP research as such.
- [ ] In `docs/v215-release.md`, preserve historical evidence as dated evidence; add a current-checkout correction for the artifact claim and replace the conflicting next-version attachments/ACP commitments with a link to this plan. Avoid rewriting prior results as if rerun.
- [ ] Run `npx tsc --noEmit --noUnusedParameters`, `git diff --check`, and `npm run ship`. Check actual suite count; reductions are acceptable only for deleted wrapper wiring, never lost behavior coverage.

### Task 6: Final validation and immutable delivery

**Files:** release documentation/ledger; candidate under root `dist/`.

- [ ] Run `npm run ship` after final edits; record the exact all-checks line and final gate verdict in REFS.
- [ ] Run expanded real probes on local 1.18.35 and another explicitly identified supported 1.x version; verify cold, managed, adopted, shared, explore, plan-to-dev transitions and `/dev` controls. Repeat on POSIX. Record unavailable environments as NOT OBSERVED.
- [ ] Measure project-local `plan.md` and isolated global config overrides against effective discovery. If tool removal cannot be established, evidence remains unverified and docs must not promise enforcement for that configuration.
- [ ] Install candidate into VS Code: verify shell-free plan inspection, gitScan, `/dev` editing, Stop, streaming, session continuation, notices and attachments. Record exact host versions and outcomes.
- [ ] Verify `dist/` exists, package with `npx vsce package --out dist/`, then run `npm run ship -- --record` against the final candidate. Verify artifact SHA against the new ledger record and that archived runtime matches validated output.
- [ ] Review final status/diff and preserve earlier ledger entries. Return version, check results, artifact path/hash and remaining unobserved checks. Commit/publish only on explicit request.

## 4. Completion and next priorities

Done means the real helper regression is closed, enforced shell is absent, literal delegation is checked at the wire, notices reflect actual execution, cleanup preserves behavior tests, and the final ship gate is green.

After 0.0.216: bounded dirty/untitled/range/Problems text context first; images and ACP each need their own measured design. Do not mix those features into this cleanup release.
