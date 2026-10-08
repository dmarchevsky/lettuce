# Upstream notes — the stories behind the rules

Archive of the incident narratives and upstream code walkthroughs that justify the
terse invariants in AGENTS.md. Nothing here is a rule; AGENTS.md is. Pointers from
AGENTS.md look like `docs/upstream-notes.md#<anchor>`.

## BFF redeploy drain

**A `bff` redeploy is the one time the connection does close — so shutdown drains first.**
Stopping the BFF closes that socket, which cancels every in-flight turn exactly as
`cleanupListenerConnection` does (see CLAUDE.md, "The BFF is a session multiplexer"). Worse,
the cancel cannot reach llama.cpp (see [Stop-cancellation call chain](#stop-cancellation-call-chain)),
so the backend run keeps going; the new BFF's owner sync then re-sends the interrupted tool
calls into a conversation that is still busy, `send.ts` `maybeWaitForBlockingRun` waits out
`BUSY_RUN_WAIT_TIMEOUT_MS` (5 min) and the turn ends with `Conversation is still busy because
run … remained active after 300000ms`. **Signature: an error push exactly five minutes after
a BFF restart, then a "completed" push shortly after, and nothing in the transcript** (seen
on prod 2026-09-25 with a two-hour cron turn). `bff/src/shutdown.ts` therefore holds SIGTERM
until `ActivityTracker` reports no turn in progress, up to `SHUTDOWN_DRAIN_TIMEOUT_SECONDS`
(default 9 min), while still serving browsers; a second signal skips the wait.
`stop_grace_period: 10m` in `docker/compose.yml` is what lets it — Docker's default 10 s
SIGKILLs the drain — and it must stay above the drain timeout. So a `bff` deploy during a
turn now takes until that turn ends to stop the old container. A turn longer than the cap
still dies.

**Both must also fit inside the deploy manager's `compose up` timeout: 900 s (`COMPOSE_TIMEOUT`), image
build included.** At 15 min / 16m a deploy during a turn (2026-09-29) hit it: the deploy manager gave
up, the new `bff` stayed *created, not started*, and once the old one finished draining prod
had no `bff` at all — down for six minutes until a second deploy (`--allow-unhealthy`,
nothing left to drain) started it. The leftover container keeps compose's temporary name
(`<hash>_letta-code-ui-prod-bff-1`) until the next deploy. Raising the drain means raising
`COMPOSE_TIMEOUT` in the deploy manager's stack variables first.

## Allowlist env-only story

There is no `users.json` and no `config/` directory: a gitignored single-file bind meant a
fresh clone got a *directory* at that path and the BFF crash-looped on `EISDIR`. In local
mode an unset `ALLOWED_USERS` makes `DEV_BYPASS_EMAIL` its own entry, so the bypass needs no
second setting — requiring both used to produce a 403 saying the bypass email was not in the
allowlist, a self-contradiction rather than a diagnosis. An explicit `ALLOWED_USERS` still
wins: set both to different people and `/auth/dev-login` refuses with that 403, which is now
a real misconfiguration rather than a contradiction. `AllowedUser.name` was deleted with the
file: nothing ever rendered it (the UI reads only `status.user?.email`).

## MCP shared-list story

We used to write the per-agent `settings.json` MCP entry and it **did not stick**: the
app-server holds `settings.json` in memory and rewrites the whole `agents` array from that
copy on any agent-setting change (`upsertAgentSettings` → `markDirty("agents")` →
`persistSettings`; agent create, pin, memfs, toolset, system-prompt versioning), silently
dropping what we wrote, and `reload` never re-reads it (`handleReloadCommand` clears only
project caches), so upstream's `mcp-servers-info` reminder never saw it either. New entries
also lacked `baseUrl`, which `getAgentSettings` matches (`local:/data/local-backend`), so
they were invisible anyway.

Upstream's reminder still says "MCP servers with available tools: None" — it only knows the
per-agent list — and plain `letta mcp list` returns `[]`. **Both traps are named in the
skill's description, not just its body**: a local model was seen skipping the skill, trusting
the reminder, running plain `letta mcp list` and telling the user web search was not set up.
That incident is also why web search is no longer an MCP server at all (CLAUDE.md, "Web
search and page reading are native tools").

## bwrap sandbox removal (measured 2026-09-25)

The filesystem sandbox was on until 2026-09-25 (bubblewrap layered onto the image,
`LETTA_FS_SANDBOX=1`, the cross-agent profile) and was removed after measuring what it
bought, in the running container:

- **It did not hold against a hostile agent.** bwrap as root takes its privileged path, and
  `buildBwrapArgs` passes no `--cap-drop`, so wrapped shells kept the container's full
  capability set including `CAP_SYS_ADMIN` — one `umount` removed the tmpfs mask over other
  agents' memfs. Other agents' **conversations** (`/data/local-backend/conversations`) were
  never masked at all, and `/root/.letta/settings.json` stayed writable: an `mcpServers`
  entry there is a command the app-server itself runs, unwrapped, on reload.
- **Its price was the boundary that matters.** Making root bwrap work at all needed
  `cap_add: SYS_ADMIN` plus `seccomp:unconfined` and `apparmor:unconfined`, weakening the
  container → host wall for every agent shell.

All agents here belong to one person, so the container boundary is the one kept. (Nor
`runtime_start.workspace_sandbox`, which the UI once requested: a write-scoped profile with
one writable root that left the agent's own memory, `/tmp` and `/root/.letta` read-only, and
that cron- and channel-fired runtimes never got.)

## LLM timeout internals

`DEFAULT_LOCAL_PROVIDER_TIMEOUT_MS` (`backend/local/local-provider-timeout.ts`) is 5 minutes;
`docker/compose.yml` raises it to 30 for the app-server. It reaches the wire as pi-ai's
`timeoutMs` → the OpenAI SDK's `timeout`, and the SDK clears that abort timer in a `finally`
once the fetch resolves (`openai/client.js`, `fetchWithTimeout`). **A streaming fetch resolves
on headers**, so the clock covers connect + queueing + prompt eval and stops the moment tokens
start. A long generation is never cut off; a stream that stalls mid-flight is never rescued.

Env names are derived from the provider's `localProviderNames`, most specific first:
`LETTA_CODE_OPENAI_COMPATIBLE_TIMEOUT_MS`, `OPENAI_COMPATIBLE_TIMEOUT_MS`, then the global
`LETTA_CODE_LOCAL_PROVIDER_TIMEOUT_MS`. A stored `timeout` on the provider record outranks
all of them. Values parse as ms, `600s`, `10m`, or `false` to disable — **an unparseable
value throws**, it does not fall back.

A timeout here **is** retryable: the SDK's `Request timed out.` matches `"timed out"` in
`RETRYABLE_LOCAL_PROVIDER_DETAIL_PATTERNS`, so the turn retries. Contrast a GPU fault like
`vk::Queue::submit: ErrorDeviceLost`, which classifies as `local_backend_error` and ends it.

`createLocalProviderFetch` in that same file looks like the enforcement point and is **not**:
it has no callers. Do not "fix" a timeout by editing it.

## Memory-worker internals

Incidental memory upkeep and post-turn git conflict repair go to a **background memory
worker**, a subagent registered like any other (`registerSubagent`) — so it shows in
`update_subagent_state`, and `push/turn-watcher.ts` holds the "finished" push until it ends.
Old transcripts still contain `memory` calls, which is why `tool-summary.ts` keeps the case.

## Stop-cancellation call chain

`abort_message` → `handleAbortMessageInput` (`listener/control-inputs.ts`) →
`turnLifecycle.requestCancellation()`, which **synchronously** flips the lifecycle to
`cancelling` — so `is_processing` goes false at once — and then emits
`emitInterruptedStatusDelta`, the "Interrupted" line. All of that is optimistic: it happens
before anything has stopped.

The abort reaches `stream.ts` → `abortStreamController(stream)` → `stream.controller.abort()`,
and **that controller is wired to nothing.** `backend/dev/provider-turn-executor.ts`
(`createProviderLettaStream`) mints `new AbortController()` whose signal is never passed
anywhere — the provider event iterable was already built without it — and
`backend/local/local-executor-factory.ts` constructs `new PiStreamAdapter({…})` with **no
`abortSignal`**, so `pi-stream-adapter.ts` never puts a `signal` on the HTTP request.
`HeadlessBackend` stores that dangling controller as the run's controller and
`persistExecutorStream` passes it straight through, so `cancelRun` → `controller?.abort()` is
a no-op against llama.cpp.

Consequence: the turn can only end when the model's **next chunk** arrives, because
`stream.ts` checks `abortSignal.aborted` only *inside* `for await (const chunk of stream)`.
Press Stop during prefill and the loop stays parked while llama.cpp finishes the whole
response — the reported "I pressed Stop, got Interrupted, and the LLM kept going".

Two more shapes of "Stop did nothing": `handleAbortMessageInput` returns early with **no
frames at all** when there is no active turn and no pending approval — which a *second* press
always hits, since the lifecycle is already `cancelling` — and `message-router.ts` answers a
stale runtime with `success: false, error: "Runtime is no longer active"`. Both are visible
only in `abort_message_response`, so the UI **must** use `request()` and not `send()` for
abort. `use-conversation.ts` does, and renders its own honest "Stopping" line for the gap.
Fixing the cancellation itself needs an upstream change; it cannot be done from here.

## tool return message capture detail

A live delta carries the singular `tool_call_id`/`status`/`tool_return` fields **and** a
`tool_returns[]` array (`normalizeToolReturnWireMessage`, `listener/interrupts.ts`); history
persists only the singular ones. `tool_returns` is absent from `protocol_v2.ts`, so
**typecheck cannot catch drift here** — it is a behavioural item, like `connection-lifecycle.ts`.

One Bash call produced two frames in a live capture: a `synthetic-tool-return-stream-<id>`
snapshot while the command ran, then a `synthetic-tool-return-<uuid>` canonical one — upstream
says so outright ("Client-executed tools emit repeated tool_return_message snapshots while
running", `app-server-openai-tools.ts`). Their ids differ, they carry no `otid`, and every
local-backend stream chunk gets a fresh `letta-msg-N` from `local-store.ts` `createStoredChunk`
anyway. So keying a return the ordinary way drew one Result row per snapshot, which a reload
then collapsed. `web/src/lib/messages.ts` keys them `return:<tool_call_id>` in both paths.
The later frame also carries the **corrected** status: the running snapshot reports `success`
even for a command that went on to fail. (The store persists the snapshot's status, so a
failed command still reads as a success after a reload — upstream, not ours.)

## Codex spike findings (2026-09-27, Codex 0.157.1, measured in the container)

- **letta hard-codes `sandboxPolicy: workspaceWrite` on every `turn/start`, and Codex builds
  that with bubblewrap,** which Docker's default seccomp (no user namespaces) and then its
  AppArmor (no mounts) both refuse — every command fails, and the model just says so.
  Relaxing both is the trade-off rejected for letta's own sandbox (see
  [bwrap sandbox removal](#bwrap-sandbox-removal-measured-2026-09-25)), and Codex's
  deprecated `use_legacy_landlock` still requires bwrap. Codex's managed `requirements.toml`
  `allowed_sandbox_modes` *rejects* a disallowed mode rather than downgrading it. So the
  shim rewrites that one field to `{type: "externalSandbox"}` — the container is the sandbox
  — and passes every other byte through. A worker therefore has the same reach as an agent
  shell: the whole container, other agents' memory included. Under `externalSandbox` Codex
  enforces nothing, network included, so the UI offers no network toggle (it would only be a
  hint to the model).
- **The preflight is `codex --version`** (since 0.33.3; it was `codex login status`, which a
  custom provider never passes). The first real turn is now what proves the provider answers.
  The BFF still writes an API-key `auth.json` with a placeholder key — no longer needed by
  the preflight, harmless, and an OpenAI-provider credential no worker uses. With workers
  disabled the shim fails the preflight, so the task reports "Codex executable is not ready:
  <our disabled message>".
- Codex also fetches its plugin marketplace from GitHub on start (`$CODEX_HOME/.tmp/plugins`)
  — not model traffic, but not nothing.

## Zombie EAGAIN diagnosis (2026-09-29)

`init: true` on `app-server`. Without it PID 1 is `node … letta server`, which never reaps
orphans, so everything an agent shell backgrounds and outlives stays a zombie counting
against the cgroup's `pids.max` until a recreate — near the cap, spawns fail with `EAGAIN`.
This was the suspected cause of frequent subagent failures on prod (2026-09-29, a day and a
half into an app-server uptime of heavy cron turns); the spawn diagnostics are what confirm
or refute it.

## Google revoke-on-reconnect (2026-09-28)

**A revoke is grant-wide:** Google removes the app's access to that account, killing every
refresh token it issued this client — including one minted a second ago. So a reconnect of
the *same* account replaces the file and revokes nothing; revoking the old token once killed
the new one on prod 2026-09-28: the first tool call after a widening reconnect got
`invalid_grant`. Only another account's token is revoked, and a rejected too-wide consent
also drops the stored same-account token.

## Google token loss story

Tokens die outside our control (revoked in the Google account, a password change, an
unpublished consent screen's 7-day limit). workspace-mcp's error then tells the model to run
`start_google_auth`, which we removed, so a model went hunting for it and gave up. Now
`google/lost-access.ts` recognises the auth failure in both the curated tools and `mcp_call`
on the Google server, records `grant.lostAt` (`markLost`) — only on Google's own refusal
(`invalid_grant`, `Token Expired/Revoked`, no credentials): workspace-mcp appends
"LLM: Try 'start_google_auth'" to **every** 403, and matching that marked access lost on prod
when the real error was `accessNotConfigured` (Calendar and Tasks APIs switched off in the
OAuth client's Cloud project). That case gets its own answer — the API, the project, a link
to its switch in the API library, "do not reconnect" — and every other Google error just
loses the misleading hint (`googleErrorAnswer`). For a real loss it answers the agent with
what to tell the user plus two links built on `PUBLIC_ORIGIN`: `/api/google/reconnect` (GET,
session- and write-gated: mints a consent `state` and 302s straight to Google — one click
from chat) and `/?settings=google` (the SPA opens Settings on that section;
`lib/settings-link.ts`). The grant stays, so the tools stay registered and keep giving that
answer, and Settings → Google leads with "Access lost for …" and a Reconnect button. Opening
it also asks Google (`checkIfDue`, at most every 5 min), so it shows a loss nobody has hit
yet — a grant already marked lost is re-checked too, so a mistaken mark clears itself. A
refresh that works again clears `lostAt`. The skill wrapper path (stdio, subagents) still
gets workspace-mcp's raw text.

## Definition-of-done origin story

This list exists because a change was once reported as complete when it had been typechecked
and built but never committed, never merged, and never deployed — the container was still
serving the previous bundle, and only the user noticed.

## Stale-pin story

A shell `LETTA_CODE_VERSION` outranks `docker/.env` in Compose's precedence order. That is
how `.env` sat at `0.30.27` through the whole `0.30.29` cycle without anyone noticing. The
pin check now prints a warning for exactly this case.

## Main-checkout collision story (2026-09-29)

Branching inside the main checkout is not a stylistic slip: two sessions sharing it collide —
one switched the checkout to its branch mid-work and `deploy-check`'s clean-tree and
on-`main` assertions then failed on the other's uncommitted changes.

## Prod builds without git

**A deploy manager does not build from its clone, so the build context has no `.git` — and a
Dockerfile that needs one aborts the whole deploy.** On 2026-10-05 a manual prod deploy of
`main` died exactly this way. The commit-stamping buildinfo stage did
`COPY .git/ ./gitmeta`, on the reasoning that the deploy manager deploys with a plain `compose up` and
passes no build args, so the refs in the context were the only source left. The reasoning was
half right: it passes no build args **and has no git metadata in the context either.**
It clones the repository into its own `git-repos/<env>/<stack>/` directory, *copies the
checked-out files* into `stacks/<env>/<stack>/`, and runs `docker compose -f
stacks/…/compose.yml up -d` with that copy as the working directory — a file copy whose
enumeration never includes `.git` (which is also why `.git/*` appears in no deploy's
file-change list). Our `bff.build.context: ..` therefore points at a tree with no `.git`,
and BuildKit refuses a `COPY` of a path that is not in the context:
`failed to compute cache key: … "/.git": not found`. Because the bake is one operation, the
failure cancelled the other targets and the deploy stopped before a single container was
created — prod kept serving the previous revision.

Two things made this survive every gate we had. The stamping stage had never run in prod (the
deploy log listed `bff/src/build-info.ts` as *added*), and every builder we exercise does have
`.git`: `bun run build:bff`, a bare `docker compose build bff`, and the CI image job, which
passes `GIT_SHA` anyway. The check that would have caught it — building from a context with no
`.git` at all — is now a step in the CI `image` job.

**So an unstamped build is a supported outcome, not a defect.** `docker/bff.Dockerfile` copies
the tree and reads `ctx/.git` if it is there: a checkout still stamps its own commit, a
deploy manager's build stamps `+unknown`, and `bun run deploy-check <origin>
--allow-unstamped` accepts `+unknown` for the release tag being checked. Which commit a
deploy manager actually deployed is in *its* record — the deploy manager's own deploy log — because no
image built that way can name it.
