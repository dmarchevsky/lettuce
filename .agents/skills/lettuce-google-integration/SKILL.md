---
name: lettuce-google-integration
description: 'lettuce Google integration mechanics: the google-mcp sidecar and its --permissions level table, the BFF''s OAuth consent invariants (scope narrowing revokes, a revoke is grant-wide, never revoke on reconnect), the google-policy and google-creds volumes and why they are never mounted into app-server, the curated gmail_/calendar_/tasks_/contacts_ mod tools and the pinned tools/list fixtures to refresh on a WORKSPACE_MCP_VERSION bump, token-loss detection and reconnect links, and the dev-bypass hole. Read before touching bff/src/google/, docker/google-mcp/, Settings → Google, or any OAuth scope level.'
---

# Google (Gmail, Calendar, Tasks, Contacts)

Loaded from `AGENTS.md`. The sidecar is reachable by anything in the container; what it may do is fixed in two places no agent can change.

Extracted from `AGENTS.md`; keep both in sync when you change either, and keep `docs/upstream-notes.md` pointers working.

- **Google (Gmail / Calendar / Tasks / Contacts) is a sidecar whose access no agent can change.**
  Agents reach `http://google-mcp:8000/mcp` (`docker/google-mcp`:
  taylorwilsdon/google_workspace_mcp, pinned `WORKSPACE_MCP_VERSION`, under `supervisor.py`),
  listed in the shared MCP list while it serves. The `google` token gates all of it: with the
  token off, reapply and status run on effective settings (stored switch forced off, sidecar
  config and MCP-list entry out) while the stored client, switch and grant survive, and the
  settings save route 404s. Reaching it is not the control — agent shells
  reach everything. What it may do is fixed in two places no agent can touch:
  1. **The token's OAuth scopes.** The BFF runs the consent (`bff/src/google/`), asking for
     exactly the levels' scopes, never `include_granted_scopes`. Invariant: the token never
     holds a scope the policy does not want — narrowing a level **revokes** it, a consent that
     comes back wider is revoked unkept, and changing the OAuth client drops it. **A revoke is
     grant-wide** — it kills every refresh token this client issued, so a same-account
     reconnect must never revoke the old token first (it did, on prod 2026-09-28; story:
     docs/upstream-notes.md#google-revoke-on-reconnect-2026-09-28). Widening waits for a
     reconnect; meanwhile the sidecar runs at what the grant covers (`coveredPermissions`,
     which also handles scopes unticked on Google's consent screen).
  2. **workspace-mcp's `--permissions`**, which filters its tool list by the same scopes.
     `bff/src/google/policy.ts` mirrors its level → scope table (`auth/permissions.py`) —
     re-verify on every version bump. The supervisor also removes `start_google_auth` (else any
     agent can mint a consent link), sets `WORKSPACE_MCP_DISABLE_LOCAL_FILES=true`
     (**load-bearing**: without it tools accept server-side `file_path`, and an agent could
     mail itself `/creds`), and launches from a clean env so no `WORKSPACE_MCP_*` fallback
     widens it.

  Both live on the `google-policy` / `google-creds` volumes, mounted by `bff` and `google-mcp`
  **only — never mount them into `app-server` or `channel-gateway`.** The token file is
  workspace-mcp's own format (`<email>.json`, `LocalDirectoryCredentialStore`); single-user
  mode uses the first file it finds, so connecting clears the directory first. The supervisor
  polls `sidecar.json` and restarts on change; disabled means nothing listens.

  **Dev bypass is the hole.** Agent shells share the BFF's namespace, so in dev-bypass mode
  they can `curl 127.0.0.1:8080/auth/dev-login` and hold a session. Google writes are
  therefore refused whenever `DEV_BYPASS_EMAIL` is set (`googleWritesAllowed`) unless
  `GOOGLE_ALLOW_DEV_BYPASS=true`. Every **other** setting (MCP list, Codex, agents) is still
  writable that way in local mode — a known gap, not fixed here. Behind Cloudflare Access an
  agent cannot mint a session. The OAuth callback is gated by its single-use `state`, not the
  cookie, so a `GOOGLE_OAUTH_REDIRECT_URI` on another origin (localhost) works.

  Limits by design: the sidecar holds one policy for every agent (a per-agent *boundary* would
  need per-agent containers; the Tools tab narrows who is *offered* what, see the
  `lettuce-per-agent-tool-access` skill), and allowed tools still combine — Calendar `full` can invite any address, which
  mails them even with Gmail read-only, and email content is prompt-injection input.

  **A token Google stops accepting is kept, marked lost — never silently dropped.**
  `google/lost-access.ts` recognises Google's own refusals (`invalid_grant`,
  `Token Expired/Revoked`, no credentials) in the curated tools and in `mcp_call` on the
  Google server, records `grant.lostAt` (`markLost`), and answers the agent with reconnect
  links built on `PUBLIC_ORIGIN`: `/api/google/reconnect` (GET, session- and write-gated —
  mints a consent `state` and 302s to Google) and `/?settings=google`
  (`lib/settings-link.ts`). Settings → Google leads with "Access lost for …" and a Reconnect
  button; opening it re-checks with Google (`checkIfDue`, at most every 5 min), and a refresh
  that works again clears `lostAt`. The `accessNotConfigured` mis-mark incident and the full
  design: docs/upstream-notes.md#google-token-loss-story.
- **Agents use Google through native tools, not the skill** (`bff/src/google/tools.ts`, the
  `lettuce-google-tools.mjs` mod): `gmail_search`, `gmail_read`, `calendar_events`,
  `calendar_freebusy`, `tasks_list`, `contacts_list`, `contacts_get` (reads, never ask) and
  `gmail_send`, `gmail_draft`, `calendar_event`, `tasks_update`, `contacts_update` (writes,
  `approval: "ask"`). Each is a compact schema mapped onto one workspace-mcp tool — its own
  schemas are large (`manage_event` has 32 parameters) and would ride in every turn's prefill.
  **Access control is unchanged:** a curated tool is registered only if the tool it maps to is
  in the sidecar's current `tools/list`, which `--permissions` and the granted scopes already
  filter, so read-only Gmail never shows `gmail_send`. `user_google_email` is left out:
  `--single-user` defaults it (and the bridge hides it from schemas). The mappings are pinned
  by a recorded `tools/list`
  (`bff/src/google/fixtures/workspace-mcp-<version>.{full,readonly}.json`, captured by running
  the pinned image with `--single-user --permissions …` and a dummy OAuth client — listing
  needs no token) and `google/tools.test.ts` checks every mapped tool, argument and read/write
  marking against it. **Refresh the fixture on every `WORKSPACE_MCP_VERSION` bump.**
  Everything else Google offers (labels, filters, focus time…) is reachable through the MCP
  bridge.
