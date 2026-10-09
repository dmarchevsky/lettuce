---
name: lettuce-upstream-sync
description: 'Run `bun run sync-upstream v<x.y.z>` to move lettuce to a new letta-code release: what the script does, why only published release tags are acceptable, typed vs behavioural drift and the five upstream files whose changes typecheck cannot catch (connection-lifecycle, gateway supervisor/local, background-process-protocol, toolset-catalog, AskUserQuestion), the six version literal sites and the stale-pin precedence trap, and why a version bump is a full redeploy. Read when bumping LETTA_CODE_VERSION or running sync-upstream.'
---

# Upstream sync and version pinning

Loaded from `AGENTS.md`. Everything the stack runs comes from a published artifact; the checkout sitting one commit past a tag has nothing to pin to.

Extracted from `AGENTS.md`; keep both in sync when you change either, and keep `docs/upstream-notes.md` pointers working.

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

### Version pinning

**Sync to a published release tag, never `main`:** the script accepts only `v<x.y.z>`.
Everything the stack runs comes from a **published artifact**: the images are
`letta/letta:$LETTA_CODE_VERSION` from Docker Hub, and the protocol types are
`@letta-ai/letta-code@<v>` from npm. A checkout sitting one commit past a tag has nothing to
pin to, and quietly stops being the code the app-server runs. `sync-upstream.sh` now asserts
both artifacts exist before re-pinning.

**The version literal lives in seven tracked places and they must move together:**

| File | Form |
|---|---|
| `docker/compose.yml` | `LETTA_CODE_VERSION: ${LETTA_CODE_VERSION:-<v>}` — app-server build arg (its `FROM`) |
| `docker/compose.yml` | `image: lettuce-app-server:${LETTA_CODE_VERSION:-<v>}-codex…` — app-server local tag |
| `docker/compose.yml` | `image: letta/letta:${LETTA_CODE_VERSION:-<v>}` — channel-gateway |
| `package.json` | `"@letta-ai/letta-code": "<v>"` |
| `bff/package.json` | same |
| `web/package.json` | same |
| `docs/CONFIGURATION.md` | the `LETTA_CODE_VERSION` row of its defaults table — what a reader is told |

`scripts/check-version-pin.ts` asserts they agree and runs first in `bun run verify`. Its
app-server patterns are fenced to that service's block: a plain lazy match ran on into
channel-gateway's image line once the app-server stopped naming `letta/letta` directly.
`sync-upstream.sh` rewrites all of them for you (its sed replaces every
`LETTA_CODE_VERSION:-…}`).

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

**A version bump is a full redeploy.** `docker compose -f docker/compose.yml up -d --build` —
rebuilds the app-server image on the new base, pulls the new channel-gateway image and
rebuilds bff. This is the documented exception to "Only `bff` is rebuilt in step 4" under
Definition of done; that note governs ordinary UI and BFF changes, this one governs version
bumps. Recreating `app-server` drops the BFF's permanent upstream connection, so any in-flight
turn is lost and the cron scheduler and Telegram gateway restart on the BFF's reconnect.
