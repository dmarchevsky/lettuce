---
name: lettuce-releasing
description: 'Cutting a lettuce release from inside a feature flow: the `v<MAJOR>.<MINOR>.<PATCH>-letta_<version>` tag format and what bumps MINOR versus PATCH, that every shipping feature bumps VERSION at the flow'\''s pre-release stage and tags its own merge (there is no batched release command), `flow release --no-version` for a flow that ships nothing, the VERSION file as the only machine-readable record (and why no package.json version exists), the CHANGELOG.md sections and entry voice, and the README / docs/CONFIGURATION.md docs-sync duty. Read when bumping VERSION, tagging, writing a changelog entry, or deciding what a flow ships.'
---

# Versioning, tags, changelog, docs sync

Loaded from `AGENTS.md`. Tags and `VERSION` are the only version record, and **every shipping feature cuts
its own**: the flow's `pre-release` stage makes the bump commit on the feature branch, and the `release`
stage tags the merge. The batched release command and its script are gone — dev-flow's gates are the
gated commands now.

Extracted from `AGENTS.md`; keep both in sync when you change either, and keep `docs/upstream-notes.md`
pointers working.

### Versioning and tags

The repo's own releases are **annotated tags on `main`**:

```
v<MAJOR>.<MINOR>.<PATCH>-letta_<LETTA_CODE_VERSION>     e.g. v0.1.0-letta_0.33.7
```

- Start at `v0.1.0-letta_0.33.7`; stay on `0.x` — MAJOR is reserved and effectively
  unused for a single-user app.
- **MINOR** (+1, PATCH resets to 0) = any new or changed user-facing functionality — a new
  feature, a changed workflow, a visible behavior change.
- **PATCH** (+1) = anything else that ships on its own: fixes and hotfixes, a standalone
  `sync-upstream` bump, internal-only changes, a batch of small fixes.
- The `letta_<version>` suffix is read from the pin at tag time (`docker/compose.yml`,
  proven consistent by `check-version-pin`), never from memory. It never resets the
  semver part; a letta bump riding along with a feature just changes that tag's suffix.
- **Derive the number in `pre-release`, from your own changelog entry**: `Added`/`Changed` → MINOR,
  `Fixed` only → PATCH. `flow release` then refuses unless `VERSION` is ahead of the last tag and
  `CHANGELOG.md` mentions it — so a wrong derivation shows up as a wrong *number*, never as a silent
  collision.
- **The tag is cut at the `release` stage, immediately after the operator squash-merges the PR**,
  annotated (`git tag -a`), at `main`'s tip, and pushed **by name** (`git push origin v<x.y.z>…`).
  Never `git push --follow-tags` — it silently skips annotated tags and the tag never reaches the
  remote. Nothing is tagged before the operator confirmed that specific merge
  (`AGENTS.md` → "Stop before publishing").
- **Parallel branches collide on purpose.** Two branches that both claim the next PATCH conflict, and
  the loser merges `main` in, re-derives from the entries it now sees, and asks **Release?** again. One
  consequence of per-feature releases: two MINOR features merged in a row are now *two* MINOR releases,
  not one release with two entries.
- A flow that ships nothing a user notices — docs-only, CI-only — runs `flow release --no-version` on the
  operator's word: no bump, no `[Unreleased]` rename, no tag, and `flow release-done` records the release
  with an unversioned note. That is the operator's choice at **Release?**, never an agent's shortcut.
- **`VERSION` at the repo root is the machine-readable record** — the full tag string, one line, bumped in
  the release-prep commit that the tag ends up pointing at. The bff image `COPY`s it and the BFF serves it
  at `/api/status` (authenticated branch only — the route's no-fingerprinting rule stands), which is how
  Settings → About shows the "lettuce" row (the letta-code row there is the live handshake's version, not
  this file's suffix). The image cannot derive it: `.dockerignore` excludes `.git/` and the image carries
  no `git`, so `git describe` at build time is impossible. `deploy-check` asserts `VERSION` agrees with
  the tag pointing at `HEAD`.
- `VERSION` and the tag are the **only** version record. No `version` field in any `package.json` — it
  would be a seventh drift-prone pin site that nothing renders.
- `release.github = false` in `.dev-flow/project.md`, so no GitHub release is published from a tag;
  `flow release-done` only verifies the tag is on `main` and on `origin`. Flipping it is the operator's
  call.
- Upstream's `v<x.y.z>` tags live in the **letta-code checkout**, a different repo — no collision with
  these, and `sync-upstream` is unaffected.
- `-letta_0.33.7` is not valid semver (underscore is not a legal prerelease character), and strict semver
  tools would sort such a tag below a bare `v0.1.0`. Deliberate — we never publish to a registry and
  never emit bare `v0.1.0`. Do not "fix" the format. `versionTag = {version}` in the playbook is a bare
  `{version}` for the same reason: `VERSION` already holds the whole tag, so do not let `flow init`
  re-add the `v`.

#### Changelog

`CHANGELOG.md` at the repo root keeps the user-facing entries, Keep a Changelog style adapted
to this repo's tag scheme:

- **Sections**: `Added` / `Changed` / `Fixed` / `Removed`. Omit empty sections. Newest release
  first; `[Unreleased]` always present at the top.
- **Entry voice**: one line, imperative ("Add…", "Fix…", "Remove…"), ≤ ~140 chars, phrased as
  what a user of the app notices — not the implementation. "Edit text files from the Files
  tab", not "wire `conversation_files_update` through the BFF".
- **Who writes them**: in the flow. Internal-only changes (refactors, CI, docs, test-only) need no
  entry; anything with user-visible behavior needs ≥1.
- **The bump commit renames the section**: the release-prep commit turns `## [Unreleased]` into
  `## [v<new-tag>] - <YYYY-MM-DD>` (that commit's date) and leaves a fresh empty `[Unreleased]` above it.
  `check-release-hygiene` requires the `[Unreleased]` heading *and* asserts `VERSION` equals the newest
  released section, so the rename and the VERSION bump are one commit or the branch is red — which is
  what keeps `VERSION` and the changelog consistent by construction.
- **`deploy-check`** re-asserts the same pair after the merge, from `main`, next to the tag at `HEAD`.
- **No links section** — private repo, no GitHub releases; do not add Keep-a-Changelog link references.

#### Docs sync (README and CONFIGURATION)

`README.md` (what the app is, architecture, how to run it) and `docs/CONFIGURATION.md`
(every environment variable and setting) describe the **shipped product**, so a release must not be cut
from a tree whose docs describe the previous one.

- **Primary place — the change's own commit**: any change that adds or changes an env
  var, setting, port, sidecar, default, or user-facing workflow carries its `README.md`
  and/or `docs/CONFIGURATION.md` update with it. That is where the knowledge is fresh and
  where the diff is reviewed together with the code.
- **The safety net is `pre-release`**: before asking **Release?**, reread what the branch actually
  changed and fix anything the per-change commits missed, in the same release-prep commit — the gate is
  about to check `VERSION` and the changelog and nothing checks the prose for you.
- A prose gate `deploy-check` cannot check: correctness of docs is a human/agent judgment at these two
  points, not an assertion.
