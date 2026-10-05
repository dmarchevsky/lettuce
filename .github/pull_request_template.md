<!--
What the reviewer needs to say yes to. Delete nothing: an empty section is a
failed gate, not a shortcut. See AGENTS.md → Definition of done.
-->

## What changes, and why

One paragraph. If it is a fix, name the symptom a user would see.

## How I tested it in the container

The only gate that proves it works. CI cannot do this part.

- [ ] `bun run verify` green in this worktree
- `docker compose -f docker/compose.yml build bff && docker compose -f docker/compose.yml up -d`
  (unscoped, from this worktree — copy `docker/.env` in first)
- **What to click:**
- **What should happen:**
- Tested by (who ran it, and their answer):

## Release hygiene

- [ ] `CHANGELOG.md` `[Unreleased]` entry added, or this PR is labeled `bump:none`
- Bump label: `bump:minor` / `bump:patch` / `bump:none` (pick one; CI derives it if missing)
- [ ] `README.md` / `docs/CONFIGURATION.md` updated — or tick: no config or user-workflow change
- [ ] `bun run ui-check` green (any `web/` change)
- [ ] `bun run smoke` green (BFF session, protocol or settings change)

## Notes for the reviewer

Anything you want looked at specifically, and anything you knowingly left out.
