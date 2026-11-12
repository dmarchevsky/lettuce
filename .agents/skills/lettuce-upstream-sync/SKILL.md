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

   Everything else the skills assert was re-checked against 0.34.56 and did **not** move: `connection-
   lifecycle.ts`, `listener/lifecycle.ts`, `gateway-supervisor.ts`, the channel state writers
   (accounts, credential store, routing, pairing, access control), the mods paths and engine,
   `agent/skills.ts`, the MCP settings writers, `utils/settings-path.ts`, `toolset-catalog.ts` and
   `background-process-protocol.ts`. A range that moves none of them still needs saying, or the next sync
   reads the silence as an unread gap.

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
