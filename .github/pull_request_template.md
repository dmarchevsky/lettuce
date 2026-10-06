<!--
What the reviewer needs to say yes to. Delete nothing: an empty section is a
failed gate, not a shortcut. See AGENTS.md → Definition of done.
-->

## What changes, and why

One paragraph. If it is a fix, name the symptom a user would see.

## Container test (done before this PR was opened)

This is the gate that proves it works, and CI cannot do it. The branch is only pushed once the
operator has run it in the container and said it works — so this section records a verdict, it is
not a checkbox to complete during review.

- [ ] `bun run verify` green in this worktree
- `docker compose -f docker/compose.yml build bff && docker compose -f docker/compose.yml up -d`
  (unscoped, from this worktree — copy `docker/.env` in first)
- **What was clicked:**
- **What happened:**
- **Tested by (who ran it, and their answer):**

## Release hygiene

- [ ] `CHANGELOG.md` `[Unreleased]` entry added, or this PR is labeled `bump:none`
- Bump label: `bump:minor` / `bump:patch` / `bump:none` (pick one; CI derives it if missing)
- [ ] `README.md` / `docs/CONFIGURATION.md` updated — or tick: no config or user-workflow change
- [ ] `bun run ui-check` green (any `web/` change)
- [ ] `bun run smoke` green (BFF session, protocol or settings change)

## Notes for the reviewer

Anything you want looked at specifically, and anything you knowingly left out.
