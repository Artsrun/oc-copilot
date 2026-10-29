# 0.0.228 plan — review of 0.0.225–0.0.227, proposals, scope

Dated 2026-10-28. Base `de2d29e` (0.0.227 plus the probe and REFS commits).
Status: **built in 0.0.228** with D1(a), D2(a), D5(a), D7(a) and U2; D3(a), D4(a) and U3, U4 in 0.0.229; D6, U1, U5–U8 are not built. Every finding below was measured through
`out/` unless it says "code read".

## Baseline

- `npm run ship` on `de2d29e`, Windows, on battery (83 %, CPU load 51 %):
  typecheck PASS, build PASS, verify **1259 of 1260** — `NF a 250 KB answer and
  two backtracking traps take < 500ms (824ms)` red, so the gate stopped there.
- Check 4 alone (a scratch copy of `ship-gate.js` with the suite skipped): every
  row PASS — 19 claims anchored, 118 cited names, 140 files, 0.0.227 still
  builds from its own code.
- Working tree clean before and after.

## Verdict: 0.0.225–0.0.227 and the commits after

| Change | Verdict |
| --- | --- |
| 0.0.225 a 2.x data folder fails fast (`dataFolderRefusal`) | Keep |
| 0.0.225 `/ping` and Diagnose say why the server is down | Keep |
| 0.0.225 `plainError`, the new-chat note log-only, no `glob: {}` row | Keep |
| 0.0.226 `/worktree` follow-ups continue the worktree and session | Keep; Fix F2–F6 (a worktree chat is a conversation now, and its turns skip most of a chat turn) |
| 0.0.226 New worktree button | Keep |
| 0.0.227 review findings get Fix chips in any layout | Keep; Fix F1 (its timing check) |
| 0.0.227 a new worktree names the uncommitted changes it lacks | Keep |
| 0.0.227 a worktree answer's chips sent as `/worktree` | Keep; D2 (the Review chip) |
| `6c32aea` probes write `C:/…` in shell commands | Keep |
| `de2d29e` REFS: five 2.x versions pass the probe | Keep; D5 (the tested range) |

## Findings

### F1 · The gate goes red on battery: a fixed 500 ms budget

Blocker by Rule 2: on battery nothing ships. `NF … take < 500ms` times three
inputs once, inside a suite that has run over a thousand checks. Today 824 ms;
REFS has 612 and 615 on battery, 109–114 on AC. The same inputs alone through
`out/natural.js`, on battery:

```text
first run (cold, as the suite measures): 48 + 205 + 177 = 430 ms
median of 9 totals: 322 ms
size x1 / x2 / x4 (median of 5):
  250 KB answer   12.6 ms   35.4 ms   82.7 ms   (x4: 6.58)
  "e.g. a, a, …" 133.4 ms  275.8 ms  524.5 ms   (x4: 3.93)
  "fix x or …"   116.7 ms  213.2 ms  518.3 ms   (x4: 4.44)
```

Linear: no backtracking regression. The budget measures the machine.

Fix (D7): keep the label assertion; replace the 500 ms with a growth check on
the two traps (x1 and x4, median of 3, ratio < 10: linear is about 4, quadratic
16) and a 2.5 s cap on the 250 KB answer. Pin: a mutant that makes one
`natural.ts` pattern quadratic turns it red; record that time in REFS.

### F2 · `/worktree` sends `model:` and `effort:` as task text

`src/chat.ts:117-121` routes `/worktree` before `parseChatPrompt`. Fake CLI,
`transport: cli`:

```text
/dev      model:tundra fix the login redirect
  → "`tundra` is not in OpenCode's model list…", nothing run
/worktree model:tundra fix the login redirect
  → run --agent build --auto --format json "model:tundra fix the login redirect"
  → branch ai/model-tundra-fix-the-login-redir-1028-182234
/worktree effort:high fix the login redirect
  → run … "effort:high fix the login redirect", branch ai/effort-high-fix-the-login-redire-…
```

`/help` lists both prefixes "before the task". Fix: parse the task with
`parseChatPrompt`, resolve `model:` with `modelResolver` (an unknown short name
refused as `/dev` refuses it), `effortFor` strict for `effort:`, the slug from
the task without its prefixes. Check `WT10`: argv carries `--model <id>` and
`--variant high`; the branch has no `model-`.

### F3 · `/worktree` ignores the `effort` setting

```text
effort: "high"
/dev      fix the login redirect → run --agent build --variant high --auto …
/worktree fix the login redirect → run --agent build --auto …      (no --variant)
```

README, *Slash commands*: "the `effort` setting does it for every turn". Fix
with F2: `effortFor(model, setting, false)`, with the same note when the model
lacks the level; `variant` on the server prompt. Check `WT10`.

### F4 · `/worktree` drops attachments without a word

```text
#file:tracked.txt, "explain this file"
/dev      → task ends "Files the user attached:\n- tracked.txt\n(Context only. …)"
/worktree → task "explain this file"
an image attached
/dev      → "Not sent to OpenCode: an image. The bridge passes files on disk, by path."
/worktree → no notice
```

README: "What OpenCode won't get is said before the answer". Fix: fold the
references as a dev turn does. A file inside the repo goes by its path relative
to the worktree (whose copy is HEAD's: an attached file the checkout has
changed is named as such); one outside the repo by absolute path;
`contextNotice` for the rest. Check `WT11`.

### F5 · `/worktree fix` skips the vague-prompt gate: a branch, a folder and a paid run

```text
new chat
/dev      fix → "`fix` is too short for me to act on…", nothing run
/worktree fix → ai/fix-1028-182222 created, the run started
```

A `/word` that skips the gate turns text into a paid run, here with a folder
and a branch as well. Fix: `isVaguePrompt` when no worktree continues
(`previous` undefined) and nothing is attached; follow-ups (`yes`, `go`) pass.
The clarify chip "Run it" carries `command: "worktree"`. Check `WT12`: no new
folder under `<repo>.worktrees/`, no argv.

### F6 · A worktree session has no books

Since 0.0.226 a worktree session spans every follow-up, but the worktree path
has none of `finishTurn`'s bookkeeping (code read: `grep -n
"compact\|notifyIfSlow\|emitReferences\|setActiveSession" src/chat-worktree.ts`
finds nothing). Measured in a chat whose only turn was `/worktree`:

```text
/session → "No session in **this chat** yet — send a message to start one. …"
/compact → "Nothing to compact — this chat has no OpenCode session yet."
```

Code read, unmeasured live: no autocompact, so a long worktree conversation
grows until OpenCode's own overflow; no completion toast for a slow run
(`notifyOnCompletion`); no "Used N references" for the files it touched; no
file pills (`createFileLinker`).

Fix (D1): `/session` names the chat's worktree (`threadWorktree`: folder,
branch, session); `/compact` in a chat whose last turn was `/worktree`
compacts the worktree session; `notifyIfSlow` and `emitReferences` on worktree
turns, paths in the worktree; autocompact by context size (the worktree keeps
no turn count). Check `WT13`.

### F7 · Words 0.0.226 left behind

- `/help` and the manifest's `/worktree` say "a NEW git worktree"; follow-ups
  continue the same one since 0.0.226.
- The participant description lists `/dev /parallel /session /new /model
  /help`: no `/worktree`, `/sessions`, `/compact`.
- The manifest's `/parallel`: "separate them with |" — `;;` and a `---` line
  split too.

Fix: words only. Check: the LB command-table check covers the description.

## Decisions

### D1 · How far `/worktree` parity goes

- **(a) recommended**: F2–F5, and from F6 `/session`, `/compact`, the toast,
  references, autocompact by size. No handoff chain: `fallbackModels` is still
  not tried when a worktree run times out.
- (b) Route `/worktree` through `runTurn` with the worktree as cwd and its
  session: one code path (handoff, echo and leak gates, chips alike). The
  largest diff of the release; every `WT` check re-baselined. Cleanest long-term.
- (c) F2 and F3 only: attachments still vanish without a word.

### D2 · The Review chip under a `/worktree` answer

- **(a) recommended**: offer it as `/worktree`. The review runs in the
  worktree, where the change is; the editing agent could edit there only.
- (b) Keep it out (0.0.227): a worktree edit gets Test it and Continue only.

### D3 · Worktree lifecycle

- **(a) recommended**: **Worktrees…** in Quick Actions, and `/worktree` with
  no task: this repo's `ai/*` worktrees (`git worktree list --porcelain`), each
  with its diff stat and Open / Diff / Remove, plus **Remove all without
  changes**. The probe left seven folders in one run; Remove is one per answer.
- (b) (a) plus **Apply to checkout**: `git diff --binary <base>` in the
  worktree, `git apply --3way` in the checkout, after a modal that lists the
  files; refused when the checkout has changes in those files. The checkout is
  written on a click, so Rule 5 needs a line for it, as `/dev` has.
- (c) Neither.

### D4 · Show full diff

- **(a) recommended**: VS Code's multi-file diff (`vscode.changes`), the base
  side from a read-only content provider (`git show <base>:<path>` in the
  worktree; nothing written). Per-file side by side, jump to the file.
- (b) Keep the untitled `.diff`.

### D5 · OpenCode 2's tested range

- **(a) recommended**: `TESTED_OPENCODE2` 2.0.18–2.2.0; README "the probe's ten
  rows on 2.0.18 to 2.2.0, the manual checks on 2.0.29 and 2.0.32";
  `probes.yml` pins 2.2.0 as must-pass. The installed 2.0.18 stops getting the
  outside-the-range line.
- (b) Keep 2.0.29–2.0.32; REFS has the rest. 2.0.18 and 2.2.0 keep the line.

### D6 · `dataHome` (`docs/data-folder-design.md`, designed, not built)

- **(a) recommended**: 0.0.229. This machine runs `opencode2`; nothing waits on it.
- (b) 0.0.228: a setting (Rule 4), one env line in `spawnOpenCode`, the clash
  reset on change.

### D7 · The timing check (F1)

- **(a) recommended**: growth ratio on the traps plus a 2.5 s cap.
- (b) Raise the cap to 1500 ms: 824 ms passes today; a slower laptop or a busy
  CI runner flakes the same way later.
- (c) Time in a fresh child process: removes the warm heap, not the battery.

## UI/UX proposals

| # | Proposal | Size | When |
| --- | --- | --- | --- |
| U1 | Status bar during a turn: `$(sync~spin) OpenCode · 1m 20s`, after it `· ctx 42%`; tooltip names the session or worktree | S | 0.0.228 if room |
| U2 | The `/worktree` opening line names the folder relative to the repo (`../<repo>.worktrees/<slug>`); the full path stays in the log | S | 0.0.228 |
| U3 | Worktrees… picker (D3a) | M | 0.0.228 or 0.0.229 |
| U4 | Multi-file diff (D4a) | M | 0.0.229 |
| U5 | Apply to checkout (D3b) | M | 0.0.229, after D3 |
| U6 | `/session` as a small table: session, turns, model and effort, context, cost, and the worktree row | S | with F6 |
| U7 | A Getting started walkthrough (`contributes.walkthroughs`): install, `/ping`, a plan turn, `/dev`, `/worktree` | M | later |
| U8 | Inline `/dev`: an Open diff button for the file it edited (base from `git show HEAD:`) | M | later |

One action, one channel: U3–U5 and U8 are artifacts (buttons, a picker), never chips.

## Order (0.0.228)

1. F1: the suite only; unblocks the gate on battery.
2. F7: words.
3. F2, F3, F5: one `parseChatPrompt` pass in the worktree path.
4. F4: attachments.
5. F6 per D1(a).
6. D2, D5 as decided; U2.
7. 0.0.228 (Rule 9: `package.json`, both lock fields, `serverInfo.version`),
   CHANGELOG and README (*Slash commands*, the `/help` table), a manual-checks
   section, `npm run ship` on AC and on battery, VSIX, `--record`.

Not in 0.0.228 unless a decision says so: U3–U8, D6.

## Noticed, not changed

- A plain message after `/worktree` (sticky command removed) runs `plan` in the
  checkout, whose session never saw the worktree ("what did you change in the
  worktree?" → a plan turn there). By design since 0.0.226; F6's `/session`
  at least shows where the work is.
- A worktree's chips are kept at `WORKTREE_TURN` per session: a second worktree
  turn replaces the first's. The host asks only for the last turn's chips.
- The uncommitted count includes untracked files (`??` in `git status
  --porcelain`); "changes" reads right for them.

## Unmeasured live

- Whether Copilot keeps `/worktree` sticky after a chip with
  `command: "worktree"` (WT9 runs on a fake host).
- F6's growth: at what size OpenCode's own overflow compaction fires on a long
  worktree session.
- The F1 check on CI's three runners (their timings are not recorded).

## Debug: each finding in a real window

- F1: on battery, `npm run ship`; the NF line's milliseconds.
- F2, F3: `@opencode /worktree m:<short> e:high add a hello.txt` → the branch
  starts `ai/m-`; Output › OpenCode, the run line has no `--model` or `--variant`.
- F4: attach a file, `/worktree explain this file` → the logged prompt has no
  "Files the user attached".
- F5: a new chat, `/worktree fix` → a new folder under `<repo>.worktrees/`.
- F6: after a `/worktree` turn, `/session` and `/compact`.

## Ship turn (after `@opencode /dev`)

```text
Implement docs/v228-plan.md with decisions D1(a) D2(a) D5(a) D7(a), in its Order. For each finding add the failing check first (NF, WT10–WT13), then the fix. Bump to 0.0.228 (AGENTS Rule 9) with CHANGELOG and README entries, run npm run ship until green, then mkdir dist and npx vsce package --out dist/. Report the check count and the VSIX path.
```
