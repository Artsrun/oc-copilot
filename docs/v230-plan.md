# 0.0.230 plan — proposals to choose from

Dated 2026-10-29. Base `fbc9392` (0.0.229, 1295 checks). Status: **chosen 2026-10-29: P1, P2 and P4**, in the order P4, P2, P1. Each proposal is fixed in scope: what is in,
what is out, the order, and what proves it done. Every one ends the same way:
checks red first, fix, `npm run ship` green, mutants caught, clean room, VSIX,
`--record`, commit, push.

## What changed outside the repo

- **VS Code 1.143 makes the Copilot harness the default for new sessions**
  (GitHub changelog 2026-10-28; this machine runs `code --version` 1.143.1).
  VS Code's AI extensibility page now titles the section "Chat participant
  (deprecated)": "Chat participants are not supported in the Copilot harness.
  The API remains available for Local harness compatibility, but new
  integrations should use plugins or tools." `@opencode` is a chat participant.
- **OpenCode 2.1.0–2.2.0** (opencode.ai/changelog; 2.0.32 → 2.2.0 between
  2026-10-16 and 2026-10-27): `session.update` takes archive, the session list
  filters by it (2.1.0); structured session errors carry `retryAfterMs`
  (2.1.2); legacy `apply_patch` permissions migrate to `edit` (2.1.3); agent
  files with V2-only fields read as V2 (2.1.4); `providerState` → `native` in
  tool and step events, `session.compacted` removed (2.1.0). The bridge reads
  `session.compaction.ended/failed` only (`v2-events.ts:136`), and has no
  `retryAfterMs` handling (`grep retry src/v2-events.ts`: nothing).
- One fixed timing budget is left in the suite: `GT 1 MB unclosed context …
  < 200ms` (`verify-chat-output.js:8647`), the kind that failed `NF` and `FK`
  on battery.

## P1 · Survive the Copilot harness (strategic) — size L

**Why.** If a new default session cannot reach `@opencode`, the extension's
front door is closed for every new user of 1.143+. Nothing here is measured
yet, so step 1 measures.

**In.**
1. *Measure* (manual, recorded in REFS): on 1.143.1, a new chat in the default
   harness — does `@opencode` appear, accept a message, stream, show chips? The
   same in the Local harness, and how a user switches. Screens and the
   Extension Host log lines.
2. *Tell the user*: when the participant cannot run (the measured signal),
   the README and `/help` say how to switch to the Local harness; the
   Diagnose page gets a "harness" row.
3. *Language model tools* (`contributes.languageModelTools` +
   `vscode.lm.registerTool`), so Copilot's own agent can delegate to OpenCode
   in any harness:
   - `opencode_ask` — a read-only turn (the enforced plan path, same rules,
     same refusal when read-only is unverified); returns the answer text.
   - `opencode_worktree` — an isolated edit in a new worktree; returns the
     answer, the branch and the diff stat. `prepareInvocation` asks the user
     to confirm (it runs a paid model and creates a branch).
   Both reuse `runOpenCode`/`handleWorktree` internals; no new spawn site
   (Rule 3), no session binding (each call is its own session).

**Out.** Agent plugin packaging (skills + an MCP server): MCP servers run
outside the extension host and could not use `spawnOpenCode` (Rule 3) — a
later round, after P1 measures what the harness offers. `/dev` as a tool
(edits the checkout from an agent's decision) — not without a separate yes.

**Proves it.** Step 1's REFS table. New group `LM`: the manifest declares
both tools; `invoke` drives the fake CLI and argv shows `--agent plan` /
the worktree cwd; a read-only refusal returns a refusal, not a run;
`prepareInvocation` of `opencode_worktree` carries a confirmation; Stop
(the token) ends the run within 1 s. Mutants: drop the confirmation; send
`build` for `opencode_ask`; skip the read-only check.

**Risks.** The tool API inside the Copilot harness may differ from the Local
one (measured in step 1 before step 3 is built: if tools do not reach the
harness either, P1 stops at step 2 and reports). A tool call cannot stream
progress into chat the way a participant does: long runs look silent.

## P2 · OpenCode 2.1–2.2 adapter refresh — size M

**Why.** The 2.x adapter was built on 2.0.29 and measured to 2.2.0 only by
the probe's ten rows. 2.1 added what the bridge works around.

**In.**
1. Record `scripts/fixtures/wire-v2.json` again on 2.2.0
   (`record-wire-fixtures.js`, a temp prefix) and diff the frames against
   2.0.29's: every renamed field the translator reads is named in REFS.
2. **Close** in `/sessions` uses 2.x's archive (`session.update` with
   archive) instead of the bridge's `ocbArchived` metadata, so OpenCode's own
   apps hide it too; the README's "Not yet: Close keeps the session listed"
   goes. A 2.0.x server (no archive) keeps the metadata path.
3. `retryAfterMs` → the live line's `Provider retry N · next in Ns` on 2.x,
   as 1.x already shows.
4. `apply_patch` → `edit` (2.1.3) and V2-only agent fields (2.1.4): the
   overrides and `v1PermissionRules` checked against a real 2.2.0
   (`probe-opencode2.js` rows plus one for a V2-only agent file).

**Out.** Code Mode worktree tools (2.0.27) — denied on read-only turns
already; ACP; the `policies` key.

**Proves it.** `TW` checks on the 2.2.0 fixture: answer once, deltas, steps,
retry line; `SL`-style check: Close sends archive to a 2.1+ fake and metadata
to a 2.0 fake. Probe output pasted in REFS. Mutants: Close always metadata;
drop the retry mapping.

**Risks.** Needs network to install 2.2.0 into a temp prefix (done before,
0.0.227). The fixture re-record changes the `TW` fakes' input: every `TW`
check is re-baselined once.

## P3 · Apply to checkout — size M

**Why.** A worktree's work ends in the worktree; today the user merges it by
hand. The deferred D3(b) / U5.

**In.** **Apply to checkout** — a button under a `/worktree` answer with
changes, and an action in OpenCode: Worktrees. `git diff --binary <base>` in
the worktree, then `git apply --3way` in the checkout, after a modal that
lists the files. Refused, with the files named, when the checkout has
uncommitted changes in any of them. The worktree is kept (Remove is separate).
Rule 5 gains its second exception, worded in AGENTS.md: "on the user's click,
a worktree's own diff into the checkout".

**Out.** Committing, merging the branch, applying part of a diff.

**Proves it.** `WT18`–`WT20`: applied files land in the checkout byte for
byte (CRLF-blind compare); a dirty overlap refuses and changes nothing;
declining the modal changes nothing; a new file and a deleted file both
apply. Mutants: skip the overlap check; apply without the modal.

**Risks.** It writes the user's checkout — on a click, after a confirm, and
only the files listed. `--3way` can leave conflict markers: the result is
reported per file and nothing is staged.

## P4 · Small, measured items — size S

**In.**
1. **Status bar during a turn** (U1): `$(sync~spin) OpenCode · plan · 1m 20s`
   at milestones only (`LF`: every update is a repaint, not a stream), then
   `· ctx 42%` after the turn; the tooltip names the session or worktree.
2. **`dataHome`** (D6, designed in `docs/data-folder-design.md`): a setting
   (Rule 4), `XDG_DATA_HOME` set for every spawn in `spawnOpenCode`, the
   remembered data-folder refusal lifted when it changes.
3. **The last fixed timing budget** (`GT … < 200ms`) becomes growth plus a cap,
   as `NF`/`FK`.

**Out.** Anything else from the U-list.

**Proves it.** `SB`-style check reads `lastStatusItem.text` mid-turn and
after; `writeFake` records `XDG_DATA_HOME` beside `PWD` (serve, run,
`--version`), empty passes the host's value; a changed setting lifts a clash;
`GT` growth check. Mutants: drop the env line; skip the clash reset.

**Risks.** Low. The status bar is shared by all chats in the window: it shows
the last turn that started.

## Recommendation

**P1 + P2.** P1 because 1.143 may already hide `@opencode` from new sessions
on this machine, and only a measurement says how much. P2 because 2.2.0 is
where `npm i @opencode/cli` lands today. P4 fits beside either as a third.
P3 changes a rule (Rule 5) and is the one that writes the user's checkout:
choose it deliberately.

| | P1 harness | P2 2.x refresh | P3 apply | P4 small |
| --- | --- | --- | --- | --- |
| Size | L | M | M | S |
| Needs | VS Code 1.143 by hand | network, 2.2.0 | — | — |
| New API | LM tools | — | — | — |
| Rule change | — | — | Rule 5 | Rule 4 (one setting) |
| Risk | harness unknown | fixture re-baseline | writes the checkout | low |

## Sources

- VS Code, AI extensibility overview: https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview
- GitHub changelog, Copilot in VS Code, 2026-10-28: https://github.blog/changelog/2026-10-28-github-copilot-in-vs-code-universe-releases/
- OpenCode changelog: https://opencode.ai/changelog
