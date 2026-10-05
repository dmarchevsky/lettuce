# lettuce — Project Guide

Self-hosted personal assistant: a local Letta agent (memory, crons, skills) driven from a
mobile-first web UI we own end to end. No Letta Cloud, no cloud LLM providers.

**This file is `AGENTS.md`, and `CLAUDE.md` is a symlink to it**, so Claude Code reads the same
text. Pi and other Agent-Skills harnesses read `AGENTS.md` first and load only one context file
per directory, so the pair never doubles up. Keep it that way — a real `AGENTS.md`-plus-`CLAUDE.md`
pair with different content is a bug.

Everything in this file is in every session's context, so it holds only what is load-bearing in
every task. Deep mechanics live in `.agents/skills/` (loaded on demand — see "Where the details
live") and incident narratives in `docs/upstream-notes.md`; pointers there read
`docs/upstream-notes.md#<anchor>`. `bun run check-docs` keeps all of those pointers real and
keeps this file inside its size budget.

## Hard rules

1. **Upstream is not ours to patch.** Nothing in `letta-code/` is compiled into any image; every
   capability we need already exists in its app-server protocol.
2. **Exactly one upstream WebSocket, owned by the BFF.** Never open a second one, never close it,
   never forward a browser disconnect upstream in any form.
3. **All durable state is under `LETTA_STATE_DIR`**, set absolutely in `docker/.env`; a compose
   command run from anywhere must hit the same state.
4. **Never recreate `app-server` on its own.** Its network namespace holds `bff` and
   `channel-gateway`, so always run `docker compose -f docker/compose.yml up -d` unscoped.
5. **Never push `main`, tag, or redeploy prod without asking, every time** — a feature-branch push
   is routine; a `main`/tag push *is* the release. `.pi/extensions/guard.ts` enforces that split.
6. **Done means the user has tested it in the container**: `bun run verify`, the local run, the
   human test gate, then after merging — rebuild `bff`, `bun run deploy-check`, plus
   `bun run ui-check` for any `web/` change. Typecheck and tests passing is not done. A
   **docs-only** change (see "Branches") stops at `bun run check-docs`.
7. **Feature work happens in a worktree on a feature branch**, under `.worktrees/` inside this
   checkout. The main checkout stays on `main` with a clean tree and only takes merged PRs — except a
   **docs-only** change (see "Branches").
8. **Never remove a worktree or delete a branch by hand** — `bun run cleanup` does it once a PR
   is merged, and refuses anything unmerged, dirty, or occupied by another session. Hand-removal
   needs the operator to name the specific one (`.pi/extensions/guard.ts` gates what you type).

## Workspace layout

```
```
~/work/
  lettuce/            this repo — everything we own (the app is **Lettuce**)
    .worktrees/       one worktree per feature branch (git- and docker-ignored)
  letta-code/         plain clone of letta-ai/letta-code at the pinned release tag — read-only.
                      A sibling of `lettuce/` because that is what `scripts/sync-upstream.sh`
                      assumes: `${LETTA_CODE_DIR:-<repo parent>/letta-code}`. A fresh machine has
                      no clone; the script clones it.
  <state dir>         LETTA_STATE_DIR from docker/.env — see "All durable state lives under one
                      host root" (here: ~/work/letta)
```
```

**The upstream clone is dev tooling, not a build input.** Nothing in `letta-code/` is compiled
into any image and nothing outside `lettuce/` is in any build context. The channel-gateway runs
upstream's published `letta/letta:<version>` as-is; the app-server runs a thin image built
`FROM` it that only adds the Codex CLI and our `codex` shim (`docker/codex/`, see the
`lettuce-coding-workers` skill); the UI consumes `@letta-ai/letta-code` from npm. The checkout exists so
`sync-upstream.sh` can diff it and so you can read the source (the npm package ships only
`dist/`). A prod host needs only `git` and `docker` — no `bun`, no letta-code checkout.

There is no fork. There used to be one (`dmarchevsky/letta-code`), but the zero-delta rule
meant it could never hold anything upstream did not, and nobody pushed to it — it simply fell
behind. A missing `letta-code/` is recreated by `sync-upstream.sh` (`git clone` of upstream).

Same arrangement as upstream: our guide is `AGENTS.md` with `CLAUDE.md` as a symlink to it, and
`letta-code/` keeps its own `AGENTS.md` (and its `CLAUDE.md -> AGENTS.md` symlink) untouched —
that is upstream's file, not ours.

## The one hard rule: upstream is not ours to patch

We run upstream's published artifacts unmodified, and `letta-code/` carries **no local
changes**. Every capability we need already exists in its app-server protocol. If something
seems to require patching letta-code, it is almost certainly reachable through an existing
protocol command — check `letta-code/src/types/protocol_v2.ts` first. `scripts/sync-upstream.sh`
refuses to run against a dirty checkout.

Building the checkout (`bun install && bun run build`) writes only to gitignored paths
(`node_modules/`, `dist/`), so it does not dirty it — but nothing needs that build, so there is
rarely a reason to run it.

## Architecture

```
browser ──WSS+cookie──> bff (Bun/Hono) ──ws + Bearer──> letta app-server (docker)
                                                              ├── llama.cpp /v1
                                                              └── mods (native tools) ─> bff /internal/tools/<name>
                                                                    ├─ web_search / fetch_webpage ─> searxng, ddg-mcp
                                                                    ├─ gmail_* / calendar_* / tasks_* ─> google-mcp
                                                                    └─ mcp_search / mcp_call[_write] ─> shared MCP list
```

### The BFF is a session multiplexer, not a proxy

**This is the most important invariant in the codebase.** Exactly ONE upstream WebSocket
connection exists, owned by the BFF, opened at boot and never closed. Browser sessions
multiplex over it and are invisible to the app-server.

Why: `letta-code/src/websocket/listener/connection-lifecycle.ts` (`cleanupListenerConnection`)
— when a connection closes and no other *subscribed* connection remains for that
`(agent_id, conversation_id)` scope, the app-server calls `turnLifecycle.requestCancellation()`
and **kills the in-flight turn**, drops that connection's queued messages, rejects its pending
approvals and kills its terminals. A phone backgrounding a tab drops its socket within seconds;
because the BFF owns the connection, none of that cleanup ever runs.

Corollaries — do not break these:
- Never open a second upstream connection, and never close the one that exists.
- Never forward a browser disconnect upstream in any form.
- The BFF allocates `request_id`s; browser ids are translated, never passed through.
- The BFF's own syncs (reconnect `resubscribe()` and the scope sweep) carry
  `resume_interrupted_turn: true`: this connection is every conversation's execution owner, so
  after an app-server restart a turn left with only replay-unsafe tool calls pending resumes
  immediately (those calls are denied) instead of waiting for a user message. Browser syncs stay
  observer syncs and never get the flag.
- Missed frames are replayed from the BFF's per-conversation ring buffer, keyed by a monotonic
  sequence number. `conversation_messages_list` (cursor `next_before` / `has_more`) is the
  cold-start fallback when a tab was away longer than the buffer.

**A `bff` redeploy is the one time the connection does close — so shutdown drains first.**
`bff/src/shutdown.ts` holds SIGTERM until `ActivityTracker` reports no turn in progress, up to
`SHUTDOWN_DRAIN_TIMEOUT_SECONDS` (default 9 min), while still serving browsers; a second signal
skips the wait. `stop_grace_period: 10m` in `docker/compose.yml` is what lets it — Docker's
default 10 s SIGKILLs the drain — and must stay above the drain timeout. Both must also fit
inside Dockhand's `compose up` timeout: 900 s (`COMPOSE_TIMEOUT`), image build included.
Without the drain the cancel cannot reach llama.cpp, and the failure signature is an error
push exactly five minutes after a BFF restart (`BUSY_RUN_WAIT_TIMEOUT_MS`,
`Conversation is still busy because run … remained active after 300000ms`) — full story:
docs/upstream-notes.md#bff-redeploy-drain.

The same permanent connection is also what boots the cron scheduler and Telegram adapters:
app-server process services start on *first client attach* (`listener/lifecycle.ts` →
`startConnectedListenerRuntime`), so with no client ever connected, crons never fire.

### All durable state lives under one host root

`LETTA_STATE_DIR` (`docker/compose.yml`) anchors every bind mount:

```
$LETTA_STATE_DIR/
  letta-home/     -> /root/.letta   settings.json, mcp-home/ (shared MCP list), global skills
  letta-data/     -> /data          conversations + agent memory (memfs git repos)
  workspaces/     -> /work          agent working directories
```

It defaults to `../..` relative to the compose file; prod sets an absolute path. **The default
is a trap in a worktree** — `../..` from `.worktrees/<feature>/docker/` resolves to
`.worktrees`, not the real state. Set `LETTA_STATE_DIR` absolutely in `docker/.env` so a
compose command run from anywhere hits the same state, and always do container work from the
main checkout.

Three named volumes remain, none precious: `bff-data` (web-push device endpoints, rebuildable by
re-subscribing), `google-policy` and `google-creds` (Settings → Google and its token — named
deliberately, so the app-server cannot mount them by accident through the state tree; losing
them only means reconnecting Google). Everything precious is in that one host directory, so a
backup is a single `tar`. `scripts/migrate-volumes-to-host.sh` moves an older install off the
named volumes; it copies and verifies but never deletes, because the memfs git history is the
only record of what an agent has learned.

### Compose profiles are the one feature list

Every optional piece of the stack hangs off `COMPOSE_PROFILES`, and each virtual token there also
decides what the app-server image contains. The `telegram` token is covered in the
`lettuce-telegram-channels` skill.

**Sidecars are opt-in: `google-mcp` has `profiles: ["google"]`, `searxng` and
`ddg-mcp` share `profiles: ["search"]`.** Prod runs
`COMPOSE_PROFILES=cloudflared,google,search,codex,claude`. Nothing `depends_on` them; without
their token the integration is off wholesale — the BFF treats the stored Settings switch as
disabled whatever it says (no sidecar config on, no shared-MCP-list entry, no native tools),
so dropping the profile is the whole off switch. Same removal rule as the gateway:
`--profile <p> rm -sf …`.

**`COMPOSE_PROFILES` is the one feature list, and it carries two VIRTUAL profiles: `codex` and
`claude`** — tokens no service declares, so they start no container. Every token is matched as an
exact comma-delimited entry (`bff/src/config.ts` `hasProfile`: `searchy` ≠ `search`), and the BFF
derives `config.features` = `web`⇐`search`, `google`⇐`google`, `codex`⇐`codex`, `claude`⇐`claude`.
- **effective-enabled = token AND stored Settings switch**, enforced at each availability
  decision: web tools render disabled (`renderAllMods`), Google reapply/status/sidecar-config
  run on the gated settings, and the codex/claude connect-time reapply writes `enabled: false`
  into `lettuce.json` so the shims refuse — the stored endpoint/model/key survive, so
  re-enabling the token needs only one flip of the switch. The four Settings save routes answer
  404 while their token is off; `web/` hides the matching Settings sections, Tasks run lists
  and Agent → Tools rows from `features` in `/api/status` (absent = all on).
- **The coding tokens also decide the app-server image**: the raw string goes in as the build
  arg `CODING_FEATURES`, the Dockerfile installs a CLI only for a token it finds, and writes
  what it actually installed to `/opt/lettuce/features`. **The image tag does not change with
  the token list** (it names version pins), so toggling a coding token REQUIRES an app-server
  rebuild, and on the one tag you can have an image built either way — the BFF reads the marker
  on every connect, logs a loud mismatch when a token is on but the CLI is not baked in (and
  "predates the marker" when the file is absent), and serves it as `coding_installed` in the
  authenticated `/api/status`. A warning about unknown profiles from Compose is fine: profile
  names are free-form and `docker compose config` accepts tokens no service declares.

## Where the details live

Task-scoped mechanics live in `.agents/skills/` (also read by pi from `.pi/skills/`), so they are
out of everyone's context until they are needed. Each has a `description` naming the files and the
traps; read it before working in that area.

| You are touching | Read the skill |
|---|---|
| `channel-gateway`, Telegram pairing, compose profiles for channels | `lettuce-telegram-channels` |
| `bff/src/mcp/`, `bff/src/mcp-bridge/`, `bff/src/internal-tools/`, Settings → MCP / Web search | `lettuce-mcp-and-mods` |
| `bff/src/skills/`, `docker/agent-skills/`, Settings → Global skills, `skill_enable` | `lettuce-skill-discovery` |
| `docker/codex/`, `bff/src/codex/`, `bff/src/claude/`, Settings → Codex / Claude Code workers | `lettuce-coding-workers` |
| `bff/src/google/`, `docker/google-mcp/`, OAuth scopes, Settings → Google | `lettuce-google-integration` |
| `bff/src/agents/tool-access.ts`, the policy mod, Agent → Tools | `lettuce-per-agent-tool-access` |
| `web/src/lib/messages.ts`, question/approval cards, `turn-errors.ts`, `turn-usage.ts`, `push/turn-watcher.ts` | `lettuce-transcript-and-streaming` |
| LLM timeout env, agent app ports, failing subagent spawns | `lettuce-runtime-and-ops` |
| Memory tab, `persona.md`, "the system prompt did not update" | `lettuce-memory-and-system-prompt` |
| `AgentMenu`, the sidebar agent list, pin/archive lists | `lettuce-ui-conventions` |
| PRs, `.github/workflows/`, `bump:*` labels, branch protection | `lettuce-pr-and-ci` |
| `bun run sync-upstream`, `LETTA_CODE_VERSION` | `lettuce-upstream-sync` |
| `VERSION`, `CHANGELOG.md`, tagging, `bun run release` | `lettuce-releasing` |

## Facts that are easy to get wrong

Cross-cutting protocol and product facts that apply to almost every task. The rest of the
load-bearing facts have their own skill (table above) and are one line here so you know the trap
exists.

- **Browsers cannot reach the app-server directly.** Auth is `Authorization: Bearer` only,
  which browsers cannot set on a WebSocket; and unauthenticated upgrades carrying `Origin` are
  rejected outright. The BFF is mandatory, not a convenience.
- **No per-user isolation.** One process-wide runtime; every socket sees every event. v1 is
  single-user by decision. Keep agent-id filtering in the BFF frame router so multi-user stays
  a small change. This is about isolation, not about how many people may sign in:
  **`ALLOWED_USERS` therefore stays a list** — in cloudflared mode it is a defense-in-depth
  mirror of the Cloudflare Access policy, and what still stands if that policy is misconfigured
  (a bypass rule, "everyone in the directory"). Do not collapse it to a single address.
- **The allowlist is env-only, and local mode infers it.** `ALLOWED_USERS` is a comma-separated
  list, required exactly when Access is the live gate (`mode === "cloudflared" && !devBypassEmail`
  — the same condition that requires `CF_ACCESS_*`). In local mode an unset `ALLOWED_USERS`
  makes `DEV_BYPASS_EMAIL` its own entry; an explicit `ALLOWED_USERS` still wins and
  `/auth/dev-login` refuses with a 403 on a mismatch. Story (no `users.json`, the `EISDIR`
  crash-loop, `AllowedUser.name`): docs/upstream-notes.md#allowlist-env-only-story.
- **letta-code's filesystem sandbox is OFF, deliberately, and the image carries no bubblewrap.**
  The app-server runs upstream's `letta/letta:<version>` (plus the Codex CLI, nothing of
  upstream's changed) with Docker's default seccomp, AppArmor and capabilities, and
  `LETTA_FS_SANDBOX: "0"`. The explicit `"0"` is load-bearing: unset is not off — memory
  subagents are sandboxed by default whenever a bwrap backend exists
  (`src/sandbox/availability.ts` `isFsSandboxEnabled`). What remains agent-to-agent is
  letta-code's in-process `evaluateCrossAgentGuard` (`permissions/cross-agent-guard.ts`),
  which covers the file tools (Read/Edit/Write) and does not depend on the flag; shells are
  unconfined within the container. Real agent-to-agent isolation would mean one app-server
  container per agent — not re-enabling the flag. The 2026-09-25 measurement that justified
  removal (`CAP_SYS_ADMIN`, `buildBwrapArgs`, unmasked conversations, the `cap_add`/
  `seccomp:unconfined`/`apparmor:unconfined` price):
  docs/upstream-notes.md#bwrap-sandbox-removal-measured-2026-09-25.
- **Provider connection state is `connected.is_connected`**, not `connected.connected`.
- **Settings are split by scope, and the split is the UI's only statement of it.** The **Agent**
  tab (`web/src/tabs/AgentTab.tsx`) holds what belongs to the selected agent: General (name,
  model, base system prompt, delete), Tools, Secrets, Reflection, and the Skills it sees.
  **Settings**, the top bar's gear (`components/GlobalSettings.tsx`, full screen; wrapping
  chips with short names on a phone, the grouped list beside the section on desktop), holds
  what every agent shares — providers, web search, MCP servers, Google, Codex workers, global
  skills — plus this device's notifications and an About. A new setting goes where its backend
  key is: keyed by `agent_id` → Agent tab; a BFF file or an app-server-wide command → Settings;
  `runtime` scope → next to the conversation (composer).
- **File protocol gotchas** (all verified against a running app-server):
  - `get_tree` returns paths **relative** to the root it was given; every other file command
    wants an absolute path, so the client must join them.
  - `grep_in_files` takes `query`, not `pattern`. Sending the wrong key produces **no response
    at all** rather than an error — a silent hang.
  - `grep_in_files` follows ripgrep defaults, so hidden and ignored files are skipped.
- **Conversations DO have a native `archived` field** (plus `archived_at`), settable via
  `conversation_update {body:{archived}}` — verified against the local backend. But
  `conversation_list` ignores an `archived` query filter, so the *list* is filtered
  client-side. (An earlier note here claimed the field did not exist and prescribed a tag
  workaround; that was wrong.)
- **Rename** = `conversation_update {body:{summary}}`. A fresh conversation has
  `summary: null`, so the UI supplies its own placeholder.
- **`create_agent` presets** are exactly `memo | tutorial | blank | linus | kawaii`. There is
  no `default`.

Short version of the topics that live in a skill:

- **MCP is one shared list** in `/root/.letta/mcp-home`, never upstream's per-agent
  `settings.json`, and most turns reach it through the mod bridge rather than the skill wrapper.
  → `lettuce-mcp-and-mods`
- **Native tools are mods** (`web_search`, `fetch_webpage`, `gmail_*`, `mcp_*`) that POST to a
  loopback-only BFF route; they load on connect and reload only on `reload`. → `lettuce-mcp-and-mods`
- **Skills have four scopes and none of them is per-conversation**, and `skill_enable` always means
  global. → `lettuce-skill-discovery`
- **The LLM timeout bounds prefill, not generation**, and there is no idle timeout at all.
  → `lettuce-runtime-and-ops`
- **Two different things are called "the system prompt"** and an agent can only change one of them.
  → `lettuce-memory-and-system-prompt`
- **Memory lives outside every agent workspace** and agents write it with ordinary file tools;
  `letta memory` has no write verb. → `lettuce-memory-and-system-prompt`
- **Stop cannot actually cancel a local generation**, and the app-server reports that it did.
  → `lettuce-transcript-and-streaming`
- **Turn errors, token usage and the turn push are live-only upstream**, so the BFF keeps them.
  → `lettuce-transcript-and-streaming`
- **Codex and Claude Code workers run through shims on PATH**; Settings decides whether they run,
  and their full transcripts live in the CLI's own files. → `lettuce-coding-workers`
- **Google is a sidecar whose access no agent can change**: OAuth scopes plus `--permissions`, on
  volumes never mounted into `app-server`. → `lettuce-google-integration`
- **Per-agent tool access is availability, not isolation** — agent shells stay unconfined.
  → `lettuce-per-agent-tool-access`
- **Agent web apps live on ports 3000-3099**, and repo files are never bind-mounted into a service.
  → `lettuce-runtime-and-ops`
- **"Subagent process exited with code unknown" means the spawn failed**, not the task.
  → `lettuce-runtime-and-ops`
- **Pinning and archiving agents are not in the protocol**, so both lists are ours in the BFF.
  → `lettuce-ui-conventions`

## Upstream sync

`bun run sync-upstream v<version>` moves the upstream checkout to a published release tag, reports
protocol and behavioural drift, re-pins every version site, and typechecks. Never sync to `main` —
there is nothing to pin. Behavioural drift (the upstream files whose changes `bun run typecheck`
cannot see) is what actually bites; the list of those files, the six version literal sites, the
stale-pin precedence trap and the full-redeploy rule are all in the **`lettuce-upstream-sync`**
skill. Read it before running the command.

## Git workflow

### Branches and PRs

Worktrees per branch, then a **PR into `main`, squash-merged** (one commit per PR, no merge
commits). Nothing lands on `main` except through a merged PR — a release included.
**An agent merges only after the operator confirms that specific PR.** Mechanics — updating a
branch without force-pushing, why a PR can report no checks, `bump:*` labels, what branch protection
enforces and what it deliberately does not yet: **`lettuce-pr-and-ci`**.

**The main checkout stays on `main` with a clean tree — only merge bookkeeping happens there.** All
feature work, including the branch and every commit on it, happens in a worktree under `.worktrees/`
(`git worktree add .worktrees/<name> -b <branch>`; git- and docker-ignored). Branching inside the
main checkout lets two sessions collide and breaks `deploy-check`'s clean-tree and on-`main`
assertions — story: docs/upstream-notes.md#main-checkout-collision-story-2026-09-29.

**Every change touching `bff/`, `web/` or `docker/` is a PR** — a new capability, a new sidecar, or
anything spanning more than one of them. The PR body (`.github/pull_request_template.md`) is the
gate list; the operator's own container test *is* the gate — nothing replaces it.

**A docs-only change touches none of `bff/`, `web/`, `docker/`: a PR of its own, nothing to
rebuild, nothing to deploy.** That is `AGENTS.md`, `docs/`, `README.md`, `CHANGELOG.md`,
`.agents/skills/`, `.pi/`, `scripts/` — none of it reaches an image, so it rides the next release's
tag. Gate: `bun run check-docs`, plus lint and tests when a script changed. `docker/agent-skills/`
is not docs-only — it ships in the app-server image.

### Versioning, tags, changelog — summary

Releases are annotated tags on `main` shaped `v<MAJOR>.<MINOR>.<PATCH>-letta_<LETTA_CODE_VERSION>`,
cut only after the prod deploy is verified. MINOR is any new or changed user-facing functionality;
PATCH is everything else that ships to prod. `VERSION` at the repo root is the only
machine-readable record and is bumped in the same commit that gets tagged; the UI reads it through
`/api/status`, and a build between releases carries its commit (`+<sha>`) so it is never
indistinguishable from the last release. A user-visible change carries a `CHANGELOG.md`
`[Unreleased]` entry in the same commit as the change, plus its `README.md` /
`docs/CONFIGURATION.md` update.

`bun run release --minor|--patch|--auto --pr` opens the release PR (the `VERSION` bump +
`[Unreleased]` rename); after it merges, `bun run release --deploy` runs deploy-check → Dockhand
plan → the one confirmation → deploy → verify → tag. Tag format rules, who writes changelog
entries, the docs-sync duty and why the release commit is never made on a feature branch:
**`lettuce-releasing`** skill.

## Workflow

The ordered shape of a change; "Definition of done" is the checklist each step has to satisfy.

1. **Worktree.** `git worktree add .worktrees/<name> -b <branch>` from the main checkout — never
   branch in the main checkout; a **docs-only** PR skips 3–5. Launched in someone else's worktree
   (`.pendant/worktrees/…`)? Use it; the gate only cares that you are not in the main checkout.
2. **Implement, commit, `bun run verify` green** — with the `CHANGELOG.md` `[Unreleased]` entry and
   any docs update in the same commit, and a `bump:*` label picked for the PR.
3. **Build and run it locally**, from the worktree: `bun run build:bff && docker compose -f
   docker/compose.yml up -d` (unscoped — hard rule 4). The stack is **one per machine, shared by
   every worktree**, so your `up -d` replaces what another session is testing. Copy the gitignored
   env in first (`cp ../../docker/.env docker/.env`) or the state dir lands in `.worktrees/`.
4. **Open the PR and stop.** Push the branch, `gh pr create` with the template filled in, say what
   to click and what should happen, then wait. Nothing merges before the human says it works; a
   failed test goes back to step 2.
5. **Merge is the human's** (squash). Then prove the artifact that ships from `main`: rebuild `bff`,
   `bun run deploy-check`, plus `ui-check` / `smoke` where they apply. Then `bun run cleanup`.
6. **Release — only after asking.** `bun run release --auto --pr`, human merges, `bun run release
   --deploy` deploys and tags. A failed deploy is never tagged; without the `dockhand-deploy` skill
   the release ends at the push and the deploy is the human's.

## Definition of done

Work is **not done**, and must not be reported as done, until every line below passes. The
origin story (a change reported complete while the container still served the old bundle):
docs/upstream-notes.md#definition-of-done-origin-story.

Passing typecheck is not done. Passing tests are not done. **Running in the container is done.**
A **docs-only** change stops after step 1.

1. **`bun run verify` green** — every offline gate (worktree, pins, prod-info, hygiene, docs,
   lint, typecheck, tests, build). Fails fast; later stages do not run once one
   fails.
 1b. **Built and running locally from the worktree** (Workflow step 3), and **tested by the user**:
    say what to look at, stop, and wait. Merge only after they say it works — no machine check
    replaces this gate, and unit tests passing is not "working".
 2. **Committed on the branch and squash-merged through its PR.** A user-visible change carries its
   `CHANGELOG.md` `[Unreleased]` entry — and its `README.md` / `docs/CONFIGURATION.md` update when
   it touched the configuration surface or a user-facing workflow — in the same commit. The
   **release commit** (`VERSION` bump + `[Unreleased]` rename) comes from `bun run release --pr`,
   never from a feature branch — see `lettuce-releasing`.
3. **The worktree goes through `bun run cleanup`**, which reports everything and removes only a
   worktree whose PR is merged with a clean tree and no process inside it (`--force` and pruning
   stay blocked outright). A concurrent agent may be sitting in a worktree; removing that one
   destroys uncommitted work.
4. **Docker rebuilt from `main`** —
   `docker compose -f docker/compose.yml build bff && docker compose -f docker/compose.yml up -d bff`.
   The `build` is not optional; see the note below.
 5. **`bun run deploy-check` green** — asserts the tree is clean and on `main`, that the
    bundle the container serves is byte-identical to the one in `web/dist`, that `VERSION`
    agrees with the tag pointing at `HEAD`, that `CHANGELOG.md` has `[Unreleased]` and its
    newest release section equals `VERSION`, and that `/readyz` and the upstream app-server
    connection are healthy.
5b. **`bun run ui-check` green** for any change touching `web/` — drives headless
   Chromium at phone and desktop widths and asserts what unit tests cannot see:
   nothing clipped off-screen, the composer controls present, sheets opening and
   closing, breakpoint behaviour. Screenshots land in `.ui-check/`. It needs the
   stack running, which is why it sits here and not inside `verify`.
6. **`bun run smoke` green** when the change touches BFF session, protocol or settings
   paths. Not part of `verify`: it needs a live stack, it needs at least one agent to
   exist, and it mutates real state (writes `smoke-probe.md` into the agent cwd, edits
   and restores the shared MCP list, creates and deletes a cron task).
 7. **Released to prod — pushed to `origin`, then redeployed with Dockhand — but stop and ask
    first** (see "Stop before releasing to prod" for the full rule, target and order).
 7b. **Tagged** — once the prod deploy verifies, tag `main`'s HEAD with the tag `VERSION` names
    (`git tag -a "$(cat VERSION)" -m "<feature>"`) and `git push origin <tag>`. Part of the same
    stop-and-ask confirmation as the release — never a separate approval, and never before
    `dockhand verify` is green.

### Stop before releasing to prod

**Never `git push` and never redeploy prod without asking, every time.** After merging to
`main` and passing steps 1–6, halt and ask for explicit confirmation of the full release.
Standing approval does not carry over: a yes on one change is not a yes on the next one, and
"go ahead" given before the preflight was shown is not a yes either.

Pushing is the one step that leaves this machine, and `origin` is the only copy of this
project that is not on one laptop — so it matters, and so it is worth a human deciding.
It comes last, after `deploy-check`, so nothing reaches `origin` that has not been proven
to run in the container first.

**Prod is deployed from `origin`, not from this machine.** Dockhand (its address lives in the
`dockhand-deploy` skill's own config — never in a tracked file) builds the stack from `dmarchevsky/lettuce` `main` at the moment of the deploy (Dockhand's
stored stack URL must be updated when the repo is renamed), so the push
must land first and an unpushed commit never reaches prod. Use the `dockhand-deploy` skill
(`~/.claude/skills/dockhand-deploy/`) for every step — `plan`, `deploy --confirm`, `verify` — never
ad-hoc API calls and never the Dockhand stop/down/delete/exec endpoints.

**When that skill is not present on the machine running the release, the release ends at
`git push origin main`.** Stop there, report the pushed commit range, and tell the user the prod
redeploy is theirs to trigger manually (from a machine that has the skill, or the Dockhand UI)
— do not substitute ad-hoc API calls for a missing skill. The rest of the flow is unchanged:
the deploy is still verified (`dockhand verify` or the user's own confirmation that the pushed
commits are live) before any tag is created, per step 7b.

The confirmation question must **name the target exactly** and show the preflight, so the user is
approving a specific thing:

| | Prod target |
|---|---|
| Dockhand environment | `letta` |
| Stack | `letta-code-ui-prod`, compose `docker/compose.yml` |
| Containers | `letta-code-ui-prod-app-server-1`, `-bff-1`, `-channel-gateway-1`, `-cloudflared-1` |

**No prod hostnames, IP addresses or Dockhand ids are kept in this repo** — names are enough to
address it, and everything else is read live from `dockhand.sh stacks letta`. `bun run
check-prod-info` keeps it that way (private IPv4 ranges and personal mail domains fail it).

Re-read environment and stack from `dockhand.sh stacks letta` before asking — never from memory,
never inferred from a similar name (`duckduckgo` alone exists in three environments). If they do
not match the table, stop and ask rather than deploying.

The question also states: the commit range (`plan` output: deployed commit → `origin/main`),
whether `docker/compose.yml` changed, **which containers will be recreated**, and the previous
deploy's duration. Call out an `app-server` recreate explicitly — Dockhand runs an unscoped
`compose up`, so any image or compose change to it recreates it, and that kills every in-flight
turn with no drain (the BFF's shutdown drain covers only `bff`; see "A `bff` redeploy is the one
time the connection does close"). A cron or Telegram turn does not show in the BFF log, so the
log alone cannot prove nothing is running.

Order, once confirmed: `git push origin main` → `dockhand.sh deploy letta letta-code-ui-prod
--confirm` → `dockhand.sh verify letta letta-code-ui-prod --since <printed time>` → the BFF log
must show `Upstream connected: letta-code <pinned version>` → tag and push per step 7b.
A version other than the pin means
Dockhand's stored stack variables override it. On any failure, stop and report — no retry, no
rollback, no restart without the user choosing it.

`origin` is `dmarchevsky/lettuce` (renamed from `letta-code-ui`; update local remotes with
`git remote set-url origin`), private, and was empty until the first push. There
is no `main` upstream to track on a fresh clone — the first push of a branch needs
`git push -u origin main`. `.gitignore` covers `docker/.env` and `docker/secrets/`; neither is
tracked, and no secret values are in history. Re-check that before pushing anything new that
touches configuration.

Only `bff` is rebuilt in step 4 — it is the only service carrying our code. Recreate
`app-server` or `channel-gateway` only when `LETTA_CODE_VERSION` or their compose config changes,
and `ddg-mcp` only when `DDG_MCP_VERSION` or `docker/ddg-mcp/` changes (it shares no namespace,
so `docker compose -f docker/compose.yml up -d --build ddg-mcp` is safe on its own). The same
goes for `google-mcp` with `WORKSPACE_MCP_VERSION` / `docker/google-mcp/`, and `searxng` with
`SEARXNG_VERSION` / `docker/searxng/`.

**`web/dist` is baked into the bff image, never mounted.** `bff.Dockerfile` builds the SPA
in its `web-build` stage and copies the result into the runtime image; the BFF's only mounts
are the `bff-data` volume and read-only views of the state (`/work`, `/root/.letta`, the memfs
root — for file mtimes and skill discovery) — it takes no configuration from disk at all.
So `docker compose up -d` on its own will happily serve a months-old UI, and a local
`bun run build` changes nothing the container sees. That is the trap step 5 catches: it
compares the served `assets/index-*.js` name against the local one.

Lint policy: `bun run lint` fails on Biome **errors** only. Warnings are visible but do not
block — a handful are load-bearing (see the comments in `biome.jsonc` for why
`useExhaustiveDependencies` is a warning here: satisfying it would reintroduce the unbounded
app-server request loop that `use-session.ts` documents).

## Commands

| Command | What it does |
|---|---|
| `bun run verify` | **The gate.** every offline stage, cheapest first (stages listed in Definition of done 1) |
| `bun run check-prod-info` | Fails if any tracked file contains a private IPv4 address or a personal mail domain |
| `bun run check-docs` | Asserts `AGENTS.md` and `.agents/skills/` are honest: anchors, paths, command table, skill frontmatter, size budget |
| `bun run deploy-check` | Asserts the running container serves the merged code, and is healthy |
| `bun run ui-check` | Layout/interaction assertions in a real browser; screenshots to `.ui-check/` |
| `bun run lint` | Biome check (errors fail, warnings do not) |
| `bun run format` | Biome check with safe fixes applied |
| `bun run typecheck` | Typecheck both packages — the protocol-drift detector |
| `bun run test` | `bun:test` unit tests, plus the harness guard rules in `tests/` |
| `bun run build` | Builds the SPA into `web/dist` (runs `tsc --noEmit` first) |
| `bun run dev` | BFF + Vite dev server |
| `bun run smoke` | Live acceptance suite against a running stack — mutates state |
| `bun run sync-upstream v<x.y.z>` | Move the upstream checkout to a release, report drift, re-pin |
| `bun run release --minor\|--patch` | The whole release: release commit on `main`, then gated push → deploy → verify → tag |
| `bun run check-version-pin` | Assert every letta-code version literal agrees (runs inside `verify`) |
| `bun run cleanup` | Report merged worktrees and branches; `--apply` removes ones that are merged, clean and unoccupied |
| `bun run screenshots` | Regenerate `docs/images/` screenshots from the running stack |
| `bun run migrate-state` | One-shot: copy the old `letta-home`/`letta-data` named volumes onto the host |
| `docker compose -f docker/compose.yml build bff` | Rebuild the BFF image — **required** to ship UI changes |
| `docker compose -f docker/compose.yml up -d` | App-server + BFF; `cloudflared`, `google-mcp` (`google`), `searxng` + `ddg-mcp` (`search`) and `channel-gateway` (`telegram`) only with their profiles |
| `git push origin main` | Release, part 1 — **ask for confirmation first, every time** |
| `~/.claude/skills/dockhand-deploy/dockhand.sh plan letta letta-code-ui-prod` | Prod preflight: commits, compose diff, what gets recreated (read-only). Only on a machine that has that skill — see "Stop before releasing to prod" |
| `… deploy letta letta-code-ui-prod --confirm` | Release, part 2 — prod redeploy via Dockhand, same confirmation as the push |

## Project harness

The repo carries its own agent-harness configuration so the rules above are not only prose:

- `.agents/skills/lettuce-*/SKILL.md` — the task-scoped mechanics this file moved out; pi lists
  their names and descriptions and loads the body only when one is read.
- `.pi/extensions/guard.ts` — confirms, or outright blocks, what this file forbids: `git push`,
  `git tag -a`, `git worktree remove` / `git branch -d|-D` (every `--force` variant and worktree
  pruning stay blocked outright), `docker compose … rm|down|stop|kill|restart`, a scoped
  `up … app-server`, and any write to `docker/.env`, `docker/secrets/` or `VERSION`. With no UI a confirmable action is blocked, never silently allowed. Rules are pure
  functions in `guard-core.ts` (tests: `tests/guard-core.test.ts`); read-only commands that merely quote
  one are exempt; it guards what an agent types, not what a script does internally — which is why
  `release.ts` carries its own typed confirmation.
- `.pi/prompts/*.md` — `/verify`, `/finish`, `/release`, `/sync-upstream` runbooks, so a fresh
  session does not have to remember the order.
- `.pi/remote-pi/`, `.pi/npm/`, `.pi/sessions/` and `.pi/settings.json` are per-machine and
  gitignored (a local `settings.json` is how you point `skills` at `~/.claude/skills`).
- `bun run check-prod-info` fails on private IPv4 addresses and personal mail domains anywhere in
  tracked files — the repo is public, so prod is referred to by name only. Use RFC 5737's
  documentation ranges (`192.0.2.0/24`) in examples and tests.
- `bun run check-docs` keeps this file and the skills honest: every `docs/*.md#anchor` resolves, every
  repo path mentioned exists, the command table matches `package.json`, skill frontmatter is valid
  and matches its directory, and `AGENTS.md` stays inside its budget (`--print-size` shows it).
