# References and closed investigations

Findings that cost real time to establish. Each is dated and names what was
actually measured, so nobody re-derives it.

---

## 0.0.224: OpenCode 1 cannot open a data folder OpenCode 2 created (2026-10-20)

Windows 11, a live VS Code window with 0.0.223. `~/.local/share/opencode/opencode.db`
had been created by `@opencode/cli` 2.0.18 (no 1.x ever ran there). Its tables
(read from a copy with `node:sqlite`): `session_v2` (10 rows), `session_message`,
`session_inbox`, `migration` (48 rows), `project`, `workspace`, … and **no
`session` table**.

| `opencode-ai@1.19.3` | Result |
| --- | --- |
| `serve`, `agent list`, `run`, on that folder | exit 1, stderr `Error: Unexpected error` then `Database is not empty and has no session table` |
| `agent list` with `XDG_DATA_HOME=<empty temp dir>` | exit 0, agents listed, a fresh `opencode.db` |

The other order works (0.0.222 entry below: 2.x adds its tables to a 1.x
folder). The stderr is ANSI-coloured on a pipe (`\x1b[91m\x1b[1mError: \x1b[0m`),
and 0.0.223 put those codes in chat. `/ping` stayed green: it runs `--version`
and reads the model catalog, neither of which opens the database.

Also seen in that window: Copilot adds a text reference
`vscode.customizations.index` to every turn; 0.0.223 said "Not sent to
OpenCode: a text attachment" for it. Bridge overhead on a prewarmed 1.x server:
`pre-run: server 28ms`, first byte 416 ms; the rest of a 65 s turn was the model.

---

## 0.0.223: whose permission rules OpenCode 2 reads (2026-10-19)

Linux, `opencode-ai@1.19.0` and `@opencode/cli@2.0.29`, each in a temp git repo
with an isolated HOME and no `OPENCODE_CONFIG_CONTENT`. The project's
`opencode.json` set 1.x's `agent.plan.permission: {"*": "deny", read: "allow",
"v1-marker": "deny"}`, and `.opencode/agents/look.md` the frontmatter
`permission: {"*": deny, read: allow, v1-look-marker: deny}`.

| Where | 1.19.0 (`GET /agent`) | 2.0.29 (`GET /api/agent/<n>`) |
| --- | --- | --- |
| `opencode.json` `agent.plan.permission` | applied (`* * deny`, `v1-marker`) | **not applied**: plan's 7 stock rules, no marker, nothing logged |
| `.opencode/agents/look.md` `permission:` | applied | applied (`* * deny`, `read * allow`, `v1-look-marker`, then `browser * deny`) |

So a project's own restrictions in `opencode.json` silently fall away on 2.x;
the bridge's own plan is unaffected (its overrides are 2.x-shaped and verified).
`npm i --prefix <dir> @opencode/cli@latest` resolved to 2.0.32 on this date.

---

## 0.0.222: OpenCode 2 through its API, end to end (2026-10-19)

Linux, Node 22.22.0, `@opencode/cli` 2.0.29 and 2.0.32, each in a temp git
repo with an isolated HOME and the scripted model.

**One override cannot serve both majors.** An `OPENCODE_CONFIG_CONTENT` with 1.x's
`agent.plan.permission` and 2.x's `agents.plan.permissions`: 1.19.0's `GET
/agent` answered 400 `ConfigInvalidError` "V2 permissions are not supported by
OpenCode V1"; 2.0.29 listed plan's stock 7 rules (neither applied). So the
spawn takes the shape of the major `--version` named (`executableMajor`), and
with `opencode2` on the identity check runs before `serve`.

**The bridge, through `out/`** (`node scripts/probe-opencode2.js <2.x>`):
`ALL 9 ROWS AS EXPECTED` on both versions — a text turn answers with model and
tokens; plan `echo > file`, plan → explore `echo > file`, plan → general write:
absent (evidence `enforced`); control `/dev` `echo > file`: CREATED; plan →
explore `git status` runs (1 subagent counted); Stop returns 1 ms after the
cancel; `/sessions` lists them with the last ask and answer; control
`enforceReadOnly: false` plan `echo > file`: CREATED. No server left running.
1.x on the same build (`opencode2` off), `node scripts/probe-readonly.js` against
1.19.0: `ALL 48 ROWS AS EXPECTED`, as before.

**Fixtures** (`node scripts/record-wire-fixtures.js --v1 … --v2 …`): 1.19.0 text
turn 42 frames plus its POST reply; 2.0.29 text 15, permission ask 27,
subagent 37, interrupt 14 frames. Folder and session ids are placeholders; no
temp path survives (grep). Event names a recording did not exercise
(`session.tool.failed`, `session.reasoning.*`, `session.execution.failed`,
`session.compaction.ended`) are the ones the 2.0.29 binary declares (`strings`).

**The fake's own bug, found by the suite:** its SSE client was dropped on the
request's `close`, which Node ≥ 16 emits once an (empty) request body is read;
`res.on("close")` is the connection. The bridge read nothing until then (0×).

Red first: the same text turn through 0.0.221's committed `out/` (opencode2 set,
the TW fake) failed in 30 ms: "`opencode` here is not OpenCode 1: `--version`
prints `opencode v2.0.29`" — nothing ran.

---

## OpenCode 2's server API, measured (2026-10-19)

Linux, Node 22.22.0. `opencode-ai@1.19.0` and `@opencode/cli@2.0.29` (2.0.32
spot-checked: same rows), each with an isolated HOME, a fresh git repo and the
scripted model (`scripts/probe-model.js`). The capture scripts were scratch
code, not committed.

**v2 serves an API; earlier probes saw only its web app.** `serve` prints
`server password <secret>`; `/api/*` answers 401 `UnauthorizedError` without
auth and accepts **Basic `opencode:<password>`** (Bearer and a bare password:
401). `GET /openapi.json` lists 165 operations (OpenAPI 3.1). Every other path,
`/global/health` included, is the web app (HTML 200). Health is
`GET /api/info` → `{version, pid, urls, paths, capabilities}`. Boot 0.25 s
(1.19.0: 2.3 s).

- **Scope:** `location: {directory}` in a body; as a query it must be the
  deep object `location[directory]=` (flat `location=` is 400 InvalidRequestError).
- **Events** (`GET /api/event`, `: heartbeat` comments): `{id, created, type,
  location, data, durable: {aggregateID, seq}}`, every session event carrying
  `data.sessionID`. Text `session.text.delta` (`assistantMessageID`,
  `ordinal`); steps `session.step.{started,ended,failed}`; tools
  `session.tool.{called,progress,success}`; spend `session.usage.updated`;
  the end `session.execution.{succeeded,interrupted}`; compaction
  `session.compaction.{started,delta,failed}`; a subagent is a
  `session.created` with `parentID`, then its own session's events.
  1.19.0's `/global/event` wraps `{directory, project, payload: {type,
  properties}}`, plus `sync` events carrying the same durable aggregate/seq.
- **Prompt** `POST /api/session/:id/prompt {text}` returns the queued inbox item at
  once (`delivery: steer|queue`); the run ends on `session.execution.*`.
  Stop is `POST …/interrupt` → `{interrupted: true}`.
- **Rules** are `{action, resource, effect}` (1.x `{permission, pattern,
  action}`); a session takes `permissions` at `POST /api/session`. An ask is
  `permission.asked {id, action, resources, save, source}`, answered at
  `POST /api/session/:sid/permission/:id/reply {decision: once|always|reject}`
  (204), confirmed by `permission.replied`. Shell is `shell`, delegation
  `subagent`.
- **Agents load lazily per location:** `GET /api/agent/plan` 400 ms after boot
  was 404 `AgentNotFoundError` and `GET /api/agent` `[]`; polled, both answer
  within about 350 ms (7 agents).

**Read-only on v2.** Stock 2.0.29 and 2.0.32, plan turns over the API, no ask
answered: plan `echo > file`, plan → explore `echo > file`, plan → general
write: CREATED ×3. 1.x's `OPENCODE_CONFIG_CONTENT` shape (`agent.plan.permission`)
is ignored. v2's config is `agents.<name>.permissions: [{action, resource,
effect}]`: given that way, the rules are APPENDED after the agent's own (and
after a project `opencode.json`'s `shell * allow`, measured), `GET
/api/agent/plan` lists them with the marker, and all three rows are absent; a
top-level `permissions` lands on every agent. Session `permissions` alone also
kept plan → explore `echo > file` absent.

**CLI.** 2.x `run` rejects `--attach --dir --variant --pure`, takes
`--server`, `--standalone`, `-m provider/model#variant`; `models` rejects
`--verbose`; `agent list` is `debug agents`. Without `--standalone`, `run` and
`debug agents` start a background `serve --service` that outlives the call
(seen running after the probe exited): a later `run` uses it, so config handed
to that later process cannot reach it. `run --standalone --format json` prints
1.x's line shapes (`step_start`, `text`, `tool_use` with `shell`,
`step_finish`; a text-only turn ends without `step_finish`) in about 0.9 s and
leaves nothing running. Its `$PWD` decides the folder, as on 1.x.

---

## 0.0.220 gitScan: filter drivers and submodules (2026-10-19)

Review of the 0.0.219 import. Linux, git 2.43.0. A probe repo with
`*.txt filter=pwn`, `filter.pwn.clean = "touch PWNED; cat"` and a stat-dirty
`a.txt`: one `tools/call` to 0.0.219's `out/git-scan-server.js` created
`PWNED`. `-c filter.pwn.clean= -c filter.pwn.process= -c filter.pwn.required=false`
before `status` did not. A submodule whose own config names a filter: with
the top-level drivers blanked, `--ignore-submodules=none` still created the
marker (status recurses into the submodule); `dirty` and `all` did not.
`dirty` keeps commit changes, so it is the one used. Driver names come from
`git config -z --get-regexp '^filter\.'`, which runs nothing; a name with
`=` cannot be expressed through `-c` and the scan refuses.

Red first: the suite against the 0.0.219 build printed `2 CHECK(S) FAILED`,
exactly the two new GS checks; both fixture controls (the filter runs without
the protection) passed.

---

## v218 context budget review (2026-10-16)

A Node probe against v217's compiled context builder measured a 147764-byte
prompt from four 20000-character non-ASCII buffers: all were marked kept but
the fourth buffer was absent. One diagnostic produced 200096 bytes; a closed
range attachment performed one synchronous disk read. Excerpt budgets now count
UTF-8 bytes including truncation markers, diagnostic rows are capped at 1024
bytes, omitted unsaved text is reported, and closed ranges remain path-based.

## v219: merged config reopened read-only agents beyond the denied writers (2026-10-16)

Linux, Node 22.22.0, OpenCode **1.18.35** and **1.19.0** (`opencode-ai`, npm),
isolated HOME/XDG per run, `scripts/probe-model.js` as the model. The
`OPENCODE_CONFIG_CONTENT` was 0.0.218's own (generated from `out/enforce.js`).

**The defect, on 0.0.218's config** (project `opencode.json`, `run --auto
--agent plan`, a 15-line stdio MCP server whose `touch` writes a sentinel):

| `agent.plan.permission` in opencode.json | write tool | git helper | MCP `w_touch` | `task@general` write |
| --- | --- | --- | --- | --- |
| none (control) | no | no | no | no |
| `*: allow, edit: allow, bash: {*: deny, "git *": allow}` | no | no | no | no |
| `*: allow, "w_*": allow` | no | no | **YES** | no |
| `*: allow, task: {*: deny, general: allow}` | no | no | no | **YES** |

Identical on both versions. Server path: `opencode serve` with the same config,
`POST /session/:id/message {agent: plan}` → `Done. The tool said: touched`,
sentinel YES; 0.0.218's `overriddenOn` logic over that `GET /agent` answered
enforced. Cause, from `opencode debug agent plan`: OpenCode deep-merges config
objects and keeps the earlier file's key order, so `w_*` and
`task general allow` follow the overrides' `* * deny`. 0.0.217's scalar denies
cover only the keys the bridge names.

**What a clean merge leaves after the last `* * deny`** (both versions, plan and
explore, `opencode debug agent`): `git-scan_gitScan`, `read *`, `read
*.env.example`, grep, glob, list, lsp, skill, todowrite, todoread, webfetch,
websearch, `task explore` (plan only), and an appended `external_directory
<data>/opencode/tool-output/* allow`. That is the allowlist `readOnlyLeaks`
uses (plus `doom_loop`, the repeated-call prompt).

**`opencode agent list` prints each agent's merged rules** (the same array as
`opencode debug agent` / `GET /agent`, 1.18.35 and 1.19.0), so the cold path
reuses the listing the bridge already ran for planAgent. `opencode debug agent
plan` cost 1.9 s with one MCP server configured.

**After (0.0.219):** `node scripts/probe-readonly.js` → `ALL 48 ROWS AS
EXPECTED` on 1.19.0 and on 1.18.35. New rows: cold plan MCP reopened, cold
plan task→general reopened, managed serve MCP reopened → `refused before
sending` (ETURNPERMISSION, zero model requests, sentinel absent); controls with
`enforceReadOnly: false` → CREATED (MCP and general). All 0.0.216–0.0.218 rows
unchanged (read, gitScan, outside-folder refusal, adopted-server known row).

**Suite:** `ALL 1188 CHECKS PASSED` (Linux). Red-first: the new suite against
the 0.0.218 build printed `23 CHECK(S) FAILED` (RX, EX, UP, and the RE
marker-only / late-allow variants that now refuse). Gate `ALL GATES GREEN`.
`OC …its server password reaches neither chat nor the log` failed once in five
runs (a 1.5 s `waitFor` under load) and passed on rerun: timing, not 0.0.219.

**Leak gate:** a 70 KB echoed excerpt block leaked 71,837 characters through
0.0.218's 64 KB hold; `CONTEXT_HOLD_BYTES` (48 KB + 31 KB + 32 KB) holds the
full excerpt + problems block (`EX`, 79 KB).

**Side by side (not product code):** pnpm 10 installs 1.19.0 and 2.0.29 into
separate folders, but blocks both packages' postinstall (which places the
binary): `--version` printed "postinstall script was not run" until
`pnpm.onlyBuiltDependencies` named `opencode-ai` / `@opencode/cli`. 2.x also
installs an `opencode2` bin. Neither ships a WASM build (per-platform native
packages).

NOT OBSERVED: Windows, a VS Code host (manual checks A–E), OpenCode 2.x.

## v216 implementation validation (2026-10-15)

Implemented shell tool removal (marker first, final catch-all deny), literal
subagent filtering, effective GET /agent verification, per-run enforcement
metrics for cold/attached/server transports, and evidence-based notices. Removed
the old command classifier, spawn-intent shortcut, global withheld-notice state,
two test forwarding wrappers, and all 39 nested docs artifacts. The deleted
docs editor setting was only the existing default plan agent.

Red-first suite run printed two failures for shell withholding and literal
subagent configuration. After implementation, `npm run ship` printed
`ALL 1153 CHECKS PASSED` and `ALL GATES GREEN — safe to package`.
`npx tsc --noEmit --noUnusedParameters` and `git diff --check` exited 0.

Expanded `node scripts/probe-readonly.js` against installed OpenCode 1.18.35 on
Windows printed `ALL 39 ROWS AS EXPECTED`. Shell was absent on cold, managed
and shared plan calls; the external-helper sentinel stayed absent. `/dev`
executed the same helper and created the sentinel. Read, explore read, and
gitScan controls ran. Project-local and isolated global plan agent overrides
could not restore bash. Attached CLI and server runner metrics both reported
`{"kind":"enforced","agent":"plan"}`. Adopted unenforced plan shell remained
able to write, as documented; delegation was withheld and later dev delegation
worked.

The real probe exposed OpenCode's appended external_directory allow to its
tool-output folder. Checking that permission as a writing-tool deny falsely
rejected otherwise shell-free explore. The discovery check now validates
writing/running tools and preserves that read reach; a suite regression covers
the observed permission shape. Probe fixture corrections: Git requires forward
slashes for GIT_EXTERNAL_DIFF on Windows; refusal classification must precede
matching a successful read's content. No production permission was weakened for
these fixture fixes.

The artifact gate previously counted git's unstaged-deletion entries as files
still in the tree. It now filters absent paths before checking nested artifacts,
matching its existing leak scan and no-git parity check. Existing nested files
remain blockers.

NOT OBSERVED here: another supported real 1.x binary, POSIX execution, and the
interactive VS Code installation/manual checks. `wsl --list --quiet` returned
no distributions; `wsl --status` reported the WSL optional component unavailable.
Private leak tokens were not configured; the gate ran generic hostname checks.

Final packaging: `npx vsce package --out dist/` printed
`Packaged: dist\opencode-copilot-bridge-0.0.216.vsix (48 files, 151.87 KB)`.
`npm run ship -- --record` again printed `ALL 1153 CHECKS PASSED` and
`ALL GATES GREEN — safe to package`, verified packaged JS against out/, and
appended the immutable 0.0.216 entry. `Get-FileHash -Algorithm SHA256` matched
the ledger: `7373cc68993e861a32296712d9778c5e5d15c36851831494c5cbb03c2ed81d16`.
No commit, extension installation, or publishing was performed.

## v216 plan recheck: real helper write, tool removal, cleanup audit (2026-10-15)

Repeated `npm run ship` on Windows: `ALL 1147 CHECKS PASSED`, then
`1 BLOCKER(S) — DO NOT SHIP` for the same 39 tracked docs artifacts. Repeated
the existing real-binary matrix: `node scripts/probe-readonly.js` printed
`ALL 24 ROWS AS EXPECTED — 1.18.35 at opencode`. These existing rows do not
exercise Git external helpers.

A separate temporary probe used `scripts/probe-model.js`, the compiled
bridge's `runOpenCode`, isolated HOME from the probe, and a new temporary Git
repository. With `agent: plan`, `readOnly: true`, `autoApprove: true`, and
`enforceReadOnly: true`, the scripted model called
`git diff --no-index --ext-diff a b`. `GIT_EXTERNAL_DIFF` named a temporary
helper that wrote a sentinel. Output:

```text
mode=current, markerCreated=true, exitCode=0, steps=[bash]
mode=scalar-deny, markerCreated=false, exitCode=0, steps=[]
scalar-deny model tools: glob, grep, read, skill, task, todowrite, webfetch
scalar-deny answer: No bash tool offered
```

The second run replaced generated `permission.bash` with scalar `deny` in the
temporary probe's module only. It did not change repository runtime code.
This upgrades the earlier policy-plus-Git observation to an actual bridge / CLI
reproduction. Tool removal worked on 1.18.35 for this path; managed/adopted
servers and other versions still require the expanded matrix.

Perplexity research led to official Git diff documentation and OpenCode V1
source. Git documents external diff and textconv execution. The retrieved
OpenCode `v1.1.35` source uses `findLast` for rule evaluation and disables a
tool only if its last matching tool rule is `pattern: "*", action: "deny"`.
Thus the old plan's `bash: {"*": "deny", "ocb-enforced": "deny"}` is not a
tool-removal guarantee. Put the marker first and catch-all last, then verify
actual offered tools. This source tag is **1.1.35, not the local 1.18.35**;
fetching the presumed `v1.18.35` source URL returned 404. The shell parser also
normalizes commands, so a whole-command regex fixture is not parser parity.
Upstream issue 39931 reports zero-command/parser bypasses; that report has not
been reproduced here and is a regression input, not a confirmed local defect.

Sources checked through Perplexity and direct fetch:
- https://git-scm.com/docs/diff-options/2.45.0
- https://raw.githubusercontent.com/anomalyco/opencode/v1.1.35/packages/opencode/src/permission/next.ts
- https://raw.githubusercontent.com/anomalyco/opencode/v1.1.35/packages/opencode/src/tool/bash.ts
- https://raw.githubusercontent.com/anomalyco/opencode/v1.1.35/packages/opencode/src/util/wildcard.ts
- https://github.com/anomalyco/opencode/issues/39931

The retrieved wildcard source additionally makes the suffix ` *` optional;
the temporary earlier matcher omitted this. The helper command contains
arguments, so that discrepancy does not change the observed reproduction.
Perplexity also claimed `git rev-parse --output` writes a file, but the official
rev-parse page retrieved here documents `--output-object-format`, not that
option: exclude the unsupported claim from the plan.

Cleanup audit: a temporary TypeScript checker script followed aliased symbols
across `src/`. No function/variable export had only its declaration reference
except the intentional external entry points `activate`, `deactivate`, and
`__test`. Excluding imports/re-exports and the test-hook initializer found five
suite-only helpers: `setStartupDeadline`, `badgeMarks`, `subagentsWithheld`,
`setReplyConfirmWait`, and `resetChipBackoff`. Suite references exist for all.
The three timing/reset hooks are useful; the two forwarding wrappers can be
replaced by tests of their underlying production functions. This is a source
reference audit, not proof of every possible dynamic code path.
`npx tsc --noEmit --noUnusedParameters` exited 0 with no output.

Fresh plan: `docs/superpowers/plans/2026-10-15-v216-rechecked-cleanup.md`.

## 0.0.215 Windows review: gate blocker and permission gaps (2026-10-15)

Ran `npm run ship` on Windows in the current working tree: typecheck and build
passed; suite printed `ALL 1147 CHECKS PASSED`; package stage printed
`1 BLOCKER(S) — DO NOT SHIP`. The blocker is 39 tracked artifacts:
`docs/.vscode/settings.json` and 38 `docs/out/*.js.map` files. Confirmed with
`git ls-files docs`. The v215 release note says these were removed, but they
are still tracked here. The package file allowlist itself passed. No private
leak tokens were configured for this run (the gate printed that limitation).

A temporary Node probe loaded the compiled `out/enforce.js` with a minimal VS
Code configuration stub and evaluated its generated shell patterns using the
same last-match wildcard semantics as the suite. It then ran real Git in a
temporary repository, with an external diff helper that writes a sentinel:

```text
{"command":"git diff --no-index --ext-diff a b","permission":"allow","externalDiffWroteFile":true}
```

This measures the generated policy plus Git's side effect, not an end-to-end
OpenCode turn. `opencode --version` on this machine printed `1.18.35`; the full
real-binary read-only matrix was not rerun. The same policy evaluation allowed
`git show --textconv HEAD`, `git log --ext-diff -p`, and `cat .env`. Consequently
the inspect shell is not a read-only boundary, and its reads bypass the `read`
tool's `.env` rule.

With `readOnlySubagents: ["*"]`, the temporary probe printed override names
`["plan","*"]`, but the session rules ended in `task allow *`. Overrides are
constructed as literal agent keys while task permissions interpret patterns;
they must not share unchecked wildcard input. This was a generated-policy
check, not a real subagent execution.

Finally, `enforcedConfigContent("{not json")` returned undefined, immediately
followed by `enforcedReadOnlyNotice()` returning the success notice beginning
`Plan turns are read-only by permission now`. The notice checks the setting,
not proof that the current turn's process received the overrides. The server's
withheld notice also uses window-global state, rather than the current turn.

Implementation sequence: `docs/superpowers/plans/2026-10-15-v216-hardening.md`.

## 0.0.215: read-only by permission, measured on real binaries (2026-10-14/15)

Linux, Node 22.22.0. OpenCode **1.19.0** (`opencode-ai`) and **2.0.29**
(`@opencode/cli`, over ACP), each with an isolated HOME. The model is
`scripts/probe-model.js`, a scripted OpenAI-compatible server: every tool
attempt is certain; a real model may not try (INCONCLUSIVE, never PASS).
`scripts/probe-readonly.js` drives the bridge's own `out/` (`runOpenCode`,
`ensureServer`, `createServerSession`, `applyTurnPermission`, `spawnOpenCode`).

**What leaked before (0.0.214 plus the agent's two fixes, rebuilt as 0.0.214):**

```text
cold run · plan · shell `echo > file`                          CREATED
cold run · plan → explore · shell `echo > file`                CREATED
cold run · plan · read a file outside the folder (--auto)       runs
managed serve · read-only session · plan → explore · `echo >`  CREATED
adopted serve · read-only session · plan → explore · `echo >`  CREATED
cold run · plan · tools offered                                bash, edit, …, write
```

The built-in `plan` is read-only by instruction (its `edit` deny covers the
write tool, not the shell); `explore` lists `bash * allow` (1.19.0; `shell *
allow` on 2.0.29), so `task allow explore` — the bridge's read-only session
rule since 0.0.203 — let a plan turn write. On 2.0.29 `plan` also hands work to
`general`, which writes, and Code Mode's `execute` can `fetch` any URL and call
`tools.opencode.worktree_create`/`session_move`.

**After (0.0.215), `ALL 24 ROWS AS EXPECTED` on 1.19.0:**

| Path | Row | Result |
| --- | --- | --- |
| cold `run` | plan · shell `echo > file` / write tool / → explore `echo >` / → general write | absent ×4 |
| | plan · `git status`; → explore `git log --oneline`; gitScan MCP | runs ×3 |
| | plan · read an attached file outside the folder | refused |
| | plan · tools offered | bash, git-scan_gitScan, glob, grep, read, skill, task, todowrite, webfetch |
| | control: `enforceReadOnly: false` · `echo >`; `/dev` · `echo >`; `/dev` · outside read | CREATED, CREATED, runs |
| managed `serve` | `GET /agent`: `plan` lists `bash ocb-enforced deny` | listed |
| | plan → explore `echo >` / `git status` / outside read | absent / runs / refused |
| adopted `serve` (no overrides) | plan → explore `echo >` (no subagent starts) / → general write / `git status` | absent / absent / runs |
| | plan's own shell `echo >` | CREATED — by instruction only there (README) |
| | the same session's next `/dev` · build → general `echo >` | CREATED |
| | control: `enforceReadOnly: false` · plan → explore `echo >` | CREATED |
| another window's `serve` (overrides on) | plan → explore `echo >` / `git log` | absent / runs |

2.0.29 over ACP (`opencode acp` spawned through `spawnOpenCode`, asks rejected
on plan turns, allowed on `/dev`): `ALL 8 ROWS AS EXPECTED` — plan `echo >`,
→ explore `echo >`, → general write: absent; `git status` runs; outside read
refused; plan offered `glob, grep, read, shell, skill, subagent, webfetch,
websearch` (no `execute`, `write`, `edit`, `question`); controls (`/dev`,
enforcement off) CREATED.

**Facts that decided the design (1.19.0 unless named):**

- `OPENCODE_CONFIG_CONTENT` is deep-merged over the config files (`opencode.json`,
  `.opencode/agents/*.md`). Existing keys keep their earlier position and new
  keys append to the end (1.18.35, 1.19.0 measured): an override with only
  `"*": "deny"` and `bash: { "ocb-enforced": "deny", "*": "deny" }` left
  `edit: "allow"` and `bash: { "git *": "allow" }` after `"*"` when a project
  config defined them. Setting scalar `"deny"` on every writing/running tool
  (`edit`, `write`, `patch`, `apply_patch`, `multiedit`, `bash`, `shell`,
  `execute`, `question`, `plan_enter`, `plan_exit`) and top-level
  `ocb-enforced: "deny"` replaces any earlier pattern map on those keys and
  withholds `bash`, `edit`, and `write` completely (`tools: { bash: false, edit:
  false, write: false }`, measured on 1.18.35).
- **A task child inherits only its parent session's deny rules**: the child of
  a session with `task allow explore` and an inspect allowlist got `question …
  deny`, `task * deny`, `edit * deny`, `bash * deny` and the `bash` denies —
  no allow — then `todowrite`/`task` deny. Consequence, measured: after strict
  read-only rules plus the dev agent's rules re-applied, a `/dev` turn's
  `general` could not write (`echo > file` absent). So no `bash`/`edit` deny
  goes on a session; a server without the overrides gets no subagents instead.
- **A message's `tools` map replaces the session's permission list**: `POST
  /session/:id/message` with `tools: {question: false, plan_enter: false,
  plan_exit: false}` turned 39 session rules into those 3, and the next
  `general` wrote. Not used: an attached `opencode run` sends no such map.
- MCP tools are permission-named `<server>_<tool>`: `git-scan_gitScan`. On
  2.0.29 no MCP tool is offered directly; they are reached through `execute`.
- `opencode run --auto` approves an `external_directory` ask: a 0.0.214 cold
  plan turn read a file outside the folder; the overrides deny it.

**Suite.** `ALL 1145 CHECKS PASSED` (Linux; the agent's base had 1117 on
Linux, 1119 on Windows: +28). Red first: the final suite against the agent's
build (shims for the three new `__test` keys) → `22 CHECK(S) FAILED`, all new
`RE`/`JN` checks, among them `RE a read-only turn on a server the bridge did not
start starts no subagent, explore included (explore: allow)`. The final probe
against that build: 9 rows red (the six leaks above, the missing marker,
another window's explore `echo >` CREATED, and a managed-serve outside read
that waited 180 s on an `external_directory` ask nobody answers) before the run
was cut at the time limit.

**The suite's model of the server** (`v5`): wildcard last-match evaluation
(`v5Eval`), `explore`'s 1.19.0 rules, and a delegation `[[delegate:<agent>]]
[[cmd:<shell>]]` whose child gets the parent's deny rules only.

**Gate.** `OCB_LEAKY` set: `ALL GATES GREEN` (Linux). Self-check: a planted
`docs/out/zz-plant.js.map` → `FAIL 4/4 no build output outside out/ and dist/`;
a `docs/released.txt` line for 0.0.215 with another code hash → `FAIL 4/4
delivered 0.0.215 still builds from its own code`. `npx vsce package --out
dist/` → 48 files, 152.12 KB, sha256
`ae0dde3d0953b6fc4dd072fc46d12e3cb7b9ebb60eb4c4ae7a421b9934b9f388`, recorded
with `npm run ship -- --record`. 0.0.214's line holds the delivered VSIX
(`21b8768b…0903`), whose manifest and 39 `out/*.js` match the 0.0.214 tree
byte for byte. Windows not run here.

---

## v214 Windows review follow-up (2026-10-14)

On this Windows checkout, the received changes passed `npm run ship` with
`ALL 1115 CHECKS PASSED` and `ALL GATES GREEN — safe to package`.
Two additional boundary regressions then made `npm run verify` print
`2 CHECK(S) FAILED`:

- `OC refused parallel turn offers its original lanes as Retry on parallel,
  plus Ping, never Continue`: no recovery chips were returned, because the
  parallel outcome bypassed failure handling and carried no replay text.
- `OC a retargeted Windows shim is resolved and checked again before any run`:
  replacing only the wrapper left its cached old target running. The old
  target and script were unchanged, so the stamp never invalidated resolution.

The executable stamp now includes the original launcher file. Refused parallel
turns carry unsent/replay metadata and use the existing failure chip cases,
with Retry explicitly routed back to parallel. Cancellation after the identity
wait returns before agent discovery. Tests use fake processes and HTTP;
no live model or interactive VS Code host was exercised in this follow-up.

After the fixes, `npm run ship` printed `ALL 1119 CHECKS PASSED`; its package
gate found an existing 0.0.214 VSIX differing in chat-parallel.js, chips.js and
proc.js. That pre-review package was preserved in the approved OS temp folder
as `opencode-copilot-bridge-0.0.214-before-review-20261014.vsix` before rebuilding
the explicitly requested v214 artifact.

Final `npm run ship` printed `ALL 1119 CHECKS PASSED` and `ALL GATES GREEN —
safe to package`. `npx vsce package --out dist/` produced
`dist/opencode-copilot-bridge-0.0.214.vsix` (47 files, 145.83 KB).
A PowerShell ZipFile comparison verified all 39 archived out files and the
manifest byte-for-byte against disk. SHA-256:
`591aab3136e1eaa2c7617a067b0cca6777679f0cb9a25748260db371093a45d4`.

---

## 0.0.214: 0.0.213 reviewed on Linux (2026-10-13)

0.0.213 as received (a tar of the Windows checkout), extracted on Linux,
Node 22.22.0, `npm ci`, `OCB_LEAKY=<org name>`:

```text
npm run ship                      -> FAIL   OC ping lifts refusal after replacing the executable with 1.x
                                     1 CHECK(S) FAILED   (1108 others ok; gate stops at 3/4)
the same, that one fake rewritten
through writeFake                 -> ALL 1109 CHECKS PASSED
                                     FAIL  4/4 no internal names in any files
                                     docs/v213-opencode2-plan.md:20, :29
```

The check rewrote `fake-oc2-cli.js` with `fs.writeFileSync` and no shebang. On
POSIX `writeFake` returns the script itself, so the spawn ran it through
`/bin/sh` (`Syntax error: word unexpected (expecting ")")`, reproduced with a
shebang-less file and `execFileSync`); `/ping` saw no `1.19.0` and the refusal
stayed. On Windows every fake is a `.cmd` that calls `node`, which is why
0.0.213's own run passed. Its gate run printed that no private leak tokens were
configured; with one, the org name in the plan document fails gate 4.

Review findings beyond the gate, all reproduced in the suite before the fix
(the six new checks, run against 0.0.213's build, printed `5 CHECK(S) FAILED`;
the sixth — an unchanged executable is not checked again — holds on both):

- The identity cache was keyed by the `executable` string for the window: a
  1.x rewritten in place as a 2.x whose plain run answers ran a `transport:
  cli` turn — chat `"ran on two"`, one `run`, no `--version`. `executableStamp`
  costs 2.4 µs a call (20 000 calls, cached resolution) and changes when the
  file is rewritten in place (a Node probe over `out/proc.js`).
- A turn refused before sending (permission rules not set, identity not
  confirmed) offered Continue, and said "OpenCode failed to start".
- A first `/parallel` on a 2.x CLI cut the refusal to 120 characters under each
  lane (``…drives OpenCode 1 only so far (its …``), without the 1.x recipe.

Final, same machine, `OCB_LEAKY` set: `ALL 1115 CHECKS PASSED`, `ALL GATES
GREEN — safe to package` (93 cited code names, 17 claims);
`dist/opencode-copilot-bridge-0.0.214.vsix`, 47 files, 145.68 KB. Not run:
Windows, a real OpenCode, a model — `docs/manual-checks.md` › 0.0.214.

---

## v213 safety implementation (2026-10-13)

Before implementation, `npm run compile && npm run verify` printed
`8 CHECK(S) FAILED`: strict-to-build restoration, unavailable restoration,
failed plan/dev PATCH barriers and retries, split password output, and CLI
identity with prewarming disabled. These are fake-process/HTTP boundary checks,
not live-model measurements. The release scope excludes ACP implementation.

Final `npm run ship` printed `ALL 1105 CHECKS PASSED` and
`ALL GATES GREEN — safe to package` for 0.0.213. It listed 45 prospective
extension files; no VSIX was created. Additional checks covered missing and
malformed permissions, failed discovery, concurrent identity checking, Stop,
unknown/nonzero version output, `/ping` recovery, separate diagnostic streams,
CRLF, unterminated lines and oversized-line discard. The diagnostic fixture
initially also emitted server secrets on its unrelated CLI fallback; restricting
that fixture to `serve` isolates the server-output boundary it measures.

The pre-commit review reproduced two regressions: invalid permission actions
were accepted, and a permission-preparation 404 suppressed deleted-session
recovery. `npm run verify` printed `2 CHECK(S) FAILED` before the fixes.
Permission actions now accept only allow/deny/ask; missing-session errors retain
the existing fresh-session recovery. Four additional checks cover the agent HTTP
boundary and deleted plan/dev sessions. `npm run ship` then printed
`ALL 1109 CHECKS PASSED` and `ALL GATES GREEN — safe to package`; no VSIX was created.

---

## v212 working-tree review and v213 entry gates (2026-10-13)

On this Windows checkout, reviewed the changes against `af13f46` (v211).
`npm run ship` printed `ALL 1087 CHECKS PASSED` and
`ALL GATES GREEN — safe to package`; `git diff --check` exited 0. The package
listing contained 45 extension files; the committable-tree comparison contained
116 files. No private leak tokens were configured, as the gate explicitly noted.
This run did not reproduce the release document's delivered-tar, sandbox or
real-model measurements.

Two Node commands reproduced gaps beyond the suite:

```text
plan -> build -> strict: extra PATCHes=0, effective general=allow, strict expected deny
failed agent discovery: task rules sent=[{"permission":"task","action":"allow","pattern":"*"}]
chunked redaction=["server pass","word sampleSecret\n"]
chunked redaction=["server password [redacted]","Secret\n"]
```

The first command loaded compiled `server-session.js` with mocked HTTP and agent
discovery, collected appended rules and evaluated the final matching task rule.
It is a boundary reproduction, not a real OpenCode measurement. The second used
the exact server-output redaction expression from `net.ts` with split chunks.
Restoration does not include agent identity in its cache, failed discovery adds
blanket task permission, and per-chunk redaction leaks split password fragments.

Source review also found CLI version detection behind optional prewarming and
not awaited by an immediate turn. Both new release/plan documents contain a
non-example login host despite their own instruction to keep it outside the
repository; a hostname-count command printed one per document without echoing
the host. The generic-only leak gate did not detect it.

The implementation sequence and ACP evidence matrix are in
`docs/superpowers/plans/2026-10-13-v213-safety-and-acp-spike.md`. No product code
was changed during this review. ACP protocol documentation was consulted for
capability negotiation, load replay, resume and permission responses; no ACP
binary or authenticated model was run during this review.

---

## OpenCode 1.19.0 and OpenCode 2 (2.0.27), run without a model (0.0.212)

**Dated 2026-10-12/13.** Binaries `opencode-linux-x64@1.19.0` and
`@opencode/cli-linux-x64@2.0.27` in a sandbox, a throwaway `HOME` each, curl and
a stdio client; no model was called. Source: `anomalyco/opencode` tags v1.18.35
and v1.19.0, diffed.

**1.18.35 → 1.19.0** touches nothing the bridge calls (the PTY origin check,
`upgrade --major` and the V2 installer, the TUI, provider message conversion).
On a 1.19.0 server: health is `{"healthy":true,"version":"1.19.0"}` after about
1.6 s; `GET /agent` lists each agent with its own `permission` rules, every
list starting `{"permission":"*","pattern":"*","action":"allow"}` (the built-in
`plan` adds `task general deny`); `POST /session` with rules, status, abort and
`/children` work; a fork copies no permission; archive hides a session from
`roots=true`; `DELETE` answers `true`. SSE adds an unattributed `sync` event
after each event (never counted as activity). A reply to an unknown permission
or question id is now a 404 (`PermissionNotFoundError`), not #15386's 200. An
unknown model answers `POST …/message` with HTTP 500 plus a `session.error`
"Model not found: … Did you mean …?". `opencode --version` prints `1.19.0` and
takes about 0.7 s (three runs: the Bun binary starting).

**Session rules merge, they are not replaced.** POST a session with 5 rules,
PATCH 1, GET returns 6: `handlers/session.ts` calls
`Permission.merge(current.permission, payload.permission)`, and
`permission/index.ts` has `merge = rulesets.flat()` and `evaluate … findLast`.
Session rules come after the agent's (`session/llm.ts`, `prompt.ts`), so they
win. 0.0.211's `/dev` PATCHed the headless rules alone after a plan turn, and the
plan turn's `task deny *` stayed last: `general` stayed denied. 0.0.212 appends
the dev agent's own `task` rules from `GET /agent` (a `*` permission rewritten
as `task`), with `task allow *` first when they leave a pattern open.

**OpenCode 2 is another program called `opencode`.**
- `serve` prints `server listening on http://…` and `server password <secret>`,
  and answers `/global/health` — every path — with its web app: 200, HTML.
- `run` with `--attach`, `--dir`, `--variant` or `--pure` prints its help on
  stdout and `ERRORS` / `Unrecognized flag: --attach in command opencode run`
  (one line per flag) on stderr, exit 1. It takes `--agent`, `--format json`,
  `--thinking`, `--auto`, `--session`, `--fork`, `--title`, `--file`,
  `--server <url>` (instead of `--attach`) and `--model provider/model#variant`.
  A plan turn's cold fallback (`run --agent plan --auto --format json
  --thinking`) therefore ran on 2.x, without the bridge's rules.
- `--version` prints `opencode v2.0.27` in about 0.1 s.
- Logging in to an organization's server is `opencode auth login <integration>
  --method <id> --answer key=value` on 2.x; 1.x has `auth login [url]`
  (a well-known provider URL) with `-p` and `-m`, and no `--answer`.
- Both keep their data in the same folder (`~/.local/share/opencode/opencode.db`
  on Linux): a session 1.19.0 made was listed by 2.0.27 after 2.x opened the
  folder (the file grew, it added its own tables), and 1.19.0 still opened it
  and listed its session afterwards. OpenCode's migration guide: the two share
  config locations, a config converted for 2.x is not for 1.x, and the 2.x
  installer replaces a 1.x binary.

**Both speak ACP (Agent Client Protocol) the same way.** `opencode acp`, then
`initialize` (`protocolVersion: 1`) and `session/new` (`cwd`, `mcpServers: []`)
over stdio: 1.19.0 answered in 1.9 s + 1.2 s, 2.0.27 in 2.9 s + 2.6 s. Both list
`loadSession`, session `close` `fork` `list` `resume`, embedded context and
images, an `opencode-login` auth method ("Run `opencode auth login` in the
terminal"), and `configOptions` for `model` (247 / 235 choices) and `mode`
(`build`, `plan`); 2.x adds `effort` (`thought_level`), session `delete` and
`additionalDirectories`, and `_meta: {"opencode/child-session-updates": true}`.
One transport for both majors is possible (the OpenCode 2 track).

## Suite time: an orphaned server start and a timer nobody cleared (0.0.212)

**Dated 2026-10-12.** A timed copy of the suite: SB4 ("a /parallel turn that
waits on a first boot says so") took 44 792 ms and its log had no `serve` spawn
of its own fake — it joined SB3's start, which `deactivate()` had orphaned: the
poll loop read the module's `serveProcess` and polled a dead port to the 45 s
deadline. `stopServer()` now drops the start in flight, and that start sees its
process is gone. SB4 then spawns its own server and takes about 3 s. Separately
the summary wait raced `delay(60 s)` and never cleared it: the process idled
about 23 s at exit. Wall time 2m45s → 2m05s; CPU time stays about 9 s.

---

## 0.0.211 follow-up context filter review

`npm run verify` against the previous build printed `7 CHECK(S) FAILED`:
blank-line inline resets (LF/CRLF), invalid fence closers, separating whitespace
(space/newline), and filtering after oversized tag/preamble blocks. The fixes
scope fail-open release to the current block, track blank-line and closing-fence
state across chunks, and retain whitespace when preceding output needs a separator.
`npm run ship` on 0.0.211 printed `ALL 1056 CHECKS PASSED` and
`ALL GATES GREEN — safe to package`; the 1 MB check measured 19.3 ms.

## 0.0.210 leak filter and gitScan review

**Dated 2026-10-09.** Branch `v188` already held 0.0.209 at `04417d7`;
`git switch -c v210 v188` preserved that baseline. `npm run ship` on the baseline
printed `ALL 1007 CHECKS PASSED` and `ALL GATES GREEN — safe to package`.

Added GT reproductions before editing the implementation: `npm run verify`
printed `9 CHECK(S) FAILED`, including selection/cursor preambles, inline/fenced
mentions, mid-line separators, nested context and the 1 MB case (8050.9 ms).
The incremental bounded implementation's later suite measured 33.9 ms for
the same 1 MB / 50-character-chunk shape. The 64 KiB cap deliberately releases
oversized content; this is a resource limit, not a guarantee to hide such blocks.

Installed `@types/vscode` documents the positional MCP constructor and permits
`process.execPath`. Its `version` documentation promises a refresh prompt when
tools change, not an unconditional automatic server restart. Keep API guards for
the extension's older supported hosts. A host-free context-markers leaf avoids
making the pure format module depend on the context module's host/filesystem code.

GS tests real newline-delimited JSON-RPC and Git porcelain-v2 NUL records against
temporary repos; rename records consume an extra source-path token. Copilot
definitions and OpenCode's own MCP configuration are independent. The copied
server imports only Node built-ins; OpenCode's snippet needs Node on PATH.

Final `npm run ship` printed `ALL 1048 CHECKS PASSED` and
`ALL GATES GREEN — safe to package` (four gates). The 1 MB filter check printed
`25.4ms`. GS proved the fsmonitor fixture executes without the protection, then
does not execute with the server's override. `git diff --check` exited 0.
VS Code GUI installation and live Copilot/OpenCode MCP discovery remain manual
checks in `docs/manual-checks.md` (then `docs/test-vsix-0.0.210.txt`); no VSIX was created during this task.

---

## Agent Host Protocol — no third-party harness adapter

**Dated 2026-09-09. Closed. Do not re-investigate.**

The question: can OpenCode be plugged into VS Code's Agent Host as a harness, so
the bridge stops being a chat participant and becomes a first-class backend?

**No.** The provider set is closed and host-internal.

| Want | Available today |
| --- | --- |
| 3P AHP **client** | Yes — official SDKs + AHPX |
| 3P AHP **host** package | No — spec only; the server is VS Code |
| 3P **harness adapter** inside VS Code's Agent Host | **No** |
| Tools / plugins / MCP / persona agents | Yes — but not a new runtime |
| Custom client transport | Yes (`AhpTransport` / `Transport`) |

What was checked:

- The providers are `CopilotAgent` (always), `ClaudeAgent` (default on) and
  `CodexAgent` (default off), registered only via
  `providerService.registerProvider(...)` in `agentHostMain.ts` /
  `agentHostServerMain.ts`.
- There is no `contributes.agentHostAdapter` contribution point.
- There is no `IAgent` in `vscode.d.ts`.
- `agentHostExtensionProtocol.ts` is debug/worktree/trust RPC. It is not an
  adapter surface.
- The proposed `chatSessions` API is extension-host session listing, not AHP.

**Where the earlier error came from — a diagram is not an API.** The architecture
diagram on <https://microsoft.github.io/agent-host-protocol> shows
"Copilot / Claude / Codex / ACP" as agent backends. That is a description of what
the first-party host happens to contain, not an extensibility contract. Verify
against `src/vs/platform/agentHost/**` before believing any claim of
pluggability.

**Consequence.** The session, handoff, retention and briefing machinery in
`session.ts` and `chat-turn.ts` is permanent code, not transitional code. It has to be correct,
not merely adequate.

---

## The marketplace repository link was SSO-walled, not merely dead

**Dated 2026-09-09. Fixed in 0.0.162.**

`package.json` shipped
`https://github.com/<employer-org>/opencode-copilot-connect.git` as
`repository.url`, with `homepage` and `bugs` pointing at the same place.

Measured: the URL does **not** 404. It redirects to *"Single sign-on to <employer>
LLC"*. So the rendered "Repository" link was simultaneously useless to everyone
outside the enterprise and an advertisement for the employer.

All three fields were removed — an absent link is honest, a dead one is not. The
ship gate's `LEAKY` scan was widened to the bare org token, and a new check
requires `repository`/`homepage`/`bugs` to be absent or on a public host.

---

## `process.exit()` truncates the ship gate's view of the verify suite

**Dated 2026-09-22. Fixed in 0.0.172.**

`scripts/verify-chat-output.js` ended with `process.exit(failed === 0 ? 0 : 1)`.
When stdout is a **pipe** — which it is whenever `ship-gate.js` spawns it —
`process.stdout.write` is asynchronous and `process.exit` does not drain the
pending writes.

Measured on the same all-green run, same machine, same build:

| stdout is | bytes captured | banner present |
| --- | --- | --- |
| a file (`> verify.out`) | 16,125 | yes |
| a pipe (`spawnSync`, `encoding: "utf8"`) | 9,124 | **no** |
| a pipe, after `process.exitCode` | 16,115 | yes |

The gate greps that capture for `/ALL \d+ CHECKS PASSED/`, so a run where all
305 checks passed was reported as `3/4 verify printed the pass banner: FAIL`,
with `3/4 verify` itself green beside it. The danger was never the red line —
it was that the obvious way to silence it is to delete the check.

`process.exitCode` lets the event loop drain and exit with the same status. It
also means the suite now has to exit on its own: if it ever leaves a handle
open the run hangs instead of exiting 0, which is a better failure than a
silent force-kill.

**Not measured, chosen:** `STDERR_CAP = 256 KB` in `run-cli.ts` is a bound, not a
finding. No trace was observed anywhere near it; it exists so an unbounded `+=`
cannot grow without limit, and 256 KB is simply far above anything real.

## `opencode run` works in `$PWD`, not the spawn cwd

**Dated 2026-09-27. Fixed in 0.0.183.**

The 1.18.32 binary's `run` handler resolves its directory as
`F = resolve(process.env.PWD ?? process.cwd())` and uses `F` unless `--dir` is
given (the TUI: `U1(D, u = process.env.PWD, F = process.cwd())`). Node's `cwd`
spawn option does not touch `PWD`, so every CLI run inherited the extension
host's — the folder VS Code was launched from.

`scripts/probe-opencode-pwd.js` (no model call — an unresolvable model id makes
`run` log its session directory and exit in ~2.5s), Linux, OpenCode 1.18.32:

| case | spawn cwd | PWD | session directory |
| --- | --- | --- | --- |
| A raw spawn (≤ 0.0.182 shape) | target | stale | **stale** |
| B `spawnOpenCode()` 0.0.183, host PWD stale | target | set by bridge | target |
| C control | target | target | target |
| B with 0.0.182's `out/proc.js` | target | stale (inherited) | **stale** |

With a real model the agent's own `bash pwd` printed the stale folder, and its
edits landed there. Exposure: cold `/dev` runs, the server-unreachable
fallback, a no-server `/worktree`, cold `/parallel` lanes — whenever `PWD` is
set and differs from the chosen folder (`code ~/proj` launched from `$HOME`,
multi-root, Git Bash on Windows where `PWD=/c/Users/…`). Attached and server
runs pass `--dir` / `?directory=` and were never affected. WT1 checked the
fake's `process.cwd()` and passed throughout; checks `PW` and `WT1 …PWD` read
the `PWD` the fake received.

Re-run on 1.19.0 (2026-10-13, 0.0.212's `out/proc.js`): A **stale**, B target,
C target — 1.19.0 still follows `PWD`, and the bridge still lands in the folder.

## OpenCode keys projects by root commit; one data dir serialises CLI runs

**Dated 2026-09-27. Measured on 1.18.32; nothing to fix in the bridge.**

- Project id = the repo's root-commit hash (`project.id` in `opencode.db`).
  Plain copies of one repo (`cp -r` with `.git`) became one project, and runs
  in later copies resolved into the first's world. A `git worktree` is
  registered as the project's `sandboxes` entry: a relative `write` from a run
  in the worktree landed in the worktree, main checkout clean. `/worktree` and
  `start-parallel-agents.*` isolation holds.
- Six concurrent `opencode run`s on one model and one data dir completed ~45s
  apart; three with separate `XDG_DATA_HOME`s finished together in 11s. The
  lock is `opencode.db`, not the provider. Attached lanes share one server
  process and are not affected.

## What VS Code does after Stop (and why 0.0.182–0.0.183 kept spinning)

**Dated 2026-09-28. Fixed in 0.0.184.** Source: microsoft/vscode main@75f204b.

- `chatServiceImpl.ts` `progressCallback` returns early once the request's
  token is cancelled: every chunk sent after Stop is dropped.
- `chatModel.ts` `cancel()` settles tool invocations, plan reviews and question
  carousels — not progress tasks. `chatTaskContentPart.ts` renders a task with
  no rows and `!isSettled` with a spinner and keeps that part while its
  settledness is unchanged: a task open at Stop spins until the view re-renders.
- `extHostChatAgents2.ts` `$invokeAgent` races the handler against Stop +
  1000ms, then `stream.close()`: every later `markdown()`/`progress()`/`button()`
  throws "Response stream has been closed". `chatServiceImpl.ts` then keeps no
  result (`token.isCancellationRequested && !rawResult → return`), so the turn's
  metadata — the session id the next message continues — is lost too.

Reproduced end to end with the real CLI (OpenCode 1.18.32, the free
`opencode/nemotron-3-ultra-free` model, managed server, attached `/dev`) and a
model of the host above (the suite's `hostStream()`):

| build | Stop at | after Stop | task left spinning |
| --- | --- | --- | --- |
| 0.0.183 `/dev`, model still thinking | 12.1s | returned 348ms | "Starting the OpenCode dev session…" |
| 0.0.183 `/dev`, mid-tool | 14.9s | 197ms | the open thought group |
| 0.0.183 plan (server transport) | 9.0s | 313ms | "Starting the OpenCode plan session…" |
| 0.0.184 `/dev`, mid-tool | 29.0s | 6ms | none |
| 0.0.184 plan | 9.0s | 4ms | none |

In every case the server run itself was aborted (status idle, no client left);
what kept moving was the spinner. With a server slow to answer the abort (the
suite's `SP` fake: 3s), 0.0.183 returned after the one-second close, so its
result was dropped and its late writes threw into the error path.

The same runs showed the attached-CLI gap: a tool is reported `pending` before
its input exists. 0.0.183 dropped that report, so a `sleep 40` produced no line
for 40 s. 0.0.181 showed `bash: running · 12s` and a ticker; 0.0.184 shows
`bash: sleep 40 && echo finished · 6s` → `· 10s` → `· 30s` → `· 47s`.

## Grok and follow-up suggestions

**Dated 2026-09-26.** Every published version of xAI's Grok prompts
(github.com/xai-org/grok-prompts, through 2025-11-17) was searched: none asks
the model to suggest follow-up questions. The "suggest 2-3 follow-up questions"
line quoted online comes from an unofficial gist. Grok 3's brevity rule:
"You provide the shortest answer you can, while respecting any stated length
and comprehensiveness preferences of the user." Hence 0.0.183: chips come from
the answer or not at all.

## Read-only turns: `planAgent`, `look.md`, and prompts nobody can answer

**Dated 2026-09-28. Shipped in 0.0.185.** OpenCode 1.18.32, real server and
CLI, free `opencode/nemotron-3-ultra-free` model; probes in the session notes.

**An unknown agent is not an error on the CLI.** `opencode run --agent ghost
--auto "…"` printed `agent "ghost" not found. Falling back to default agent`
on stderr, exited 0, and the session's messages say `agent: build` — a
read-only turn with a typo would have edited. A subagent name falls back the
same way. `POST /session/:id/message` with `agent: "ghost"` answers HTTP 500
"Unexpected server error"; the `session.error` event carries `Agent not
found: "ghost". Available agents: build, explore, general, look, plan`.

**Where to ask instead.** `GET /agent?directory=` lists the loaded agents
(`name`, `mode`, `hidden`, `permission` rules in order); `opencode agent list`
prints `name (mode)` plus the rules as JSON: 1.4s, or 14s the first time in a
fresh config dir (it installs OpenCode's plugin SDK there). A running server
builds the list once per directory: an edited `look.md` showed the old rules
5s later and the new ones only after `POST /instance/dispose?directory=`.

**The built-in `plan` is read-only by instruction.** Its rules: `* allow`,
`edit` denied except `.opencode/plans/*.md`, `question` and `plan_exit` allowed,
`task` denied for `general` only, asks for `external_directory`, `*.env` reads
and `doom_loop`. Any bash command runs.

**Two `look.md` drafts against 10 real write attempts** (one session each, the
model told to run the command; `git status` in the repo after each):

| attempt | draft 1: bash allow-list | draft 2: `"*": deny` + redirects denied |
| --- | --- | --- |
| `cat a.txt > r1.txt` | **written** (matches `cat *`) | refused; `tee`, `cp`, `echo >` also refused |
| `cat a.txt >> r2.txt` | **written** | refused |
| `ls $(touch r3.txt)` | refused (each command is checked) | refused |
| `git status; touch r4.txt` | refused | refused |
| `find . -name a.txt -fprint r5.txt` | **written** | refused |
| write tool | not offered (`edit: deny`) | not offered |
| `task` → `general` subagent | **written** by the subagent | tool not offered |
| `git log -1 --output=r8.txt` | refused, then `git log -1 > r8.txt` **written** | both refused |
| `… \| xargs sed -i` | refused | refused |
| read `.env` | asked (hangs headless), then `cat .env` printed it | read refused; bash `cat` is not stopped |

A command's matched text includes its redirect (`redirected_statement`), so a
trailing `"*>*": deny` catches `>`, `>>` and `2>`.

**Prompts nobody can answer.** On the server path the bridge is the only
client:

| probe | result |
| --- | --- |
| plan turn, model calls `question` | waited 45s, until aborted |
| same, session created with `question`/`plan_enter`/`plan_exit` denied (what `opencode run` does) | tool not offered; answered in text, 10.7s |
| same, bridge answers the question "ask in your reply" | tool completes; the model asks in its reply, 20.6s |
| plan turn reads `/etc/hostname` (`external_directory` ask) | waited 45s, until aborted |
| same, reply `reject` | turn ends with no answer (3.9s): `PermissionRejectedError` breaks the loop |
| same, reply `reject` with a message | the model is told why and carries on (30.7s): `PermissionCorrectedError` |

The attached CLI answers permission asks itself (`--auto`: `once`; without:
`reject`) and tracks subagent sessions by `session.created` → `parentID`; it
never answers a question.

## Which model answers a turn

**Dated 2026-09-28. Shipped in 0.0.185.** OpenCode 1.18.32, `POST
/session/:id/message`, three turns per session:

| sent | answered by |
| --- | --- |
| turn 1 `nemotron-3.5-lightning-free`, turn 2 no model | turn 2: lightning (sticky) |
| turn 1 lightning, turn 2 `nemotron-3-ultra-free`, turn 3 no model | turn 3: ultra |
| fresh session, no model | `github-copilot/claude-sonnet-4.6` (OpenCode's default here) |

The prompt handler resolves `input.model ?? agent.model ?? sessionModel`,
where the session row's `model` moves with every explicit model (and the
newest user message's model backs it up); `Provider.defaultModel()` —
`config.model`, then the recent list, then the first provider — applies only to
a session that never had one. `GET /config/providers` returns a default PER
PROVIDER, and `opencode models` listed `opencode/big-pickle` first, so the
bridge's old compaction fallback (`catalog.models[0]`) would summarize a
claude-sonnet session with big-pickle. The CLI's `--format json` stream names
no model at all (`step_start`, `text`, `step_finish` only); the server's
response `info` and `message.updated` events (`{ sessionID, info }`) do.
`GET /session/:id/message?limit=N` returns the session's LAST N messages,
oldest first (an 8-message session: `limit=2` gave messages 7 and 8), so the
bridge reads them from the end.

## `server.heartbeat` kept the server-path idle cap from firing

**Dated 2026-09-28. Fixed in 0.0.185.** OpenCode 1.18.32's `/global/event`
sends `{"type":"server.heartbeat","properties":{}}` about every 10s (3 in a
35s capture of an idle server) — no session id. The bridge's shared SSE demux
hands unattributed, non-content events to every subscriber, and the server
transport treated everything it received as its own run's activity. Real
runs, `transport: server`, `/dev`, "run `sleep 120 && echo done`",
`idleTimeoutMs` 30000:

| build | outcome |
| --- | --- |
| 0.0.184 | ran to completion: 142.9s |
| 0.0.185 | "went quiet for the whole idle window and was stopped after 40.6s" |

The same 0.0.184 build, on a plan turn blocked on an `external_directory` ask
with `idleTimeoutMs` 60000, was still waiting at 150s when the probe killed it.
The attached-CLI listener had filtered by session id since v177; the server
path now does too, and gives a tool it reports as running `toolQuietMs`: the
packaged 0.0.185 with `toolQuietMs` 45000 stopped the same `sleep 120` at
57.7s, naming `bash`; 0.0.184 ran it for 141.3s. The server answers the
bridge's own abort with `session.error` `MessageAbortedError`, which 0.0.185
no longer reports as OpenCode's error.

## Badges: chat's KaTeX `style` rule replaces the span rule

Measured 2026-09-29 against microsoft/vscode main, sanitizer run in Chromium.
`chatMarkdownContentPart.ts` renders with
`MarkedKatexSupport.getSanitizerOptions(…)`, which appends KaTeX's own `style`
predicate; `domSanitize.ts` keeps one predicate per attribute name, so it
replaces the span rule. KaTeX allows no `background-color`, no `border-radius`,
and a colour only as a bare word — `#4daafc` arrives as `rgb(77, 170, 252)` and
fails. Every `<span style>` badge of 0.0.182–0.0.186 rendered as `style=""`, and
each `supportHtml` part refused to merge with its neighbours. Since 0.0.187
marks are inline-code pills. In CommonMark `\(` escapes the `(` and a pill
touching another backtick run fuses the runs, so the badger skips an escaped
mark and puts a zero-width space between a pill and a backtick (0.0.188).

## Mermaid in chat (from `/flow`, removed in 0.0.196)

Chat draws a ```` ```mermaid ```` block from any participant through the
built-in `mermaid-markdown-features` renderer (microsoft/vscode main@4b24360).
Mermaid takes `%%{…}%%` inside a quoted label as a directive and rejects
`[""]`. Label escaping (`src/flow.ts`) and the Chromium probe
(`scripts/probe-mermaid-flow.js`) are in the parent of the commit that deleted
them, whatever its hash in your clone:
`git show "$(git log -1 --diff-filter=D --format=%h -- src/flow.ts)^:src/flow.ts"`.

## OpenCode's session store over HTTP (1.18.33)

Read from `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`
and `src/session/session.ts` at tag v1.18.33 (2026-09-30):

- `GET /session?directory=&roots=true&limit=` — sorted by most recently updated;
  archived sessions are excluded (`isNull(time_archived)` unless `archived`);
  `roots` drops subagent children.
- `GET /session/:id/message?limit=N` — the newest N, paged with a `before`
  cursor. `DELETE /session/:id` — removes it and its messages, returns `true`.
- `PATCH /session/:id` — `title`, `metadata`, `permission`, `time.archived`:
  archiving is how OpenCode "closes" a session.
- `POST /session/:id/fork` — empty body forks the whole session; `messageID`
  forks up to that message. The copy gets the messages and metadata, **not the
  permission rules** — the bridge PATCHes its headless rules back.

## Chats vanish from the sessions list while they run (investigated, not ours)

Reported 2026-09-30: with several chats working, a running chat drops out of the
Chat sessions list and comes back when it finishes.

- The bridge runs no chat command during a turn: `workbench.action.chat.open` is
  called only from a toast's **Open Chat** (on click), the composer and New
  session (user actions). Checked with `grep executeCommand src/*.ts`.
- The list is VS Code's (microsoft/vscode main@4b24360):
  `localAgentSessionsController.ts` shows loaded chat models ∪ stored index
  entries not loaded (`chatServiceImpl.ts` `getLiveSessionItems` /
  `getHistorySessionItems`), hiding a loaded model without requests. The compact
  list shows pinned + the top 3 (`CAPPED_SESSIONS_LIMIT = 3`), the rest under
  **More**; the date groups place a chat by `lastRequestEnded ?? created`, so a
  running chat whose last turn ended on an earlier day sits in that day's group
  until it finishes, then jumps to Today.
- Unmeasured which of these Jan sees. To tell: reproduce with two plain Copilot
  chats (no `@opencode`) — if they vanish too, it is the host. Pinning a chat
  keeps it visible in the compact list. **Developer: Set Log Level → Trace**
  then the Window log shows `Disposing chat session …` if a model is unloaded.

---

## A `node.cmd` ahead of `node.exe` on PATH sends every fake through cmd.exe

**Dated 2026-10-02. Environment, not product.** Six suite checks (J, JC, FV,
IL) failed on every run: each one sends a multi-line prompt. Cause: `npx node@22`
run inside the repo installed the `node` npm package as a dependency, so
`node_modules/.bin/node.cmd` came first on PATH under `npm run`. The fakes'
shim reads `node "<file>" %*`; `readShimTarget` resolved `node` to that
`node.cmd`, correctly refused to chain into a second shim, and fell back to
cmd.exe, which cuts the prompt at its first newline (§7). After removing the
package, the suite printed `ALL 766 CHECKS PASSED` on Node 20.6.1 and on Node
22.23.2. Never run `npx node@…` in this folder. In production this needs a
shim whose head is `node` and a `node.cmd` earlier on PATH: unmeasured, and
rare.

## `@vscode/vsce` 4 needs Node 22; the gate's fallback list was wrong

**Dated 2026-10-02. Fixed in the gate.** `vsce ls` on Node 20.6.1 died with
`util.styleText is not a function` (vsce 4.0.0 declares `engines.node >= 22`),
so the gate used `simulatePackageList`. That listed 69 files, `dist/*.vsix` and
`.vscode/*` among them: `toRe` turned `**` into `(.*/)?` and then rewrote that
group's own `*` and `?`. With placeholders, the simulation matches `vsce ls`
(Node 22) file for file: 34 = 34. Use Node 22 for the gate.

## File links in chat: anchor parts, not empty-text links (VS Code 1.139.1)

**Dated 2026-10-02. Read from the installed `workbench.desktop.main.js`
(1.139.1, 04c0d99).** Three ways a participant can make a file clickable:

- **A reference row** `{ variableName, value: uri | Location }`: the list
  renders the file's basename with `#<variableName>` as its description and
  opens `value` on click (with the Location's range). Without `value` the row
  is a plain label. Used for accordion rows that name one file.
- **An empty-text markdown link** `[](file:///…)`: becomes an inline file
  pill, but its click passes `editorOptions.selection = undefined`, which is
  spread over the selection the opener parsed from `#L42`: the line is lost.
  A link with text stays an ordinary link.
- **`response.anchor(Location)`** (an `inlineReference` part): merged into the
  preceding markdown part as a link (`http://_vscodecontentref_`), so it sits in
  the sentence; the pill reads `cart.ts:42` and opens at the line. The answer's
  file pills use this. (0.0.184 removed anchors only because they were called
  unbound; `chatStream` calls every method on the stream.)

## A listener that only says {"healthy":true} receives the prompt (measured, fixed 0.0.205)

`scripts/probe-server-adoption.js` ran one turn against a fake non-OpenCode listener
on the server port. `ensureServer()` adopted it: `POST /session` and
`POST /session/<id>/message` reached it, the body of both carried the prompt text,
and every URL carried the workspace path in `?directory=`. The real server's
health answer is `{"healthy":true,"version":"1.18.34"}` (1.18.34), and the
server docs list it (`GET /global/health` → `{ healthy: true, version: string }`).
0.0.204 read it for a one-line note outside 1.18.27–1.18.34. 0.0.205 adopts a
listener on a fixed port only if it names a version; anything else gets that
one health probe and this window starts its own server on a free port (suite
`ID`; the probe now prints the health probe alone). A server this window
started is used with or without a version. Not measured: whether 1.18.27–1.18.33
send `version`; one that does not gets a second server of its own, not a failure.

## A fixed port held by a listener that never answers (reported, 0.0.202)

Reported log: `[13:33:07] serve exited (1)` then `[13:33:11] compact failed:
OpenCode server did not become healthy on http://127.0.0.1:53200`. The 20 s
deadline and the 5 s health timeout explain the shape: the first probe of
53200 waited out its 5 s (something accepted and never answered), the
bridge's own `serve` could not bind there and exited 1 after its boot, and the
poll that was waiting at the deadline turned that exit into "did not become
healthy". Not reproduced against a real hung server here; the suite's `SV`
reproduces the shape with a listener that never answers and a fake `serve`.
0.0.203: a port that accepts TCP but fails the health probe gets a server of
the window's own on a free port; exits report the server's own last error
line; polls wait 1.5 s (0.0.204: 3 s, see the next entry). Check the `[serve]` lines in the debug log for the
real cause on your machine (`EADDRINUSE` is the expected one).

## A first `opencode serve` boot that outlasts the wait (reported, 0.0.203)

Reported: `/sessions` → `OpenCode server did not become healthy on
http://127.0.0.1:61930 within 20 s`, and `/ping` healthy on the same port a
moment later. Not measured here: the reading is that a first boot (config,
plugins, MCP servers) answers health slowly, and 0.0.203's 1.5 s poll timeout
never counted such an answer. 0.0.204: 3 s per poll, 45 s in all, a live
process that misses the deadline is reported as still running with its last
printed line, and every start logs `serve on … answered after N.Ns` — read that
figure before moving the deadline again. The suite's `SB` uses a fake `serve`
that accepts and stays silent for 2.2 s. A turn that warms the server (an
attached dev run, `/parallel`) says so after 1.5 s too.

## Subagents run with their own permissions (docs; measured in 0.0.215)

Measured on 1.19.0 in 0.0.215 (top of this file): `explore` runs any shell
command, and a child inherits only its parent session's deny rules.


OpenCode's agents docs (V2): "The child currently uses its own configured
permissions, not a restricted copy of the parent's permissions"; the v1 docs
say `general` "has full tool access". `permission.task` takes globs, the last
match wins, and a denied subagent is removed from the task tool's
description. A task result carries no duration, tokens or cost (#47822); the
child session's `message.updated` does. `opencode run --format json` drops a
child's parts (#49300). `scripts/probe-plan-subagents.js` measures the plan →
`general` edit with and without the 0.0.203 rules — run it before relying on
`RO` against a live model.

The Resume chip reads a `task` part with `status: "error"` or
`metadata.interrupted` and the child in `metadata.sessionId` (issues #41055,
#39196; the suite uses fakes, 1.18.34 not measured). A permission-denied call
is probably `error` too and would earn a rerun chip; its error text is not
measured, so it is not filtered. A later completed call (same child, or same
agent and description) clears the mark.

## Permission asks: two event shapes, and a reply that proves nothing (docs, not measured)

OpenCode's generated v1 SDK types (`packages/sdk/js/src/gen/types.gen.ts`, dev,
read 2026-10-07) name the ask `permission.updated` (properties `id`, `type`,
`pattern`, `sessionID`, …), its answer `POST /session/:id/permissions/:permissionID`
with `{ response: "once" | "always" | "reject" }` (the server docs list that route
too), and the confirmation `permission.replied` `{ sessionID, permissionID,
response }`. What the bridge measured on 1.18.32 is `permission.asked` and
`POST /permission/:id/reply` with `{ reply, message? }`; the shape of its
`permission.replied` (`requestID`, `reply`) is recalled, not measured. The bridge
answers both ask events, once per request id, and reads either id field in the
confirmation. `POST /permission/:id/reply` answers 200/true for an id that is
not pending (#15386; closed unfixed, the fix PR #24322 was closed unmerged;
1.19.0 answers 404 for an unknown id, measured in 0.0.212), so a 200 proves
nothing: a reply without a `permission.replied` after 3 s is sent
once more, then given up on, with a log line either way. A pre-1.1 `reject`
carries no message, so on such a server it ends the turn instead of being fed
back. Not measured: any of this on a real server; the suite uses fakes (`HQ`).

## Streaming, auto compaction and VS Code's per-request discovery (source read, 0.0.207)

**Dated 2026-10-07. Read, not yet measured against a live server.** Sources:
sst/opencode tag v1.18.32 (and main at 1.18.35), microsoft/vscode main@91b51fe.

- **Text arrives as deltas.** `session/processor.ts` `text-delta` /
  `reasoning-delta` publish `message.part.delta` `{ sessionID, messageID,
  partID, field: "text", delta }` — no `part` object; `text-start` publishes the
  empty part, `text-end` the whole part (after the `experimental.text.complete`
  plugin hook, which may rewrite it). 0.0.206's server path read only
  `part.updated`, so every text part reached chat whole at its end.
- **The CLI prints parts whole.** `cli/cmd/run.ts` L753: `part.type === "text"
  && part.time?.end` → `emit("text")`; reasoning the same. An attached run's
  stdout is never streamed. `--auto` is `permission.reply({ reply: "once" })`
  for every `permission.asked` (L800–820) — what `watchFamily` does with
  `autoApprove` on the server path.
- **An auto compaction keeps going.** `POST /session/:id/summarize` →
  `compactSvc.create` + `promptSvc.loop` (`handlers/session.ts` L273–291). The
  loop sets the session busy (`prompt.ts` L1089). With `auto: true` and no
  overflow, `compaction.ts` L468–545 appends a synthetic user message "Continue
  if you have next steps, or stop and ask for clarification…" (plugin hook
  `experimental.compaction.autocontinue`, enabled by default) and the loop runs
  another agent turn. `auto: false` stops after the summary.
- **Provider backoff is a status.** `processor.ts` L674–686: each retry sets
  `session.status` `{ type: "retry", attempt, message, action, next }` (`next`
  a timestamp).
- **VS Code's "discoveries" are its own, before any participant.**
  `chatServiceImpl.ts` awaits `Promise.all([collectHooks(), collectInstructions()])`
  before `invokeAgent`, for every participant; `chatWidget.ts` always sends
  `instructionContext` unless a contributed session type opts out
  (`autoAttachReferences`). The discovery lists are `CachedPromise`s; the
  Discovery events are logged once per chat session, then "Resolve
  Customizations … in X ms" per request (`promptsDebugContribution.ts`).
  Uncached per request: agent-instruction file lookups in the roots and the
  home folder; in Agent mode the customizations index (~33 KB, sent to the
  extension host, discarded by `buildChatContext` as added by the host); with
  `chat.useNestedAgentsMdFiles`, a `**/AGENTS.md` workspace file search. MCP
  autostart is awaited too (`chat.mcp.autostart`).
  `chat.experimental.collectInstructionsInExtension` (main, experimental) skips
  the core path.

## OpenCode 1.18.35: nothing the bridge uses changed (diffed, 0.0.208)

**Dated 2026-10-08.** `git diff v1.18.34 v1.18.35` in sst/opencode: under
`packages/opencode/src` one file, `session/message-v2.ts` — tool-result image
attachments other than PNG, JPEG and WebP are dropped for `@ai-sdk/xai` models
(xAI rejected the whole request with `invalid_image`). `packages/sdk`,
`packages/server` and `packages/core` changed only their `version`. The rest
of the 157 files are the web docs, the stats and console apps. Tested range
raised to 1.18.35; not run against a live 1.18.35 server here.

## Streamed context cutoff and repeated blocks (0.0.209)

**Dated 2026-10-09.** A Node probe loaded `out/format.js` with a `vscode`
module stub and pushed the two reported chunk sequences through
`createLeakGate`, then flushed. Before the fix it printed:

```text
unclosed block: "Answer <workspace-context>SECRET"
second block: "<workspace-context>B</workspace-context>Done"
2 regression cases failed
```

`GT` covers the missing close, repeated blocks, every two-chunk split of each
context opener, and a partial opener that remains ordinary text. `DS` sends a
second context block and an unclosed final block through a real chat turn's
fake server stream and checks what reached chat.
