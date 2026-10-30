---
name: lettuce-pr-and-ci
description: 'lettuce PR and CI mechanics: worktree → local container test → PR → merge commit (the human test happens before the branch is pushed), which branch protections are on and which are deliberately not yet, the bump:minor / bump:patch / bump:none labels and how a missing one is derived, the Tier A job list in .github/workflows/ci.yml, the advisory Tier B live stack in .github/workflows/live.yml, the publish workflow that pushes the images a prod deploy pulls (.github/workflows/publish.yml), the gates that stay local because CI has no stack and no secret, and why no job gets a secret, why a PR branch only runs checks if it contains the workflow file, why `git push` inside a `&&` chain kills the whole command, why feature branches get `main` merged into them instead of rebased, and that the operator's Release? is what authorizes the agent to merge. Read before opening, reviewing, updating or merging a PR, or before touching `.github/workflows/` or the `flow-guard` rules around merges.'
---

# PR flow and CI

Loaded from `AGENTS.md`. The short version: work happens in a worktree driven by dev-flow, the operator
tests it there, and only then does it become a PR that lands on `main` as a merge commit. Landing is not
shipping.

## The lifecycle

```
.dev-flow/<slug>/worktree                 main
─────────────────────────                ────
flow approve (plan) → the worktree and branch
flow check green
build + run locally
user tests it in the browser  ←── the gate, and it happens here, before any push
  │  pre-release: ponytail-review, then VERSION bump + changelog rename in one commit
  └──push──▶  PR opens (template filled, test already recorded)
              ├─ CI Tier A (`.github/workflows/ci.yml`)
              ├─ ci green → the agent merges it (--merge) ──▶ main
              └─ tag main's tip, push it by name ──▶ flow release-done → flow finish
```

The order is the point: **untested code never leaves the machine.** The PR is the record of a change
the operator already verified, so Tier A is an independent re-check of something already proven, not
the verifier. A red CI check after the human gate means environment drift — or the branch-only-
workflow-file trap below.

1. **The worktree and the branch are dev-flow's, not yours.** `flow approve` creates both from
   `.dev-flow/project.md` (`branchPattern`, `worktreeDir`), and an unbound session cannot edit source at
   all — there is no hand-made worktree and no bypass. Never branch in the main checkout.
2. **Commit on the branch.** Commit and push are separate commands — the guard blocks a compound line
   containing `git push`, so `git add … && git commit … && git push` runs *none* of it and the commit
   silently never happened.
3. **Build and run it locally, then stop for the container test.** Say what to click and what should
   happen and wait. Nothing replaces it: no type check, no unit test, no CI job. A failed test goes
   back to `bun run verify` and no PR is opened.
4. **Then push (`git push -u origin <branch>`) and open the PR** with `gh pr create`, filling in
   `.github/pull_request_template.md` — its container-test section records who ran it and what they
   answered, which is a precondition of the PR rather than a review checkbox. Note `gh` bodies are
   scanned by the guard too: a body that *quotes* `docker compose stop` still trips the compose rule,
   so pass long bodies with `--body-file`.
5. **CI green, then merge it yourself.** **Release? is the authorization** — the operator does not merge
   by hand: once `ci` is green on the PR the agent runs `gh pr merge <n> --merge`. A standing
   "continue" is not an authorization, and neither is a reviewer's `Approved` review — that says they
   ran it, not that they own the merge.
6. **Merge = merge commit** (`--merge`, the repo's only enabled method). The branch's own commits are
   what reach `main`, so a landed branch really is an ancestor of `main` and `git branch -d` can delete
   it — no PR API needed to know what merged. Report the worktree as merged and let `flow finish`
   remove it; never remove it yourself.
7. **Updating a PR branch with `main`:** merge `main` in (`git merge main` in the worktree), do not
   rebase and force-push — `--force` is blocked outright and `gh pr update-branch` does nothing on
   the `gh` version installed here. Merge commits are how a PR lands anyway, so one more on the branch
   costs nothing.

## What CI cannot do, so the machine still does

Tier A is everything that needs no running stack and no secret; Tier B (`live.yml`) boots the shipped
compose file on a runner. Everything else stays local by construction: **the operator's container
test** (step 3 above), `bun run deploy-check` (it asserts against the running prod-shaped stack and
needs `origin` reachable), the real `bun run ui-check` (needs agents, which a fresh CI stack has not
got), `bun run smoke` (mutates live state), and anything deploy-manager, Google or `smoke`-shaped that
would need a credential. `check-worktree` is a `verify` stage but exits 0 under `CI=true` — the rule
protects a dev box, not a runner.

## Why a PR reports no checks

GitHub runs `pull_request` workflows from the **PR head branch**, not from `main`. A branch cut
before `.github/workflows/` existed reports *no* checks and looks green while being unverified —
merge `main` in (step 7) and the jobs appear. Check the checks list, not the absence of red.

## Tier A (`ci.yml`) — what runs and why

One job per signal, then an aggregate `ci` job which is the check branch protection points at (an
aggregate is what keeps a PR from waiting forever on a job a path filter skipped).

| Job | What it is |
|---|---|
| `lint-and-types`, `test`, `build` | `biome`, typecheck (the protocol-drift detector), `bun test`, the SPA build |
| `hygiene` | `check-version-pin`, `check-docs`, `check-prod-info`, and `check-release-hygiene --pr` fed with the PR's labels and title |
| `compose-config` | `docker compose config` bare and with every profile token |
| `image` | builds `docker/bff.Dockerfile` twice with a layer cache and pushes nothing: once stamped (asserts the image names this commit) and once from an export with **no `.git`** (asserts it succeeds and stamps `+unknown`); then builds `google-mcp` through compose, whose Dockerfile runs the recipient-guard tests against the pinned workspace-mcp |
| `actionlint` | the workflows themselves, from the pinned image |
| `secrets-scan` | gitleaks, **required** since 2026-10-24 (it was `continue-on-error` while a live `SESSION_SECRET` rode a green `ci`); the committed test fake is allowlisted in `.gitleaks.toml` |

Hard rules about the file itself:

- **No job gets a secret.** Fork `pull_request` runs get a read-only token and none of the repo's
  secrets, so the tier has to stay runnable under that. Anything needing a credential
  (`smoke`, anything deploy-manager, anything Google) is not in here.
- **CI still builds the image the way a *fallback* deploy would, and that builder is not a checkout.**
  Prod pulls the published images, but every service keeps its `build:` section for a host that must
  build (a failed publish run, a namespace left unset), and such a builder is the deploy manager's copy
  of the tree, which carries no `.git` — a `COPY .git/` in the Dockerfile aborted a whole prod deploy
  that way (2026-10-05, docs/upstream-notes.md#prod-builds-without-git). So the `image` job also
  exports the tree with `git archive`, builds it with `GIT_SHA=` and asserts `BUILD_INFO` names no
  commit. Any Dockerfile change that makes the image depend on git metadata has to pass that shape
  too, and a deployment whose image cannot name its commit is checked with
  `bun run deploy-check <origin> --allow-unstamped`.
- **`.gitleaks.toml` must keep its `[extend] useDefault = true`.** A config file with no
  `[[rules]]` and no extend stanza *replaces* gitleaks' built-in rules, so the required
  `secrets-scan` job finds nothing and reports green forever — measured, not theorised (planted
  secrets pass it; the same allowlist with `[extend]` finds them), and the job greps for the stanza
  before scanning, so removing it fails the check instead of quieting it. Allowlist new test fakes
  line-wise on the fake's value, never by path: allowlist `paths` and `regexes` are a union, so a
  path entry blinds the scan to a real secret in that file. Reproduce the job locally with
  `docker run --rm -v "$PWD:/repo" -w /repo zricethezav/gitleaks:latest detect --redact --no-banner`
  (exit 1 with the findings listed when it sees one).
- **Actions are pinned to commit SHAs** with the tag in a trailing comment. Get the SHA with
  `gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq .object.sha`.
- Validate the file locally before pushing:
  `docker run --rm -v "$PWD:/work:ro" -w /work rhysd/actionlint:1.7.7 -color`.
- `bun install --frozen-lockfile --ignore-scripts` mirrors the image: letta-code's native
  postinstall builds need a toolchain neither the runner nor the runtime image carries.

## Tier B (`live.yml`) — advisory until it has measured itself

The live tier runs the shipped compose file on a runner: writes a gitignored `docker/.env` (state in
the runner temp, local mode, **no compose profiles**, so no sidecars and no Codex/Claude CLIs in the
image), `build`, `up -d`, waits on `/readyz` — which only answers once the upstream WebSocket is
connected, so that wait stands in for `deploy-check`'s health assertion — then tears the stack down.
It runs on PRs, on `main`, and nightly. Measured cold cost of the whole thing: deps 3 s, Chromium
37 s, both images built 66 s, up 6 s, readyz in seconds.

**`ui-check` is behind `env.UI_CHECK: "off"` in that file, and that is a gap, not a decision to
keep.** A CI stack boots with an empty state dir, so it has no agent, and the UI is about agents —
the first real run passed 40-some layout assertions and then timed out waiting for
`.switcher-agents .switcher-card-title`. Seeding needs either an app-server-side fixture (the BFF
has no create-agent route; creation is `create_agent` over the WebSocket CI does not speak) or a
ui-check that asserts on the empty state. Until one exists, Tier B verifies **compose boot and the
upstream connection**, nothing more, and says so in the run.

Three CI-env facts that cost a run each, learned the hard way: `SESSION_SECRET` must be ≥32
characters or the BFF refuses to start; **there are two binds** — `BFF_BIND` is the host side of the
published port, while the BFF binds `0.0.0.0` inside the container whenever a `LETTA_HOST_BIND` is
declared — a loopback bind there makes the published port unreachable, and looks exactly like the
server being down (that is what `DEV_BYPASS_ALLOW_REMOTE` used to be for); and the container listens on 8080 while
the runner reaches it on `BFF_PORT`.

It is **deliberately not in the required `ci` aggregate**, and it carries no `continue-on-error`: a red
`live` check is loud and honest, it just does not block the merge. Whether it becomes a gate for
`web/**` PRs now hinges on the seed gap above, not on cost. `smoke` is in neither tier: it mutates
live state and needs an agent to exist.

## Publish (`publish.yml`) — what a release leaves behind

A prod deploy pulls images instead of building them, so publishing is part of shipping. On a `v*` tag
push the workflow builds **all five images this repo builds** (`app-server bff searxng ddg-mcp
google-mcp`) and pushes them under the release tag and `latest`; a merge to `main` publishes `latest`
alone, which is what `LETTA_IMAGE_TAG=latest` runs without a release.

- **The build *is* the compose file:** one `docker compose build --push` over the five services, so
  contexts, build args and image names cannot drift from what a host reads, with `LETTA_IMAGE_TAG`
  deciding the tag. It builds with `COMPOSE_PROFILES=codex,claude` so the published app-server always
  carries both coding CLIs (a coding token in prod is then a Settings flip, not a rebuild), and with
  `GIT_SHA=$GITHUB_SHA` so Settings → About names a commit a deploy-manager build could not.
- **No secret, and no pull credential either.** Push uses the job's own `GITHUB_TOKEN` with
  `packages: write`; the repo is public, so its GHCR packages are public and a host pulls without a
  login. That is what keeps publishing inside the no-secrets rule. But compose still *parses* the whole
  file before it builds, and the bff declares `SESSION_SECRET` with `:?`, so the build step passes a
  throwaway value — `docker/.env` is gitignored and does not exist on a runner, and without it compose
  refuses to even start the build (`error while interpolating services.bff.environment.SESSION_SECRET`).
  A service's `environment` is runtime, so nothing fake is baked into an image.
- **A tag push must match `VERSION`,** or the run refuses: images under a tag no checkout names are
  how a host ends up running bytes nobody can point at. `check-release-hygiene` holds compose's
  `LETTA_IMAGE_TAG` default to `VERSION` for the same reason from the other side.
- **`latest` is retagged server-side** (`docker buildx imagetools create`), never rebuilt, so it is
  byte-identical to the release it just pointed at, and `cancel-in-progress: false` because a
  half-published set of five is a deploy that pulls four. The run's last step inspects every image
  back out of the registry — that is the receipt, and it fails the run if one is missing.
- **`workflow_dispatch` with a tag input proves the workflow only after it ships**, and **not before**:
  GitHub lets a workflow be dispatched once its file exists on the default branch, so a brand-new
  `publish.yml` sitting on a feature branch is not dispatchable at all — `gh workflow run publish.yml`
  answers 404 and the workflow is not even in `gh api …/actions/workflows`. **The first real run is the
  merge to `main`**, whose push publishes `latest`; prove it with an unauthenticated pull —
  `DOCKER_CONFIG=$(mktemp -d) docker buildx imagetools inspect ghcr.io/<owner>/lettuce-bff:latest` —
  before cutting the tag. After that, dispatch is how you republish.
- **`docker compose build --push` over several services exits 0 even when every push
  fails** — reproduced on Compose v5.5.1: it prints `target p: failed to solve: failed to
  push docker.io/library/probe-a:t1: push access denied` for each target and still returns
  0. That is why the step asserts the resolved names *before* building and the last step
  inspects the pushed tags *after*; neither is decoration. The first real run proved the
  point — `LETTA_IMAGE_NS` was not passed, so compose built local `lettuce-*:latest` names,
  the build step came back green, and only the receipts step noticed the registry was empty.
  (`docker compose config --images <service>` also prints its dependencies' images, so
  compare the whole set, not one service at a time.)
- **`linux/amd64` only** — that is the runner and prod. The upstream images are multi-arch, so an
  arm64 host would need a real multi-platform build, which this is not. No build cache either: `docker
  compose build` exposes no `--cache-from`/`--cache-to`, and public repos are not short of minutes.

## Labels and the bump

`bump:minor`, `bump:patch`, `bump:none` declare what a merged PR means for the next release;
`check-release-hygiene.ts` fails a PR that touches `bff/`, `web/` or `docker/` without a
`CHANGELOG.md` `[Unreleased]` entry and without `bump:none`. Test files and `fixtures/` do not count
as user-visible — the deliberate cost of that rule: a change to tests or fixtures alone never earns a
changelog line, even one a user would notice, and it is what lets a test-only fork PR go green, whose
author can write the changelog but cannot set `bump:none`. The job warns when a label contradicts
the changelog section it adds. With no label it derives from the PR title (`feat` → minor,
`docs` → none, else patch), which is why the PR title must be a Conventional Commit. Which
heading a patch entry belongs under is a `pre-release` rule in `.dev-flow/project.md`. `VERSION`
itself is never touched on a feature branch — see the `lettuce-releasing` skill.

## Branch protection: what is on

`main` is protected. Read it live rather than trusting this file —
`gh api repos/dmarchevsky/lettuce/branches/main/protection -q '{approvals:
.required_pull_request_reviews.required_approving_review_count, checks:
.required_status_checks.contexts, strict: .required_status_checks.strict, force:
.allow_force_pushes.enabled, admins: .enforce_admins.enabled}'` — but as it stands:

- **A PR is required**, and `ci` must be green on a branch current with `main` (`strict: true`, and
  with no force-push, "current" means merging `main` into the branch).
- **Zero approving reviews, deliberately.** One human account and the agent's token are the same
  identity, and GitHub refuses self-approval flat out — *"Can not approve your own pull request"* —
  so a review requirement turned every merge into an admin bypass, which hides who decided. The gate
  is now `ci` **plus the operator's Release? for that release** — the guard deliberately no longer
  intercepts `gh pr merge`, because the operator wants the release merged by the flow, so the human word
  at the release gate is the one thing standing between a branch and `main`. A review is still welcome
  and still counts; it is just not the gate.
- **Conversation resolution is required**, and **a merge commit is the repo's only enabled merge
  method** (`allow_squash_merge` and `allow_rebase_merge` are off in the repo settings, not in the
  branch protection payload), so a PR's commits survive onto `main` and ancestry stays meaningful.
- Force-push and deleting `main` are forbidden outright. **`enforce_admins` is false**, so the owner
  keeps an emergency direct push; an agent reaches for `--admin` only when told to override something
  protection still requires, and says so in the same breath.
- Merging **auto-deletes the branch on `origin`** (`delete_branch_on_merge`), so a merged branch is
  gone from the remote without anyone sweeping. It is still recoverable for a while at
  `refs/pull/<N>/head` — `git fetch origin pull/<N>/head:<name>` — which is also why PRs are never
  tidied away: they are the record.

Because a PR is required, the tag is always cut *after* the merge: the version and its changelog section
ride the feature's own branch — see `lettuce-releasing`.

## After merge: `flow finish`

Bookkeeping is dev-flow's, not a script and not a habit. Once the PR is merged and
`flow release-done` has recorded the tag, `flow finish` closes the feature: it refuses a dirty main
checkout or a `HEAD` that is not on `origin/main`, blocks on uncommitted changes inside the worktree,
notes any commit that never reached `main`, then removes the worktree and the local branch and deletes
`origin/<branch>` only on proof it was released. With merge commits that proof is plain ancestry —
which is also why `git branch -d` works here: a merged branch is an ancestor of `main`.

Two things a per-feature close cannot see, both handled elsewhere:

- **Abandoned branches** — no PR ever, or a closed one — have no merge event to hang a rule on. The
  weekly `stale-report` workflow lists branches with no open PR and lets a human decide; it never
  deletes.
- **Orphans** — a worktree no unfinished feature owns, a `feat/*` branch nobody claims, or a feature
  whose worktree vanished — are what `flow init`'s doctor reports.

Finish only your own slug. `flow finish` checks dirt and unmerged commits — it does not look for a live
process sitting in that worktree, so closing a slug another session holds can delete committed-but-
unpushed work. `flow status` names the claim holder.

The guard is dev-flow's: the rules are the `flow-guard` block in `.dev-flow/project.md` `## global`,
judged **ahead of** dev-flow's own stage rules, at every stage. Read that block for what is denied and
what needs the operator — what belongs here is *how* it matches, because that decides whether a rule is
protecting you or only looks like it:

- A rule matches one **segment** of a command line (`&&`, `||`, `;`, `|`, newline) whose head verb is
  *doing* something. Read-only heads are skipped — `grep "git push --force" AGENTS.md` and
  `git log --grep=--force` are free, so writing about a forbidden command is not a violation.
- A quoted body is still shell text: `gh pr create --body "…docker compose stop…"` trips the compose
  rule, because `gh pr create` is a doing-verb. A body that quotes a command goes in a file written
  with the file tools and comes in with `--body-file`.
- Path rules (`protect docker/.env`, `forbid docker/secrets`) are matched on the `edit` and `write`
  tools only. A shell redirect (`echo … > docker/.env`) or `sed -i` is invisible to them, because
  parsing a path out of arbitrary shell is how you get a rule nobody trusts.
- A rule sees what an agent types, never what a script does internally — so `flow finish` removing a
  worktree and branch is not guarded; it is checked (dirty tree, commits that never reached `main`,
  verified-merged remote delete).
