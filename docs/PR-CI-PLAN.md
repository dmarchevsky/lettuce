# Plan for review: PR-based flow, GitHub CI gates, version + SHA policy

Status: **proposal, not adopted.** Nothing here is project truth until this doc is
merged and `AGENTS.md` is rewritten to match. Six decisions need an owner's call
(§2).

Written against `main` at `9400080` (v0.6.1-letta_0.34.1).

---

## 1. Evaluation of the current process

Today (`AGENTS.md` → "Git workflow", "Definition of done"): worktree per branch →
commit → local `bun run verify` → build + run locally → **human tests in the
container** → `git merge --ff-only` into `main` → **stop and ask** → `git push` →
Dockhand deploy → verify → annotated tag. Explicitly "no PRs".

What that process actually enforces, and where it leaks:

| Property | Today | Consequence |
|---|---|---|
| Automated gates | none off-machine — there is **no `.github/` at all** | every gate is an agent's good behaviour on one laptop |
| `check-prod-info` | exists, **not a stage in `scripts/verify.ts`** | a private IPv4 or personal mail address can land on `main` today |
| Landing vs releasing | fused: `git push` *is* the release moment | nothing can land on `main` that prod does not run; a half-tested branch can't be parked |
| Review | by eye, in the local checkout, immediately before the push | no durable review record, no diff-per-change, no evidence attached |
| Inbound contributions | 2 open fork PRs right now (`#2` conflicting, `#3` 540 lines / 15 files, from `dmarcelino`) with **no checks and no labels** | external code is reviewed by reading only; none of our six version pins, docs-honesty or prod-info gates run on it |
| Provenance of a running container | `/api/status` serves the `VERSION` file = the **last tag** | between releases it is impossible to tell which commit prod is running — this is what "add sha" fixes |
| Parallel agents | serialized by the human + the shared local stack | two sessions can only take turns at merge time |
| `origin` | mirror of local `main` | no independent record of what was approved |

Moving to PRs is worth it, and the cost is mostly re-writing our own harness, not
the product:

- **For:** CI makes the gates mechanical (and applies them to fork PRs we cannot
  trust); PR = unit of review + evidence; landing decouples from releasing, so
  `main` can accumulate work while prod stays at the last tag; branch protection
  makes "`main` is deployable" enforced rather than intended.
- **Against / real costs:** the *human container test* gate cannot be automated —
  it must become a review requirement, not a CI check (see §3); merging needs a
  human with a GitHub button (our token cannot manage branch protection — see
  §9); squash-merge replaces `--ff-only`, so `AGENTS.md`'s "no merge commits" rule
  must be restated; one more moving part (Actions) between an agent and a shipped
  change; `AGENTS.md` has **zero size headroom** (39.0 KB used of the
  `SIZE_BUDGET_BYTES = 40_000` budget in `scripts/check-docs.ts`), so the new text
  has to be paid for by moving detail into a new skill.

**Recommendation: adopt PRs for anything touching `bff/`, `web/` or `docker/`**
(the same scope as today's "feature branch" rule), keep **docs-only changes
landing straight on `main`** (no image is involved), and treat **release as its own
PR** (§5) so `VERSION`/tag discipline survives branch protection.

---

## 2. Decisions requested

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Merge method | squash / rebase-and-merge / merge commit | **Squash**, PR title = Conventional Commit subject; "history stays linear, never merge commits" replaces "fast-forward only". Rebase-and-merge is the runner-up if per-commit authorship matters more than one-commit-per-PR |
| D2 | Who may merge | human always / agent after the human says "it works" | **Human merges**, or the agent merges only on that explicit instruction for that PR. Guard gains a rule for `gh pr merge` / `gh pr review --approve` |
| D3 | Bump signal | PR label / Conventional Commit / human at release | **Label `bump:minor`/`bump:patch`** on the PR (source of truth) + commit-subject fallback in CI |
| D4 | Where the SHA comes from at image build | build-arg plumbing / `.git` refs metadata in the build context / per-merge VERSION bump | **`.git` refs metadata via `COPY`** (§6.3), with `ARG GIT_SHA` as override. No env plumbing, works identically for local, CI and Dockhand |
| D5 | Live stack (deploy-check + `ui-check`) in CI | required for `web/**` / advisory nightly / not at all | **Spike first (PR-4), advisory for a week, then required for `web/**`** — it is the highest-value and least-certain gate |
| D6 | `bun run smoke` in CI | CI / release-only / local-only | **Local + release-time only.** It mutates real state and needs a live agent; a fork PR must never run it |

---

## 3. Target lifecycle

```
worktree (.worktrees/<branch>)            PR on GitHub                     main
─────────────────────────────            ──────────────────              ────
branch + worktree          ──push──▶  PR opens                    merged commit on main
Tier A locally: verify                   │                              │ (prod lags by design)
build + run locally                      ├─ CI Tier A (required) ──▶ green
human tests in container ───────review──▶├─ CI Tier B (paths: web/bff) ─▶ green
                                         ├─ human approval (the container-test gate)
                                         └─ human merges (squash) ─────────▶ main
release (own PR, §5): VERSION bump + [Unreleased] rename → merge → Dockhand deploy
from main → verify → annotated tag on that commit (+ tag push)
```

Rules that carry over unchanged: never push/tag/redeploy prod without asking
(§"Stop before releasing to prod"); never remove a worktree or branch on your own
initiative; one upstream WebSocket (untouched by all of this).

Rules that change:

1. **`git push` splits into two acts.** Pushing a *feature branch* becomes routine
   work (it changes nothing that runs). Pushing `main`, `--tags`, `--force` and
   `gh pr merge` stay confirm-gated. Today
   `.pi/extensions/guard-core.ts` pattern `/\bgit\b[^\n]*\bpush\b(?!\w)/`
   confirms every push, which would put a human prompt in front of every `git push
   -u origin <branch>` (§7).
2. **The container test becomes review evidence.** The PR body template gets a
   mandatory "Tested in the local stack" section naming what was clicked and what
   happened; branch protection requires 1 approval, so the human test gate is
   expressed as the approval. CI cannot substitute for it and must not be sold as
   if it could.
3. **`main` advances without deploying.** Prod moves only on a release (§5). That
   is the point of the split, and it must be said out loud in `AGENTS.md` so nobody
   reads "merged" as "live".
4. **PR body = the current changelog/docs duty.** `[Unreleased]` entry plus
   `README.md`/`docs/CONFIGURATION.md` updates, same commit as the change —
   enforced by CI (§4, `release-hygiene`), which today is prose only.

PR scope rule, mirroring today's:

- touches `bff/`, `web/` or `docker/` → PR, required checks, approval;
- docs-only (`AGENTS.md`, `docs/`, `README.md`, `CHANGELOG.md`, `.agents/skills/`,
  `.pi/`, `scripts/` only) → straight to `main`, no CI beyond a docs-only path run.

---

## 4. GitHub CI: proposed gates

All new files live under `.github/`. Runner notes: `ubuntu-latest`,
`oven-sh/setup-bun@v2` pinned to `bun-version: 1.3.0` (matching `packageManager`
in `package.json`), `bun install --frozen-lockfile` with `actions/cache`, workflow
top-level `permissions: contents: read`, `concurrency` group cancelling superseded
runs, and **actions pinned to commit SHAs** with `actionlint` +
`yamllint`/`check-jsonschema` run in CI as a gate of its own.

### Tier A — `ci.yml`, every PR and every push to `main`; all required; target < 3 min

One `setup` job, then independent jobs (so a reviewer sees *which* gate failed),
plus a synthetic `ci (required)` job that `needs` them all — with path filters, the
aggregate job is the thing made required in branch protection, so a filtered-out
job never leaves a check pending.

| Job | Command | Catches what nothing catches today |
|---|---|---|
| `static` | `bun run lint`, `bun run typecheck` | today inside `verify` only |
| `test` | `bun test` | same |
| `build` | `bun run build` | same; artifact `web/dist` for Tier B |
| `release-hygiene` | new `scripts/check-release-hygiene.ts` (§5) | CHANGELOG/VERSION/bump-label contract |
| `pins` | `bun run check-version-pin`, `bun run check-docs`, **`bun run check-prod-info`** | `check-prod-info` is not in `verify` today; fork PRs run none of these |
| `image` | `docker/buildx-action` build of `docker/bff.Dockerfile` (no push, GHA layer cache) | the Dockerfile / `COPY VERSION` / `web-build` stage breakage that only surfaces on the deploy machine |
| `compose-config` | `docker compose -f docker/compose.yml config --quiet` + profile token assertion | compose YAML/profile typos, currently found at deploy time |
| `secrets-scan` | `gitleaks` (or extend `check-prod-info` with a secret entropy pass) | `docker/.env` is gitignored but this repo carries config templates and is readable by contributors |

Changes this forces inside the scripts: `scripts/check-worktree.ts` must no-op when
`CI=true` (a GitHub checkout is detached HEAD, which already passes — make it
explicit rather than accidental), and `scripts/verify.ts` gains
`check-prod-info` + `release-hygiene` stages so local and CI run the same list.

### Tier B — `live.yml`, path-filtered (`bff/**`, `web/**`, `docker/**`, `scripts/ui-check.ts`), **spike before required (D5)**

Bring up the real stack with `docker compose up -d` and run `bun run deploy-check`
then `bun run ui-check` (Playwright, needs `playwright install --with-deps
chromium`). Minimum env: `SESSION_SECRET` (compose requires it — any throwaway
value), `LETTA_STATE_DIR` absolute, no `COMPOSE_PROFILES` (so local mode +
`DEV_BYPASS_EMAIL`, which is what `ui-check`'s `/auth/dev-login` relies on), no
Dockhand token, no Cloudflare, no Google, no push keys.

Unproven, and the reason this is a spike and not a promise: it must pull
`letta/letta:0.34.1`, boot the app-server, and satisfy `/readyz` (which asserts
only the BFF↔app-server WebSocket, not a model) — none of that has ever run outside
our laptops. Budget it, and keep it advisory until it survives a week of green.

Security: fork PRs run with the default read-only token and **no secrets**; nothing
in Tier A or B may need one. Anything needing credentials stays
`workflow_dispatch`-only, on `main`.

### Tier C — nightly / manual, never required

- `nightly-live`: Tier B against `main` at a fixed hour (drift detector, screenshots).
- `upstream-staleness`: newest `letta/letta` release vs `LETTA_CODE_VERSION` and
  `@letta-ai/letta-code` — a warning issue/annotation, not a failure (feeds
  `bun run sync-upstream`).
- `release`: manual/dispatch only, wraps `bun run release` (§5) for the human who
  prefers clicking to typing. Not required for anything.
- `bun run smoke`: stays local and release-time (D6).

---

## 5. Version bumps: who, when, and how they survive branch protection

Keep the existing invariant, stated in `scripts/release.ts` and the
`lettuce-releasing` skill: **`VERSION` is never bumped on a feature branch.** Two
reasons, both still true: parallel branches cannot know the next version, and two
MINOR features merged together are one MINOR release.

**Who:** the person running the release — the operator by default; an agent only
with the explicit, per-release stop-and-ask confirmation that already guards
`git push` and `git tag -a`. **When:** at release time, after every merge intended
for that release, immediately before the deploy. Not per PR, not at merge time.

What must change is the *mechanics*: branch protection forbids pushing `main`, so
the release commit cannot be committed on `main` and pushed the way
`scripts/release.ts` does today. It becomes a **release PR**:

1. `bun run release --minor|--patch --pr` — new mode: branch
   `release/<next>` off `main`, write `VERSION` = next tag, rename
   `## [Unreleased]` → `## [<next>] - <date>`, commit, push branch, open the PR
   (`gh pr create`). Nothing deployed, nothing tagged.
2. Human reviews + merges (squash). CI green includes `release-hygiene`.
3. `bun run release --deploy` (or `--tag`, same gate): resolve `origin/main`, run
   Tier-A checks against it, `deploy-check`, `dockhand plan` → **one confirmation
   naming the exact tag** → deploy → `verify` → BFF-log upstream-version check →
   `git tag -a <next>` on that `origin/main` commit → push the tag. The existing
   confirmation contract (`RELEASE_CONFIRM=<exact tag>` for non-TTY) is unchanged;
   only the commit/push target moved from `main` to a branch, and the tag now points
   at the *resolved* `origin/main` SHA rather than local `HEAD`.

Minor-vs-patch is decided by **labels on the merged PRs** (D3), computed by the new
`scripts/check-release-hygiene.ts`, which CI runs on every PR and `release` runs
before it opens the release PR:

- a PR touching `bff/`, `web/` or `docker/` must add a `CHANGELOG.md` `[Unreleased]`
  entry, or carry `bump:none` (internal-only) — today this is prose in
  `.pi/prompts/finish.md` step 2;
- an `### Added`/`### Changed` entry requires `bump:minor`; a `### Fixed`-only
  change requires `bump:minor` or `bump:patch`;
- fallback when a label is missing: the Conventional Commit subject
  (`feat`→minor, `fix`/`chore`→patch), which the squash title already carries;
- `--minor`/`--patch` stay accepted and always win, so a human can override.

`deploy-check` keeps its `VERSION`↔tag and newest-CHANGELOG↔`VERSION` assertions
unchanged, because `VERSION` keeps its exact `vX.Y.Z-letta_A.B.C` shape — the SHA is
never written into the file (§6).

---

## 6. Add the SHA to unreleased versions

### 6.1 Goal

Any running build answers "which commit are you" without SSH-ing to it. Today
`bff/src/version.ts` reads the `VERSION` file (the last *release* tag) and
`docker/bff.Dockerfile` `COPY VERSION` — so prod between releases reports
`v0.6.1-letta_0.34.1` no matter what it actually runs.

### 6.2 Format (SemVer build metadata, so nothing downstream has to change its parser)

| Checkout | `/api/status` `version` |
|---|---|
| HEAD is tagged | `v0.6.1-letta_0.34.1` (exactly the tag — keeps `deploy-check`'s VERSION↔tag equality) |
| untagged commit | `v0.6.1-letta_0.34.1+9400080` |
| untagged + dirty tree | `v0.6.1-letta_0.34.1+9400080-dirty` |
| no git at all (tarball, odd build) | `v0.6.1-letta_0.34.1+unknown` |
| no `VERSION` file (existing dev case) | `dev` (unchanged) |

The base stays the last released version — "unreleased" is expressed by *not* being
tagged plus carrying a SHA, which is exactly what you want when comparing prod
against `main`.

### 6.3 Plumbing — recommended option (D4)

`.dockerignore` excludes `.git/`, so the image cannot discover the SHA itself, and
the prod build runs under Dockhand, which we do not wrap. Env plumbing
(`--build-arg`) would therefore work locally and silently fail in prod. Baking
metadata out of the build context needs no cooperation from whoever runs the build:

1. `scripts/build-info.ts` — one resolver, `resolveVersion(root)`, used by the BFF,
   `deploy-check` and tests. Resolution order: baked `BUILD_INFO` file → `git`
   commands if a real `.git` is present (dev checkout) → `+unknown`.
2. `docker/bff.Dockerfile` — before the app `COPY`, write
   `BUILD_INFO` from `ARG GIT_SHA`; when `GIT_SHA` is empty, derive it by copying
   the *metadata-only* git refs into a build stage and reading them with plain file
   reads: `.git/HEAD` (usually `ref: refs/heads/main`), `.git/refs/`,
   `.git/packed-refs`. That is a handful of bytes, **no objects, no history**, no
   `git` binary needed at build or run time.
3. `.dockerignore` — add negations after `.git/`: `!.git/HEAD`, `!.git/refs/`,
   `!.git/packed-refs/`. Refs are ~48 KB here, packed-refs 4 KB; the layer changes
   per commit, which is correct and cheap.
4. `docker/compose.yml` — `bff.build.args: GIT_SHA: ${GIT_SHA:-}` so a builder
   without refs (or CI, which checks out with history) can pass `github.sha`
   explicitly. Local convenience: `bun run build:bff`
   (`scripts/build-bff.ts`) = `docker compose build bff` with
   `GIT_SHA=$(git rev-parse --short HEAD)`, and it becomes the documented build
   command so local builds stop being anonymous.
5. `bff/src/version.ts` — read `BUILD_INFO`, else `git rev-parse --short HEAD` +
   `git status --porcelain`, else `+unknown`; `bff/src/version.test.ts` gains the
   five table rows above.
6. UI: Settings → About shows the whole string; optionally a `commit` row linking
   `https://github.com/dmarchevsky/lettuce/commit/<sha>` when the SHA is known.
7. New gate in `deploy-check`: **served version's SHA == `git rev-parse --short
   HEAD`**, which catches the "container serves an older build" class even more
   directly than the existing bundle-name comparison, and would have caught the
   origin story in `docs/upstream-notes.md#definition-of-done-origin-story` on a
   machine where the bundle hash happened to coincide.

Rejected: per-merge `VERSION` bumps (release-please style) — it would make
`VERSION` a merge-conflict magnet across parallel worktrees and break
`check-version-pin`/`deploy-check`'s exact-format assumptions.

---

## 7. Harness and docs work (this is most of the cost)

| File | Change |
|---|---|
| `scripts/check-release-hygiene.ts` (new) | §5 rules; unit tests in `tests/` |
| `scripts/build-info.ts` (new), `bff/src/version.ts` + `.test.ts` | §6 |
| `scripts/build-bff.ts` (new) + `package.json` `build:bff` | §6.3.4 |
| `scripts/verify.ts` | add `prod-info` and `release-hygiene` stages; keep cheapest-first |
| `scripts/check-worktree.ts` | explicit `CI=true` no-op |
| `scripts/deploy-check.ts` | serve-version SHA check (§6.3.7) |
| `scripts/release.ts` | `--pr` and `--deploy` modes; tag on resolved `origin/main` |
| `docker/bff.Dockerfile`, `docker/compose.yml`, `.dockerignore` | §6.3 |
| `.pi/extensions/guard-core.ts` + `tests/guard-core.test.ts` | split `push` (feature branch free; `main`/`--tags`/`--force` confirm); add confirm rules for `gh pr merge`, `gh pr review --approve`, `gh api …/merge`, `gh release create`; `VERSION` stays protected |
| `.pi/prompts/finish.md` | steps 3–7 rewritten: push branch → `gh pr create` → hand to human for the container test → human merges → stop before release |
| `.pi/prompts/release.md` | release-PR runbook |
| `.agents/skills/lettuce-pr-and-ci/SKILL.md` (new), `lettuce-releasing` (rewritten) | CI tiers, labels, branch-protection settings, release PR mechanics. Required because `AGENTS.md` is at 39.0 KB of a 40,000-byte budget — the PR/CI text must be paid for by moving detail here |
| `AGENTS.md` | "Git workflow" + "Definition of done" rewritten (PRs, squash, CI, release PR, SHA format); "no PRs" and "fast-forward merge only" removed; skill table gains `lettuce-pr-and-ci`; `check-docs --print-size` stays green |
| `docs/CONFIGURATION.md`, `README.md` | `GIT_SHA`/`BUILD_INFO`, "About now shows the commit", PR contribution note for `dmarcelino`-style contributors |
| `.github/` (new) | `workflows/ci.yml`, `live.yml`, `nightly.yml`, `release.yml`, `dependabot.yml` (optional), `pull_request_template.md`, `CODEOWNERS` (optional, single owner), `labeler` if labels drive D3 |

Labels to create in GitHub (one-time human task): `bump:minor`, `bump:patch`,
`bump:none`, plus `area:web`, `area:bff`, `area:docker` for path review hints.

---

## 8. Rollout — one PR per step, each independently revertable

| PR | Content | Depends on | Est. |
|---|---|---|---|
| PR-1 | `check-release-hygiene` + tests, `check-prod-info`/`release-hygiene` added to `verify`, `check-worktree` CI no-op, PR template | — | 0.5 d |
| PR-2 | SHA in version: `build-info`, `BUILD_INFO`, Dockerfile/compose/`.dockerignore`, `build:bff`, About, `deploy-check` SHA assertion, tests | PR-1 | 1 d |
| PR-3 | `.github/workflows/ci.yml` Tier A (+ `actionlint`, SHA-pinned actions, permissions, concurrency). Merge, confirm green, **then** enable branch protection (§9) | PR-1, PR-2 | 1 d |
| PR-4 | **Spike:** Tier B live stack (`deploy-check` + `ui-check`) advisory; measure flakiness, app-server boot time, cost | PR-3 | 1–2 d |
| PR-5 | Release PR mode in `release.ts` + `--deploy`/`--tag` split; `lettuce-releasing` rewrite | PR-1..3 | 1 d |
| PR-6 | Guard rules + tests, `finish.md`/`release.md`, new `lettuce-pr-and-ci` skill, `AGENTS.md` rewrite + compaction | PR-5 | 1 d |
| PR-7 | Tier B made required for `web/**` (only if PR-4 proved out); optional `nightly`, `upstream-staleness` | PR-4 | 0.5 d |

PR-2 lands before PR-3 deliberately: the image built by CI should already carry a
real SHA. Until PR-5 lands, releases keep using today's on-`main` flow, so
PR-3 must not enable "require PRs on main" until PR-5 is merged — or enable PRs and
accept one release through the old path first. Say which when protection is set up.

Cleanup to note, not to act on: `origin/pr-2` and `.worktrees/pr-2` still exist
while `#2`'s content already landed on `main` as `a274dec`; `#2` is `CONFLICTING`
and should be closed by whoever opened it (never closed by us unilaterally), and
`#3` (540 lines, fork, Claude Code workers) is the first real candidate to run
through the new flow once Tier A is required.

---

## 9. Human-only steps (the agent cannot do these with the current token)

- **Branch protection on `main`** — `gh api repos/…/branches/main/protection`
  returns 403 with the stored token. Desired settings: require a PR (docs-only
  exception by admin or by `paths` bypass if GitHub offers it on the plan), require
  the `ci (required)` check, require review before merge (1 approval), dismiss
  stale approvals on new commits, allow squash only, disallow force pushes and
  deletions, restrict tag deletion. Admin access or a broader token is the operator's
  call.
- Create the labels (§7).
- Merge the PRs, and the container test inside each approval.
- Every prod release: the stop-and-ask, and the `dockhand deploy --confirm`.

---

## 10. Risks and open questions

- **The container-test gate is the whole product gate and it is not automatable.**
  CI green ≠ works. The mitigation is review + approval, which is a human habit,
  not a config. If approvals become rubber stamps we have traded a real gate for a
  fake one — keep the PR body's "what I clicked / what happened" mandatory.
- **Tier B may not be feasible** as designed (app-server image pull time, healthcheck
  assumptions, memfs mounts). PR-4 exists to fail early; fallback is keeping
  `ui-check` local-only and requiring a screenshot attachment in the PR instead.
- **CI cost/time**: every PR pulls `letta/letta` in Tier B. If that is too slow or
  too noisy, keep Tier B nightly + pre-release rather than per PR.
- **Prod drifts behind `main` by design.** Good for parking work, bad if
  "merged" is read as "live". The SHA in About (PR-2) is the mitigation: prod shows
  the tag, a main build shows the SHA.
- **Dockhand builds from `origin/main` HEAD, not a tag.** A release therefore deploys
  whatever `main`'s tip is at confirm time. With PRs, that tip can move between the
  plan and the deploy. Recommend `release --deploy` assert `origin/main` == the
  release PR's commit *and* re-plan if it moved. (Alternative: switch Dockhand's
  stack to deploy the tag — bigger change, out of scope here.)
- **Two identities in one project** (`dmarchevsky` local-agent flow vs
  `dmarcelino` fork-PR flow). Decide whether fork PRs get Tier B run at all
  (recommended: yes, no secrets involved) and whether an outside PR can carry a
  `bump:` label or whether that is maintainer-only.
- **`smoke` and `sync-upstream` never become required.** Don't let "add CI" creep
  into CI that mutates state.
