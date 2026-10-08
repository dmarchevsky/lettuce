---
name: lettuce-telegram-channels
description: 'lettuce Telegram/channel-gateway mechanics: why app-server, bff and the gateway share one network namespace, the --ws-auth vs no-bearer-token deadlock, why channel_* commands are excluded from the BFF allowlist, the opt-in `telegram` compose profile and how to stop a running gateway, and the one-time `letta channels configure/pair` setup. Read before touching channel-gateway in docker/compose.yml, the BFF''s channel or profile code, or Telegram pairing.'
---

# Telegram channels in lettuce

Loaded from `AGENTS.md`. Two facts in letta-code combine into the topology: the app-server refuses a non-loopback listener without `--ws-auth`, and `letta channel-gateway` sends no bearer token at all.

Extracted from `AGENTS.md`; keep both in sync when you change either, and keep `docs/upstream-notes.md` pointers working.

### Channels (Telegram) — why the topology looks like this

Two facts in letta-code combine into one hard constraint:

1. The app-server **refuses to listen on a non-loopback address without `--ws-auth`**
   (`app-server.ts` → `isUnauthenticatedNonLoopbackListener`).
2. `letta channel-gateway` **sends no bearer token** (`gateway-local.ts` calls
   `createAppServerClient` with no `authToken`), so it cannot attach to an authenticated
   app-server.

Together: channels only work when the app-server listens on loopback with auth off. So the
app-server, the BFF, and the gateway all share one network namespace
(`network_mode: "service:app-server"`) and talk over `127.0.0.1:4500`. Nothing outside that
namespace can reach the app-server at all — stronger isolation than a shared token on a bridge
network, and it removes the capability token entirely.

**Never recreate `app-server` on its own.** Its network namespace is the one the other two
services live in, so `docker compose up -d app-server` recreates it and leaves `bff` and
`channel-gateway` `Exited (1)` — the whole UI goes down, and `docker ps` without `-a` shows a
healthy app-server and no sign of why. Always run `docker compose -f docker/compose.yml up -d`
unscoped; it restarts the dependents in the right order. (Rebuilding only `bff` is still fine —
nothing shares *its* namespace.)

**Channel configuration is not reachable from the web UI, by design of letta-code.** The
app-server only dispatches `channel_*` commands when `runtime.serviceCommandHandler` is set
(`message-router.ts`), installed by `startChannelGatewaySupervisor` — which has no production
caller and talks to its child gateway over **stdio**, not the WebSocket. A `channel_*` command
sent over the app-server socket is parsed, matched by nothing, and silently dropped. They are
therefore excluded from the BFF's browser allowlist: a hang is worse than a refusal.

**The gateway is opt-in: `channel-gateway` has `profiles: ["telegram"]`** (off since
2026-09-28 — no channel was in use, and it idled at ~170 MiB). It runs only when
`COMPOSE_PROFILES` includes `telegram` (e.g. `cloudflared,telegram`; `LETTA_MODE` matches
`cloudflared` with `includes`, so extra profiles are safe). Removing the profile does **not**
remove a running gateway — `up -d` merely stops managing it — so it must be stopped with
`--profile telegram rm -sf channel-gateway`, and on prod that is a host-side step in the
operator's own deploy tooling. With no
gateway, agents simply have no `MessageChannel`
tool.

Telegram is set up once with the CLI inside the gateway container (see
[`docs/CONFIGURATION.md` → Telegram](../../../docs/CONFIGURATION.md#telegram)),
the same way llama.cpp is set up with `letta connect`. The gateway then runs it, and the agent
reaches it through the `MessageChannel` tool the gateway registers as an external tool.
