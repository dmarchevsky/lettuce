---
description: Bump letta-code to a published release tag and report the drift it causes
argument-hint: "<vX.Y.Z>"
---
Bump the upstream checkout to the letta-code release `<vX.Y.Z>` given above (a published tag —
never `main`; if no tag was given, ask for one). Read the `lettuce-upstream-sync` skill first,
then:

1. `bun run sync-upstream <vX.Y.Z>`. It refuses a dirty `letta-code/` checkout, checks the
   checkout out at the tag, re-pins every version site and typechecks.
2. Read the reported drift. Typed drift means `bun run typecheck` is already failing — fix it.
   Behavioural drift is the dangerous kind: check each file the script names
   (`connection-lifecycle.ts`, the channel gateway supervisor and gateway-local,
   `background-process-protocol.ts`, `toolset-catalog.ts`, `AskUserQuestion`) against the
   invariants in `AGENTS.md` and the matching skill, and say what each change means for us.
3. If `check-version-pin` warns about `docker/.env` or a shell `LETTA_CODE_VERSION`, say so —
   that precedence once hid a stale pin for a whole cycle.
4. `bun run verify` green, commit in a flow on a feature branch, and remember this is a **full
   redeploy** (new app-server base image, new channel-gateway image): recreating `app-server` drops the
   BFF's permanent upstream connection and every in-flight turn, so it goes through the normal release
   gate with the `app-server` recreate called out when the flow asks **Release?**.
