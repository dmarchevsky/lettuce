# lettuce — dev-flow playbook

<!-- Operator-owned. Agent changes go through `flow init --write`; `flow init` alone runs the doctor. -->

## global

```flow
defaultBranch = main
branchPattern = feat/{slug}
worktreeDir = .worktrees/{slug}
release.changelog = CHANGELOG.md
release.github = false
```

```flow-guard
deny    \bgit\b[^\n]*--force(?!\w)                        :: history stays linear — PRs squash-merge, update a branch by merging main into it
deny    \bgit\b[^\n]*\bpush\b(?!\w)[^\n]*\s-f(?!\w)       :: the short spelling of the force push above
deny    \bgit\b[^\n]*\bworktree\s+prune\b                 :: prunes other sessions' worktrees
confirm \bgit\b[^\n]*\bworktree remove\b                  :: `bun run cleanup` checks PR state and live sessions first
confirm \bgit\b[^\n]*\bbranch\s+(?:-d\b|--delete\b)       :: report the branch instead; `bun run cleanup` does the checking
confirm \bgit\b[^\n]*\bbranch\s+(?:-D\b|--delete\s+--force|--force\s+--delete) :: deletes a squash-merged branch git cannot see as merged
confirm \bgh\b[^\n]*\bpr\s+merge\b                        :: the operator merges, or names this specific PR
confirm \bgh\b[^\n]*\bpr\s+review\b[^\n]*(?:--approve|\bapprove\b) :: an approval is a human statement that they ran it
confirm \bgh\b[^\n]*\bapi\b[^\n]*\/merges?\b              :: the same merge through the raw API
confirm \bdocker\b[^\n]*\bcompose\b[^\n]*\b(?:rm|down|stop|kill)\b :: stops running containers
confirm \bdocker\b[^\n]*\bcompose\b[^\n]*\brestart\b      :: drops the permanent upstream connection and any turn in flight
confirm \bdocker\b[^\n]*\bcompose\b[^\n]*\bup\b[^\n]*(?:^|\s)app-server(?=\s|$) :: that service shares a network namespace with two others
protect docker/.env                                       :: gitignored live secrets — never echo the values
forbid  docker/secrets                                    :: gitignored secret storage
```

Feature work lives in a worktree under `.worktrees/<slug>`; the main checkout stays on `main` with a
clean tree and only takes merged PRs. Area mechanics live in `.agents/skills/lettuce-*/SKILL.md` —
read the one AGENTS.md's table names before planning. Upstream `letta-code/` is read-only and is never
patched. A plan document rides its own feature's branch and PR, never a PR of its own.

**Production deploy is the operator's alone.** The agent publishes — branch, PR, merge on the operator's
word for that PR, annotated tag — and stops there. It never deploys prod, never asks whether a deploy
happened, and keeps no prod host, address or deploy-manager detail in the tree
(`bun run check-prod-info` is what enforces that).

A `flow-guard` rule matches shell text, not intent: a `gh pr create --body "…git branch -D…"` trips the
branch rule, so a body that quotes a command goes in a file and comes in with `--body-file`.

## plan

- [ ] (ui) mockups of every changed surface, rendered at 390 and 1280 and embedded in plan.md

Anything user-visible starts with `flow start <slug> --ui`. A docs-only change (nothing under `bff/`,
`web/` or `docker/`) still needs a flow: `flow start <slug> --patch` — and `--patch` / `--docs` are the
operator's grant in chat, never self-selected. Before asking for approval check
`git log origin/main..main --oneline` — local-only commits on `main` fall out of the worktree's base.

## implement

```flow
setup = cp -n ../../docker/.env docker/.env && bun install
test = bun run verify
run = docker compose -f docker/compose.yml up -d
dev = bun run build:bff && docker compose -f docker/compose.yml up -d
health = curl -fsS http://127.0.0.1:${BFF_PORT:-8090}/readyz
```

`bun run verify` is the whole offline half (worktree, version pins, prod-info, release hygiene, docs,
lint, typecheck, tests, build), so no separate `build` key. A fresh worktree has no `docker/.env`
(gitignored) — `setup` copies it in when `flow approve` creates the worktree, or the state-dir default
lands inside `.worktrees/`. Never recreate `app-server` on its own and never a scoped `up`: `bff` and
`channel-gateway` share its network namespace. The local stack is one per machine and shared, so an
`up -d` replaced whatever another session was testing — say so out loud. A web/ change needs `build:bff`
first or the container serves the old bundle.

- [ ] built and running in the local container stack (unscoped `up -d`, `build:bff` first for any web/
      change) and the operator clicked through the change and said it works
- [ ] (ui) `bun run ui-check` screenshots plus a live look at 390 and 1280, reviewed as a whole screen

## pre-release

```flow
versionFile = VERSION
versionTag = {version}
changelog = CHANGELOG.md
github = false
```

VERSION holds the whole release tag (`v<MAJOR>.<MINOR>.<PATCH>-letta_<LETTA_CODE_VERSION>`), which is
why `versionTag` is a bare `{version}` — do not let the doctor re-add the `v`. MINOR for new or changed
user-facing functionality, PATCH for everything else that ships. The version is cut here, per feature:
**one commit** bumps VERSION and renames `## [Unreleased]` to `## [v…] - <date>`, leaving an empty
`## [Unreleased]` above it — `check-release-hygiene` fails the branch when the two disagree, so a rename
without a bump is red. A flow that ships no version runs `flow release --no-version` on the operator's
word instead. Parallel branches collide on `VERSION` and `CHANGELOG.md`: merge `main` in and re-derive
the version before asking Release?, because the gate refuses a tag that already exists.

- [ ] `ponytail-review` run on the change and every must-have and should-have finding fixed
- [ ] the CHANGELOG entry, the VERSION bump and any README / docs/CONFIGURATION.md sync in that one
      release-prep commit, and the `bump:minor` / `bump:patch` / `bump:none` label agrees with it
- [ ] the operator confirmed this exact tag, after being told the commit range and whether `app-server`
      gets recreated (an `app-server` recreate kills every in-flight turn; the BFF drain covers only bff)

## release

Publish only — the preparation happened above. Push the branch, open the PR from
`.github/pull_request_template.md`, wait for the operator to confirm this specific PR and merge it
(squash), `git fetch`, create the annotated tag at `main`'s tip and push it **by name**
(`git push origin v<x>`, never `--follow-tags`), then `flow release-done`. No GitHub release is
published (`release.github = false`). Nothing here deploys prod, and nothing is pushed or tagged without
the operator's confirmation of that specific change — a standing yes from an earlier change is not one.

- [ ] after the merge and from `main`: `bun run deploy-check` green, plus `bun run ui-check` and
      `bun run smoke` where they apply
