---
description: Implement through the local run and the user's test, open the PR, stop before merge and release
---
Take the current change through `AGENTS.md`'s workflow and definition of done, stopping before
anything reaches `main`. Read the `lettuce-pr-and-ci` skill first — it has the guard and CI details.
In order:

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
5. Push the branch (`git push -u origin <branch>`) and open the PR with `gh pr create`, filling in
   `.github/pull_request_template.md` — the "how I tested it in the container" section is what a
   reviewer refuses if it is empty. A long body goes in a `--body-file`, because a body that quotes
   a blocked command gets the `gh` call blocked.
6. **Stop and hand over.** Name what to click and what should happen, then wait: the human tests
   it, CI goes green, and they merge — or tell you to merge *that* PR. You do not merge on a general
   "continue", and you never approve your own PR. If their test fails, go back to step 1 with their
   feedback.
7. Once they merge it, run `bun run cleanup` (plain first, then `--apply` and type the phrase it
   prints). It removes this worktree and branch only if the PR merged, the tree is clean and no
   process has its cwd inside; any refusal means leave it and say why. Do not `git worktree remove`
   or `git branch -D` by hand — the script is the checked path, and it is the only thing that knows
   squash-merged branches are not "merged" as far as git cares.
8. **Do not push `main`, do not tag, do not touch prod**: the release is a separate, explicitly
   confirmed step (`/release`).
