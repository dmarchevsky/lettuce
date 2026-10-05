---
name: lettuce-pr-and-ci
description: 'lettuce PR and CI mechanics: worktree → PR → squash merge instead of a local fast-forward, which branch protections are on and which are deliberately not yet, the bump:minor / bump:patch / bump:none labels and how a missing one is derived, the Tier A job list in .github/workflows/ci.yml and why no job gets a secret, why a PR branch only runs checks if it contains the workflow file, why `git push` inside a `&&` chain kills the whole command, why feature branches get `main` merged into them instead of rebased, and the rule that an agent merges only after the operator confirms that specific PR. Read before opening, reviewing, updating or merging a PR, or before touching `.github/workflows/` or the guard rules around merges.'
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

The live tier — `deploy-check`, `ui-check`, `smoke` against a real compose stack — is **not** in
Tier A and has no home yet; it has never run outside a dev box.

## Labels and the bump

`bump:minor`, `bump:patch`, `bump:none` declare what a merged PR means for the next release;
`check-release-hygiene.ts` fails a PR that touches `bff/`, `web/` or `docker/` without a
`CHANGELOG.md` `[Unreleased]` entry and without `bump:none`, and warns when a label contradicts
the changelog section it adds (an `Added` section with `bump:patch` is a MINOR, not a PATCH). With
no label it derives from the squash subject (`feat` → minor, `docs` → none, else patch), which is
why the squash title must be a Conventional Commit. `VERSION` itself is never touched on a feature
branch — see the `lettuce-releasing` skill.

## Branch protection: what is on

Currently on `main`: force-push and branch deletion **forbidden** (`enforce_admins` false, so an
admin can still do both — it is a guardrail for agents, not a lock).

Deliberately **not** on yet, because each one breaks something until its dependency lands:

- **Require a PR** — `scripts/release.ts`'s one-shot mode still commits on `main`; it works via
  `--pr`/`--deploy` now, so this can be switched on once that has shipped.
- **Require the `ci` check** — pointless without require-a-PR, since a direct push bypasses it.
- **Require an approving review, squash-only** — same moment.

The moment those go on, the release *must* go through `bun run release --pr`, and `AGENTS.md`'s
release summary has to say so.
