---
description: The gated prod release — release PR, explicit confirmation, immediate tag, operator redeploy
argument-hint: "--minor | --patch | --auto"
---
You are about to release to production. Read the "Stop before releasing to prod" section of
`AGENTS.md` and the `lettuce-releasing` skill first, then:

1. Preflight. `main` must be checked out, clean, level with `origin/main`, and `bun run verify`
   green. If the `[Unreleased]` changelog range changed anything `README.md` or
   `docs/CONFIGURATION.md` describes, make that docs commit on `main` now (it must be its own
   commit — `release.ts` stages only `VERSION` and `CHANGELOG.md`).
2. Choose the bump. `--minor` for new or changed user-facing functionality, `--patch` for
   everything else; `--auto` derives it from the `[Unreleased]` headings (falling back to the
   commit subjects) and prints its reasoning — always read the reasoning before you go on.
3. `bun run release --auto --pr` (or `--minor`/`--patch --pr`). This opens the release PR —
   branch `release/<tag>` with the `VERSION` bump and the `[Unreleased]` rename — and deploys
   and tags nothing. Stop for the human to merge it: you do not merge a release PR on your own.
   Where `main` still takes direct pushes, the one-shot `bun run release --minor` is the same
   sequence in one command.
4. After the release PR merges, the tag is cut immediately, as part of the release. Before running
   anything, show the human the preflight and ask for explicit confirmation: the commit range,
   whether `docker/compose.yml` changed, and which containers get recreated (call out an
   `app-server` recreate: it kills every in-flight turn with no drain). The harness also blocks
   `git push` and `git tag -a` until the operator confirms. Never type the confirmation yourself
   and never reuse an earlier yes.
5. `bun run release --deploy`. It refuses unless `origin/main`'s tip is that release commit, runs
   `deploy-check`, asks for the exact tag, then pushes `main` (one-shot mode) and the tag.
   The prod redeploy from `origin/main` and its verification are the operator's own, done with
   their deploy tooling after the tag is out; the BFF log there must show
   `Upstream connected: letta-code <pinned version>`.
6. Do not substitute ad-hoc calls of the operator's deploy tooling, and never merge a release PR
   yourself.
7. On any failure, stop and report — no retry, no rollback, no restart without the user choosing
   it.
