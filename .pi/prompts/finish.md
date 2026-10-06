---
description: Implement through the local run and the user's test, then open the PR; stop before merge and release
---
Take the current change through `AGENTS.md`'s "Definition of done", stopping before anything reaches
`main`. Read the `lettuce-pr-and-ci` skill first — it has the guard, CI and merge details. In order:

1. `bun run verify` green, in the worktree you are in. Fix and re-run until it is.
2. The changelog and docs duty: a user-visible change needs a `CHANGELOG.md` `[Unreleased]`
   entry in the same commit, plus `README.md` / `docs/CONFIGURATION.md` updates if it touched the
   configuration surface or a user-facing workflow. Pick the `bump:minor` / `bump:patch` /
   `bump:none` label that matches — `check-release-hygiene` fails the PR if a change to `bff/`,
   `web/` or `docker/` has no entry and no `bump:none`. Read the `lettuce-releasing` skill for the
   voice and rules.
3. Commit on the branch (never on `main`). Commit and push are **separate commands** — the guard
   blocks a whole compound line that contains `git push`, so `git add && git commit && git push`
   silently does none of it.
4. Build and run it locally from this worktree. A worktree has no `docker/.env` (gitignored), so
   copy it in first (`cp ../../docker/.env docker/.env`) — without it the state-dir default lands
   inside `.worktrees/`:
   `bun run build:bff && docker compose -f docker/compose.yml up -d` — unscoped, never scoped to
   `app-server`, and never `up -d` without a build for a UI change. Say plainly that the local
   stack is shared, so anything else being tested on this machine just got replaced by this branch.
5. **Stop for the human verification gate.** Name what to click and what should happen, then wait
   for them to run it in the container and say it works. Nothing replaces this gate — not the type
   check, not the tests, not CI — and **untested code does not leave the machine**. If it fails, go
   back to step 1 with their feedback and do not open a PR yet.
6. Only now push the branch (`git push -u origin <branch>`) and open the PR with `gh pr create`,
   filling in `.github/pull_request_template.md`. The container test is recorded there as something
   that already happened — who ran it and what they answered — not as a box to tick during review.
   A long body goes in a `--body-file`, because a body that quotes a blocked command gets the `gh`
   call blocked.
7. **Hand over again and wait:** CI goes green, and the human merges — or tells you to merge *that*
   PR. You do not merge on a general "continue", and you never approve your own PR.
8. Once they merge it, run `bun run cleanup` (plain first, then `--apply` and type the phrase it
   prints). It removes this worktree and branch only if the PR merged, the tree is clean and no
   process has its cwd inside; any refusal means leave it and say why. Do not `git worktree remove`
   or `git branch -D` by hand — the script is the checked path, and it is the only thing that knows
   squash-merged branches are not "merged" as far as git cares.
9. After the merge, prove what ships from `main` (rebuild `bff`, `bun run deploy-check`, plus
   `ui-check` / `smoke` where they apply). **Do not push `main`, do not tag, do not touch prod**:
   the release is a separate, explicitly confirmed step (`/release`).
