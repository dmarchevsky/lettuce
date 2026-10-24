# lettuce — Project Guide

Self-hosted personal assistant: a local Letta agent (memory, crons, skills) driven from a
mobile-first web UI we own end to end. No Letta Cloud, no cloud LLM providers.

**This file is `AGENTS.md`, and `CLAUDE.md` is a symlink to it**, so every harness reads the same
text; they load one context file per directory, so a real pair holding different content is a bug.
Everything here is in every session's context, so it holds only what is load-bearing in every task.
Task-scoped mechanics live in `.agents/skills/` (see "Where the details live") and incident
narratives in `docs/upstream-notes.md`, pointed at as `docs/upstream-notes.md#<anchor>`.
`bun run check-docs` keeps those pointers real and keeps this file inside its size budget.

## Hard rules

1. **Upstream is not ours to patch.** Nothing in `letta-code/` is compiled into any image, and every
   capability we need already exists in its app-server protocol.
2. **Exactly one upstream WebSocket, owned by the BFF.** Never open a second, never close it, never
   forward a browser disconnect upstream in any form.
3. **All durable state is under `LETTA_STATE_DIR`**, set absolutely in `docker/.env`, so a compose
   command from anywhere hits the same state.
4. **Never recreate `app-server` on its own** — its network namespace holds `bff` and
   `channel-gateway`. Always `docker compose -f docker/compose.yml up -d` unscoped.
5. **Never push `main` or a tag without asking, every time.** A feature-branch push is routine; a
   `main`/tag push *is* the release, and only dev-flow's `release` stage may write it. Production deploy
   is the operator's alone — the agent publishes and stops.
6. **Done means the operator tested it in the container** — see "Definition of done". Typecheck and
   tests passing is not done. A **docs-only** change stops at `bun run check-docs`. **UI changes**
   carry two more gates — approved target-state mockups (desktop + phone) before implementing, a
   holistic visual pass after: `lettuce-ui-verification`.
7. **Every change happens in a worktree on a feature branch** — `flow approve` creates it at
   `.dev-flow/<slug>/worktree` — a docs-only change included, which is what `flow start <slug> --docs` is
   for. The main checkout stays on `main` with a clean tree and only takes merged PRs.
8. **Never remove a worktree or delete a branch by hand** — `flow finish` closes the feature whose PR
   merged: it checks the worktree is clean, notes commits that never reached `main`, and deletes
   `origin/<branch>` only on proof it was released.

## Workspace layout

```
~/work/
  lettuce/            this repo — everything we own (the app is **Lettuce**)
    .dev-flow/<slug>/worktree/
                      one worktree per feature branch — dev-flow's default location, inside the
                      self-ignored `.dev-flow/`; `.dockerignore` keeps it out of build contexts
  letta-code/         plain clone of letta-ai/letta-code at the pinned release tag — read-only.
                      A sibling of `lettuce/` because that is what `scripts/sync-upstream.sh`
                      assumes: `${LETTA_CODE_DIR:-<repo parent>/letta-code}`. A fresh machine has
                      no clone; the script clones it.
  <state dir>         LETTA_STATE_DIR from docker/.env — see "All durable state lives under one
                      host root"
```

**The upstream clone is dev tooling, not a build input.** Nothing in `letta-code/` is compiled into any
image and nothing outside `lettuce/` is in any build context: the channel-gateway runs upstream's
published `letta/letta:<version>` as-is; the app-server runs a thin image built `FROM` it that only
adds the coding CLIs and our shims (`lettuce-coding-workers`) and the env that keeps agent-installed
tools in `tools/` (`lettuce-runtime-and-ops`); the UI consumes
`@letta-ai/letta-code` from npm. The checkout exists so `sync-upstream.sh` can diff it and so you can
read source the npm package does not ship. A prod host needs only `git` and `docker`. There is no fork
of upstream: the zero-delta rule means one could hold nothing upstream lacks.

`letta-code/` keeps its own `AGENTS.md` (and its `CLAUDE.md -> AGENTS.md` symlink) untouched — that is
upstream's file, not ours.

**Upstream is not ours to patch.** `letta-code/` carries **no local changes** and
`scripts/sync-upstream.sh` refuses to run against a dirty checkout. If something seems to need a
letta-code patch, it is almost certainly an existing protocol command — check
`letta-code/src/types/protocol_v2.ts` first.

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

**This is the most important invariant in the codebase.** Exactly ONE upstream WebSocket connection
exists, owned by the BFF, opened at boot and never closed. Browser sessions multiplex over it and are
invisible to the app-server.

Why: `letta-code/src/websocket/listener/connection-lifecycle.ts` — when a connection closes and no
other *subscribed* connection remains for that `(agent_id, conversation_id)` scope, the app-server
cancels and **kills the in-flight turn**, rejects its pending approvals and kills its terminals —
since 0.34.2 it keeps queued messages (process-owned, run when a subscribed connection returns).
A phone backgrounding a tab drops its socket in seconds; because the BFF owns the
connection, none of that cleanup runs.

Corollaries — do not break these:
- Never open a second upstream connection, and never close the one that exists.
- Never forward a browser disconnect upstream in any form.
- The BFF allocates `request_id`s; browser ids are translated, never passed through.
- The BFF's own syncs (reconnect `resubscribe()` and the scope sweep) carry
  `resume_interrupted_turn: true`: it is every conversation's execution owner, so after an app-server
  restart a turn left with only replay-unsafe tool calls pending resumes immediately (those calls are
  denied) instead of waiting for a user message. Browser syncs stay observer syncs, never the flag.
- Missed frames replay from the BFF's per-conversation ring buffer, keyed by a monotonic sequence
  number. `conversation_messages_list` (cursor `next_before` / `has_more`) is the cold-start fallback
  when a tab was away longer than the buffer.

**A `bff` redeploy is the one time the connection does close — so shutdown drains first.**
`bff/src/shutdown.ts` holds SIGTERM until `ActivityTracker` reports no turn in progress (up to
`SHUTDOWN_DRAIN_TIMEOUT_SECONDS`, 9 min default; a second signal skips the wait), and
`stop_grace_period: 10m` in `docker/compose.yml` is what lets it — Docker's default 10 s SIGKILLs the
drain. Both must stay inside the deploy manager's own `compose up` timeout. Without the drain the cancel
cannot reach llama.cpp; the signature is an error push five minutes after a BFF restart
(`BUSY_RUN_WAIT_TIMEOUT_MS`): docs/upstream-notes.md#bff-redeploy-drain.

The same permanent connection is also what boots the cron scheduler and Telegram adapters: app-server
process services start on *first client attach* (`listener/lifecycle.ts` →
`startConnectedListenerRuntime`), so with no client ever connected, crons never fire.

**`web/dist` is baked into the bff image, never mounted** — the image builds the SPA in its
`web-build` stage and copies it in. So `docker compose up -d` alone serves a months-old UI and a
local `bun run build` changes nothing the container sees: the release stage publishes the image and `bun run
deploy-check` compares the served `assets/index-*.js` with the local one.

**A prod deploy pulls published images; the deploy host builds nothing.** Every release publishes
the five images we build to GHCR under the release tag (`.github/workflows/publish.yml`; public
packages, so a host needs no registry credentials), and `docker/compose.yml`'s `LETTA_IMAGE_TAG`
default — the release literal, moved with `VERSION` in the same release-prep commit and asserted by
`check-release-hygiene` — names them. The namespace default is **empty** on purpose: an un-namespaced
name cannot be pulled, so a dev checkout always builds from source, and `build:` stays on every
service as that fallback.

### All durable state lives under one host root

`LETTA_STATE_DIR` (`docker/compose.yml`) anchors every bind mount:

```
$LETTA_STATE_DIR/
  letta-home/     -> /root/.letta   settings.json, mcp-home/ (shared MCP list), global skills
  letta-data/     -> /data          conversations + agent memory (memfs git repos)
  workspaces/     -> /work          agent working directories
  tools/          -> /opt/agent-tools  what agents install (npm -g, cargo, go, uv), via image ENV
```

It defaults to `../..` relative to the compose file, which is **a trap in a worktree** — `../..` from
`.dev-flow/<slug>/worktree/docker/` resolves to `.dev-flow/<slug>`. Prod sets an absolute path in `docker/.env`
(hard rule 3), and container work always happens from the main checkout.

Three named volumes remain, none precious: `bff-data` (web-push endpoints, rebuilt by re-subscribing)
and `google-policy` / `google-creds` (Settings → Google Workspace, named so the app-server cannot mount them by
accident through the state tree; losing them means reconnecting Google). Everything precious is under
that one host directory, so a backup is a single `tar`. Older installs move off the named volumes with
`bun run migrate-state`, which copies and verifies and never deletes — the memfs git history is the
only record of what an agent has learned.

### Compose profiles are the one feature list

Every optional piece of the stack hangs off `COMPOSE_PROFILES`, and each token there also decides what
the app-server image contains. **Sidecars are opt-in: `google-mcp` has `profiles: ["google"]`,
`searxng` and `ddg-mcp` share `["search"]`, `channel-gateway` has `["telegram"]`
(`lettuce-telegram-channels`), `cloudflared` has `["cloudflared"]`.** Prod runs
`COMPOSE_PROFILES=cloudflared,google,search,codex,claude`. Nothing `depends_on` a sidecar, and
without its token the integration is off wholesale whatever the stored Settings switch says —
dropping the profile is the whole off switch. Removal is
`--profile <p> rm -sf …`. To test a profile locally **without editing `docker/.env`**, prefix the
command — `COMPOSE_PROFILES=<…,pi> docker compose -f docker/compose.yml up -d bff`: shell env beats
the `.env` file, `LETTA_MODE` carries the string to the BFF, and the next un-prefixed `up` reverts it.

Three tokens are **virtual**: none is declared by a service, none starts a container. `codex` and
`claude` decide what the app-server *image* contains; `pi` (Remote Pi) is BFF-side only and installs
nothing in the image. Every token is matched as an exact comma-delimited entry (`bff/src/config.ts`
`hasProfile`: `searchy` ≠ `search`), and the BFF derives `config.features` = `web`⇐`search`,
`google`⇐`google`, `codex`⇐`codex`, `claude`⇐`claude`, `pi`⇐`pi`.

- **effective-enabled = token AND stored Settings switch**, enforced at each availability decision: web
  tools render disabled (`renderAllMods`), Google reapply/status/sidecar-config run on the gated
  settings, and the codex/claude connect-time reapply writes `enabled: false` into `lettuce.json` so
  the shims refuse (the stored endpoint/model/key survive, so re-enabling is one switch flip). Their
  Settings and worker routes answer 404 while the token is off, and `web/` hides the matching sections,
  Tasks run lists and Tools tab rows from `features` in `/api/status` (absent = all on).
- **The coding tokens and the image marker (`CODING_FEATURES`, `/opt/lettuce/features`,
  `coding_installed`) are the `lettuce-coding-workers` skill: toggling one needs an app-server
  rebuild locally, because a local image tag does not change with the token list** — the published
  images bake both CLIs, so in prod it is a Settings flip. A Compose warning about unknown profiles is
  fine — `docker compose config` accepts tokens no service declares.

## Where the details live

Task-scoped mechanics live in `.agents/skills/` (pi reads them from `.pi/skills/` too), so they are out
of context until needed. Each `description` names the files and the traps — read the skill before
working in that area.

| You are touching | Read the skill |
|---|---|
| `channel-gateway`, Telegram pairing, compose profiles for channels | `lettuce-telegram-channels` |
| `bff/src/mcp/`, `bff/src/mcp-bridge/`, `bff/src/internal-tools/`, Settings → MCP / Web search | `lettuce-mcp-and-mods` |
| `bff/src/skills/`, `docker/agent-skills/`, Settings → Global skills, `skill_enable` | `lettuce-skill-discovery` |
| `docker/codex/`, `bff/src/codex/`, `bff/src/claude/`, Settings → Codex / Claude Code workers | `lettuce-coding-workers` |
| `bff/src/google/`, `docker/google-mcp/`, OAuth scopes, Settings → Google Workspace | `lettuce-google-integration` |
| `bff/src/agents/tool-access.ts`, the policy mod, the Tools tab, `bff/src/pi/agent-settings.ts` | `lettuce-per-agent-tool-access` |
| `ACCESS`/`SIGNIN`, `bff/src/auth/`, the password store, Settings → Access / Sign-in | `lettuce-access-and-signin` |
| `web/src/lib/messages.ts`, question/approval cards, `turn-errors.ts`, `turn-usage.ts`, `push/turn-watcher.ts` | `lettuce-transcript-and-streaming` |
| LLM timeout env, agent app ports, failing subagent spawns, the agent-tools ENV in `docker/codex/Dockerfile` | `lettuce-runtime-and-ops` |
| Memory tab, `persona.md`, "the system prompt did not update" | `lettuce-memory-and-system-prompt` |
| `AgentMenu`, the sidebar agent list, pin/archive lists, Settings vs Agent tab layout | `lettuce-ui-conventions` |
| Any `web/` UI change: mockups before implementing, visual pass after | `lettuce-ui-verification` |
| PRs, `.github/workflows/`, `bump:*` labels, branch protection, CI tiers | `lettuce-pr-and-ci` |
| `bun run sync-upstream`, `LETTA_CODE_VERSION` | `lettuce-upstream-sync` |
| `VERSION`, `CHANGELOG.md`, tagging, the bump labels | `lettuce-releasing` |

## Facts that are easy to get wrong

Cross-cutting protocol and product facts that apply to almost every task. Anything area-specific
lives in a skill — the table above says which.

- **Browsers cannot reach the app-server directly.** Auth is `Authorization: Bearer` only —
  unsettable on a browser WebSocket — and unauthenticated upgrades carrying `Origin` are rejected
  outright; the BFF is mandatory.
- **No per-user isolation, and `ALLOWED_USERS` therefore stays a list.** One process-wide runtime;
  every socket sees every event; v1 is single-user by decision, so keep agent-id filtering in the BFF
  frame router. `ALLOWED_USERS` is env-only and means something only for the methods that receive an
  address — required for `SIGNIN=cf-access` and `SIGNIN=google`, unused (with a boot warning) by
  `none` and `password`, which have no address to match. Under `cf-access` it is the defense left
  standing when the Access policy is misconfigured, so never collapse it to one address.
  Story: docs/upstream-notes.md#allowlist-env-only-story.
- **Access and sign-in are separate axes, and boot checks where they disagree.** `config.access`
  (`ACCESS`, must agree with the `cloudflared` profile token both ways) is the route; `config.signin`
  (`SIGNIN`, one of `none|password|cf-access|google`) is the method — the old single `mode` conflated
  them, and `DEV_BYPASS_EMAIL` is gone (its presence is a boot error). `signin === "cf-access"` is the
  only method that reads a header, so `resolve-session` gates on exactly that; `signin === "none"`
  requires a loopback host bind and `access === "cloudflared"` forbids a wide one, because Compose
  cannot derive one setting's default from another's value. The password hash lives on the `bff-auth`
  **named volume**, never under `LETTA_STATE_DIR` — agent shells mount that tree read-write as uid 0.
- **There is no agent-to-agent isolation.** What separates agents is letta-code's in-process
  cross-agent guard (`permissions/cross-agent-guard.ts`), which covers the file tools; shells are
  unconfined within the container. Real isolation would mean one app-server container per agent.
- **Provider connection state is `connected.is_connected`**, not `connected.connected`.
- **Settings are split by scope, and the split is the UI's only statement of it.** The **Agent** tab
  (`web/src/tabs/AgentTab.tsx`) holds what belongs to the selected agent; the top bar's gear
  (**Settings**) holds what every agent shares — providers, web search, MCP servers, Google, coding
  workers, global skills — plus this device's notifications and an About. A new setting goes where its
  backend key is: keyed by `agent_id` → Agent tab; a BFF file or an app-server-wide command → Settings;
  `runtime` scope → next to the conversation. Layout: `lettuce-ui-conventions`.
- **File protocol gotchas** (all verified against a running app-server): `get_tree` returns paths
  **relative** to the root it was given while every other file command wants an absolute path, so the
  client must join them; `grep_in_files` takes `query`, not `pattern`, and the wrong key produces **no
  response at all** — a silent hang, not an error; and it follows ripgrep defaults, so hidden and
  ignored files are skipped.
- **Conversations DO have a native `archived` field** (plus `archived_at`), set with
  `conversation_update {body:{archived}}`, but `conversation_list` ignores an `archived` filter, so the
  *list* is filtered client-side. **Rename** = `conversation_update {body:{summary}}`; a fresh
  conversation has `summary: null`, so the UI supplies its own placeholder.
- **`create_agent` presets** are exactly `memo | tutorial | blank | linus | kawaii`. There is no
  `default`.

## Git workflow

### Branches and PRs

Worktrees per branch, then a **PR into `main`, landed as a merge commit** — a PR's commits are what
reach `main`, so `git branch --merged main` stays truthful and `git branch -d` can delete a merged
branch. Nothing lands on `main` except through a merged PR — a release included. **Release? is the merge
authorization** — the operator does not merge by hand: the agent opens the PR, waits for `ci`, and
merges it (`gh pr merge <n> --merge`). Mechanics, labels, protection and CI tiers:
**`lettuce-pr-and-ci`**.

**Why the worktree rule is a gate and not a preference** (dev-flow enforces it — see *Definition of
done*): branching in the main checkout lets two sessions collide and breaks `deploy-check`'s clean-tree
and on-`main` assertions. `bun run check-worktree` (a `verify` stage) refuses it.
Story: docs/upstream-notes.md#main-checkout-collision-story-2026-09-29.

**Every change touching `bff/`, `web/` or `docker/` is a PR** — a new capability, a new sidecar, or
anything spanning more than one of them. The PR body (`.github/pull_request_template.md`) is the gate
list; the operator's own container test *is* the gate — nothing replaces it.

**A docs-only change touches none of `bff/`, `web/`, `docker/`: a PR of its own, nothing to rebuild,
nothing to deploy.** That is `AGENTS.md`, `docs/`, `README.md`, `CHANGELOG.md`, `.agents/skills/`,
`.pi/`, `scripts/` — none of it reaches an image, so it rides the next release's tag.
`docker/agent-skills/` is **not** docs-only: `docker/bff.Dockerfile` copies it into the **bff** image and
`bff/src/agent-skills.ts` writes it into the container on connect, so a change there needs `build:bff`.

**Never split a plan from the code it plans: a plan doc rides its work's branch and PR, not
its own PR.**

### Versioning, tags, changelog

`VERSION` holds the whole tag string — `v<MAJOR>.<MINOR>.<PATCH>-letta_<LETTA_CODE_VERSION>` — and is the
only machine-readable record. MINOR is new or changed user-facing functionality, PATCH everything else
that ships. Every shipping feature cuts its own release, and the flow owns the mechanics of when: the
`VERSION` bump and the `## [Unreleased]` rename are one commit at `pre-release`, and the annotated tag is
pushed by name at the merge. `.dev-flow/project.md` holds those steps; **`lettuce-releasing`** holds the
tag format, the changelog voice, the bump labels and the docs-sync duty.

## Upstream sync

`bun run sync-upstream v<version>` moves the upstream checkout to a **published release tag** (never
`main` — nothing to pin), reports protocol and behavioural drift, re-pins every version site and
typechecks. Behavioural drift is what bites; the file list, version literal sites, stale-pin trap and
full-redeploy rule are in **`lettuce-upstream-sync`** — read it before running the command.

## Definition of done

Every change runs through dev-flow — the `flow` tool for an agent, `/flow` for the operator: **plan →
implement → pre-release → release → done**, one worktree and branch per feature, and one feature at a
time **per session** — dev-flow keeps parallel features apart by worktree, so a second session may run
its own flow while this one is open. Each
stage's commands, scripted checks and checklist live in `.dev-flow/project.md`, and dev-flow's guard
refuses work outside the stage or outside the session's worktree — so this file states only what a gate
cannot check.

**Running in the container is done.** Typecheck is not done. Tests are not done. Every stage hands off to
one human word — **Approve?** on the written plan, **Verified?** once they have clicked through the change
in the local container stack, **Release?** on the tag, **Finish?** — and nothing else satisfies it: no
type check, no unit test, no CI job. **Untested code does not leave the machine.** Origin story:
docs/upstream-notes.md#definition-of-done-origin-story.

Two things no gate can see on its own:

- A `web/` change needs `bun run build:bff` before the container test, or the container serves the old
  bundle — `web/dist` is baked into the bff image.
- The stack is one per machine and shared, so an `up -d` replaced whatever another session was testing.
  Say so out loud.

A **docs-only** change runs the same flow with `--docs`: no plan file and no tier-1 checks, which is
exactly why `bun run check-docs` is the agent's own job here; it ships unversioned when the operator says
so.

**UI changes carry two extra gates** — approved target-state mockups at phone and desktop *before*
implementing, a holistic visual pass *after*. The `(ui)` checklist items in `.dev-flow/project.md` gate
them; `lettuce-ui-verification` holds the mechanics.

### Stop before publishing

**Never push `main` or a tag without asking, every time** (hard rule 5). Halt before the push and ask for
explicit confirmation of that specific release. Standing approval does not carry over: a yes on one change
is not a yes on the next, and "go ahead" before the commits were shown is not a yes. Pushing is the one
step that leaves this machine, and `origin` (`dmarchevsky/lettuce`) is the only copy of this
project not on one laptop. `docker/.env` and `docker/secrets/` are gitignored and no secret values are in
history — re-check that before pushing a configuration change.

**Prod is the operator's** (hard rule 5), so this repo keeps no prod hostname, address, container list or
deploy-manager detail — `bun run check-prod-info` fails the tree if one appears (private IPv4 ranges and
personal mail domains fail it; use RFC 5737's `192.0.2.0/24` in examples and tests). Prod builds from
`origin/main` at the tag, so the push has to land first.

Call out an `app-server` recreate before shipping one: an unscoped `compose up` after an image or compose
change recreates it and kills every in-flight turn with no drain (the drain covers only `bff`), and a cron
or Telegram turn does not show in the BFF log.

Only `bff` is rebuilt to prove an artifact — the only service carrying our code. Recreate `app-server` or
`channel-gateway` only when `LETTA_CODE_VERSION` or their compose config changes, and a search or
Google sidecar only when its own pin or `docker/<name>/` changes. `bun run lint` fails on Biome
**errors** only; `biome.jsonc` explains which few warnings are load-bearing.

## Commands

| Command | What it does |
|---|---|
| `bun run verify` | **The offline gate.** Every stage that needs no running stack, cheapest first |
| `bun run check-docs` | Asserts `AGENTS.md` and the skills are honest: anchors, paths, command table, frontmatter, size budget |
| `bun run check-release-hygiene` | `VERSION` ↔ `CHANGELOG.md`; with `--pr`, that the change added its entry and its `bump:*` label agrees |
| `bun run check-version-pin` | Assert every letta-code version literal agrees |
| `bun run check-pin-upstream` | Report every upstream pin vs its registry (needs network; never fails) |
| `bun run check-prod-info` | Fails if a tracked file holds a private IPv4 address or a personal mail domain |
| `bun run check-worktree` | Feature work is not happening in the main checkout |
| `bun run deploy-check` | The running container serves the merged code, and is healthy |
| `bun run ui-check` | Layout/interaction assertions in a real browser; screenshots to `.ui-check/` |
| `bun run smoke` | Live acceptance suite against a running stack — mutates state |
| `bun run build:bff` | Rebuild the bff image (it bakes `web/dist`) — **required** to ship UI changes |
| `bun run sync-upstream v<x.y.z>` | Move the upstream checkout to a release, report drift, re-pin |
| `flow` / `/flow` | The stage gates: `start`, `use`, `status`, `check`, `approve`, `verify`, `release` (`--no-version`), `release-done`, `finish` |
| `bun run migrate-state` | Older installs only: copy the old `letta-home`/`letta-data` named volumes onto the host |
| `docker compose -f docker/compose.yml up -d` | App-server + BFF; sidecars and `channel-gateway` only with their profiles |
| `git push origin v<x>` | The release-stage tag push, at the merge that just landed on `main`; **ask for confirmation first, every time** |

The obvious ones are not listed: `lint`, `format`, `typecheck`, `test`, `build`, `dev`, `build-info`,
`screenshots`. `check-docs` asserts every other `package.json` script appears here.

## Project harness

The repo carries its own agent-harness configuration, so the rules above are enforced and not only
prose. Gate messages cite this file **by section name, never by rule or step number**, so renumbering
cannot desync them.

- `.agents/skills/lettuce-*/SKILL.md` — task-scoped mechanics; pi lists names and descriptions and
  loads a body only when one is read.
- **dev-flow** is the harness (`pi install git:github.com/dmarchevsky/dev-flow`, recorded in the
  gitignored `.pi/settings.json`, so a fresh machine runs that command). It owns the stages, the worktrees
  and the safety rules, which are the `flow-guard` block in `.dev-flow/project.md` — `deny` / `confirm` /
  `protect` / `forbid`, judged at every stage **ahead of** flow discipline, and blocked rather than
  silently allowed when there is no UI to confirm in. Read that block for what is refused outright and what
  needs the operator; this file does not copy it. The rules see what an agent *types*, not what a script
  does internally. Bookkeeping is not guarded because nothing hand-removes a worktree: `flow finish`
  does it, with its own checks (hard rule 8).
- `.dev-flow/project.md` — the operator-owned playbook: default branch, worktree path, the tier-1 check
  commands, each stage's checklist, and the prose rules. It is tracked; feature plans and flow state are
  not. Since it is tracked, a change rides a flow and a PR like any other file; `flow init --write` is
  the operator-driven path that writes the live copy, and `flow doctor` validates either.
- `.pi/prompts/sync-upstream.md` — the one runbook left; the stage gates replaced `/verify`, `/finish`
  and `/release`.
- The gate that owns each rule: `check-worktree` (worktrees), `check-release-hygiene` (changelog entry
  and bump label), `check-version-pin` (pins), `check-prod-info` (prod details out of the tree),
  `check-docs` (this file and the skills), `deploy-check` (the container serves `main`).
- `.pi/remote-pi/`, `.pi/npm/`, `.pi/git/`, `.pi/sessions/`, `.pi/goals/`, `.pi/skills/`,
  `.pi/plans/`, `.pi/settings.json` and `.pendant/` are per-machine and gitignored. `.pi/git/` is pi's
  own package cache (`pi install git:…`) and appears the first time a package is installed.
