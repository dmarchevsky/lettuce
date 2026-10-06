---
name: lettuce-pr-and-ci
description: 'lettuce PR and CI mechanics: worktree → local container test → PR → squash merge (the human test happens before the branch is pushed), which branch protections are on and which are deliberately not yet, the bump:minor / bump:patch / bump:none labels and how a missing one is derived, the Tier A job list in .github/workflows/ci.yml, the advisory Tier B live stack in .github/workflows/live.yml, the gates that stay local because CI has no stack and no secret, and why no job gets a secret, why a PR branch only runs checks if it contains the workflow file, why `git push` inside a `&&` chain kills the whole command, why feature branches get `main` merged into them instead of rebased, and the rule that an agent merges only after the operator confirms that specific PR. Read before opening, reviewing, updating or merging a PR, or before touching `.github/workflows/` or the guard rules around merges.'
---

# PR flow and CI

Loaded from `AGENTS.md`. The short version: work happens in a worktree, the operator tests it there,
and only then does it become a PR that squash-merges into `main`. Landing is not shipping.

## The lifecycle

```
.worktrees/<branch>                       main
─────────────────                        ────
branch + worktree
verify green
build + run locally
user tests it in the browser  ←── the gate, and it happens here, before any push
  │
  └──push──▶  PR opens (template filled, test already recorded)
              ├─ CI Tier A (`.github/workflows/ci.yml`)
              ├─ human review
              └─ squash merge ───────────────────────▶ main
release PR (`bun run release --pr`) → merge → `bun run release --deploy` → tag
```

The order is the point: **untested code never leaves the machine.** The PR is the record of a change
the operator already verified, so Tier A is an independent re-check of something already proven, not
the verifier. A red CI check after the human gate means environment drift — or the branch-only-
workflow-file trap below.

1. **Branch and worktree** as usual (`git worktree add .worktrees/<name> -b <branch>` from the main
   checkout). Never branch in the main checkout.
2. **Commit on the branch.** Commit and push are separate commands — the guard blocks a compound line
   containing `git push`, so `git add … && git commit … && git push` runs *none* of it and the commit
   silently never happened.
3. **Build and run it locally, then stop for the container test.** Say what to click and what should
   happen and wait. Nothing replaces it: no type check, no unit test, no CI job. A failed test goes
   back to `bun run verify` and no PR is opened.
4. **Then push (`git push -u origin <branch>`) and open the PR** with `gh pr create`, filling in
   `.github/pull_request_template.md` — its container-test section records who ran it and what they
   answered, which is a precondition of the PR rather than a review checkbox. Note `gh` bodies are
   scanned by the guard too: a body that *quotes* `git branch -D` gets the `gh pr create` call
   blocked, so pass long bodies with `--body-file`.
5. **CI green**, then the human merges. **An agent merges only after the operator confirms that
   specific PR** — "continue" or a standing approval is not that confirmation. The guard asks for
   confirmation on `gh pr merge` and `gh pr review --approve` to make that hard to get wrong; a
   reviewer's `Approved` review is their decision, not permission to click merge.
6. **Merge = squash** (`gh pr merge <n> --squash`), which is what keeps history linear with one
   commit per PR — squash discards the branch's own history, so nothing is lost by the merge shape
   below. Report the worktree as merged and safe to remove; never remove it yourself.
7. **Updating a PR branch with `main`:** merge `main` in (`git merge main` in the worktree), do not
   rebase and force-push — `--force` is blocked outright and `gh pr update-branch` does nothing on
   the `gh` version installed here. A merge commit on a PR branch is harmless because the merge to
   `main` squashes it away.

## What CI cannot do, so the machine still does

Tier A is everything that needs no running stack and no secret; Tier B (`live.yml`) boots the shipped
compose file on a runner. Everything else stays local by construction: **the operator's container
test** (step 3 above), `bun run deploy-check` (it asserts against the running prod-shaped stack and
needs `origin` reachable), the real `bun run ui-check` (needs agents, which a fresh CI stack has not
got), `bun run smoke` (mutates live state), and anything Dockhand, Google or `smoke`-shaped that
would need a credential. `check-worktree` is a `verify` stage but exits 0 under `CI=true` — the rule
protects a dev box, not a runner.

## Why a PR reports no checks

GitHub runs `pull_request` workflows from the **PR head branch**, not from `main`. A branch cut
before `.github/workflows/` existed reports *no* checks and looks green while being unverified —
merge `main` in (step 6) and the jobs appear. Check the checks list, not the absence of red.

## Tier A (`ci.yml`) — what runs and why

One job per signal, then an aggregate `ci` job which is the check branch protection points at (an
aggregate is what keeps a PR from waiting forever on a job a path filter skipped).

| Job | What it is |
|---|---|
| `lint-and-types`, `test`, `build` | `biome`, typecheck (the protocol-drift detector), `bun test`, the SPA build |
| `hygiene` | `check-version-pin`, `check-docs`, `check-prod-info`, and `check-release-hygiene --pr` fed with the PR's labels and title |
| `compose-config` | `docker compose config` bare and with every profile token |
| `image` | builds `docker/bff.Dockerfile` twice with a layer cache and pushes nothing: once stamped (asserts the image names this commit) and once from an export with **no `.git`** (asserts it succeeds and stamps `+unknown`) |
| `actionlint` | the workflows themselves, from the pinned image |
| `secrets-scan` | gitleaks, `continue-on-error` until it has been quiet on this history |

Hard rules about the file itself:

- **No job gets a secret.** Fork `pull_request` runs get a read-only token and none of the repo's
  secrets, so the tier has to stay runnable under that. Anything needing a credential
  (`smoke`, anything Dockhand, anything Google) is not in here.
- **CI builds the image the way prod does, and prod's builder is not a checkout.** Dockhand
  copies the tree into its stack directory and builds there, and that copy carries no `.git`
  — a `COPY .git/` in the Dockerfile aborted a whole prod deploy that way (2026-10-05,
  docs/upstream-notes.md#dockhand-builds-without-git). So the `image` job also exports the tree
  with `git archive`, builds it with `GIT_SHA=` and asserts `BUILD_INFO` names no commit. Any
  Dockerfile change that makes the image depend on git metadata has to pass that shape too, and
  a deployment whose image cannot name its commit is checked with
  `bun run deploy-check <origin> --allow-unstamped`.
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
published port, while the BFF's own bind is pinned to loopback by dev bypass unless
`DEV_BYPASS_ALLOW_REMOTE=true`, and a loopback bind inside the namespace makes the published port
unreachable (it looks exactly like the server being down); and the container listens on 8080 while
the runner reaches it on `BFF_PORT`.

It is **deliberately not in the required `ci` aggregate**, and it carries no `continue-on-error`: a red
`live` check is loud and honest, it just does not block the merge. Whether it becomes a gate for
`web/**` PRs now hinges on the seed gap above, not on cost. `smoke` is in neither tier: it mutates
live state and needs an agent to exist.

## Labels and the bump

`bump:minor`, `bump:patch`, `bump:none` declare what a merged PR means for the next release;
`check-release-hygiene.ts` fails a PR that touches `bff/`, `web/` or `docker/` without a
`CHANGELOG.md` `[Unreleased]` entry and without `bump:none`, and warns when a label contradicts
the changelog section it adds (an `Added` section with `bump:patch` is a MINOR, not a PATCH). With
no label it derives from the squash subject (`feat` → minor, `docs` → none, else patch), which is
why the squash title must be a Conventional Commit. `VERSION` itself is never touched on a feature
branch — see the `lettuce-releasing` skill.

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
  is now `ci` **plus a human commanding the specific merge**: the guard confirms every `gh pr merge`,
  and the agent merges #N only when #N is named. A review is still welcome and still counts; it is
  just not the thing standing between a branch and `main`.
- **Conversation resolution is required**, and **squash is the repo's only merge method**, so history
  stays one commit per PR.
- Force-push and deleting `main` are forbidden outright. **`enforce_admins` is false**, so the owner
  keeps an emergency direct push; an agent reaches for `--admin` only when told to override something
  protection still requires, and says so in the same breath.
- Merging **auto-deletes the branch on `origin`** (`delete_branch_on_merge`), so a merged branch is
  gone from the remote without anyone sweeping. It is still recoverable for a while at
  `refs/pull/<N>/head` — `git fetch origin pull/<N>/head:<name>` — which is also why PRs are never
  tidied away: they are the record.

Because a PR is required, `bun run release --pr` is not optional for a release — see
`lettuce-releasing`.

## After merge: `bun run cleanup`

Worktree and local-branch bookkeeping is a script, not a habit: `scripts/cleanup-merged.ts` with
the decision rules in `scripts/cleanup-core.ts` (tests: `tests/cleanup-core.test.ts`). Default mode
only reports; `--apply` removes, and only after you type the exact phrase it printed, which is
derived from the counts so a plan that changed mid-run cannot be confirmed by the old phrase.

Why a script and not `git worktree remove` in a loop — three checks a human would otherwise have to
remember, each one a way to eat someone's work:

- **PR state decides, never git ancestry.** This repo squash-merges, so a merged branch is not an
  ancestor of `main` and `git branch --merged` is permanently meaningless here; `-d` always refuses
  and `-D` deletes anything, merged or not. The script asks the API.
- **A dirty tree is a refusal.** A follow-up fix made only in the worktree is exactly what a
  merge-triggered auto-delete would lose. Untracked files count as dirty.
- **A live process with its cwd inside is a refusal** (read from `/proc/*/cwd`; unknown is treated
  as occupied, not empty). This is the case the hand-removal rule exists for — another session sitting
  in the worktree — and nothing about the PR being merged tells you.

A branch some worktree holds is normally that worktree's decision and never touched separately —
unless that worktree is being removed in the same pass, in which case one run finishes the job
(worktrees go first). There is no `--force`. A refusal is an instruction to go look. `--remote` additionally deletes the
merged branches on `origin` for branches that were created before auto-delete existed, and
`--skip-session-check` exists for a platform that cannot report live sessions; both are stated in
the output, never assumed.

Abandoned branches — the kind a merge never triggers on — are not the script's business. The weekly
`stale-report` workflow lists branches with no open PR and lets a human decide; it never deletes.

The guard follows the same shape: `git branch -D` is confirmable (it has to be, because squash
ancestry means `-d` can never succeed), every `--force` variant, `git push -f` and worktree pruning
stay hard blocks, and `bun run cleanup` — like `release.ts` — carries its own confirmation because
the guard only sees what an agent types.

What it sees, exactly, is worth knowing before you rely on it (`scripts/guard-core.ts`, tests in
`tests/guard-core.test.ts`):

- A push is gated when the refspec is `main`, a tag (`refs/tags/…` or a refspec starting `v1.2.3`,
  which is what `bun run release` tags), or missing entirely. A branch named `release/v0.8.0-…` is
  free — only a refspec that *begins* with the version counts as the tag.
- Merging is gated on `gh pr merge`, and on `gh api …/merge` / `…/merges`, which is the same act with
  the gate walked around. `gh release create` is gated for the same reason as `git tag -a`.
- Protected files (`docker/.env`, `docker/secrets/`, `VERSION`) are matched on the `edit` and
  `write` tools only. A shell redirect (`echo … > VERSION`) or `sed -i` is invisible to it, because
  parsing a path out of arbitrary shell is how you get a rule nobody trusts.
- Every segment of a command line is scanned, including text an agent only *quoted* — an
  `--body-file` body, or a heredoc body writing docs about the guard. That is why quoting
  `git push --force` inside a `cat > file <<EOF` gets the whole call blocked. To write about a
  blocked command, write the file with the file tools: those are checked by path, not by content.
