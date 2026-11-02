---
name: lettuce-upstream-sync
description: 'Run `bun run sync-upstream v<x.y.z>` to move lettuce to a new letta-code release: what the script does, why only published release tags are acceptable, typed vs behavioural drift and the upstream files whose changes typecheck cannot catch (connection-lifecycle, gateway supervisor, background-process-protocol, toolset-catalog, settings-path, subagent-control), the six version literal sites and the stale-pin precedence trap, why the reference checkout must not lag the pin, and why a version bump is a full redeploy. Read when bumping LETTA_CODE_VERSION or running sync-upstream.'
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
     but not the semantics) — since 0.34.38 `read_subagent_events` pages a subagent's JSONL log
     (`tool_call`/`tool_result`/`text`/`reasoning`/`notification`, `next_seq`, `missed`, an oversized
     event cut with a `[truncated N bytes]` marker). Read the two gates separately: **the readable log
     (`event_seq`) exists only for a caller-notified launch** — `serveTaskEvents` runs under
     `if (publishResult)` in `task.ts`, 32 MiB kept per child — while `progress_texts` is **not**
     gated (`addProgressText` runs in every task's `onText`), so a snapshot can carry recent progress
     text whatever the launch mode. Neither command is on the BFF allowlist — see the roadmap.
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
     a `LETTA_CONFIG_DIR` would move where the mods the BFF *writes* are discovered (inert while
     nothing sets it). `mod-sources.ts`, `mod-engine.ts`, `types.ts` and `mod-diagnostics-file.ts` are
     byte-identical across this range, so render, reload and diagnostics did not move.
   - `src/agent/skills.ts` — `GLOBAL_SKILLS_DIR` became `getGlobalSkillsDir()` off
     `resolveGlobalStateDir`, so the global skill root is now conditional. `bff/src/skills/`
     re-implements discovery against the fixed `/root/.letta/skills`; if the root ever moves, both
     move. Same release added `runtime_start`'s `bundled_skills`: expose named bundled skills while
     `skill_sources` omits `"bundled"` — the per-agent granularity we do not have (roadmap).
   - `src/types/schedule-protocol.ts` — `CronRunOutcome` gained `delivered` and `CronRunReason` a
     `dequeued`. Nothing renders an outcome exhaustively today, so it is silent until we do.
   - `src/backend/local/*` — since 0.34.32 a local-backend request carries `x-letta-request-kind:
     turn|compaction`, and `model_settings.temperature` plus verbosity actually reach the endpoint.
     That is a behaviour change on our primary provider: a compaction is now distinguishable at the
     llama.cpp end, and a temperature that was silently dropped is not.

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
../letta-code describe --tags` against `VERSION` before trusting a report, and expect the two to land on
the same tag after a sync.

**From a worktree, set `LETTA_CODE_DIR`.** The script defaults the clone to `<script dir>/../letta-code`,
which inside `.dev-flow/<slug>/worktree/` resolves under `.dev-flow/<slug>/` and silently clones a second
copy: `LETTA_CODE_DIR=<main checkout's parent>/letta-code bun run sync-upstream v<x.y.z>`.

**A version bump is a full redeploy.** `docker compose -f docker/compose.yml up -d --build` —
rebuilds the app-server image on the new base, pulls the new channel-gateway image and
rebuilds bff. This is the documented exception to "Only `bff` is rebuilt to prove an artifact" in
`AGENTS.md` → "Stop before publishing"; that note governs ordinary UI and BFF changes, this one
governs version bumps. Recreating `app-server` drops the BFF's permanent upstream connection, so any
in-flight turn is lost and the cron scheduler and Telegram gateway restart on the BFF's reconnect.
