# Remote Pi live — trustworthy progress, then a live UI

Plan for the branch `feat/pi-live`. Written from the prod post-mortem of agent **olla**,
conversation `local-conv-120` (2026-10-08/09), where a healthy 18 MB run streamed for 26
minutes while `pi_status` reported `events 0` — the agent concluded the integration was
wedged, force-detached healthy runs, paid for a duplicate planning run, and wrote a false
"queue serialization" lesson into its memory. The evidence is in the run store: `pi_status`
reads `meta.eventCount` / `meta.lastEventAt` from disk, and `runner.ts` persists the meta
only on the `session` header line and at exit — send runs show `events 0`, fresh runs show
`events 1`, until the process exits. Nothing was wedged; the status was lying.

User-visible symptom today: **there is no way to watch a remote pi run**. The only updates a
human gets are whatever the agent chooses to relay, and the agent can only get them by
burning turns on sleep/poll loops and self-scheduled wakes.

## Goals

1. Progress truth: `pi_status` (and everything downstream) reports what the run is actually
   doing — event growth, last activity, current step, honest quiet detection.
2. Stop faking interactivity: one-shot `pi_wait` for agents that must block; a web-push on
   settle so humans do not need the agent to relay; cancel that really cancels.
3. A live UI: a run card in the transcript, a dedicated **Runs** tab with a live run viewer
   for every remote worker, an active-runs chip — so "any updates from pi?" is answered on
   screen, updating, without an agent turn.

## Non-goals (this branch)

- Full interactive rpc-mode sessions (steering, answering remote approvals from the chat).
  That is the post-branch milestone; § C.3 sketches it. This branch makes one-ssh-per-turn
  honest and its surfaces live, which is the prerequisite either way.
- Artifact fetch (`pi_fetch`) ships in its own follow-up (§ C.1); the mockups show where
  artifacts will land, the card hides the section until the backend exists.
- Per-agent host/settings work is already shipped (`feat: per-agent Remote Pi settings`);
  nothing here changes resolution.

## A. Backend — progress truth and control (`bff/src/pi/`)

A1. **Persist progress during the run** (`runner.ts`). `handleLine` updates `eventCount` /
    `lastEventAt` in memory only; add a throttled flush — write the meta at most every 2 s
    (or every 64 lines) when dirty, and always on terminal transitions. Add
    `bytesCaptured: number` to `PiRunMeta` (0 for old files).

A2. **Seek-based tail** (`DirPiRunStore.readEventsTail`). Today it `readFile`s the whole
    capture (prod: 18 MB per `pi_status` poll) and slices. Open the file, `stat` it, read the
    last `maxChars` via positional read. Same signature, same leniency.

A3. **A real `pi_status`** (`service.ts`). When `state === "running"`:
    - read the tail (A2, ~256 KB) through the existing `parsePiRun` steps and report:
      **current step** (last `tool_execution_start` without an end, e.g. `Bash: npx playwright
      screenshot …`), **last assistant `message_end` text** found scanning back through the
      tail (not the current 4 KB guess), and the step count;
    - report `events N · Xs ago` from the persisted meta (A1) and mark **`quiet 7m`**
      (warn) when the capture file's mtime is > 60 s stale while the ssh child is alive;
    - keep the existing plain-text shape; it is tool output, not JSON.

A4. **`pi_wait {run, timeout_seconds}`** (new tool, cap 120 s, default 60). Resolves when the
    run reaches a terminal state, returning the `pi_status` body; on timeout, returns the
    current status with a `still running` line. Implementation: an in-process wait map keyed
    by runId that the runner's exit hook drains; also resolves on `force` kill. This is the
    replacement for background-`sleep`-poll loops and `Wake` hacks; the `pi_run`/`pi_send`
    answers change to: `… pi_wait {run} blocks until it settles; pi_status shows progress.`
    `approval: "auto"`.

A5. **Real cancel.** The remote command becomes `… pi … & rp=$!; echo "lettuce-remote-pid $rp"
    >&2; wait $rp`. The runner parses `lettuce-remote-pid <n>` off stderr into
    `meta.remotePid`. `pi_stop {run, force?: true}`: with force, a second ssh runs
    `kill <rp>` and the run records a new terminal state **`cancelled`** (add to
    `PiRunState`, all readers stay lenient with unknown strings). Detach stays the default and
    keeps its honest wording. Guard against killing pid 0/negatives (validate digits).

A6. **Web-push on settle** (`bff/src/push/`). The runner already knows the exact settle
    moment; on `completed` / `failed` / `cancelled` (not `detached`) fire a web-push:
    `Remote pi completed — <prompt first line>` (and the failed/errored variants), deep-link
    to the Tasks tab run viewer. Follow the existing `turn-watcher` subscription model;
    silence while the same conversation's turn is still open is *not* needed — a settled run
    is exactly what a waiting human wants; keep one notification per run.

A7. **Session-busy hint.** In `startRun("send")`, `findBySession` already runs; if the origin
    run is still `running`, append `note: run <id> is still live on this session` to the
    answer so the model does not pile sends onto a busy session.

A8. **Retention** (`service.ts` boot + hourly sweep). Delete run meta+jsonl older than 14
    days, capped to the newest 300 runs. Prod accumulates 7–18 MB per planning run forever
    today (`/app/data/pi/runs` holds captures back to Sep 30).

A9. Tests (`bff/src/pi/pi.test.ts`): fake spawner emits lines on a controlled cadence →
    meta flush is throttled but ≤ 2 s stale; seek-tail equals whole-file-slice on a fixture;
    `pi_status` shows current step + quiet verdict; `pi_wait` resolves on settle and on
    timeout; `force` kill argv and `cancelled` state; retention sweep keeps the newest 300.

## B. UI — live surfaces (`web/`)

Gates: mockups approved **before** implementing (this doc + `.mockups/pi-live.html`),
`bun run ui-check` + holistic pass after, both widths.

B1. **Run card in the transcript.** `web/src/lib/messages.ts` recognizes a paired
    `pi_run`/`pi_send` tool return whose text holds a run UUID; `MessageList` renders an
    `.entry.tool.pirun` card instead of the raw text row (the text stays in the fold). The
    card polls `GET /api/pi/runs/:runId` every 3 s while `running` and stops on terminal
    state. States (see mockups): running (current step + events + age), quiet (warn pill,
    mtime-based), completed (ok pill + last assistant text + artifacts section placeholder),
    failed (bad pill + error), detached (warn pill + "remote outcome unknown"), cancelled.
    Actions on the card: **View run** (opens the sheet) and **Stop** / **Force stop** (two-
    click confirm, mirrors the rotate-key pattern). New BFF route
    `POST /api/pi/runs/:runId/stop {force}` — the tool already exists; the browser needs a
    door.

B0. **Runs tab.** A seventh tab, `Runs` (label order: Chat · Files · Tasks · **Runs** · Memory
    · Tools · Agent — the nav already scrolls, and `Runs` clears the 58px phone budget).
    It hosts the three worker run lists moved wholesale out of `TasksTab` —
    `PiRunsList`, `CodexRunsList`, `ClaudeRunsList`, same feature gates — because
    "codex / claude-code / pi ran a job for me" is one kind of screen, and Tasks is then
    honestly *scheduled* runs (crons, background tasks) only. The components already exist
    as self-contained lists that open their sheets; the move is imports and section-notes.
    Deep links use `?tab=runs`.

B2. **Live run viewer.** `PiRunSheet` (opened from the Runs tab) polls while `running`: new endpoint
    `GET /api/pi/runs/:runId/events?since=<byteOffset>` → `{next, lines, state}` over the
    seek reader (A2); the sheet appends parsed steps and auto-scrolls at the live edge with
    a `Running…` peek line (existing `.tool-peek`). Terminal runs render once, as today.

B3. **Active-runs chip.** Topbar: when `features.pi` and any run is `running`, a `pi · N`
    pill (existing `.pill` language, next to the ContextGauge) opens a small menu listing
    live runs (prompt one-liner, host, age) → tap opens the sheet on the Runs tab. App-level
    poll of `/api/pi/runs?limit=20` every 10 s only while at least one run is active (plus
    on focus).

B4. **Push → deep link.** A push tap opens the app on the Runs tab with the run sheet open
    (`?tab=runs&run=<id>` query handling in App.tsx).

B5. `web/src/lib/pi.ts`: `stopPiRun(runId, force)`, `piRunEvents(runId, since)`; status
    union gains `cancelled` (renderers default unknown → neutral tag, as `detached` does).

B6. ui-check assertions: card renders for a scripted pi_run return (fixture), pill tone per
    state, no horizontal overflow at 390px on the card and sheet; chip hidden when idle;
    Runs tab active-state and the moved lists appear there and are gone from Tasks.

## C. Follow-ups this branch sets up but does not ship

C1. **`pi_fetch {run|session, path}` + `pi_ls`** — ssh `cat` (path confined to the agent's
    configured workdir, 25 MB cap) into `runs/<runId>/files/`, served under
    `/api/pi/runs/:runId/files/<name>`; card shows an Artifacts row with image thumbs
    (mocked so the layout is approved now). Replaces the `python -m http.server` dance the
    olla agent invented to move PNGs.
C2. Prompt via stdin instead of argv (visible in remote `ps`, ARGV_MAX), and a `check` probe
    that the remote pi never blocks on tool approval in the configured workdir.
C3. **Interactive milestone**: one persistent ssh + `pi --mode rpc` per pi session
    (ControlMaster multiplexing), live stream, steering, real interrupt, remote approvals
    surfaced as an in-chat card (the QuestionCard pattern). `pi_wait`/push are the honest
    interim; rpc is the real thing.
C4. Correct olla's memory note (`references/remote-pi.md`): there was no queue wedge.

## PR split

PR-1: A1–A7 (+tests) — backend only, ships `pi_wait`, `force` stop, honest status; the
transcript is unaffected. PR-2: B0–B6 + A8 (one shippable UI story: Runs tab + card + live
sheet + chip + push deep link). Mockups ride PR-2's body.

## Mockups (gate 1 artifacts)

`.mockups/pi-live.html` + `.mockups/shot.ts` → `.mockups/png/pi-*.png` (deviceScaleFactor 2,
real `web/src/styles.css`, app class names):

| png | surface |
|---|---|
| `pi-card-running-phone` / `pi-card-running-desktop` | card mid-run: step, events·age, View/Stop |
| `pi-card-quiet-phone` | warn pill, quiet 7m |
| `pi-card-done-phone` | completed + last text + artifacts row (C1 preview) |
| `pi-card-failed-phone` | failed + error; detached variant below |
| `pi-tab-phone` / `pi-tab-desktop` | the new Runs tab: all three worker lists, live sheet open |
| `pi-viewer-live-phone` / `pi-viewer-live-desktop` | live sheet at the live edge |
| `pi-chip-desktop` | topbar chip + live-runs menu |
| `pi-card-widths-desktop` | card at narrow container (tablet) — truncation check |
