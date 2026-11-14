---
name: lettuce-transcript-and-streaming
description: 'lettuce wire-shape mechanics the UI depends on: tool_return_message''s two shapes and why returns are keyed return:<tool_call_id>, every tool call arriving as approval_request_message, asynchronous AskUserQuestion receipts and the question card, blank/narration text folding in groupTranscript, provider errors arriving as JSON, why Stop cannot cancel a local generation, and the live-only data the BFF keeps because upstream stores it nowhere: turn errors, token usage (prompt_tokens is net of the prompt cache), turn-push settling, the BFF-enforced per-agent model call limit (step limit), and signed-out vs offline link state. Read before touching web/src/lib/messages.ts, web/src/components QuestionCard/ApprovalSheet, bff/src/session/turn-errors.ts, turn-usage.ts or step-limit-watchdog.ts, bff/src/push/turn-watcher.ts, web/src/lib/auth-probe.ts, or use-conversation.ts.'
---

# Transcript shapes, approvals, questions, stop

Loaded from `AGENTS.md`. Several of these are behavioural, not typed, so `bun run typecheck` cannot catch drift here.

- **Stop cannot actually cancel a local generation, and the app-server says it did.** The abort
  controller is wired to nothing, so the turn can only end when the model's **next chunk**
  arrives; press Stop during prefill and llama.cpp finishes the whole response. The UI **must**
  use `request()` and not `send()` for abort: a second press returns no frames at all and a
  stale runtime answers `success: false, error: "Runtime is no longer active"`, both visible
  only in `abort_message_response`; `use-conversation.ts` does, and renders its own honest
  "Stopping" line for the gap. Fixing the cancellation itself needs an upstream change; it
  cannot be done from here. Full call chain:
  docs/upstream-notes.md#stop-cancellation-call-chain.
- **`tool_return_message` has two shapes, and one call emits several frames.** A live delta
  carries the singular `tool_call_id`/`status`/`tool_return` fields **and** a `tool_returns[]`
  array; history persists only the singular ones. `tool_returns` is absent from
  `protocol_v2.ts`, so **typecheck cannot catch drift here** — a behavioural item, like
  `connection-lifecycle.ts`. One call can emit a running snapshot frame and a canonical one
  with different ids and no `otid`, so `web/src/lib/messages.ts` keys returns
  `return:<tool_call_id>` in both paths; the later frame carries the **corrected** status (the
  running snapshot reports `success` even for a command that goes on to fail, and the store
  persists the snapshot's status — upstream, not ours). Capture detail:
  docs/upstream-notes.md#tool-return-message-capture-detail.
- **Every tool call arrives as `approval_request_message`**, approved or not. The real approval
  prompt is the `control_request` frame that drives `ApprovalSheet`; the message is just the
  call record, so the transcript labels it "Tool".
- **`AskUserQuestion` is asynchronous since 0.34.1 — an opt-in question card, not an approval.**
  Upstream (LET-13511) replaced the blocking tool with `AskUserQuestionAsync` (model-facing name
  still `AskUserQuestion`), removed it from every default toolset, and removed its interactive
  approval classification entirely — it never raises a `control_request`, so `ApprovalSheet` is
  pure approvals now. The tool is offered only when the client opts in with
  `input.payload.client_preferences.toolset.include` (typed addition to
  `InputCreateMessagePayload`; omitted = inherit, supplied = **replaces** the per-conversation
  snapshot persisted in settings.json, `{}` clears; the include list is additive to the base
  toolset and validated against upstream's bundled tool names). The BFF stamps
  `include: ["AskUserQuestion"]` on every browser create_message relay
  (`session/protocol.ts` `withWebClientPreferences`) — same value every message, so the sticky
  snapshot never drifts; the BFF's own syncs and the sweep carry no preferences. The tool does
  **not** block: its return is an immediate receipt `{type:"ask_user_question",version:2,
  toolCallId,questions}` and is persisted like any tool return, so a pending question survives
  tab-away, reconnect and history rebuild. `web/src/lib/messages.ts` promotes every parsed
  receipt to a standalone `question` transcript entry (parsed and answered with the
  browser-safe npm module `@letta-ai/letta-code/ask-user-question` — same code both sides of
  our wire), `groupTranscript` never folds it into a steps run, and `QuestionCard` renders the
  form; Skip is `status:"dismissed"` with no answers. The answer returns as an **ordinary
  user message** built by upstream's `prepareAskUserQuestionNotif` (a `<task-notification>`
  block — `taskEntry` lifts the `<ask-user-question-response>` back out into
  `entry.questionResponse`, which is what flips the card read-only) and goes through the
  normal send path, so it can arrive whenever the user gets to it — from any device, or even
  as a Telegram message. The turn push says "Asked a question and is waiting for your answer"
  when the last turn's stream carried a receipt (`bff/src/push/turn-watcher.ts`).
- **An outbound `MessageChannel` send is promoted to a standalone `channel_send` entry, the same
  way a question is.** Folded into the run, the call is one step line whose subtitle truncates, so
  the transcript carried the agent's *claim* ("the digest is in your Telegram") instead of the
  message. `promoteChannelSends` (`web/src/lib/messages.ts`) reads the call's args — only the
  outbound actions `send` / `send-rich` / `upload-file`, because the same tool also reacts, binds
  threads and downloads files — plus the paired return: its `status === "error"` is the **only**
  failure signal, since upstream's executor returns `Error: …` text and sets `is_error` from that
  same test, while success reads `Message sent to telegram (message_id: N)`
  (`letta-code/src/channels/message-channel-executor.ts`). No return yet means pending, and
  pending shows no delivery badge; a badge before the channel answers is the lie the card exists to
  prevent. `groupTranscript` never folds it into a steps run (`ChannelSendCard`).
- **Every model text part is an `assistant_message`, even `"\n"`.** Local models emit text
  between tool calls — narration and, for some, a lone newline per step (`[thinking, toolCall,
  "\n", toolCall]` in the pi-ai store). `groupTranscript`
  (`web/src/lib/messages.ts`) drops blank text, treats text that more work follows **within
  the same turn** as narration (turn boundaries: your message, a task notification, an injected
  reminder, a notice) and folds a turn's work into one run headed by its latest narration line;
  only the turn's last text is an answer. Live, the newest text is an answer until a step
  follows it. A run emptied of steps is not a run: what is left is narration alone, so it renders
  as those messages rather than a fold headed "0 steps" — which is also what the Filter sheet's
  detail switches (`thinking`, `tool_runs`) leave behind when they hide a turn's whole run.
- **Provider errors reach the transcript as JSON.** `local-provider-errors.ts`
  `localProviderErrorDetail` joins the error message with `JSON.stringify()` of whichever of
  `responseBody`, `data`, `body`, `detail`, `code` the failure had, and the terminal `loop_error`
  carries that detail. `splitErrorDetail` in `web/src/lib/messages.ts` lifts the payload's own
  `message` for the headline and keeps the body behind a disclosure.

**Turn errors are live-only upstream, so the BFF keeps them.** A failed turn reaches clients as
a `loop_error` delta and `turn_finished.error`; neither is written to the message store, so
`conversation_messages_list` cannot show it. `bff/src/session/turn-errors.ts` records the last
few per scope (in memory), served at `GET /api/turn-errors`, and `mergeTurnErrors`
(`web/src/lib/messages.ts`) slots them back into the rebuilt transcript by date. The failure
push also carries the error's first line.

**Token usage is live-only too, so the BFF keeps it as well.** The context gauge's numbers come
from one `usage_statistics` stream delta per model step (`turn_finished.usage` exists only with
CLI `execution_settings`, which we never set). Folding the deltas per browser in `localStorage`
made devices disagree about the same conversation. `bff/src/session/turn-usage.ts` folds every
scope's steps (skipping `subagent_id` deltas, which share the parent's scope) and serves the
last finished turn plus the one in flight at `GET /api/turn-usage`; the web refetches on each
usage delta and `turn_finished`, and it observes frames **before** the fan-out so that refetch
always finds the step. Note the split pi-ai makes: `prompt_tokens` is **net of the prompt
cache**, which comes as `cached_input_tokens` (llama.cpp's slot cache) — an 85k context behind
a 790-token prompt is a cache hit, not a bug.

**The per-agent step limit is the BFF's, not letta-code's `max_turns`.** Upstream's cap
(`execution_settings.max_turns` on `runtime_start`) rides the runtime a browser opens, so cron and
Telegram turns would run uncapped; it also pins runtimes the BFF's one connection stays subscribed to,
and replaces the shell's `MEMORY_DIR`. `bff/src/session/step-limit-watchdog.ts` keeps its **own** step
count — `turn-usage.ts` forgets the turn in flight at every compaction, and a turn long enough to compact
is the one a limit is for — and, at the agent's limit (`bff/src/agents/step-limit.ts`, Agent → General's
**Model call limit**; "steps" there would clash with the transcript fold's "N steps", which counts items),
sends `abort_message` with the turn's `run_id` when the stream showed one, but only when that step asked
for a tool (a step's `approval_request_message` precedes its `usage_statistics`), so a final answer is
never stopped. `abort_message` is the user's Stop, so the watchdog undoes what upstream's own cap does not
do: it parks queued user messages (a `resume_queue` follows the stopped turn's finish) and emits an
"Interrupted" status (dropped for that run). Once the app-server confirms the abort (`aborted: true`), the
`cancelled` `turn_finished` is rewritten to `max_steps` with an error, preceded by an injected terminal
`loop_error` delta, **before any consumer sees it** (`translate`, first thing in `onFrame`): the
transcript, the turn errors and the push read it like upstream's own cap. A user's Stop that landed first
is not rewritten. The abort shares Stop's limit: a model call already running finishes its prefill first.
And **the model is told the user interrupted it**: the capped step's tool calls persist as "Interrupted by
user", and upstream sends `interrupt_recovery_alert.txt` ("The user interrupted the active stream",
`turn-setup.ts`) after those results and ahead of the conversation's next input, where its own cap denies them with "Maximum turns limit
reached". `abort_message` carries no reason, so this is a known limit of the approach, not ours to fix.

**A turn push waits for the agent to be done, not for `turn_finished`.** One request often
spans several turns and `turn_finished` fires for each. `bff/src/push/turn-watcher.ts` holds a
finished turn until the scope has had nothing processing (`update_device_status`), nothing
queued that will run (`update_queue`, paused items excluded) and no pending/running subagent
(`update_subagent_state`) for `SETTLE_MS` (5 s), then pushes the **last** turn's outcome,
capped at `MAX_HOLD_MS` (30 min) so a stuck subagent cannot swallow it. Whether a session is
watching is decided when the push is due. Titles name the agent (`agent_retrieve` via the
permanent connection, cached 10 min in `push/agent-names.ts`, "Letta" if the lookup fails).

**An expired login must not look like "offline".** A refused WebSocket upgrade reaches the
browser as close code 1006 with no HTTP status, identical to a dropped network. Two rules:
- `/ws` resolves the session exactly like HTTP (`bff/src/auth/resolve-session.ts`: cookie, else
  the Access JWT, minting a cookie onto the 101). A signed-out upgrade is **accepted and closed
  with 4401** after a `__bff_auth_required` frame — never refused — because a close code is the
  one signal the browser can read.
- An expired **Cloudflare Access** login is blocked at the edge before the BFF sees it. After
  two consecutive failed opens `SessionClient` probes `/api/status` with `redirect: "manual"`
  (`web/src/lib/auth-probe.ts`): an `opaqueredirect`, 401/403 or `authenticated: false` means
  signed out → link state `signed-out`, and `use-session.ts` reloads the page once (top-level
  navigation is the only way through Access's login), at most every 5 minutes; after that the
  pill is a "Sign in again" button. A network error keeps the ordinary backoff.
