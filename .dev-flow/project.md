# lettuce — dev-flow playbook

<!-- Operator-owned and tracked: a change rides a flow and a PR like any other file. `flow init --write`
     writes the live copy on the operator's word; `flow init` alone runs the doctor. -->

## global

```flow
defaultBranch = main
branchPattern = feat/{slug}
worktreeDir = .dev-flow/{slug}/worktree
```

```flow-guard
confirm \bdocker\b[^\n]*\bcompose\b[^\n]*\b(?:rm|down|stop|kill)\b :: stops running containers
confirm \bdocker\b[^\n]*\bcompose\b[^\n]*\brestart\b      :: drops the permanent upstream connection and any turn in flight
confirm \bdocker\b[^\n]*\bcompose\b[^\n]*\bup\b[^\n]*(?:^|\s)app-server(?=\s|$) :: that service shares a network namespace with two others
protect docker/.env*                                      :: gitignored live secrets and their backups — never echo the values
forbid  docker/secrets                                    :: gitignored secret storage
```

Feature work lives in the worktree dev-flow creates at `.dev-flow/<slug>/worktree`; the main checkout
stays on `main` with a clean tree and only takes merged PRs. Area mechanics live in `.agents/skills/lettuce-*/SKILL.md` —
read the one AGENTS.md's table names before planning. Upstream `letta-code/` is read-only and is never
patched. A plan document rides its own feature's branch and PR, never a PR of its own.

**Production deploy is the operator's alone:** the agent publishes — branch, PR, merge on the operator's
word for that PR, annotated tag — and stops there. It never deploys prod and never asks whether a deploy
happened.

A `flow-guard` rule matches shell text, not intent: a `gh pr create --body "…docker compose down…"` trips
the confirm rule, so a body that quotes a command goes in a file and comes in with `--body-file`.

A force push needs no rule of its own: dev-flow asks the operator before any `git push --force` /
`--force-with-lease`, and their word is the `DEV_FLOW_ALLOW_REWRITE=1` prefix. A pushed branch is still
updated by merging `main` into it — that includes a contributor's fork-PR branch, pushed to under
maintainerCanModify with a PR comment saying so — never by rebasing it.

`protect` and `forbid` name a path and its subtree; a glob works in the **last segment only**, as a
sibling set: `protect docker/.env*` covers `.env` and every `docker/.env.bak-20261021` a variable flip
leaves beside it. Flip a variable **in place** anyway instead of copying `.env` aside, and never `-f` add
an ignored dotfile — `git add -f docker/.env.bak` is a public secret, not a shortcut. Committing the
playbook itself is the one `-f` add that is right (`.dev-flow/` is ignored, `project.md` is tracked):
`git add -f .dev-flow/project.md` on its own line — a plain `git add` exits 1 and silently drops the
`&& git commit` chained after it.

## plan

- [ ] (ui) mockups of every changed surface, rendered at 390 and 1280 and embedded in plan.md

A mockup links the **worktree's** stylesheet (`../../worktree/web/src/styles.css` from `plan/mockups/`)
— never the main checkout's, which lacks every class the branch adds until it merges, so a re-render
silently loses the new styling. Check the link resolved before trusting a shot.

Write the plan to `plan/` **as the discussion goes**, not when it ends: pi has auto-compacted at the
`release` stage twice now, and a plan that lived only in the transcript was gone with it — the gates read
the file, so the file is the work's memory. Pace the gates the same way: land each one's output on disk
before moving on.

Anything user-visible starts with `flow start <slug> --ui`. A docs-only change (nothing under `bff/`,
`web/` or `docker/`) still needs a flow: `flow start <slug> --patch` — and `--patch` / `--docs` are the
operator's grant in chat, never self-selected. `flow approve` cuts the branch from
`origin/main` as this clone last fetched it, so `git fetch` right before approving — an unfetched
`origin/main` puts the whole feature, its diff and every `flow check`, on a stale base that pre-release
pays for with a merge and a full CI re-run. Local-only commits on `main`
(`git log origin/main..main --oneline`) never reach the branch at all. When a parallel flow lands while
you work, merge `main` into the branch then rather than leaving it to pre-release.

## implement

```flow
setup = cp -n "$(git rev-parse --git-common-dir)/../docker/.env" docker/.env && bun install
test = bun run verify
run = docker compose -f docker/compose.yml up -d
dev = bun run build:bff && docker compose -f docker/compose.yml up -d
health = curl -fsS http://127.0.0.1:${BFF_PORT:-8090}/readyz
healthWait = 60
```

`bun run verify` is the whole offline half (worktree, version pins, prod-info, release hygiene, docs,
lint, typecheck, tests, build), so no separate `build` key. The commands assume `bun` on PATH, which the
harness env does not guarantee: `bun: command not found` means pi was started without `~/.bun/bin`, and
the fix is a symlink into a directory already on PATH (`ln -s ~/.bun/bin/bun ~/.local/bin/bun`) — a
machine fix, not a playbook edit. `bun run ui-check` can fail the same way from a fresh worktree: its
`bun install` resolves a Playwright whose pinned Chromium build is not the one this machine caches, so
either `npx playwright install chromium` once, or set `PLAYWRIGHT_CHROMIUM` to the cached
`~/.cache/ms-playwright/chromium_headless_shell-<build>/chrome-headless-shell-linux64/chrome-headless-shell`.
A fresh worktree has no `docker/.env` (gitignored) — `setup` copies it in when `flow approve` creates
the worktree, or the state-dir default lands inside `.dev-flow/<slug>/`. It reads the file from the
**main** checkout through `git rev-parse --git-common-dir`, because a linked worktree has no
`docker/.env` of its own and a
relative `../../` breaks the moment `worktreeDir` changes depth. A failed `setup` fails `flow approve`
and runs again on the next one; a `--docs` flow skips it.

`flow verify` runs `dev` itself — `build:bff`, then `up -d` — and its `dev ran (…)` line is the record of
that deploy; do not run the step by hand first, and do not write "no container was rebuilt" into a PR
whose verify printed it. **That deploy is the one the operator clicks.** The gate deploys before it
reports, so "keep the app running when you ask Verified?" means leave *this* deploy up while the
operator reviews — it is not an instruction to hand-run `build:bff` + `up -d` earlier in implement. The
`flow verify --confirmed` that records the answer runs `dev` again: that re-run is a **re-check** of the
same stack (the image build is cached and compose converges where nothing changed; `health` proves it
still serves this build), not a
second deploy to narrate. The local stack is one per machine and shared, so that `up -d` replaced
whatever another session was testing — say so out loud. `health` is a single `/readyz` probe; dev-flow
retries it within `healthWait`.

A look at the running stack never mutates operator state on its own. Move nothing under
`$LETTA_STATE_DIR` or `/app/auth`, never claim an instance you were not handed, and keep nothing durable in
a container path — the next recreate deletes it. A session that moved the sign-in hash aside to photograph a
locked screen, keeping its only backup inside `bff`, cost the operator their password when the container was
rebuilt. Copy state **out** to the host to photograph it, or add data instead of moving it.

`smoke` and `ui-check` both stop at `LETTUCE_TEST_PASSWORD` when the stack signs in with a password
(`scripts/harness.ts`), and an agent never stores that password: it is not a repo file, and exporting it
into a shell is the operator's per-machine choice. So an agent that cannot run them records **what it
probed in the container** instead — in the PR's *What was clicked* — and says plainly that a human pass on
the sign-in path is still owed. `flow verify` deploying and probing `/readyz` is not that pass and never
counts as one. When the branch edits `scripts/ui-check.ts` itself, the owed item is narrower: **the
operator runs `bun run ui-check` once** during the container test — a click-through does not execute
the suite and CI's `live.yml` runs with `UI_CHECK=off`, so a new assertion would otherwise ship never-run.

- [ ] built and running in the local container stack by `flow verify`'s own `dev` run (`build:bff`
      first for any web/ change, then unscoped `up -d`), left up while Verified? is asked, and the
      operator clicked through the change and said it works
- [ ] (ui) `bun run ui-check` screenshots plus a live look at 390 and 1280, reviewed as a whole screen
      — or `LETTUCE_TEST_PASSWORD` is not held: record the container probes and the owed human pass above

## pre-release

```flow
versionFile = VERSION
versionTag = {version}
changelog = CHANGELOG.md
releases = true
artifact = docker buildx imagetools inspect ghcr.io/dmarchevsky/lettuce-bff:{tag}
```

VERSION holds the whole release tag (`v<MAJOR>.<MINOR>.<PATCH>-letta_<LETTA_CODE_VERSION>`), which is
why `versionTag` is a bare `{version}` — do not let the doctor re-add the `v`. MINOR for new or changed
user-facing functionality, PATCH for everything else that ships. The version is cut here, per feature:
**one commit** bumps VERSION and renames `## [Unreleased]` to `## [v…] - <date>`, leaving an empty
`## [Unreleased]` above it — `check-release-hygiene` fails the branch when the two disagree, so a rename
without a bump is red. The heading an entry lands under is what CI derives the bump from: `### Added` and
`### Changed` are proof of a MINOR, so a PATCH flow files its entry under `### Fixed` or `### Removed`
— otherwise the derivation answers `unknown` against a `bump:patch` label. A flow that ships no version runs `flow release --no-version` on the operator's
word instead. Parallel branches collide on `VERSION` and `CHANGELOG.md`: merge `main` in and re-derive
the version before asking Release?, because the gate refuses a tag that already exists.

**A code-free release flow** (its only commit is the bump) inverts the order above: `flow verify` refuses
a branch with nothing committed, so the release-prep commit is cut at implement, and pre-release only
validates and tags. The operator's Verified? was then spoken over the base, which covers this branch
only because the bump ships no runtime code — say so in the PR. The bump renames every image tag, so
verify's `dev` rebuilds all five images under the new name (app-server from scratch) and recreates every
container; `docker tag` the old name to the new one first for images whose content did not change, or
say plainly to expect the full build.

`VERSION` is not the only release literal: the compose image-tag default (`${LETTA_IMAGE_TAG:-v…}`) is a
release-literal site too and moves in the same commit — it is the tag a host without `LETTA_IMAGE_NS`
builds, and what CI compares against `VERSION` after the merge. `sync-upstream` leaves it alone on purpose.

- [ ] `/flow-review` run on the change (a fresh-session read-only review of the branch diff — the
      `flow-review` skill, or `flow_stage` op `review`) and every must-have and should-have finding
      fixed — on a
      code-free release branch, `check-release-hygiene --pr` over the branch stands in, named as such
- [ ] the CHANGELOG entry, the VERSION bump and any README / docs/CONFIGURATION.md sync in that one
      release-prep commit, and the `bump:minor` / `bump:patch` / `bump:none` label agrees with it
- [ ] the compose image-tag default moved with VERSION in that same commit
- [ ] the operator confirmed this exact tag, after being told the commit range and whether `app-server`
      gets recreated (an `app-server` recreate kills every in-flight turn; the BFF drain covers only bff)

## release

```flow
merge = merge
```

Publish only — the preparation happened above. Push the branch, open the PR from
`.github/pull_request_template.md`, wait for `ci` green, **merge it yourself**
(`gh pr merge <n> --merge`), `git fetch`, create the annotated tag at `main`'s tip and push it
**by name** (`git push origin v<x>`, never `--follow-tags`), then `flow release-done`, which creates
the GitHub Release for that tag (`release.releases = true`) with the changelog section as its notes. Nothing here deploys prod, and nothing is pushed, merged or
tagged without the operator's **Release?** for that specific change — a standing yes from an earlier
change is not one. dev-flow refuses `gh pr merge` and tag pushes before `flow release`; after it, the
merge guard wants the style spelled out (`gh pr merge <n> --merge`).

The tag *is* the publish trigger — pushing it runs `.github/workflows/publish.yml`, which pushes all five
images to GHCR and retags `latest` — so **`release.artifact` is what proves a release shipped**:
`flow release-done` fails if the registry does not hold the tag. It exists because two publishes came back
green and pushed nothing — `lettuce-pr-and-ci` says why a green Compose build is not proof of a push. A
green pipeline is not the artifact; the registry is. (An unversioned flow tags nothing, so this gate and
the artifact check both stand down.)

- [ ] after the merge and from `main`: `bun run build` **first** — `deploy-check` compares the served bundle
      against this host's `web/dist`, and after a release built in a worktree that copy is stale
      (`build:bff` refreshes the image, never the host's copy) — then `bun run deploy-check` green, plus
      `bun run ui-check` and `bun run smoke` where they apply. A merge that ships nothing an image carries
      (playbook, docs, CI) still leaves build identity naming an older sha: rebuild `bff`, or record that
      there was nothing to rebuild.
- [ ] a versioned release's **image tag lags the checkout** on a build-locally host: the compose tag default
      moved with `VERSION`, so nothing built before the merge carries the new name and build identity fails
      with no flag to forgive it. Fix from `main` with a clean tree — `bun run build:bff` then
      `docker compose -f docker/compose.yml up -d --no-deps bff` (`--no-deps` is what keeps `app-server`
      from coming along; see the recreation warning above) — and then `deploy-check` is green because
      `VERSION` at `main` now equals the tag the image gets. The published GHCR images are the shipped
      artifact either way; this only proves the local stack matches the release. A host that pulls images
      instead of building them sets `LETTA_IMAGE_NS` (and `LETTA_IMAGE_TAG`) in its own gitignored
      `docker/.env`, and that is the operator's choice, never an agent's edit.

**A release-tag bump guarantees an `app-server` recreation**, and an `app-server` recreation kills every
in-flight turn with no drain — the BFF's drain covers `bff` alone. So after a versioned release, even a
scoped `docker compose up -d bff` on a build-locally host recreates `app-server`, because its image tag
default moved with `VERSION`. Name it in the handoff, and use `--no-deps` when the turn in flight matters.
Earlier versions of this playbook asked only "does app-server get recreated?", which made it sound
optional; for a versioned release it is not.
