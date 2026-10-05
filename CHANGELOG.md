# Changelog — opencode-copilot-bridge

Full release history, newest first; releases before the last one are condensed
to their summary and headlines. The README ships the last five.

### 0.0.196

`/flow` is removed, `/parallel` lanes get your attachments, and the gate
catches two more kinds of drift. No setting was removed.

- **Removed: `/flow`** and its alias `/f` — the command, the turn trace in
  every turn's metadata, `src/flow.ts`, the mermaid probe and the docs. A
  typed `/flow` or `/f` now says it was removed and runs nothing; before, the
  `/` kept it out of the vague-prompt gate and it would have gone to the model
  as a paid task. The mermaid finding stays in REFS. Checks `RM`.
- **Fixed: `/parallel` dropped attached files.** The context was built after
  the parallel branch had returned, so `#file:` reached no lane. Every lane now
  gets the attachment after its own task, the files show as references, and
  `includeChatReferences: false` still keeps lanes bare. Checks `J`.
- **Gate: without git, every file is scanned for internal names.** The 0.0.195
  tar's `.vscode/settings.json` pinned a model on a private gateway, and the
  fallback scan read only the packaged files; the pin now names a public model.
- **Gate: `package-lock.json` must carry the manifest's version** (it said
  0.0.194 in 0.0.195, as it said 0.0.187 in 0.0.189).

### 0.0.195

Fixes from a review of `/parallel`.

- **Fixed: `transport: server` ran `/parallel` lanes cold**, serialising them
  on one `opencode.db`. Lanes attach to the managed server now; `cli` stays
  cold, `auto` keeps the `attachDevToServer` opt-out. Checks `FC`.
- **Fixed: Stop waited out a cold server boot** before the turn ended. The
  three server warm-ups are raced against Stop.
- The composed-lanes text moved to `metadata.composedLanes`; `lanes` is only
  ever a count.

### 0.0.194

Files named in chat open on click.

- **File pills in the answer**: `src/cart.ts`, `src/cart.ts:42` or
  `src/cart.ts#L42` in inline code becomes an inline anchor that opens the
  file at that line. Only a file that exists inside the workspace; never inside
  a fence or a multi-backtick span; a path split across stream chunks is held
  until its span closes. Sent as `response.anchor(Location)`: VS Code 1.139
  merges it into the sentence, while an empty-text markdown link would lose the
  line on click. Checks `FK`.
- **Accordion rows open their file**: a `read`, `edit`, `write` or `patch`
  row carries its file and renders as `cart.ts  #read`; shell and search rows
  stay text.

### 0.0.193

Fixes from a review of the follow-up chips.

- **Fixed: "let me know if you want the docs updated or the tests added"
  gave one garbled chip** ("Add the docs updated or the tests", sent to
  `/dev`). Each part is its own chip now; a part that is no action ("more
  detail or …") leaves the sentence without chips.
- **"Next steps: A, B, and C"** is three chips, not one cut-off chip. ", and"
  between two actions ("run the tests, and fix any failures") stays one.
- A long path in a chip label is cut after a `/`, not inside a file name.
- A bug while reading chips from a finished answer costs the chips, not the
  turn: it no longer reports "OpenCode failed to start" under the answer.

### 0.0.192

Fixes from a review of `/sessions` and the `/parallel` composer.

- **Keep in this chat** on the chat's own session no longer resets its turn
  count and spend.
- **Fork** deletes the copy when the bridge's headless rules cannot be put back
  on it, instead of leaving a fork that could ask questions nobody can answer.
- **Close / Delete** clear the folder's session pointer only when it holds the
  session that is gone, whichever chat owns it.
- A server error listing sessions is reported as one, not as "no sessions".
- Session titles show as plain text; an excerpt cut inside a code fence is
  closed.
- The composer: a model id with a colon (`ollama/qwen2.5-coder:7b`,
  `…:free`) is kept whole; a typed task no longer reorders the list, so Enter
  keeps the model you chose; Stop ends the turn while the model list loads; it
  lists the models of the chat's folder.
- **Run lanes** and **Compose…** are chips now, not buttons: a chip
  owns the next message.

### 0.0.191

Public-repository hygiene; no behaviour change.

- Test fixtures and examples no longer name an employer's model gateway:
  provider `acme-gateway`, models Tundra / Oasis / Arbor / Aspen. Help text and
  README examples read `model:tundra`.
- The ship gate's leak scan reads every file git would commit, not only the
  package, and takes its private tokens from `OCB_LEAKY` or `~/.ocb-leaky`
  instead of from its own source.

### 0.0.190

Sessions you can see and act on, a composer for `/parallel`, and one "New
session" instead of two look-alikes. No setting was removed.

- **`/sessions`** (alias `/ls`, palette **OpenCode: Sessions**): this folder's
  OpenCode sessions from its server (`GET /session?roots=true`, newest first,
  archived left out), this chat's marked. Pick one: **Continue here** (the chat
  is bound through the turn's metadata, as a finished turn binds it; its last
  ask and answer are shown), **Fork into this chat** (`POST …/fork`; OpenCode's
  fork copies no permission rules, so the bridge's headless rules are PATCHed
  back), **Close** (OpenCode's archive, after stopping a running turn),
  **Delete…** (modal confirm). Closing or deleting this chat's own session
  starts the chat fresh. Routes read from OpenCode 1.18.33's
  `httpapi/groups/session.ts`. Checks `SL`.
- **`/parallel` alone opens a lane composer** (also **OpenCode: Compose
  Parallel Lanes** and Quick Actions). One quick pick per lane: the task is
  typed in its box, the models are its list (default first and active — all
  `alwaysShow`, so typing never hides them). From two lanes on a Submit button
  and a last item appear; Submit inserts `@opencode /parallel …` into the chat
  input (`isPartialQuery`), nothing runs. A task the splitter would cut is
  refused on its page. Stable VS Code gives a participant no form inside the
  chat; the quick pick is the native step UI. Checks `PW`, `X`.
- **"Ask OpenCode" merged into "New session"**: both opened a chat with
  `@opencode ` typed; New session now does that in a **new** chat — a new
  thread is a new session, and the chat you leave keeps its own. It used to
  submit `/new` into the current chat. "Ask in Chat" and "New Chat" stay
  registered (keybindings) but leave the palette. Checks `NS`, `QA`.
- **Investigated: chats vanishing from the sessions list while they run.** The
  bridge runs no chat command during a turn; the list is VS Code's (REFS).

### 0.0.189

A `---` line separates lanes whatever the line endings. No setting was removed.

- **Fixed: a multi-line `/parallel` prompt pasted on Windows ran as no lanes.**
  The chat input sent CRLF, and a `---` line matched only `\n---\n`:
  reproduced, a 4-lane prompt splits into 4 with LF and 1 with CRLF or CR, and
  one lane is refused. Line endings are normalised before splitting. A `---`
  line may have spaces around it, and a `---` inside backticks or a fence (YAML
  front matter) is text, like `|` and `;;` there. Checks `PL`.

### 0.0.188

`/flow`, safer lane splitting, two rendering fixes, and a gate that stops one
version number from meaning two builds. No setting was removed.

- **`/flow`** (alias `/f`): what a turn did, as a mermaid flowchart — folder,
  model, session, transport, agent, each tool step (repeats merged), handoffs,
  how it ended, and its chips. `/flow 2` the turn before, `/flow all` every
  traced turn since `/new`; `/parallel` draws a box per lane. No model call, no
  process, no request: traces live in memory, last 20 turns of the window. The
  turn's metadata carries only the trace id. Chat draws a ```` ```mermaid ````
  block with VS Code's built-in renderer (`chatMarkdownContentPart.ts` →
  `hasCodeBlockRenderer`, main@4b24360); labels were run through real mermaid
  11 in Chromium (`scripts/probe-mermaid-flow.js`): a `%%{…}%%` directive is
  honoured even inside a quoted label, so `%`, `#`, `"`, `&`, backtick, `<`, `>`
  are entity codes. Checks `FL`.
- **Lanes split on `|`, `;;` or a `---` line only.** `||` (a shell OR) and `::`
  are text — `run npm test || true` is one lane. With no lane cap, a stray split
  is a paid run. Checks `PL`.
- **Fixed: a mark after a backslash became a broken pill.** `\(•‿•)` escapes
  the `(` in CommonMark; a pill there sent an escaped backtick and a stray one.
  It is left as written, and a pill that touches a backtick run is kept apart by a zero-width space, across streamed chunks too. Checks `KB`.
- **Fixed: each unknown lane model cost a catalog fetch.** Three misspelt lanes
  spawned `opencode models --verbose` three times in a row, and Stop could not
  cut them short. One forced fetch per turn, raced against Stop. Check `PL`.
- **Kept from the local review of 0.0.187**: CommonMark fence closing (same
  character, at least the opener's length), backslash-escaped backticks and
  CRLF line endings in the badger; short names for multi-slash ids by last segment or `/`-suffix; one
  forced refetch for an unknown short name.
- **Gate**: `no packaged <version> with other code` — a VSIX of this version in
  `dist/` must hold today's `out/*.js` (a local rebuild of 0.0.187 differed in
  four modules under the same number); `every chat command is documented in the
  readme`.
- Version history left the source comments; README, AGENTS and this file are
  shorter.

### 0.0.187

Kaomoji marks finally render as badges, models show by name, each `/parallel` lane can run on its own model, and every command has a short alias. One setting was removed: `parallelMaxLanes`.

- **Kaomoji marks are inline-code pills.** Correction to 0.0.182–0.0.186: the `<span>` badges never rendered.
- **Models by name.** The catalog keeps each model's name and provider, as OpenCode shows them: `Tundra (Model-1, Code generation & refactors)` from Acme, not only…
- **Short model names.** `model:tundra`, and `m:tundra` in a lane: one match or a refusal naming the candidates.
- **`/parallel`: a model per lane, or one task on several models.**
- **Removed: `parallelMaxLanes`, and with it every lane cap.** Every lane you write runs.
- **Aliases for every command** (`/p` `/d` `/pl` `/n` `/s` `/x` `/m` `/w` `/e` `/h` `/?`), plus your own in the new `commandAliases` setting.
- From the review of the local changes: a follow-up chip with nothing to send is left out and logged, never thrown (a throw cost the turn every chip), and…

### 0.0.186

`@opencode` in inline chat (Ctrl+I), and the kaomoji badges are coloured again. No command or setting was removed.

- **Inline chat.** A second participant, also `@opencode`, is offered only in the editor's inline chat.
- **Fixed: kaomoji badges lost their colour in 0.0.185.** Its badge style was wrapped in `{…}`, which VS Code's sanitizer drops whole, so every mark rendered as plain text.

### 0.0.185

Read-only turns can run as an agent of your own, no turn waits on a prompt nobody can answer, and a turn runs on the model you chose — or, visibly, OpenCode's. No command or setting was removed.

- **`planAgent`** (new, default `plan`): plan turns and read-only `/parallel` lanes run as the agent you name — such as the `look` agent in the README, which is read-only…
- **No turn waits on a prompt nobody can answer.** When OpenCode asks during a plan turn on the server (a read outside the folder, a `.env`, a repeated call), the bridge…
- **Fixed: the idle cap never fired on the server transport.** OpenCode sends `server.heartbeat` to every client about every 10 s, and the bridge counted it as the run's…
- **Fixed: compaction used the wrong model.** With no pin it summarized with the catalog's first entry — `opencode/big-pickle` where this was measured, for a session on…
- **Fixed: a timeout handoff stuck.** OpenCode keeps a session on the model it was last sent (measured), so with no pin one stall moved the session to the fallback for…
- **Fixed: Set Default Model wrote into the repo.** It always wrote Workspace settings (`.vscode/settings.json`).
- `/model` and `/session` name the model that answered when the server names it (a cold CLI run never does); `/model` without a pin says what OpenCode does, with the…
- From Jan's review: `WT1` compares real paths (Windows 8.3 short names), and `.opencode/` is ignored by git and left out of the package.
- A `planAgent` confirmed by `opencode agent list` is re-checked after 60s, as a server's is (was 10 min: a deleted agent would have run as `build`).

### 0.0.184

Stop stops, the quick button asks instead of sending, a long tool is visible while it runs, and the brevity experiment is gone. No command or setting was removed; the prompt tail and the chip labels are back to Jan's.

- **Fixed: Stop left a spinner running.** VS Code drops everything a participant sends after Stop (`chatServiceImpl.ts`), and a progress task that never settles keeps…
- **Fixed: a slow abort could cost the thread its session.** After Stop the host waits one second for the turn, then closes the stream and keeps no result. 0.0.183 waited…
- **Fixed: Stop did not stop `/parallel` lanes or `/worktree` on the server.**
- **A long tool is visible.** An attached run reports a tool before its input exists; 0.0.183 dropped that report, so a 40 s `sleep` showed nothing until it ended.
- **Fixed: Quick Actions → Ask OpenCode sent a prompt.** It (and **OpenCode: Ask in Chat**) filled in "Continue from where you stopped…" and submitted it, so every click…
- **Removed: the concise-vs-sharp experiment** , including its probe script, its npm script and its notes.
- Removed: the inline file links after an answer.
- The suite now checks rendering against a model of the real host: chunks dropped after Stop, the one-second close, task rows gated on the header's ack.

### 0.0.183

Follow-ups that read like the next thing you'd say — or nothing — and a real directory bug found while measuring. No command or setting was removed.

- **Fixed: a CLI run could work in the wrong folder.** `opencode run` resolves its directory from `$PWD` before its spawn directory (1.18.32), and the bridge passed only…
- **Natural follow-ups.** Chips under a finished answer are what the agent itself offered or asked at its end — "Want me to draft a plan for any of these — e.g.
- **Recovery chips** only after a failure or a stop: Try again, Pick up where it stopped, Start fresh (a long session timed out), Check the connection (OpenCode…
- Prompt tail changed to `Be concise.` (back to `Be short & sharp.` in 0.0.184).
- **Grouped progress, reviewed against VS Code's renderer.** Live tool and thought lines are plain again, so they shimmer and fade as the next group or the answer arrives…
- **`withBadges` survives a class-instance stream** (0.0.182 copied `Object.keys()` and would have lost every method).
- README "How it behaves" still showed `⏹️`; fixed.

### 0.0.182

Progress that reads like Copilot's, and marks you can spot. No command, setting or default was removed; two settings were added, both on by default.

- **Thoughts are accordions.** Each reasoning sentence becomes a collapsible header; the tool steps that followed it are its rows (`(´-ω-) Let me look at the key changes…
- **Spinner lines settle in place.** "Connecting to the OpenCode server…" and "Starting the OpenCode … session" spin, then turn into a done line with the time taken — no…
- **Kaomoji badges.** Marks in the reply body (folder, new chat, stopped, warnings, `/ping`) sit on the theme's badge colour.
- How: `progress(title, task)` — a stable runtime overload with no proposed-API gate (only the stable `.d.ts` omits it); a task that reports rows renders as a collapsible…
- Settings: `groupProgress` (off = one line per step), `kaomojiBadges`.
- Checks `GP` (grouping, settling, dedupe, cap, opt-out) and `KB` (badge style vs the sanitizer regex, `supportHtml`, plain progress, opt-out).

### 0.0.181

Kaomoji, one JSON, short & sharp. No command, setting or default was removed.

- **Every emoji is a kaomoji.** Chat, progress, `/ping`, `/env`, the debug log: `(•‿•)` ok, `(×﹏×)` failed, `(°ロ°)` warning, `(-ω-)zZ` went quiet, `(・ω・)ノ` stopped.
- **`src/followups.json`** : every prompt a chip or handoff sends, every chip (kaomoji, label, prompt key, command), which chips each outcome gets (`cases`), and the marks.
- **The vague-prompt gate guards a session's first message only.**
- **Faster decisions** : follow-ups are an outcome `switch` over `cases`, the answer-aware chips a `[chip, agent, test]` rule table, a numbered plan is one regex pass…
- Checks `KM` (no emoji rendered anywhere in the suite, markdown-safe marks, no prompt text left in code) and `VG`; chip checks now compare against the shipped JSON labels.

### 0.0.180

One action, one place — and the turn does less before the model sees it. No command, setting or default was removed.

- **No duplicate follow-ups.** A clarified prompt showed "Run it anyway" as a button and a chip; a failed turn offered Retry three times (button, chip, toast).
- **Every chip names its command** , the clarify chip included (a sticky `/dev` turn kept its kind only by luck).
- **A one-word prompt with an attachment runs.** `fix` with a selected function is a task; the vague-prompt gate now skips any turn with references (`FV`).
- **One health check per server turn** (was two — `chat.ts` and `runs.ts` each asked; `FW` counts the requests on the wire).
- **`pre-run:` log line** per turn — server / session / busy-check milliseconds, so speed work starts from numbers.
- Status bar: `$(code)` instead of `$(snake)`, "N turns" instead of a bare number, and a name in the status bar's hide menu.
- Keyboard shortcuts: `Ctrl/Cmd+Alt+O` opens `@opencode `, add `Shift` for `@opencode /dev `.

### 0.0.179

Review release: a red gate fixed at its cause, two test-only survivors of the v165 removal resolved, and the harness surface pruned to what the suite reads. No commands, settings or defaults changed.

- **The ship gate was red on 0.0.178's tree.** `media/command.svg` was rebranded to the blue tile after release and failed `HA …currentColor glyph`.
- **Session ids are sanitised where they cross a boundary.** `safeSessionId` lost its only caller when v165 stopped writing transcripts, while five URL sites…
- **`escapeHtml` removed.** Dead since v165 removed the HTML briefing; `BB` now asserts it stays gone.
- **`__test` carries only what the harness reads.** 12 keys (and their imports) were re-exported to nobody; `MA` fails on any unread key.
- **`deactivate()` really runs last in the suite.** It sat mid-file, so the `KA`–`LB` groups ran turns against a torn-down extension.
- `package-lock.json` version synced (it still said 0.0.171).

### 0.0.178

Cooperative by default, isolated by command — and every isolation claim is now backed by code the ship gate can point at.

- **`/worktree <task>`** runs the editing agent in a new git worktree + branch (`<repo>.worktrees/<slug>`, `ai/<slug>`) next to the repo, from your `HEAD`.
- **`/plan`** is listed with the commands (registered in v176).
- **Parallel scripts fixed:** `start-parallel-agents.sh` is executable again (it shipped as mode 644 — `Permission denied`); both scripts run `opencode run --agent build…
- **README no longer promises what nothing implements.** `git diff main...ai/opencode` printed nothing — the agents do not commit.
- **Claim guard.** Every `<!-- claim:… -->` tag in the README must have a matching `claim:…` comment in `src/` or `scripts/`, or the ship gate fails.

### 0.0.177

Chat turns no longer crawl behind runs nobody is watching, and long MCP/tool calls are not killed for being quiet.

- **Stopping the client now stops the run.** Measured on opencode 1.18.32: killing a `run --attach` client leaves the server-side run going (`/session/status` stays…
- **A busy session is stopped before a new message is sent** (`busySessionPolicy`, default `abort`; `queue` keeps the old behaviour).
- **`/stop`** stops a run still going on the server — closing a chat or reloading a window never did.
- **Liveness comes from the server session, not from CLI stdout.**
- **No handoff while a tool is running.** Another model cannot make a Jira call faster; the log says so instead.
- **Attached runs create their session up front** , so liveness follows it from the first event.

### 0.0.176

`/dev` stays `/dev`, runs about as fast as plan, follow-ups read the answer, and the progress line stops scrolling.

- **`/dev` attaches to the warm server** (`attachDevToServer`, on by default with `transport: auto`).
- **`/dev` names its agent.** Without `--agent`, OpenCode runs your config's `default_agent`; with `default_agent: "plan"` that was "We're in plan mode — I can't execute…
- **Follow-up chips carry their command, not a text prefix.** Copilot keeps the previous command sticky, so a chip whose text began with `/dev` showed as `/dev /dev …`,…
- **`/plan` is registered.** It was in `/help` and the runtime table since v168 but not in the manifest, so there was no way out of a sticky `/dev`.
- **Answer-aware follow-ups.** "Go with your recommendation", "Do step 1 only", "Review the changes" (plan), "Run the tests" (dev), "Apply it now".
- **`/new` is one line** : which session was closed, and that the next message starts from zero. "Open a new chat" is still one click.
- **The progress line no longer scrolls.** The elapsed readout only speaks into silence, at 3/10/30/60/120s…: a 60s silent start is 5 lines, not 24.
- **The thought line shows where the reasoning got to** , not its opening "The user said…", at most once per 5s.
- **Autocompaction runs in the background** with 180s instead of holding a finished answer open for 30s and then timing out.
- **CLI events after Stop are logged as late** , not dumped raw as "bad JSON".
- **`scripts/mac-setup.sh`** (repo only, not shipped): `install` the newest `.vsix`, `doctor` (VS Code CLI, `opencode`, the Dock-launched PATH, port, logs),…

### 0.0.175

Validated the v0.0.174 fixes and tightened configuration drift checks.

- Removed the unused `liveSessionGraceMinutes` setting while retaining the in-memory live-session tracker.
- Added a release gate that catches settings declared in `package.json` but no longer read by the extension.
- Clarified that vague-prompt handling applies to a single bare word.

### 0.0.174

Lighter config: the adaptive wall-clock strategy is gone.

- **`timeoutStrategy`, `maxTimeoutMs` and `buildTimeoutMultiplier` are removed.**

### 0.0.173

Follow-up chips reworked, `/new` tells the truth, and the readme stopped shipping its own history.

- **Follow-up chips.** "Retry" and "Continue" used to carry the *identical* prompt — two pills, one behaviour, implying a choice that did not exist.
- **`/new` no longer overstates itself.** It resets the OpenCode session; it cannot clear the Copilot thread you are looking at, and Copilot keeps replaying those turns…
- **The readme is a reference, not an archive.** The full release history lives in `CHANGELOG.md` in the repository, which does not ship.
- **`media/activitybar-clear.svg` removed** — referenced by nothing: no `viewsContainers`, no code.

### 0.0.172

Crash-safety on the spawn and stream error paths, a ship-gate false alarm, and a third of the installed size removed. No settings, commands or defaults changed.

- **The ship gate reported a failure that was not one.** `verify-chat-output.js` ended with `process.exit()`.
- **`killTree` could take the window down on Windows.** The `taskkill` spawn is wrapped in `try/catch`, but `spawn` reports failure asynchronously on the child, not as a…
- **Same class, `opencode serve`.** A spawn failure that is not `ENOENT` (`EACCES`, `EAGAIN`, `EMFILE`) surfaces asynchronously on `serveProcess`, which had no `error`…
- **Response-stream errors on the three HTTP helpers.** A socket that drops *after* the headers arrive emits on the response, not on the request.
- **`metrics.stderr` is bounded at 256 KB, head-first.** 0.0.167 removed the 4 KB tail because it dropped the part of a trace that names the cause; that was right, but…
- **`opencode serve`'s log output is decoded with `setEncoding`**
- **A failed `opencode serve` start now says why.** An asynchronous spawn failure leaves `exitCode = -errno`, so the startup poll threw `OpenCode server process exited…
- **The stderr cap announces itself once** in the output channel when it is reached, so a truncated trace is never silently truncated.
- **Installed size: 222 KB → 193 KB.** The readme ships inside the `.vsix` and is installed on every machine, and two thirds of it was release history nobody reads from…

### 0.0.171

Stream-decoding correctness, bounded spawns, and a visible icon. No settings, commands or defaults changed — every fix is behaviour-preserving on the happy path.

- **Multi-byte output is no longer corrupted.** Every stdout/stderr and HTTP response stream is now decoded with `setEncoding("utf8")` instead of calling `.toString()` on…
- **`opencode models` is bounded.** The catalog spawn had no timeout, so a gateway that accepted and never answered hung everything that awaits it — `/ping`, `/diagnose`,…
- **A dropped SSE socket can no longer take down the extension host.**
- **The server transport always releases its subscription.** `sse.close()` moved into a `finally`, so a throw while walking the response parts can no longer leak a…
- **CLI tool steps show the final detail.** `applyServerPart` already replaced a tool's detail when a later event carried a fuller input; the CLI path kept the first,…
- **A failed `/parallel` lane reports its real elapsed time** , not the configured cap — which with `timeoutMs` at its `0` default was `0.0s` — and carries its error…
- **Icons.** `media/icon.png` was a black mark on transparency, so it was invisible on the dark marketplace card and in dark themes.
- Dead `attemptsRun` counter and a stray `void state` removed; `chat.iconPath` no longer builds its URI from a segment with a leading slash.

### 0.0.170

Dev-experience polish on the same single chat surface.

- **Smart follow-up chips.** The v169 `followupProvider` now keys off whether this turn actually has a session, not just its kind.
- **Failed runs raise an error notification.** `notifyIfSlow` splits its output: a timeout or hard error fires `showErrorMessage` (with a one-click `Retry`) even when the…
- **No more `/plan` redundancy.** `/plan <task>` is the default agent, so it now behaves exactly like `<task>` instead of sending the stray `/plan ` into the task…
- **Long runs are no longer cut off needing a manual restart.**
- Dead `liveGraceMs()` removed (exported but never called, in code or the suite).

### 0.0.169

Three chat-surface refinements, all on the critical chat path.

- **`response.anchor` jump links.** Files the agent touches now render as inline clickable anchors in the answer body, beside the existing bottom "used references" chips…
- **Context-aware follow-up chips.** A `followupProvider` returns host-rendered follow-ups keyed on the turn's metadata: `Continue`/`Session`/`New session` after a normal…
- **Slash-command drift guard.** The control-command table is now a single source (`SLASH_COMMANDS`) that also derives the typed-`/word` regex, and the suite (`LB`)…
- Verification suite grew to 301 checks.

### 0.0.168

One chat surface, not a tooling zoo. v168 deleted the secondary surfaces that were reachable but off the chat-critical path. `plan` and `dev` are the only agents now.

- **Live View removed.** The webview panel (`openLiveView`, `liveViewHtml`), the `showLiveView` setting, the `opencodeCopilotBridge.liveView` command, and its palette…
- **Bench removed.** `/bench`, the **OpenCode: Measure Which Model Is Best** command, and the parallel model race (`benchmarkModels`/`raceModelsInChat`) are gone.
- **Manual `/compact` removed.** Autocompaction is untouched — `autoCompact` and `autoCompactEveryTurns` still summarize the session on schedule.
- **`/build` and `/research` aliases removed.** `/dev` is the editing agent, `/plan` the read-only one; the aliases had no behaviour of their own and are gone.
- Verification suite grew to 293 checks; the Live View webview checks were deleted and the shared-SSE-socket check (`JD`) now runs two concurrent server-transport turns.

### 0.0.167

Three removals, one theme: stop the bridge from cutting a run short or cutting its output down.

- **The wall-clock timeout no longer blocks a long task.** `opencodeCopilotBridge.timeoutMs` now defaults to `0` — no wall clock at all.
- **Captured output is no longer clipped.** stderr was kept as a 4 KB *tail*, which dropped the head of a trace — the part that names the cause — in exactly the case…
- **The event-schema drift detector is gone.** 0.0.150 shipped a hardcoded allow-list of 25 OpenCode event names, a `globalState` tally of anything outside it, and three…

### 0.0.166

- Removed the unused `/usage`, `/handoff`, and `/sessions` surfaces plus their dead implementation and test code.
- Removed obsolete briefing, transcript, usage, and follow-up files from the extension source and package surface.
- Verified the cleanup with the full headless suite and prepared the VSIX under `dist/`.

### 0.0.165

Four subsystems were removed so a chat turn is the coding path and nothing else. The unused commands, settings, source chunks, and legacy test blocks are no longer shipped.

- **Nothing is written into your workspace.** The markdown transcript, the HTML briefing, the `.turns.json` sidecar, `index.json`/`index.md` and the self-ignoring…
- **Chat is the answer plus the file chips.** Working list, `🤓` metrics footer, compact status line, context-size warning, handoff notice and follow-up chips are off.
- **Usage and spend tracking are off.** No recording, no budgets, no status-bar percentage, no `/usage` table, no spend in Diagnose.
- **The unparsed-output safety net is gone.** `rawStdout` was accumulated with a 256 KB string copy *per unrecognised line* — quadratic in a run that speaks a dialect the…
- **What deliberately stayed:** `timedOut`, `stderr`, `exitCode` and `hadOutput` on `RunMetrics` (they drive the handoff retry and the v153 stale-session recovery —…
- **Coverage lost, stated plainly:** the CLI/server step-dedup guard (`JF`) read its step count out of the metrics footer.
- **Not claimed:** no end-to-end turn speedup is quoted here.

### 0.0.164

Two defects in boundedness, an engine-floor correction, and a shipped-dark capability.

- **Retention no longer disables itself.** The "session this window drove" set was add-only, so a window that touched 60 chat threads protected 60 sessions forever and…
- **The turn-store cache evicts.** It was a `Map` that only grew; now a capped LRU (16 stores), cleared on teardown.
- **The Quick Actions title-bar button is gated.** It sat in every editor's title bar with no `when` clause.
- **Virtual workspaces declared unsupported** (`capabilities.virtualWorkspaces`), because the extension spawns a local binary and writes session files.
- **Engine floor raised to `^1.104.0`** (and `@types/vscode` with it).
- The ship gate now enforces documentation: the readme must name the current version, every command, and every setting, or `npm run ship` fails.

### 0.0.163

Performance and structure, no user-visible behaviour changes:

- One refcounted SSE subscription per server instead of one per chat.
- The briefing sidecar became append-only NDJSON behind an in-memory cache.
- CLI step dedup keys on `part.id`, like the server path already did.
- The server turn resolves on the SSE `"connected"` signal (with the old 80 ms kept only as the bound).
- Per-delta reasoning/text output-channel lines are gated behind `debugLog`.

### 0.0.162

- Progress inflation fixed: a reasoning delta no longer forces a step render; the backoff ladder is actually consulted now.
- Cross-session SSE leakage fixed: a `text`/`reasoning` part not attributed to this session is dropped instead of streamed into the reply.
- The marketplace "Repository"/"homepage"/"bugs" fields were removed — they pointed at an internal host that redirected to employer SSO.
- A stale-session restart keeps its session bytes, so the context warning stopped warning about hundreds of KB a new session did not hold.

### 0.0.156

- `httpPostJson` finally got the timeout `httpGetJson` had since 0.0.147.
- The per-turn transcript is now appended, not read-modify-written whole.
- The briefing `.html` is rendered on open from the `.turns.json` sidecar, not re-rendered after every turn.
- The usage write (debounced) is flushed in `deactivate()`, so closing a window right after a run no longer loses that run's cost.
- Untrusted workspaces can no longer name the spawned executable or the host it reaches (`capabilities.untrustedWorkspaces.supported: "limited"`).

### 0.0.155

The reported defect: **a new Copilot chat continued the previous OpenCode conversation.**

- **Sessions are now scoped to the chat thread, not the folder.**
- **Retention no longer deletes a conversation you still have open.**
- **OpenCode: New Session told the truth again.** It cleared the folder pointer, which under thread scope does nothing to the chat in front of you.
- `/session` says whether a session belongs to this chat, `/sessions` marks the ones open elsewhere, and `/env` reports the scope in effect.
- New setting: `sessionScope` (`thread` default, `workspace` restores the old folder-wide sharing).
- Verification suite grew from 250 to 281 checks.

### 0.0.153

Two defects that only show up in real use: one when you open a second repository, one when a remembered session disappears.

- **One shared server ran every workspace in the wrong directory.**
- **A stale session ID broke the workspace permanently.** The ID is stored per workspace and outlives OpenCode's storage.
- `/ping` reports how many sessions the shared server holds **for this workspace**, which is also a live check that the scoping is arriving.
- `repository`, `homepage` and `bugs` metadata added, so the packaged extension links back to its source.
- Verification suite grew from 232 to 250 checks.

### 0.0.152

Restored every release-gate fix the 0.0.151 drop had reverted, and fixed a non-hermetic check it shipped.

- **`@types/vscode` was back at `^1.136.0`** against `engines.vscode ^1.90.0`, which `vsce` hard-rejects — 0.0.151 could not be packaged at all.
- **The ship gate reported that rejection as a network outage**
- **The verify step could never run on Windows** — `shell: false` had been dropped, so `process.execPath` was split at the space in `C:\Program Files\nodejs\node.exe`.
- **`DA an empty workspace discovers nothing` was not hermetic.**
- The `CK` idle-timeout checks, deleted in 0.0.151 while the fix they guard was kept, are back.

### 0.0.151

Review pass over the `fallbackModels` handoff path. Three defects, all mine, all in accounting rather than behaviour — the handoff *worked*, it just lied about what it cost.

- **A timed-out attempt's spend was discarded.** `metrics` is reassigned on every attempt, so when a run timed out and handed off, the first attempt's tokens and cost…
- **Per-model usage credited the wrong model.** `recordUsage(metrics, model, …)` used the *configured* model, so a run that timed out on A and answered on B was billed…
- **The handoff chain was unbounded.** Every entry is a full run at the full timeout, so six fallbacks under a 180s cap allowed a thirty-minute turn.
- **Handoffs are now disclosed in the reply.** Previously you saw one answer and were billed for two runs with nothing in chat to say so.
- New setting: `maxHandoffAttempts`.
- Verification suite grew from 219 to 228 checks.

### 0.0.150

Awareness of OpenCode's own extension surface, defence against schema drift, and the 0.0.149 idle fixes carried forward.

- New command: `/env`.
- Verification suite grew from 197 to 219 checks.

### 0.0.148

Fixes the "`@opencode` returns nothing" report, plus adaptive timeouts, Copilot handoff, and session retention.

- **Salvage.** If a run produces no events, its raw stdout is cleaned of ANSI and leading banner lines and shown verbatim, clearly labelled as unparsed.
- **`/ping`** — connectivity check that calls no model: executable resolution, version, server health, model catalog tier, and the timeout policy in force.
- **Adaptive timeouts.** `timeoutMs` is the read-only baseline; `buildTimeoutMultiplier` (3x) sizes editing runs and `maxTimeoutMs` bounds them.
- **Clarification.** A bare single word gets a clarifying reply and a "Run it anyway" button instead of a wasted run; sending the same prompt again always runs it.
- **`/handoff`** — a paste-ready context block (question, files touched, where it got to, transcript path) so Copilot can continue without the OpenCode session.
- **`/sessions` and session retention.** Sessions are listed with sizes and retention status; `sessionRetentionDays` (30) and `sessionMaxCount` (50) prune automatically a…
- New settings: `timeoutStrategy`, `idleTimeoutMs`, `maxTimeoutMs`, `buildTimeoutMultiplier`, `clarifyVaguePrompts`, `sessionRetentionDays`, `sessionMaxCount`,…
- Verification suite grew from 159 to 197 checks, including a direct reproduction of the reported failure.

### 0.0.147

Response to the v0.0.145 review. Ship discipline, the Windows shim fix, and five defects closed.

- **Ship gate** — `npm run ship`.
- **`npm run probe:windows`** — measures PATH resolution, sibling scan, shim contents, and a hostile-payload argv round trip.
- **Windows shim fix** ported and covered: `readShimTarget`, `tokenizeCmdLine`, `expandShimVar`, `prefixArgs` through `spawnOpenCode`.
- **Five defects closed** — session-id path traversal, `escapeHtml` attribute escaping, `httpGetJson` timeout, `timeoutMs` default drift (code said 90s, package.json said…
- **Regression tripwires** for `textContent` over `innerHTML`, nonce CSP, `enableScripts: false`, optional-chained VS Code APIs, `taskkill /T`, immediate `stdin` close,…
- `AGENTS.md` rewritten with the rules, the open-defect table, and the assertion style that catches boundary bugs.
- Verification suite grew from 125 to 159 checks.

### 0.0.146

Aligned with **VS Code 1.136** (released 2 September 2026). That release has no Extension Authoring section and no deprecations, so nothing here was broken by it — but three of its features exposed real gaps.

- **Multi-root workspaces.** 1.136 gave agent sessions multi-root support; this extension had eleven hard-coded `workspaceFolders[0]` lookups.
- **Run notifications.** Mirrors 1.136's `chat.notifyWindowOnResponseReceived`: runs over `notifyAfterMs` notify when the window is unfocused, never when it is focused,…
- **Per-model usage.** Matches the per-model chat usage tracking 1.135 added.
- **Session index.** `index.md` in the session directory, in the spirit of 1.136's readable breadcrumbs for session files.
- **`engines.vscode` raised from `^1.85.0` to `^1.90.0`.** This is a correction, not a feature: `chatParticipants[].commands` and `followupProvider` have been used since…
- New settings: `notifyOnCompletion`, `notifyAfterMs`, `writeSessionIndex`.
- Verification suite grew from 104 to 125 checks.

### 0.0.145

Two ideas worth borrowing from `ltmoerdani/opencode-copilot-chat`, adapted to a local OpenCode instead of a hosted gateway.

- **Usage tracking.** Cost, tokens, cache reads, and run counts recorded per run and rolled up over session / today / rolling 5h / 7d / 30d.
- **Tiered model catalog.** live → cached → stale → configured, with the tier named in the picker and in diagnostics.
- **Diagnostics Runtime section.** Host, trust, platform, ComSpec, PATH size, catalog tier, usage rollup.
- New settings: `showUsageStatusBar`, `usageBudget.session`, `usageBudget.daily`, `usageBudget.rolling5h`, `usageBudget.weekly`, `usageBudget.monthly`,…
- New commands: **OpenCode: Show Usage**, **OpenCode: Refresh Model Catalog**.
- Verification suite grew from 83 to 104 checks.

### 0.0.14

Fixes two bugs visible in real use, cuts chat noise, and adds parallel lanes.

- **Fixed: the raw context block printed into chat.** Copilot silently adds its own instruction-file references (`.github/copilot-instructions.md`, `AGENTS.md`,…
- **Fixed: `$(codicon)` syntax rendered literally in follow-up labels.**
- **`chatDensity`** — `minimal` / `compact` (new default) / `full` (the 0.0.13 layout).
- **`/parallel a | b | c`** — concurrent lanes in isolated sessions, read-only by default, capped by `parallelMaxLanes`.
- **Self-ignoring session directory** (`autoIgnoreSessionDir`, default on).
- New settings: `chatDensity`, `autoIgnoreSessionDir`, `parallelMaxLanes`, `parallelAllowWrite`.
- Verification suite grew from 59 to 83 checks.

### 0.0.13

Additive only — no behaviour from 0.0.12 was removed or changed by default.

- **Slash commands.** `/plan /dev /parallel /session /new /model /help` registered in `contributes.chatParticipants[].commands`, so VS Code autocompletes them.
- **Attached context.** `request.references` become a `<workspace-context>` block in the prompt plus clickable chat references.
- **Heartbeat progress.** The progress line reports elapsed time against the cap instead of freezing between events.
- **Cancellation.** Announced, partial output kept, transcript written, not reported as a timeout.
- **Dead-end recovery.** Retry / Show log / Diagnose buttons on timeout, error, and spawn failure.
- **Follow-ups.** Up to three contextual one-click suggestions per reply.
- **Multi-turn briefing.** The HTML briefing previously kept only the most recent turn and overwrote itself; it now accumulates every turn behind a `.turns.json` sidecar,…
- **Status bar + `OpenCode: Diagnose`.**
- **Session totals.** Cumulative tokens, cost, and tool bytes reported by `/session`; cache-hit rate added to the chat footer.
- **`session.error`** from the SSE stream is surfaced instead of swallowed.
- New settings: `includeChatReferences`, `includeEditorSelection`, `progressHeartbeatMs`, `workingListMax`, `followups`, `statusBar`.
- Verification suite grew from 31 to 59 checks; all 31 original assertions still pass unchanged.
