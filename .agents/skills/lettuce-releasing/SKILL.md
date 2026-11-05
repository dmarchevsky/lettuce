---
name: lettuce-releasing
description: 'Cutting a lettuce release from inside a feature flow: the `v<MAJOR>.<MINOR>.<PATCH>-letta_<version>` tag format and what bumps MINOR versus PATCH, why the tag is not valid semver and must not be "fixed", the VERSION file as the only machine-readable record (and why no package.json version exists), the docker/compose.yml image-tag default that rides the same release-prep commit, the CHANGELOG.md sections and entry voice, and the README / docs/CONFIGURATION.md docs-sync duty. The stage sequence itself is `.dev-flow/project.md`. Read when bumping VERSION, tagging, or writing a changelog entry.'
---

# Versioning, tags, changelog, docs sync

Loaded from `AGENTS.md`. Tags and `VERSION` are the only version record, and **every shipping feature cuts
its own**: the flow's `pre-release` stage makes the bump commit on the feature branch, and the `release`
stage tags the merge. The sequence, the checklist and what `flow release` refuses are
`.dev-flow/project.md`; this file is the format and the voice.

### Versioning and tags

The repo's own releases are **annotated tags on `main`**:

```
v<MAJOR>.<MINOR>.<PATCH>-letta_<LETTA_CODE_VERSION>     e.g. v0.1.0-letta_0.33.7
```

- Start at `v0.1.0-letta_0.33.7`; stay on `0.x` — MAJOR is reserved and effectively
  unused for a single-user app.
- MINOR is any new or changed user-facing functionality — a new feature, a changed workflow, a visible
  behavior change. PATCH is everything else that ships on its own: fixes and hotfixes, a standalone
  `sync-upstream` bump, internal-only changes, a batch of small fixes.
- The `letta_<version>` suffix is read from the pin at tag time (`docker/compose.yml`,
  proven consistent by `check-version-pin`), never from memory. It never resets the
  semver part; a letta bump riding along with a feature just changes that tag's suffix.
- **Derive the number in `pre-release`, from your own changelog entry** — the heading rule and what
  `flow release` then refuses are in `.dev-flow/project.md`. What that means for the writing: a wrong
  derivation shows up as a wrong *number*, never as a silent collision.
- **The tag is cut at the `release` stage, immediately after the PR merges**,
  annotated (`git tag -a`), at `main`'s tip, and pushed **by name** (`git push origin v<x.y.z>…`).
  **The tag is the publish trigger** — pushing it runs `.github/workflows/publish.yml`, which pushes all
  five images to GHCR at that tag and retags `latest`, and `release.artifact` in the playbook makes
  `flow release-done` inspect the registry before recording the release. A tag pushed while that workflow
  fails is a release with nothing in it: read the run before `release-done`, and never pass
  `--no-artifact-check` to get past a registry that has no tag.
  Never `git push --follow-tags` — it silently skips annotated tags and the tag never reaches the
  remote. Nothing is tagged before the operator confirmed that specific merge
  (`AGENTS.md` → "Stop before publishing").
- One consequence of per-feature releases: two MINOR features merged in a row are now *two* MINOR
  releases, not one release with two entries.
- **`VERSION` at the repo root is the machine-readable record** — the full tag string, one line, bumped in
  the release-prep commit that the tag ends up pointing at. The bff image `COPY`s it and the BFF serves it
  at `/api/status` (authenticated branch only — the route's no-fingerprinting rule stands), which is how
  Settings → About shows the "lettuce" row (the letta-code row there is the live handshake's version, not
  this file's suffix). The image cannot derive it: `.dockerignore` excludes `.git/` and the image carries
  no `git`, so `git describe` at build time is impossible. `deploy-check` asserts `VERSION` agrees with
  the tag pointing at `HEAD`.
- `VERSION` and the tag are the **only** version record. No `version` field in any `package.json` — it
  would be a seventh drift-prone pin site that nothing renders.
- Upstream's `v<x.y.z>` tags live in the **letta-code checkout**, a different repo — no collision with
  these, and `sync-upstream` is unaffected.
- `-letta_0.33.7` is not valid semver (underscore is not a legal prerelease character), and strict semver
  tools would sort such a tag below a bare `v0.1.0`. Deliberate — we ship no npm package and never emit
  bare `v0.1.0`. Do not "fix" the format. (The tag *is* also an image tag: the release publishes the
  five images we build under this exact string — see `lettuce-pr-and-ci`.)

#### Changelog

`CHANGELOG.md` at the repo root keeps the user-facing entries, Keep a Changelog style adapted
to this repo's tag scheme:

- **Sections**: `Added` / `Changed` / `Fixed` / `Removed`. Omit empty sections. Newest release
  first; `[Unreleased]` always present at the top.
- **Entry voice**: one line, imperative ("Add…", "Fix…", "Remove…"), ≤ ~140 chars, phrased as
  what a user of the app notices — not the implementation. "Edit text files from the Files
  tab", not "wire `conversation_files_update` through the BFF".
- **Who writes them**: in the flow. Internal-only changes (refactors, CI, docs, test-only) need no
  entry; anything with user-visible behavior needs ≥1. **An unversioned flow is the exception**: a flow
  released with `flow release --no-version` files exactly one line under `## [Unreleased]` even when the
  change is internal-only, because that heading is the only record of what shipped without a tag — a
  harness-only change (playbook, skills, CI) files under `### Changed` and rides into whatever release
  folds `Unreleased`.
- **The release-prep commit renames the section**: it turns `## [Unreleased]` into
  `## [v<new-tag>] - <YYYY-MM-DD>` (that commit's date) and leaves a fresh empty `[Unreleased]` above it.
  `check-release-hygiene` requires the `[Unreleased]` heading *and* asserts `VERSION` equals the newest
  released section, so the two must move together.
- **The same commit bumps `docker/compose.yml`.** Every built service's image is
  `${LETTA_IMAGE_NS:-}lettuce-<name>:${LETTA_IMAGE_TAG:-v…-letta_…}`, and that default names the
  release whose images CI published, so it is rewritten to the new tag in the same commit as `VERSION`
  — `check-release-hygiene` fails the branch when the two disagree. Forgetting it does not break CI; it
  makes a prod deploy pull the previous release's images.
- **`deploy-check`** re-asserts the same pair after the merge, from `main`, next to the tag at `HEAD`.
- **No links section** in the changelog itself — `flow release` publishes a GitHub Release per tag
  (`release.releases = true` in the playbook) and renders its notes from that section, so the file needs
  no link references at the bottom.

#### Docs sync (README and CONFIGURATION)

`README.md` (what the app is, architecture, how to run it) and `docs/CONFIGURATION.md`
(every environment variable and setting) describe the **shipped product**, so a release must not be cut
from a tree whose docs describe the previous one.

- **Primary place — the change's own commit**: any change that adds or changes an env
  var, setting, port, sidecar, default, or user-facing workflow carries its `README.md`
  and/or `docs/CONFIGURATION.md` update with it. That is where the knowledge is fresh and
  where the diff is reviewed together with the code.
- **The safety net is the reread before Release?**: what the branch actually changed, against what the
  prose now claims, fixed in the same release-prep commit. Nothing asserts prose correctness — the gate
  that follows checks `VERSION` and the changelog, so this one is a human/agent judgment.
