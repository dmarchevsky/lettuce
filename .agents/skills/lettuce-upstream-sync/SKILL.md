---
name: lettuce-upstream-sync
description: 'Run `bun run sync-upstream v<x.y.z>` to move lettuce to a new letta-code release: what the script does, why only published release tags are acceptable, typed vs behavioural drift and the upstream files whose changes typecheck cannot catch (connection-lifecycle, gateway supervisor, background-process-protocol, toolset-catalog, settings-path, subagent-control, the channel state files Settings → Telegram writes), the six version literal sites and the stale-pin precedence trap, why the reference checkout must not lag the pin, and why a version bump is a full redeploy. Read when bumping LETTA_CODE_VERSION or running sync-upstream.'
---

# Upstream sync and version pinning

Loaded from `AGENTS.md`. Everything the stack runs comes from a published artifact; the checkout sitting one commit past a tag has nothing to pin to.

## Upstream sync

`bun run sync-upstream v<version>` — fetches upstream tags, reports protocol and behavioral
drift between the checkout's current tag and the target, checks the target out (detached),
re-pins every version site to the new release, and typechecks.

**A sync plan adjudicates from the script's "Watched-file drift" section and never from a
hand-listed subset of paths.** That section is the real tag-to-tag diff intersected with the
script's own `PROTOCOL_FILES`/`BEHAVIOR_FILES` arrays, printed as a count with the list — a
flow that hand-picks paths silently files whatever it forgot as unchanged (one wrote "only
three watched files moved" into an approved plan while the arrays answered eleven).

**`bun run check-pin-upstream` is the first step of any component-version survey**, this one included: it
already checks `LETTA_CODE` plus `CODEX`, `CLAUDE_CODE`, `WORKSPACE_MCP`, `DDG_MCP`, `SEARXNG`, `GH` and
`CLOUDFLARED` against their registries in one pass. Ad-hoc probes mislead twice: the reference clone's
`origin` is a lagging mirror with **no tags at all**: `git ls-remote --tags origin` answers empty *and exits 0*,
so a probe that trusts the exit code reports "no newer release" as fact. The probes that work are
`npm view @letta-ai/letta-code versions`, `git ls-remote --tags https://github.com/letta-ai/letta-code`, and
the GitHub compare/tags API — quote one of them, and a freshly published npm version can still take hours to
appear under `/<pkg>/latest`. A survey
done by hand therefore reports a pin as behind or ahead of what the registry actually holds.

An **upstream release note is a claim about upstream's app, not about this install.** Before a note reaches
`plan.md` or the changelog, adjudicate it against the code path a local install actually reaches, and name that
path (`file:line`, or the BFF route that stands in for it). A note about a route the BFF never speaks, a method
behind cloud-only auth, or a UI surface this app does not render is **Cloud-only here**: drop it or mark it so.
Two claims once reached an approved plan and a changelog line describing cloud behaviour (`MCP tool timeouts
explain themselves` among them), and only the independent review caught them; typecheck says nothing, because
nothing local changed.

Protocol drift shows up two ways:
1. **Typed** — `web/` and `bff/` import from `@letta-ai/letta-code` (pinned to the npm release
   matching the running image), so `bun run typecheck` fails on any breaking protocol change.
2. **Behavioral** — types will NOT catch these; the sync script flags changes to:
   - `src/websocket/listener/connection-lifecycle.ts` — the turn-cancellation semantics above.
     0.34 keeps them for a normal listener socket (the last subscribed connection closing still
     cancels with `cause: "transport"`), but a close no longer *drops* queued messages: they are
     detached (`connectionId: undefined`) and the queue pump runs them when a subscribed
     connection returns. So a BFF restart mid-queue now replays the queue instead of losing it —
     verify dedup in the ring buffer, do not assume the drop.
   - `src/types/turn-finished-protocol.ts` (new since 0.34.2) — `input.terminal_consumer_id`,
     `turn_finished.terminal_consumer_ids` and a `turn_finished_ack` command: a durable, acked,
     fsynced terminal journal for clients that declare a consumer id. **Dormant for us** — the BFF
     sends no `terminal_consumer_id`, and upstream sets it only when the client does. That same
     durable ledger capped an accepted input at 1 MiB until 0.34.9 raised it to 21 MiB: a queued
     message carrying an inline base64 photo used to be dropped with no error at all.
   - `src/channels/gateway-supervisor.ts` and `src/channels/gateway-local.ts` — if the gateway
     ever gains `--ws-auth`, the shared-network-namespace workaround can be dropped.
   - `src/types/background-process-protocol.ts` — `readBackgroundProcesses` hand-parses these
     and drops unknown kinds. 0.33 made `workflow` a native kind (it used to arrive as `bash`
     with a `workflow_N` id); a missed new kind vanishes from the Tasks tab without a type error.
     0.34 added an optional `progress` to a running `workflow` (`agents_total/done/failed/running`,
     `total_tokens`, per-phase) — nothing breaks without it, the Tasks tab just cannot show it.
   - `src/tools/toolset-catalog.ts` — which tools agents actually get. 0.33 removed `memory`,
     `MultiEdit`, `TodoWrite` and the Codex shell aliases, and added `Wake` (durable timed
     follow-ups stored in the local cron scheduler — so they fire only because the BFF's
     permanent connection keeps the scheduler running, and they appear in `cron_list`).
     0.33.3 added `WatchPR` (a `monitor` background process with `source:
     "github_pull_request"`). It shells out to `gh api`, so the app-server image carries the
     GitHub CLI (pinned `GH_VERSION`, installed from the release tarball — the base image has
     no apt, gzip or git). Its login is in `GH_CONFIG_DIR=/root/.letta/gh`, persisted and
     readable by every agent shell; setup is in
     [`docs/CONFIGURATION.md` → GitHub (WatchPR)](../../../docs/CONFIGURATION.md#github-watchpr).
     0.34.1 removed `AskUserQuestion` from every featured toolset — the async question tool is
     offered only through `client_preferences.toolset.include`, which our BFF stamps on every
     browser message (see the `lettuce-transcript-and-streaming` skill). 0.34.7 put a `Memory`
     tool back in three toolsets: read-only progressive discovery of *deferred* MemFS v2 memory
     (a `path` arg; it lists a directory's `MEMORY.md` and its children). It is gated on the
     agent's memory dir actually being memfs-v2 with a root `MEMORY.md`, and the permission
     checker auto-allows it outside Strict mode. `web/src/lib/working.ts` and `tool-summary.ts`
     still only know the old lowercase `memory` — `Memory` needs its own verb/summary.
   - 0.34.17 added **`CodeMode`** to the same three toolsets: the agent submits a JavaScript
     async body and calls tools from it (`tools.<name>(args)`, MCP as `tools.mcp__server__tool`),
     which makes one call where a model otherwise needs ten. Decided at the 0.34.21 sync: **not
     advertised** — it renders as an unlabeled tool row (`summarizeToolCall` returns null for an
     unlisted tool, as `Memory` did before its summary), and that is intentional, so the next
     sync should not "fix" it. Two things to re-check on every sync instead: a mod disabled per
     agent (`isEnabled`) must stay unreachable from a script (upstream filters it out of the mod
     tool registry in `mods/tool-registry.ts`, so `tools.<name>` should say "not available"), and
     nested calls that would need an approval card **fail** rather than prompt — so every
     `approval: "ask"` tool we render (`gmail_*` writes, `mcp_call_write`) is out of reach from a
     script by design.
   - `src/types/subagent-protocol.ts` + `subagent-events.ts` (typed, so `typecheck` sees the shape
     but not the semantics) — since 0.34.38 `read_subagent_events` pages a subagent's event log
     (`tool_call`/`tool_result`/`text`/`reasoning`/`notification`, `next_seq`, `missed`, an oversized
     event cut with a `[truncated N bytes]` marker). **It reads the in-process `stores` Map in
     `subagent-events.ts`, not the task's JSONL file** — so the readable log dies with the app-server
     process, the 32 MiB cap is a memory cap, and `missed` counts events evicted from RAM. The durable
     record is separate: `task-transcript.ts` appends every event to `log.eventsFile` under
     `TASK_EVENTS_MAX_BYTES` (256 MiB), which is what a Tasks transcript should read. Read the two
     gates separately: **the readable log (`event_seq`) exists only for a caller-notified launch** —
     `serveTaskEvents` runs under `if (publishResult)` in `task.ts` — while `progress_texts` is
     **not** gated (`addProgressText` runs in an **external-worker** task's `onText` — the only caller
     is `externalWorkerProgressListeners`, wired on the generic external-worker branch, so any worker
     type gets it), so a snapshot can carry recent progress text whatever the launch mode. Neither
     command is on the BFF allowlist yet.
   - `src/websocket/listener/commands/subagent-control.ts` — steering a **local** external worker (a
     `codex_<thread>`/`claude_<session>` id, no `@computer`) was already allowed at 0.34.21; do not
     record it as new. What 0.34.37 added is `ownsNativeSession`, so a worker stays steerable after
     its background-task row is evicted, plus resumes getting the launch environment. The guard that
     rejects a `@computer`-routed id is unchanged and is the boundary for what a browser may send.
   - `src/utils/settings-path.ts` — every `~/.letta` path resolves through it now, and its two
     resolvers are **not** interchangeable: `resolveGlobalConfigDir` is `LETTA_CONFIG_DIR` (absolute
     or it throws) else `$HOME/.letta`, and `resolveGlobalStateDir` additionally honours `LETTA_HOME`
     (only when `LETTA_CONFIG_DIR` is unset). So settings.json and the mods dir ignore `LETTA_HOME`
     entirely; global skills do not. Decided at the 0.34.38 sync: **`LETTA_CONFIG_DIR` not adopted**
     — one env var at a time, and the shared MCP list's `HOME=/root/.letta/mcp-home` moves with it.
   - `src/mods/paths.ts` — the same move on the other side of the mod contract:
     `getGlobalModsDirectory` and the extensions dir now resolve through `resolveGlobalConfigDir`, so
     a `LETTA_CONFIG_DIR` would move where the mods the BFF *writes* are discovered — and they also
     honour `LETTA_MODS_DIR` / `LETTA_EXTENSIONS_DIR` first, so nothing sets it today either way.
     `mod-sources.ts`, `mod-engine.ts`, `types.ts` and `mod-diagnostics-file.ts` are byte-identical
     across this range, so render, reload and diagnostics did not move.
   - `src/agent/skills.ts` — since 0.34.27 `GLOBAL_SKILLS_DIR` became `getGlobalSkillsDir()` off
     `resolveGlobalStateDir`, so the global skill root is now conditional, while `bff/src/skills/`
     re-implements discovery against the fixed `/root/.letta/skills`; if the root ever moves, both
     move. Separately, since 0.34.22 `runtime_start` takes `bundled_skills`: expose named bundled
     skills while `skill_sources` omits `"bundled"` — the per-agent granularity `bff/src/skills/`
     cannot express today, since its smallest unit is a whole source.
   - `src/types/schedule-protocol.ts` — `CronRunOutcome` gained `delivered` and `CronRunReason` a
     `dequeued`. Nothing renders an outcome exhaustively today, so it is silent until we do.
   - the local backend's request kind — since 0.34.32 a local-backend request carries
     `x-letta-request-kind: turn|compaction` (emitted in `src/backend/dev/pi-request-headers.ts`, used
     by `pi-stream-adapter.ts` for turns and `local/compaction.ts` for compactions), and
     `model_settings.temperature` plus verbosity actually reach the endpoint. That is a behaviour
     change on our primary provider: a compaction is now distinguishable at the llama.cpp end, and a
     temperature that was silently dropped is not.

   - `src/websocket/listener/control-inputs.ts` — this sync answers the standing question: a browser
     `abort_message` still takes the old path (return `true`, cancel fire-and-forget, pump the queue at
     once), so nothing the Stop button does moved. New is a `confirmBackendCancellation` caller — only
     `subagent_stop` sets it — which awaits the cancellation lease for up to 10 s and **throws** unless
     the backend reports every run `cancelled`. Stopping a worker settles instead of answering
     optimistically, and a stop the backend cannot confirm is an error rather than a success.
   - `src/tools/manager.ts` — tool **scopes** were removed (0.34.46): an external tool is owned by the
     runtime its registering connection holds, not by a scope id, and a client tool call can now
     auto-background (0.34.50), with a hung foreground one timed out soon after. Dormant for us — the BFF
     registers no external tools — but `protocol_v2.ts` now exports `ExternalToolCallCancelMessage` in
     the external-tool union, so a controller that *does* register one must handle a mid-call cancel.
   - `src/permissions/checker.ts` — since 0.34.42 path arguments are expanded (`~`, relative-to-cwd)
     **before** the permission check, so `~/secrets/x` is judged on the file it will really open instead
     of the literal string. That tightens the boundary our `approval: "ask"` write tools sit inside; it
     does not move where that boundary is.
   - `src/tools/impl/codex-app-server.ts` + `external-coding-agent.ts` — the worker path our shims sit
     in. Since 0.34.44 the spawn may lead with Codex CLI overrides (`-c key=value`) before
     `app-server --stdio`, when upstream proxies a worker's model calls for tracing
     (`external-llm-trace-launch.ts`). That proxy is Cloud-only — it returns undefined outside the `api`
     backend, and this stack sets `LETTA_LOCAL_BACKEND_EXPERIMENTAL` — so it never fires here, but our
     shim now reads its subcommand off the first **non-option** argument rather than `args[0]`, so a
     Cloud-side flip cannot quietly stop the sandbox rewrite. A worker shell also gets
     `LETTA_PARENT_CONVERSATION_ID` now (0.34.44).
   - `src/tools/impl/send-agent-message.ts` — `SendAgentMessage` finally **works on the local backend**
     (0.34.50): it refused with "SendAgentMessage requires a Cloud backend." whenever the
     backend had no environment routing, which is every local install. That is the follow-up and steering call the shipped `delegating-to-codex` and
     `delegating-to-claude-code` skills tell an agent to use, and the call the BFF's worker policy mod
     guards, so both the steer-a-running-worker path and its denial path became real here. `toolset-catalog.ts`
     itself did not change — the tool was already listed; it just could not be served.
   - `src/tools/impl/task.ts` + `src/types/subagent-protocol.ts` — a launch now names its runner with
     `harness` (`letta` | `claude-code` | `codex`) and may `fork_context` to inherit the parent transcript
     (0.34.40, by default since 0.34.44); the old `subagent_type` spelling is still translated, so our
     `subagent_type: "codex"` keeps working. `subagent_stop` gained `conversation`/`client_message_id`
     and a `cleanup_confirmed` answer, and for a native worker it now really kills the Claude/Codex
     session — so a browser-driven worker stop may take seconds, not a frame. Fresh preset subagents can
     run in ephemeral conversations (0.34.49), but `shouldRunSubagentEphemerally` refuses the local
     backend, so a subagent here still gets its hidden agent.
   - `src/channels/gateway-core.ts` — the gateway now re-registers a conversation with
     `mode_is_default: true` beside its default permission mode (0.34.40), so a mode someone chose in
     that conversation survives re-registration instead of being overwritten by the channel default.
     Nothing in our tree reads `mode_is_default`; the gateway is upstream's own image, so this lands in
     a Telegram install by itself.
   - the summarisation default — `DEFAULT_SUMMARIZATION_MODEL` (`letta/auto`) is gone entirely (0.34.45):
     a compaction with no model of its own now falls back to the agent's own model, or nothing. Upstream
     stopped defaulting to retired Letta-hosted models at all in the same release, and a local compaction
     that cannot get under the pressure threshold now raises the matching error type instead of looping
     or overrunning the server (`src/backend/local/compaction.ts`, 0.34.42). All of it lands on our
     primary provider, where a cloud summariser name could only ever fail.
   - `src/backend/local/compaction.ts` + `compaction-settings.ts` — since 0.34.61 the local backend
     can summarize instead of truncating: `LocalCompactionMode` is `all | sliding_window |
     self_compact_all | self_compact_sliding_window`, and a `self_compact_*` mode compacts inside the
     agent's **own** request context — the turn's system prompt, history and tools plus a compaction
     prompt — so it needs no second model, which is exactly what a local install lacks. The default is
     unchanged (`sliding_window`, `LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE` 0.3), so nothing moved for
     us until asked: it is per-agent and arrives through a verb we already speak, `create_agent` or
     `agent_update` with `compaction_settings {mode, prompt, clip_chars, sliding_window_percentage}`,
     validated by `validateLocalCompactionSettingsRecord` and kept on the local agent record.
   - the model catalog is a **dependency, not a pin**: `@earendil-works/pi-ai` went `^0.99.1` → `^1.5.2`
     across this range and the script prints only the two ranges. It is what Settings → Providers lists,
     so a catalog move changes the model list and the counts written in `docs/CONFIGURATION.md` with no
     lettuce file touching them. Recount from the installed copy —
     `node_modules/.bun/@earendil-works+pi-ai@<v>*/…/pi-ai/dist/providers/data/openrouter.json`, a dict
     keyed by api type where chat is `anthropic-messages` + `openai-completions` (398 at 0.99.2 → 403 at
     1.5.2) and `openrouter-images` (57 → 66) and `typesafe-system-one` (9 → 36) are not chat. Take the
     copy whose version the lockfile resolves: a bump leaves the previous copy installed beside it, and
     the glob above matches either. The same number is repeated in code — the OpenRouter entry's
     comment in `bff/src/providers/registry.ts` once claimed the catalog's Claude count and now refuses
     to, because nothing catches a stale one. Same turn upstream renamed Azure's provider id
     `azure-openai-responses` → `azure` with the old spelling aliased; nothing in our tree names either.

   **Eleven watched files moved** over 0.34.56 → 0.34.63 (the list was 61 files at the time; it is a
   line longer now). Take that count from
   `git diff --name-only <old>..<new>` against the script's own two arrays, not from a hand-picked
   list: this sync's first pass diffed a subset, reported three files, and silently filed the eight it
   had forgotten as unchanged. What moved, and what it costs us:
   - *typed and inert*: `protocol_v2.ts` (`cloud_monitors` joins the `ExperimentId` union; nothing here
     switches on an experiment id) and `subagent-protocol.ts` (`"queued"` joins
     `SubagentMessageResponse.delivery`, 0.34.62 — a steer aimed at a worker mid-tool-call is queued
     rather than refused). The second stays unread because `subagent_message` is on no BFF allowlist;
     if it ever is, `"queued"` needs a label of its own.
   - **the subagent steering guard moved — ownership is now judged against the parent *agent*, not the
     parent *conversation*** (`subagent-control.ts`, 0.34.59's worker handoffs: `parentConversationId`
     is gone from `findOwnedTask` and `ownsNativeSession`, and the refusal text is `subagentAccessError`).
     `subagent_stop` **is** on the BFF allowlist, so a stop from a different conversation of the same
     agent is accepted where it was refused. One user behind one trust boundary, so this is a widening
     rather than a hole — but it is the boundary this file exists to describe, so it is written down here
     and nowhere else.
   - *local provider, one family*: `pi-model-factory.ts`, `pi-stream-adapter.ts` and
     `provider-turn-executor.ts`. Sampling (`max_tokens`, `temperature`, and now a `sampling_params`
     pass-through) is gathered once and handed to pi-ai, so a model setting reaches a llama.cpp request
     that used to be dropped quietly; and a tool call whose arguments fail to parse now yields provider
     error chunks and ends the stream instead of forwarding a malformed call, which is what a small
     local model does often enough to matter. Both land on shapes `bff/src/session/turn-usage.ts` and
     `turn-errors.ts` read, and both help, so no code.
   - *task surfaces*: `tools/manager.ts` (a `Task`/`Skill`/`Monitor` receipt now carries the executor's
     own tool-call id), `tools/impl/task.ts` (a launch may append a result reminder; a fork's prompt is
     validated before launch) and `tools/toolset.ts` (a caller-owned `readScopeState` wraps scope
     metadata reads). None of it changes what a browser frame carries.
   - the compaction pair above, and `external-coding-agent.ts` — a comment and how a fork meets a
     default computer, which is Cloud routing this stack has none of.

   Everything else on the list did **not** move: `connection-lifecycle.ts`, `listener/lifecycle.ts`,
   `gateway-supervisor.ts`, `gateway-core.ts`, `control-inputs.ts`, `interrupts.ts`, the channel state
   writers (accounts, credential store, routing, pairing, access control), the mods paths and engine,
   `agent/skills.ts`, the MCP settings writers, `utils/settings-path.ts`, `toolset-catalog.ts`,
   `background-process-protocol.ts`, `schedule-protocol.ts`, the mod-validation and connect-provider
   paths. One file that is **not** on the list moved and matters more than most: `app-server-client.ts`,
   which is what `bff/src/upstream/connection.ts` wraps — since 0.34.61 its constructor keeps a
   permanent no-op `error` listener and `connect()` closes the socket on a failed handshake. It is
   watched now; a range that moves none of them still needs saying, or the next sync reads the silence
   as an unread gap.

### The 0.34.63 → 0.34.67 sync

**Twelve watched files moved** (2 protocol, 10 behavioural), adjudicated:

- *typed and inert*: `protocol_v2.ts` (the `ExperimentId` union moved to `@/experiments/types`; nothing
  here switches on an experiment id) and `subagent-protocol.ts` (`LaunchSubagentWireArgs` gained an
  optional `cloud_skill_repositories` — Cloud sandbox routing, dead in a local install).
- **the skill freeze** — `agent/client-skills.ts` plus new `client-skills-baseline*.ts`: `client_skills`
  is now frozen per conversation until the next compaction (#5486), and catalog changes arrive as a
  **skill-delta system reminder** that supersedes the frozen list. `bff/src/skills/` discovery is
  untouched, but a Settings → Global skills flip mid-conversation now shows up as a reminder message
  rather than a prompt change — the container check is that `web/src/lib/messages.ts` folds it cleanly.
- *worker steering* — `subagent-control.ts`: pending steer de-dupe entries now expire
  (`REMOTE_SUBAGENT_MESSAGE_DEDUPE_PENDING_TTL_MS`), so a stuck steer no longer poisons retries —
  **dormant for the BFF**, which never sends `subagent_message` (no allowlist entry); the steers that
  benefit are the agent's own `SendAgentMessage` calls. Steering a local `codex_<thread>`/`claude_<session>`
  id and the parent-**agent** ownership rule are unchanged. `codex-app-server.ts` /
  `external-coding-agent.ts` / `claude-stream-session.ts`: a slow Codex steer reports `queued` after
  10 s (#5782) and a steer racing turn completion starts a new turn (#5799) — real for us, they sit in
  `sendCodexMessage` under the agent's steer path; the spawn argv did not move, so the shim preflight
  is intact.
- `app-server-client.ts` — an opaque socket `error` no longer rejects a connect on its own; the rejection
  waits for the `close` and carries its reason (#5740). Still exactly one rejection per failed
  handshake and the constructor's permanent no-op `error` listener stands, so the BFF's process guard
  needed nothing.
- *task surfaces* — `tools/manager.ts`, `task.ts`, task notifications: replies survive relay
  reconnects (#5757), MCP discovery failures are tolerated at worker launch (#5760), transcript paths
  stay inside the notification (#5805).
- *local backend* — compaction stats gained `summary_source` (`self` / `transcript` /
  `transcript_after_overflow` / `transcript_after_no_text`, #5774 — stored on the summary message, read
  by nothing in our tree yet), `memory_metadata` counts messages
  outside the context (#5772), and the self-compaction acknowledgement was dropped (#5804); all on the
  primary provider's path, and `turn-usage.ts` / `turn-errors.ts` parse what the stream still emits.
  `pi-stream-adapter.ts` moved only by import reshuffle (`LocalCompactionStats` now from
  `local-message.ts`) — inert.
- *not watched but ours* — `src/reminders/engine.ts` (#5775): with no server-side MCP the empty MCP
  list no longer sends the "MCP servers with available tools: None" reminder — that reminder is the
  one `bff/src/mcp/skill.ts` documents as talking a model out of the `mcp-servers` wrapper, so local
  agents lose a false-negative nudge. The #5776 MCP-timeout explanation is **not** ours: it lives in
  the Cloud unified-MCP path (`runUnifiedMcpTool`, gated on `serverSideToolManagement`, false on the
  local backend), and `bff/src/mcp-bridge/` speaks MCP itself with its own timeout.
- `@earendil-works/pi-ai` did **not** move across this range (`^1.5.2` at both tags) — no model-catalog
  recount, no `docs/CONFIGURATION.md` count edits.

### The 0.34.67 → 0.34.68 sync

**Zero watched files moved** (both script arrays intersected with the range's file list — 6 commits).
Adjudicated:

- `fix(stream)` #5847 — the terminal-EOF guard (`src/cli/helpers/stream.ts` +
  `stream-terminal-eof-guard.ts`) sits on the **letta-client Cloud API SSE path** (its own doc names
  the PROCESSING_API_RESPONSE signature; the stall reconciler around it queries cloud run status).
  **Dormant for us**: local-backend turns are produced through pi-ai's `openai-completions`, which
  imports the official `openai` SDK — that SDK ends its iterator at `data: [DONE]` and never waits
  for body EOF, so llama.cpp cannot wedge a local turn this way. Re-check only if a future range
  moves `pi-stream-adapter.ts` or the local path starts sharing the drain.
- `fix(bash)` #5833 — **ours, agent-facing, but gated on the queue bridge**: with no explicit
  `timeout`, a foreground command that *cannot* auto-background — no queue consumer, i.e. headless
  `-p` contexts — is now terminated at the default 120000 ms instead of running until it exits.
  An interactive agent's long command still auto-backgrounds and survives the turn (auto-backgrounding
  and the 600000 ms foreground cap unchanged). Baked into `docker/agent-skills/` installing-tools,
  whose wording mirrors upstream's, so headless workers stop assuming an unbounded foreground.
- The rest are Cloud or headless-CLI only: oversized external-agent trace payloads (#5842, the
  Cloud tracing proxy), deferred cloud PR-watch registration (#5853), headless one-shot SIGTERM
  shutdown (#5851 — `letta -p`/`letta code` processes; it also touched `shell-runner.ts`, which runs
  for every app-server foreground Bash on the terminate path, bounded by a 2 s force-kill grace).

### Version pinning

**Sync to a published release tag, never `main`:** the script accepts only `v<x.y.z>`.
Everything the stack runs comes from a **published artifact**: the images are
`letta/letta:$LETTA_CODE_VERSION` from Docker Hub, and the protocol types are
`@letta-ai/letta-code@<v>` from npm. A checkout sitting one commit past a tag has nothing to
pin to, and quietly stops being the code the app-server runs. `sync-upstream.sh` now asserts
both artifacts exist before re-pinning.

**The version literal lives in six tracked places and they must move together:**

| File | Form |
|---|---|
| `docker/compose.yml` | `LETTA_CODE_VERSION: ${LETTA_CODE_VERSION:-<v>}` — app-server build arg (its `FROM`) |
| `docker/compose.yml` | `image: letta/letta:${LETTA_CODE_VERSION:-<v>}` — channel-gateway |
| `package.json` | `"@letta-ai/letta-code": "<v>"` |
| `bff/package.json` | same |
| `web/package.json` | same |
| `docs/CONFIGURATION.md` | the `LETTA_CODE_VERSION` row of its defaults table — what a reader is told |

The app-server's own image tag used to be a seventh site (`lettuce-app-server:${LETTA_CODE_VERSION:-…}
-codex…-gh…-claude…`). It is now the **release** tag (`${LETTA_IMAGE_TAG:-v…-letta_…}`), which the sync
must not rewrite: it names the images CI published, so it moves with `VERSION` in the release-prep
commit and `check-release-hygiene.ts` — not this checker — holds it there.

`scripts/check-version-pin.ts` asserts they agree and runs first in `bun run verify`. Its
app-server patterns are fenced to that service's block: a plain lazy match ran on into
channel-gateway's image line once the app-server stopped naming `letta/letta` directly.
`sync-upstream.sh` rewrites all of them for you (its sed replaces every
`LETTA_CODE_VERSION:-…}`, and deliberately leaves `LETTA_IMAGE_TAG:-…}` alone). The other pins in
compose — `GH_VERSION`, `CODEX_VERSION`, `CLAUDE_CODE_VERSION`, the sidecar versions — are separate
and not what this check covers.

**`docker/.env` must not set `LETTA_CODE_VERSION` at all.** Compose reads that file and its value
outranks compose's own default, so a leftover freezes the host on an older release and survives
every later sync. `check-version-pin.ts` prints one as a `!` to be deleted, and `sync-upstream.sh`
deletes it wherever it finds one — before its "already synced" exit, so re-running the command
cleans a host whose only problem is that line. A host that genuinely needs an override passes it in
the shell environment, where the command that set it is visible.

**The trap that hides a stale pin:** a shell `LETTA_CODE_VERSION` outranks `docker/.env` in
Compose's precedence order — that is how `.env` once sat a whole cycle behind unseen; story:
docs/upstream-notes.md#stale-pin-story. The pin check now prints a warning for exactly this
case.

**The reference checkout must not lag the pin.** The script diffs from wherever `letta-code/` currently
sits, so a clone five releases behind our own pin reports five releases of drift we already adjudicated —
and every "read out of letta-code at v0.34.x" fact in the skills is that much older. Check `git -C
../letta-code describe --tags` before trusting a report. It will **not** match `VERSION` for the whole
implement stage — the script never rewrites `VERSION`, whose `-letta_<v>` half moves with the bump at
pre-release — so the two agree only once this release is cut.

**From a worktree, set `LETTA_CODE_DIR`.** The script defaults the clone to `<script dir>/../letta-code`,
which inside `.dev-flow/<slug>/worktree/` resolves under `.dev-flow/<slug>/` and silently clones a second
copy: `LETTA_CODE_DIR=<main checkout's parent>/letta-code bun run sync-upstream v<x.y.z>`.

**A version bump is a full redeploy.** `docker compose -f docker/compose.yml up -d --build` —
rebuilds the app-server image on the new base, pulls the new channel-gateway image and
rebuilds bff. This is the documented exception to "Only `bff` is rebuilt to prove an artifact" in
`AGENTS.md` → "Stop before publishing"; that note governs ordinary UI and BFF changes, this one
governs version bumps. Recreating `app-server` drops the BFF's permanent upstream connection, so any
in-flight turn is lost and the cron scheduler and Telegram gateway restart on the BFF's reconnect.
