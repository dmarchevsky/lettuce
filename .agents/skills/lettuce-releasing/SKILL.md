---
name: lettuce-releasing
description: 'Cutting a lettuce release: the `v<MAJOR>.<MINOR>.<PATCH>-letta_<version>` tag format and what bumps MINOR versus PATCH, creating a tag only after the prod deploy verifies, `bun run release` as gated commands (`--pr` to open the release PR, `--deploy` to ship and tag it, or the one-shot), the VERSION file as the only machine-readable record (and why no package.json version exists), the CHANGELOG.md [Unreleased] voice and section rules, and the README / docs/CONFIGURATION.md docs-sync duty on the feature branch and at release time. Read when bumping VERSION, tagging, writing a changelog entry, or running release.'
---

# Versioning, tags, changelog, docs sync

Loaded from `AGENTS.md`. Tags and VERSION are the only version record, and the release commit is made on main — directly, or (once `main` requires PRs) through a release PR — never on a feature branch.

Extracted from `AGENTS.md`; keep both in sync when you change either, and keep `docs/upstream-notes.md` pointers working.

### Versioning and tags

The repo's own releases are **annotated tags on `main`**:

```
v<MAJOR>.<MINOR>.<PATCH>-letta_<LETTA_CODE_VERSION>     e.g. v0.1.0-letta_0.33.7
```

- Start at `v0.1.0-letta_0.33.7`; stay on `0.x` — MAJOR is reserved and effectively
  unused for a single-user app.
- **MINOR** (+1, PATCH resets to 0) = any new or changed user-facing functionality — a new
  feature, a changed workflow, a visible behavior change.
- **PATCH** (+1) = anything else that ships to prod on its own: fixes and hotfixes, a
  standalone `sync-upstream` bump, internal-only changes, a batch of small fixes.
- The `letta_<version>` suffix is read from the pin at tag time (`docker/compose.yml`,
  proven consistent by `check-version-pin`), never from memory. It never resets the
  semver part; a letta bump riding along with a feature just changes that tag's suffix.
- A tag is created **only after the prod deploy is verified** (AGENTS.md's "Stop before releasing to
  prod") and pushed with `git push origin <tag>`. A failed deploy is never tagged.
- Before running it, make the release-time **docs sync** commit on `main` if the
  `[Unreleased]` range changed anything `README.md` or `docs/CONFIGURATION.md` describes
  (see "Docs sync"). `release.ts` only stages `VERSION` and `CHANGELOG.md`.
- **`bun run release`** (`scripts/release.ts`) is the release as gated commands. All of them
  assert `main` is checked out, clean and level with origin, that `VERSION` is well-formed and
  agrees with the newest `CHANGELOG.md` section, and that HEAD is not already tagged; the tag is
  computed from `VERSION` + the compose pin, never from memory.
  - **`--minor` / `--patch` / `--auto`** picks the bump. `--auto` reads the `[Unreleased]`
    headings (`Added`/`Changed` → MINOR, `Fixed` only → PATCH) and falls back to the commit
    subjects since the current tag, then prints its reasoning — read it.
  - **`… --pr`** opens the **release PR**: branch `release/<tag>` carrying the `VERSION` bump and
    the `[Unreleased]` rename, pushed and opened with `bump:none`. It deploys and tags nothing.
    A human merges it; merge it **last**, because anything merged after it would ship and get
    tagged with no changelog entry.
  - **`--deploy`** is the second half: it refuses unless `origin/main`'s tip *is* that release
    commit and unless that tag does not already exist, then runs `deploy-check`, prints the
    Dockhand plan, asks for the one confirmation, and does deploy → verify → upstream-log check →
    tag → push tag.
  - **`--minor` alone** is the original one-shot (release commit on `main` locally, then push →
    deploy → verify → tag). Correct while `main` accepts direct pushes; it fails at the push
    once require-PR is on.
  - Confirmation is unchanged in every mode: type the tag exactly on a TTY, or
    `RELEASE_CONFIRM=<tag>` for a non-interactive caller that has asked the human. A failure
    stops with no rollback, and a failed deploy is never tagged. Doing it by hand is still
    allowed — this is the same order — but the hand version is what forgot the VERSION bump once.
- **`VERSION` at the repo root is the machine-readable record** — the full tag string,
  one line, bumped in the same commit that is tagged. The bff image `COPY`s it and the
  BFF serves it at `/api/status` (authenticated branch only — the route's
  no-fingerprinting rule stands), which is how Settings → About shows
  the "lettuce" row (About no longer shows a letta-code version row). The image cannot derive it: `.dockerignore` excludes
  `.git/` and the image carries no `git`, so `git describe` at build time is
  impossible. `deploy-check` asserts `VERSION` agrees with the tag pointing at `HEAD`.
- Tags and `VERSION` are the **only** version record. No `version` field in any
  `package.json` — it would be a seventh drift-prone pin site that nothing renders.
- Upstream's `v<x.y.z>` tags live in the **letta-code checkout**, a different repo —
  no collision with these, and `sync-upstream` is unaffected.
- `-letta_0.33.7` is not valid semver (underscore is not a legal prerelease character),
  and strict semver tools would sort such a tag below a bare `v0.1.0`. Deliberate — we
  never publish to a registry and never emit bare `v0.1.0`. Do not "fix" the format.

#### Changelog

`CHANGELOG.md` at the repo root keeps the user-facing entries, Keep a Changelog style adapted
to this repo's tag scheme:

- **Sections**: `Added` / `Changed` / `Fixed` / `Removed`. Omit empty sections. Newest release
  first; `[Unreleased]` always present at the top.
- **Entry voice**: one line, imperative ("Add…", "Fix…", "Remove…"), ≤ ~140 chars, phrased as
  what a user of the app notices — not the implementation. "Edit text files from the Files
  tab", not "wire `conversation_files_update` through the BFF".
- **Who writes them**: on the feature branch, in the same commit as the change (Definition of
  done step 2). Any change with user-visible behavior needs ≥1 entry; internal-only changes
  (refactors, CI, docs, test-only) need none.
- **On version bump**: the release commit that bumps `VERSION` renames `## [Unreleased]` to
  `## [v<new-tag>] - <YYYY-MM-DD>` (date of that commit) and starts a fresh empty
  `[Unreleased]` above it. This keeps `VERSION` and the changelog consistent by construction
  even if the deploy later fails and the tag is never created.
- **The release commit is made on `main`, never on a feature branch** — by
  `bun run release`, after every merge for that release and before the push. Parallel
  worktrees cannot know the next version: two MINOR features merged together are **one**
  MINOR release, and two branches each bumping `VERSION` would both claim the same tag.
  Between releases `main` sits at the last tag with entries accumulating under
  `[Unreleased]`, which `deploy-check` passes — nothing forces the bump early.
- **No links section** — private repo, no GitHub releases; do not add Keep-a-Changelog link
  references.
- `deploy-check` asserts `CHANGELOG.md` has `## [Unreleased]` and that its newest
  `## [v...]` section equals `VERSION`.

#### Docs sync (README and CONFIGURATION)

`README.md` (what the app is, architecture, how to run it) and `docs/CONFIGURATION.md`
(every environment variable and setting) describe the **shipped product**, so a release
must not be cut from a `main` whose docs describe the previous one.

- **Primary place — the feature branch, in the same commit as the change** (Definition of
  done step 2), exactly like the changelog entry: any change that adds or changes an env
  var, setting, port, sidecar, default, or user-facing workflow carries its `README.md`
  and/or `docs/CONFIGURATION.md` update with it. That is where the knowledge is fresh and
  where the diff is reviewed together with the code.
- **Release-time safety net — on `main`, right before `bun run release`**: skim the
  `CHANGELOG.md` `[Unreleased]` entries since the last tag and update anything the
  per-change commits missed, as a `docs:` commit on `main`. It must be its own commit
  because release requires a clean tree and `release.ts` stages only `VERSION` and
  `CHANGELOG.md`; being on `main` before the release commit, it rides into the tagged
  range and ships with the tag.
- A prose gate `deploy-check` cannot check: correctness of docs is a human/agent judgment
  at these two points, not an assertion.
