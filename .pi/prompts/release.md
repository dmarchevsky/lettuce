---
description: The gated prod release — release PR, explicit confirmation, deploy, verify, tag
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
4. After the release PR merges, re-read the target from `dockhand.sh stacks letta` — never from
   memory — and compare it to the table in `AGENTS.md`. If it does not match, stop. Show the
   human the preflight and ask for explicit confirmation: the commit range, whether
   `docker/compose.yml` changed, which containers get recreated (call out an `app-server`
   recreate: it kills every in-flight turn with no drain), and the previous deploy's duration.
   The harness also blocks `git push` and `git tag -a` until the operator confirms. Never type
   the confirmation yourself and never reuse an earlier yes.
5. `bun run release --deploy`. It refuses unless `origin/main`'s tip is that release commit,
   runs `deploy-check`, prints the Dockhand plan, asks for the exact tag, then deploys →
   verifies → checks the BFF log for `Upstream connected: letta-code <pinned version>` → tags →
   pushes the tag.
6. If the `dockhand-deploy` skill is not installed on this machine, the release ends at the
   push: report the pushed commit range and say the prod redeploy is theirs. Do not substitute
   ad-hoc Dockhand API calls, and tag nothing that has not been verified.
7. On any failure, stop and report — no retry, no rollback, no restart without the user choosing
   it. A failed deploy is never tagged.
