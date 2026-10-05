---
name: lettuce-pr-and-ci
description: 'lettuce PR and CI mechanics: worktree → PR → squash merge instead of a local fast-forward, which branch protections are on and which are deliberately not yet, the bump:minor / bump:patch / bump:none labels and how a missing one is derived, the Tier A job list in .github/workflows/ci.yml, the advisory Tier B live stack in .github/workflows/live.yml, and why no job gets a secret, why a PR branch only runs checks if it contains the workflow file, why `git push` inside a `&&` chain kills the whole command, why feature branches get `main` merged into them instead of rebased, and the rule that an agent merges only after the operator confirms that specific PR. Read before opening, reviewing, updating or merging a PR, or before touching `.github/workflows/` or the guard rules around merges.'
---

# PR flow and CI

Loaded from `AGENTS.md`. The short version: work happens in a worktree, lands on `main` through a
squash-merged PR, and prod moves only when a release says so. Landing is not shipping.

## The lifecycle

```
.worktrees/<branch>              the PR                          main
─────────────────              ────────                        ────
branch + worktree  ──push──▶  PR opens (template filled)
verify green                   │
build + run locally            ├─ CI Tier A (`.github/workflows/ci.yml`)
user tests it in the browser   ├─ human review = the container test
                               └─ squash merge ────────────────────▶ main
release PR (`bun run release --pr`) → merge → `bun run release --deploy` → tag
```

1. **Branch and worktree** as usual (`git worktree add .worktrees/<name> -b <branch>` from the main
   checkout). Never branch in the main checkout.
2. **Commit, then `git push -u origin <branch>`** — a feature-branch push is routine and the guard
   does not gate it. Push and commit must be **separate commands**: the guard blocks an entire
   compound command line that contains `git push`, so `git add … && git commit … && git push` runs
   *none* of it and the commit silently never happened.
3. **Open the PR** with `gh pr create` and fill in `.github/pull_request_template.md` — the
   "how I tested it in the container" section is the part a reviewer refuses if it is empty.
   Note `gh` bodies are scanned by the guard too: a body that *quotes* `git branch -D` gets the
   `gh pr create` call blocked, so pass long bodies with `--body-file`.
4. **CI green**, then the human tests it and approves. **An agent merges only after the operator
   confirms that specific PR** — "continue" or a standing approval is not that confirmation. The
   guard asks for confirmation on `gh pr merge` and `gh pr review --approve` to make that hard to
   get wrong; a reviewer's `Approved` review is their decision, not permission to click merge.
5. **Merge = squash** (`gh pr merge <n> --squash`), which is what keeps history linear with one
   commit per PR — squash discards the branch's own history, so nothing is lost by the merge shape
   below. Report the worktree as merged and safe to remove; never remove it yourself.
6. **Updating a PR branch with `main`:** merge `main` in (`git merge main` in the worktree), do not
   rebase and force-push — `--force` is blocked outright and `gh pr update-branch` does nothing on
   the `gh` version installed here. A merge commit on a PR branch is harmless because the merge to
   `main` squashes it away.

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
| `image` | builds `docker/bff.Dockerfile` with a layer cache, pushes nothing, and asserts the image can name its commit |
| `actionlint` | the workflows themselves, from the pinned image |
| `secrets-scan` | gitleaks, `continue-on-error` until it has been quiet on this history |

Hard rules about the file itself:

- **No job gets a secret.** Fork `pull_request` runs get a read-only token and none of the repo's
  secrets, so the tier has to stay runnable under that. Anything needing a credential
  (`smoke`, anything Dockhand, anything Google) is not in here.
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
  as occupied, not empty). This is the case rule 8 was written for — another session sitting in the
  worktree — and nothing about the PR being merged tells you.

There is no `--force`. A refusal is an instruction to go look. `--remote` additionally deletes the
merged branches on `origin` for branches that were created before auto-delete existed, and
`--skip-session-check` exists for a platform that cannot report live sessions; both are stated in
the output, never assumed.

Abandoned branches — the kind a merge never triggers on — are not the script's business. The weekly
`stale-report` workflow lists branches with no open PR and lets a human decide; it never deletes.

The guard follows the same shape: `git branch -D` is confirmable (it has to be, because squash
ancestry means `-d` can never succeed), every `--force` variant and worktree pruning stay hard
blocks, and `bun run cleanup` — like `release.ts` — carries its own confirmation because the guard
only sees what an agent types.
