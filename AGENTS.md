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
5. **Never push `main`, tag, or redeploy prod without asking, every time.** A feature-branch push is
   routine; a `main`/tag push *is* the release. `.pi/extensions/guard.ts` enforces that split.
6. **Done means the operator tested it in the container** — see "Definition of done". Typecheck and
   tests passing is not done. A **docs-only** change stops at `bun run check-docs`. **UI changes**
   carry two more gates — approved target-state mockups (desktop + phone) before implementing, a
   holistic visual pass after: `lettuce-ui-verification`.
7. **Feature work happens in a worktree on a feature branch** under `.worktrees/`; the main checkout
   stays on `main` with a clean tree and only takes merged PRs (docs-only changes excepted).
8. **Never remove a worktree or delete a branch by hand** — `bun run cleanup` does it once a PR is
   merged, and refuses anything unmerged, dirty, or occupied by another session.

## Workspace layout

```
~/work/
  lettuce/            this repo — everything we own (the app is **Lettuce**)
    .worktrees/       one worktree per feature branch (git- and docker-ignored)
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
adds the coding CLIs and our shims (`lettuce-coding-workers`); the UI consumes
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
cancels and **kills the in-flight turn**, drops its queued messages, rejects its pending approvals and
kills its terminals. A phone backgrounding a tab drops its socket in seconds; because the BFF owns the
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
drain. Both must stay inside the prod deploy manager's 900 s `compose up` timeout. Without the drain the cancel
cannot reach llama.cpp; the signature is an error push five minutes after a BFF restart
(`BUSY_RUN_WAIT_TIMEOUT_MS`): docs/upstream-notes.md#bff-redeploy-drain.

The same permanent connection is also what boots the cron scheduler and Telegram adapters: app-server
process services start on *first client attach* (`listener/lifecycle.ts` →
`startConnectedListenerRuntime`), so with no client ever connected, crons never fire.

**`web/dist` is baked into the bff image, never mounted** — the image builds the SPA in its
`web-build` stage and copies it in. So `docker compose up -d` alone serves a months-old UI and a
local `bun run build` changes nothing the container sees: step 7 builds the image and `bun run
deploy-check` compares the served `assets/index-*.js` with the local one.

### All durable state lives under one host root

`LETTA_STATE_DIR` (`docker/compose.yml`) anchors every bind mount:

```
$LETTA_STATE_DIR/
  letta-home/     -> /root/.letta   settings.json, mcp-home/ (shared MCP list), global skills
  letta-data/     -> /data          conversations + agent memory (memfs git repos)
  workspaces/     -> /work          agent working directories
```

It defaults to `../..` relative to the compose file, which is **a trap in a worktree** — `../..` from
`.worktrees/<feature>/docker/` resolves to `.worktrees`. Prod sets an absolute path in `docker/.env`
(hard rule 3), and container work always happens from the main checkout.

Three named volumes remain, none precious: `bff-data` (web-push endpoints, rebuilt by re-subscribing)
and `google-policy` / `google-creds` (Settings → Google, named so the app-server cannot mount them by
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

Two tokens are **virtual**: `codex` and `claude` are declared by no service, start no container, and
instead decide what the app-server *image* contains. Every token is matched as an exact
comma-delimited entry (`bff/src/config.ts` `hasProfile`: `searchy` ≠ `search`), and the BFF derives
`config.features` = `web`⇐`search`, `google`⇐`google`, `codex`⇐`codex`, `claude`⇐`claude`.

- **effective-enabled = token AND stored Settings switch**, enforced at each availability decision: web
  tools render disabled (`renderAllMods`), Google reapply/status/sidecar-config run on the gated
  settings, and the codex/claude connect-time reapply writes `enabled: false` into `lettuce.json` so
  the shims refuse (the stored endpoint/model/key survive, so re-enabling is one switch flip). The four
  Settings save routes answer 404 while their token is off, and `web/` hides the matching sections,
  Tasks run lists and Tools tab rows from `features` in `/api/status` (absent = all on).
- The coding tokens and the image marker (`CODING_FEATURES`, `/opt/lettuce/features`,
  `coding_installed`) are the `lettuce-coding-workers` skill: toggling one needs an app-server rebuild,
  because the image tag does not change with the token list. A Compose warning about unknown profiles is
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
| `bff/src/google/`, `docker/google-mcp/`, OAuth scopes, Settings → Google | `lettuce-google-integration` |
| `bff/src/agents/tool-access.ts`, the policy mod, the Tools tab, `bff/src/pi/agent-settings.ts` | `lettuce-per-agent-tool-access` |
| `web/src/lib/messages.ts`, question/approval cards, `turn-errors.ts`, `turn-usage.ts`, `push/turn-watcher.ts` | `lettuce-transcript-and-streaming` |
| LLM timeout env, agent app ports, failing subagent spawns | `lettuce-runtime-and-ops` |
| Memory tab, `persona.md`, "the system prompt did not update" | `lettuce-memory-and-system-prompt` |
| `AgentMenu`, the sidebar agent list, pin/archive lists, Settings vs Agent tab layout | `lettuce-ui-conventions` |
| Any `web/` UI change: mockups before implementing, visual pass after | `lettuce-ui-verification` |
| PRs, `.github/workflows/`, `bump:*` labels, branch protection, CI tiers | `lettuce-pr-and-ci` |
| `bun run sync-upstream`, `LETTA_CODE_VERSION` | `lettuce-upstream-sync` |
| `VERSION`, `CHANGELOG.md`, tagging, `bun run release` | `lettuce-releasing` |

## Facts that are easy to get wrong

Cross-cutting protocol and product facts that apply to almost every task. Anything area-specific
lives in a skill — the table above says which.

- **Browsers cannot reach the app-server directly.** Auth is `Authorization: Bearer` only —
  unsettable on a browser WebSocket — and unauthenticated upgrades carrying `Origin` are rejected
  outright; the BFF is mandatory.
- **No per-user isolation, and `ALLOWED_USERS` therefore stays a list.** One process-wide runtime;
  every socket sees every event; v1 is single-user by decision, so keep agent-id filtering in the BFF
  frame router. `ALLOWED_USERS` is env-only, required exactly when Access is the live gate
  (`mode === "cloudflared" && !devBypassEmail`); in local mode an unset list makes `DEV_BYPASS_EMAIL`
  its own entry, and an explicit list still wins. In cloudflared mode it is the defense left standing
  when the Access policy is misconfigured, so never collapse it to one address.
  Story: docs/upstream-notes.md#allowlist-env-only-story.
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

Worktrees per branch, then a **PR into `main`, squash-merged** (one commit per PR, no merge commits).
Nothing lands on `main` except through a merged PR — a release included. **An agent merges only after
the operator confirms that specific PR.** Mechanics, labels, protection and CI tiers:
**`lettuce-pr-and-ci`**.

**The main checkout stays on `main` with a clean tree — only merge bookkeeping happens there.** All
feature work happens in a worktree under `.worktrees/` (git- and docker-ignored). Branching in the
main checkout lets two sessions collide and breaks `deploy-check`'s clean-tree and on-`main`
assertions; `bun run check-worktree` (a `verify` stage) refuses it.
Story: docs/upstream-notes.md#main-checkout-collision-story-2026-09-29.

**Every change touching `bff/`, `web/` or `docker/` is a PR** — a new capability, a new sidecar, or
anything spanning more than one of them. The PR body (`.github/pull_request_template.md`) is the gate
list; the operator's own container test *is* the gate — nothing replaces it.

**A docs-only change touches none of `bff/`, `web/`, `docker/`: a PR of its own, nothing to rebuild,
nothing to deploy.** That is `AGENTS.md`, `docs/`, `README.md`, `CHANGELOG.md`, `.agents/skills/`,
`.pi/`, `scripts/` — none of it reaches an image, so it rides the next release's tag. Gate:
`bun run check-docs`, plus lint and tests when a script changed. `docker/agent-skills/` is not
docs-only — it ships in the app-server image.

**Never split a plan from the code it plans: a plan doc rides its work's branch and PR, not
its own PR.**

### Versioning, tags, changelog — summary

Releases are annotated tags on `main` shaped `v<MAJOR>.<MINOR>.<PATCH>-letta_<LETTA_CODE_VERSION>`, cut
as part of the release, immediately after the release PR merges. MINOR is new or changed user-facing functionality; PATCH is
everything else that ships. `VERSION` is the only machine-readable record and is bumped in the commit
that gets tagged. A user-visible change carries its `CHANGELOG.md` `[Unreleased]` entry — plus any
`README.md` / `docs/CONFIGURATION.md` update — in the same commit. `bun run release --auto --pr` opens
the release PR; `bun run release --deploy` ships and tags it. Format rules, the changelog voice, the
bump labels and the docs-sync duty: **`lettuce-releasing`**.

## Upstream sync

`bun run sync-upstream v<version>` moves the upstream checkout to a **published release tag** (never
`main` — nothing to pin), reports protocol and behavioural drift, re-pins every version site and
typechecks. Behavioural drift is what bites; the file list, version literal sites, stale-pin trap and
full-redeploy rule are in **`lettuce-upstream-sync`** — read it before running the command.

## Definition of done

The ordered shape of a change **and** the checklist each step has to satisfy. Work is not done until
every step passes. Typecheck is not done. Tests are not done. **Running in the container is done.**
Origin story: docs/upstream-notes.md#definition-of-done-origin-story. A **docs-only** change stops
after step 2.

1. **Worktree.** `git worktree add .worktrees/<name> -b <branch>` from the main checkout — never branch
   in the main checkout. Already sitting in someone else's worktree? Use it; the gate only cares that
   you are not in the main checkout.
2. **Implement, commit, `bun run verify` green** — the offline half (worktree, version pins,
   prod-info, release hygiene, docs, lint, typecheck, tests, build), failing fast. The `CHANGELOG.md`
   `[Unreleased]` entry, any `README.md` / `docs/CONFIGURATION.md` update and the `bump:*` label go in
   the same commit; the **release commit** itself comes from `bun run release --pr`, never a feature
   branch.
3. **Build, deploy and run it locally from the worktree.** Copy the gitignored env in first
   (`cp ../../docker/.env docker/.env`) or the state-dir default lands inside `.worktrees/`, then
   `bun run build:bff && docker compose -f docker/compose.yml up -d` (unscoped — hard rule 4). The
   stack is **one per machine, shared by every worktree**, so your `up -d` replaces whatever another
   session was testing — say so.
4. **Human verification — stop.** Say what to click and what should happen, then wait for the
   operator to run it in the container and say it works. Nothing replaces this gate: no machine check,
   no unit test, no CI job. **Untested code does not leave the machine** — a failed test goes back to
   step 2 and no PR is opened.
5. **Open the PR.** `git push -u origin <branch>`, then `gh pr create` with
   `.github/pull_request_template.md` filled in — including who ran the container test and what they
   answered, since that is now a precondition of the PR, not a review checkbox. CI re-runs the offline
   gates independently; a branch cut before `.github/workflows/` existed reports no checks until you
   merge `main` in.
6. **Merge is the human's** (squash). An agent merges only after the operator confirms that specific
   PR; a general "continue" is not that authorization.
7. **Prove the artifact that ships from `main`.** Rebuild the image
   (`docker compose -f docker/compose.yml build bff && … up -d bff`) and get `bun run deploy-check`
   green: clean tree on `main`, served bundle byte-identical to `web/dist`, `VERSION` agreeing with the
   tag at `HEAD`, `/readyz` and the upstream connection healthy. Then `bun run ui-check` for any `web/`
   change and `bun run smoke` for BFF session/protocol/settings changes — both need the live stack, and
   `smoke` mutates real state and needs an agent to exist. Then `bun run cleanup`.
8. **Release — only after asking.** `bun run release --auto --pr` opens the release PR, the human
   merges it, `bun run release --deploy` runs deploy-check → the one confirmation → tag → push tag,
   immediately after that merge; the prod redeploy from `origin/main` is the operator's own. Never
   push `main` or tag without the confirmation in "Stop before releasing to prod".

**UI changes carry two extra gates.** *Before* implementing (during steps 1–2): mock the target state
of every changed surface at phone (390px) and desktop width and get the mockups approved — a static
page linking `web/src/styles.css`, screenshotted with Playwright, is the proven method. *After*
(before step 4): `bun run ui-check`'s screenshots plus a live look at both widths, reviewed
holistically — task accomplishable, reads like its neighbours, nothing clipped or overflowing, no
stray scrollbars; not pixel accuracy. Mechanics: `lettuce-ui-verification`.

### Stop before releasing to prod

**Never `git push` and never redeploy prod without asking, every time.** After step 7, halt and ask for
explicit confirmation of the whole release. Standing approval does not carry over: a yes on one change
is not a yes on the next, and "go ahead" before the preflight was shown is not a yes. Pushing is the
one step that leaves this machine, and `origin` (`dmarchevsky/lettuce`, private) is the only copy of
this project not on one laptop. `docker/.env` and `docker/secrets/` are gitignored and no secret values
are in history — re-check that before pushing a configuration change.

**Prod deploys from `origin`, not from this machine.** The prod deploy manager (its address and token
live in the operator's own config, never a tracked file) builds from `dmarchevsky/lettuce` `main` at
deploy time, so the push must land first. It is the operator's own tooling: this repo keeps no
commands, ids or addresses for it.

**`bun run release --deploy` cuts the release as part of the release, immediately after the release
PR merged**: deploy-check → the exact-tag confirmation → push `main` (one-shot mode) → tag → push
the tag.

The release question **names the target exactly** — environment `letta`, stack `letta-code-ui-prod`
(compose `docker/compose.yml`, containers `letta-code-ui-prod-app-server-1`, `-bff-1`,
`-channel-gateway-1`, `-cloudflared-1`) — read live from the operator's tooling, never from memory,
and states the commit range (`plan`: deployed commit → `origin/main`), whether `docker/compose.yml`
changed, **which containers get recreated**, and the last deploy's duration. If the live target does
not match this list, stop and ask rather than deploying.

Call out an `app-server` recreate: the prod deploy runs an unscoped `compose up`, so any image or compose
change recreates it and kills every in-flight turn with no drain (the drain covers only `bff`), and a
cron or Telegram turn does not show in the BFF log. **No prod hostnames, IP addresses or deploy-manager
ids are kept in this repo** — `bun run check-prod-info` enforces it (private IPv4 ranges and personal
mail domains fail it; use RFC 5737's `192.0.2.0/24` in examples and tests).

Order, once confirmed: `bun run release --deploy` pushes `main` and the tag (the tag points at the
release commit the moment the release PR merged) → the operator redeploys prod from `origin/main` and
verifies: the BFF log must show `Upstream connected: letta-code <pinned version>` (prod's image is
built where there is no git metadata, so its `/versionz` says `+unknown` and the commit is the deploy
manager's own record). A version other than the pin means the stored stack variables override it. On
any failure, stop and report — no retry, no rollback, no restart without the user choosing it.

Only `bff` is rebuilt in step 7 — the only service carrying our code. Recreate `app-server` or
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
| `bun run check-prod-info` | Fails if a tracked file holds a private IPv4 address or a personal mail domain |
| `bun run check-worktree` | Feature work is not happening in the main checkout |
| `bun run deploy-check` | The running container serves the merged code, and is healthy |
| `bun run ui-check` | Layout/interaction assertions in a real browser; screenshots to `.ui-check/` |
| `bun run smoke` | Live acceptance suite against a running stack — mutates state |
| `bun run build:bff` | Rebuild the bff image (it bakes `web/dist`) — **required** to ship UI changes |
| `bun run cleanup` | Report merged worktrees/branches; `--apply` removes ones merged, clean, unoccupied |
| `bun run sync-upstream v<x.y.z>` | Move the upstream checkout to a release, report drift, re-pin |
| `bun run release --minor\|--patch\|--auto` | Release commit on `main` via `--pr`, then gated push and tag via `--deploy` |
| `bun run migrate-state` | Older installs only: copy the old `letta-home`/`letta-data` named volumes onto the host |
| `docker compose -f docker/compose.yml up -d` | App-server + BFF; sidecars and `channel-gateway` only with their profiles |
| `git push origin main` | The release push — normally done by `bun run release --deploy`; **ask for confirmation first, every time** |

The obvious ones are not listed: `lint`, `format`, `typecheck`, `test`, `build`, `dev`, `build-info`,
`screenshots`. `check-docs` asserts every other `package.json` script appears here.

## Project harness

The repo carries its own agent-harness configuration, so the rules above are enforced and not only
prose. Gate messages cite this file **by section name, never by rule or step number**, so renumbering
cannot desync them.

- `.agents/skills/lettuce-*/SKILL.md` — task-scoped mechanics; pi lists names and descriptions and
  loads a body only when one is read.
- `.pi/extensions/guard.ts` — confirms or blocks what this file forbids; rules are pure functions in
  `scripts/guard-core.ts` (tests: `tests/guard-core.test.ts`). `git push` to `main` or a tag, a bare
  `git push`, `git tag -a`, `gh pr merge` / `pr review --approve` / `api …/merge` / `release create`,
  `--force` and `push -f`, `worktree remove` and `prune`, `branch -d` and `-D`,
  `docker compose rm|down|stop|kill|restart`, a scoped `up … app-server`, and any `edit`/`write` of
  `docker/.env`, `docker/secrets/` or `VERSION` (a shell redirect is not seen). With no UI a confirmable
  action is blocked, never silently allowed. It guards what an agent types, not what a script does
  internally — which is why `release.ts` carries its own typed confirmation.
- `.pi/prompts/*.md` — `/verify`, `/finish`, `/release`, `/sync-upstream` runbooks.
- The gate that owns each rule: `check-worktree` (worktrees), `check-release-hygiene` (changelog entry
  and bump label), `check-version-pin` (pins), `check-prod-info` (prod details out of the tree),
  `check-docs` (this file and the skills), `deploy-check` (the container serves `main`).
- `.pi/remote-pi/`, `.pi/npm/`, `.pi/sessions/`, `.pi/goals/`, `.pi/skills/`, `.pi/plans/`,
  `.pi/settings.json` and `.pendant/` are per-machine and gitignored.
