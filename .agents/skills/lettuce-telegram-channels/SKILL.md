---
name: lettuce-telegram-channels
description: 'lettuce Telegram/channel-gateway mechanics: why app-server, bff and the gateway share one network namespace, the --ws-auth vs no-bearer-token deadlock, why channel_* commands are excluded from the BFF allowlist, the opt-in `telegram` compose profile (now a `features` flag) and how to stop a running gateway, what Settings → Telegram writes (bff/src/channels/ over the three JSON files under /root/.letta/channels/telegram/), what applies live vs. via the supervise-wrapper restart, and the `letta channels` CLI fallback. Read before touching channel-gateway in docker/compose.yml, bff/src/channels/, the BFF''s profile code, or Telegram pairing.'
---

# Telegram channels in lettuce

Loaded from `AGENTS.md`. Two facts in letta-code combine into the topology: the app-server refuses a non-loopback listener without `--ws-auth`, and `letta channel-gateway` sends no bearer token at all.

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

**The `channel_*` protocol commands stay unreachable, and Settings works around that on
purpose.** The app-server only dispatches them when `runtime.serviceCommandHandler` is set
(`message-router.ts`), installed by `startChannelGatewaySupervisor` — which has no production
caller and talks to its child gateway over **stdio**, not the WebSocket. A `channel_*` command
sent over the app-server socket is parsed, matched by nothing, and silently dropped. They are
therefore excluded from the BFF's browser allowlist: a hang is worse than a refusal. Settings →
Telegram (`bff/src/channels/`) instead reads and writes the gateway's own **state files** over
the `read_file`/`write_file` connection the codex settings already use — the same trick, and the
same rule: never invent parallel state, so the CLI and the screen see one truth.

**The gateway is opt-in: `channel-gateway` has `profiles: ["telegram"]`** (off since
2026-09-28 — no channel was in use, and it idles at ~170 MiB). The token is now also a real
feature: `config.features.telegram` gates the `/api/channels/*` routes (404 off) and the Settings
section, like every other integration — effective-enabled is token AND configured account.
Removing the profile does **not** remove a running gateway — `up -d` merely stops managing it —
so it must be stopped with `--profile telegram rm -sf channel-gateway`, and on prod that is a
host-side step in the operator's own deploy tooling. With no gateway, agents simply have no
`MessageChannel` tool.

### The three files, and what applies when

All under `/root/.letta/channels/telegram/`, all JSON (`pairing.yaml` despite its name), shapes
pinned by tests against upstream's own writers (`bff/src/channels/state.ts`):

| File | Holds | Read by the gateway |
|---|---|---|
| `accounts.json` | the bot: uuid, `token` (inline — compose pins `LETTA_CHANNEL_CREDENTIALS_STORE=file`), `enabled`, `dmPolicy`, mixed camel/**snake** keys (`group_mode`, `transcribe_voice`, …) | **once, at startup** (`--restore-enabled-channels`) |
| `routing.json` | chat → agent/conversation rows | per inbound message (`routing.ts`) |
| `pairing.yaml` | pending codes + approved users | at the access-control check |

So approvals, ignores and route removals are **live**; an account change (token, enable) is
applied by `docker/channel-gateway-supervise.sh` — the wrapper compose mounts as the container's
command. It watches the checksum of every `accounts.json` (~5 s poll), TERM-restarts the gateway
when it changes, forwards TERM/INT, and backs off when the child dies at once. It restarts for
**nothing else** — a restart drops any Telegram-fired turn in flight (browser turns never: the
BFF owns that connection), so watching pairing or route churn would kill work for changes the
gateway already picks up live. The wrapper also adds `--install-channel-runtimes`, so `letta
channels install` is never a manual step.

An approve also **tells the chat** (best effort): upstream never notifies the paired user, so
`notifyPairingApproved` posts one `sendMessage` to `api.telegram.org` with the stored token, naming
what the chat connected to. Its failure never unwinds the approve — it only flips `notified: false`
in the route response.

Rewrite rules the tests hold: parse lenient (missing/corrupt = empty store, like upstream's own
loaders), clone-and-patch (unknown fields and other array entries survive), render exactly
upstream's write shape, and the bot token never leaves the BFF — the API shows its last four
characters. The token lives on the state root where agent shells can read it — the same
documented reach as the `gh` login, not the google-creds treatment.

**Upstream's CLI is the fallback, never the front door.** `letta channels status|pair|route`
inside the gateway still works and edits the same files; the screen models one telegram bot —
slack/discord/whatsapp/signal/custom have no form and keep the CLI path.

Telegram setup from a clean install is now: enable the profile, put the @BotFather token into
Settings → Telegram, message the bot, approve the pairing that appears there — see
[`docs/CONFIGURATION.md` → Telegram](../../../docs/CONFIGURATION.md#telegram).
