---
name: lettuce-coding-workers
description: 'lettuce external coding-worker mechanics: `subagent_type: "codex"` / "claude-code", the docker/codex shims on PATH, the workspaceWrite → externalSandbox rewrite, preflight commands (`codex --version`, `claude auth status --json`), CODEX_HOME / CLAUDE_CONFIG_DIR config rendering, Claude subscription (`claude setup-token`) vs endpoint auth, rollout and transcript files behind GET /api/codex/runs and /api/claude/runs, the codex_<thread>/claude_<session> agent ids, cwd of cron/channel workers, and the CODEX_VERSION / CLAUDE_CODE_VERSION pin sites. Read before touching docker/codex/, bff/src/codex/, bff/src/claude/, Settings → Codex/Claude Code workers, or the app-server Dockerfile.'
---

# Codex and Claude Code workers

Loaded from `AGENTS.md`. letta-code spawns the real CLIs; a shim makes them fit this container, and the Settings switch decides whether they run at all.

Extracted from `AGENTS.md`; keep both in sync when you change either, and keep `docs/upstream-notes.md` pointers working.

- **Codex workers: letta-code runs them, a shim makes them fit this container.** Since 0.33,
  `Task` / `launch_subagent` accept `subagent_type: "codex"` and spawn `codex app-server
  --stdio` from PATH (`tools/impl/external-coding-agent.ts`, `codex-app-server.ts`). Our
  app-server image (`docker/codex/Dockerfile`) installs the real CLI under `/opt/codex` only
  when the `codex` profile token is in `CODING_FEATURES` (see "Compose profiles are the one
  feature list" in `AGENTS.md`), and always puts `docker/codex/codex-shim.mjs` on PATH as `codex` — with the
  CLI absent the shim's preflight fails with ENOENT and the task reports it. Upstream
  unmodified.
  - The shim's one rewrite: letta hard-codes `sandboxPolicy: workspaceWrite` on every
    `turn/start`, Codex builds that with bubblewrap, and Docker's default seccomp/AppArmor
    refuse it — so the shim rewrites that field to `{type: "externalSandbox"}` and passes
    every other byte through. A worker therefore has the same reach as an agent shell (the
    whole container, other agents' memory included) and Codex enforces nothing, network
    included — the UI offers no network toggle. Spike detail (`use_legacy_landlock`,
    `requirements.toml` `allowed_sandbox_modes`, the placeholder `auth.json`):
    docs/upstream-notes.md#codex-spike-findings-2026-09-27-codex-01571-measured-in-the-container.
  - **The preflight is `codex --version`** (since 0.33.3). With workers disabled the shim fails
    it, so the task reports "Codex executable is not ready: <our disabled message>".
  - **Configuration is Settings → Codex workers, owned by the BFF** (`bff/src/codex/`). It
    stores `lettuce.json` in `CODEX_HOME=/root/.letta/codex` (persisted, so threads survive
    recreates and `SendAgentMessage` follow-ups can resume them) and renders `config.toml`
    (provider `lettuce`, `wire_api = "responses"` — the endpoint must serve `/v1/responses`,
    which llama.cpp does) and `auth.json` from it, on every save and every upstream connect.
    The API key never goes back to a browser. `lettuce.json` is also the switch: the shim
    refuses to run until it says `enabled`, and that refusal is what a task reports. With the
    `codex` token off the connect-time reapply writes `enabled: false` regardless of the stored
    switch and the settings save route 404s — the endpoint and key survive, only the switch
    resets.
  - **The settings file was renamed from `letta-ui.json`, and both names are live on purpose.**
    The shim that reads it ships inside the app-server image, which is only rebuilt when
    letta-code is bumped, so the BFF reads new-then-old and mirrors every write into the old
    name (`bff/src/internal-tools/legacy.ts`, the `*_LEGACY_PATH` constants). Same for
    `/opt/lettuce/features` (written by the image, read by the BFF, old path tried second) and
    `LETTUCE_SPAWN_DIAG_OFF` (which still accepts `LETTA_UI_SPAWN_DIAG_OFF`). Do not delete the
    fallbacks until the pinned image postdates the rename.
  - **letta keeps only a worker's final message.** The full run lives in Codex's rollout,
    `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`, appended live. Thread
    ids are UUIDv7, so the day directory comes from the id. `GET /api/codex/runs[/:threadId]`
    parse it (`codex/rollout.ts`); the viewer polls while a run is going. The task notification
    carries `agent_id=codex_<thread id>` (success only), which is how a transcript entry links
    to its run. The live `update_subagent_state` snapshot does **not** carry it (`agent_url`
    stays null for external workers), hence the "Codex runs" list in Tasks.
  - **cwd is whatever the parent runtime's is:** `/work/<agent-id>` for UI conversations, but
    `/work` for a runtime started without a cwd (cron- and channel-fired ones).
  - Upstream drift to watch: the shim depends on letta's `turn/start` shape and the preflight
    command; re-verify both on every letta-code or Codex bump (`CODEX_VERSION` is pinned in
    compose, never floated).
- **Claude Code workers: the same arrangement, minus the sandbox rewrite.** Since 0.33 upstream
  also accepts `subagent_type: "claude-code"` and spawns `claude --print --input-format
  stream-json --output-format stream-json …` with the prompt on stdin
  (`tools/impl/claude-stream-session.ts`). The image installs the real CLI under
  `/opt/claude-code` only when the `claude` profile token is in `CODING_FEATURES` (like Codex
  above) and always puts `docker/codex/claude-shim.mjs` on PATH as `claude`; the shim rewrites
  nothing (argv and stdin pass through verbatim) — its whole job is env injection and the
  switch.
  - **Two auth modes, `mode` in `lettuce.json`** (in `CLAUDE_CONFIG_DIR=/root/.letta/claude`,
    on the letta-home mount; absent `mode` = `endpoint`, which is what every file saved before
    the mode existed holds). There is no config file to render; the shim injects env, each
    variable only if not already in the env (`claude-shim-core.mjs` `buildEnv`).
    - `subscription`: the long-lived OAuth token `claude setup-token` prints (run on any machine
      with a browser; nothing logs in inside the container), injected as
      `CLAUDE_CODE_OAUTH_TOKEN`, plus `ANTHROPIC_MODEL` only when `subscriptionModel` is set. The
      shim sets **no** `ANTHROPIC_BASE_URL` (it would send the subscription token to a proxy) and
      **no** placeholder `ANTHROPIC_AUTH_TOKEN` (it outranks the OAuth token in Claude Code's auth
      order and would shadow it). It also **deletes** any of `ANTHROPIC_BASE_URL`,
      `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` it inherited (`SUBSCRIPTION_UNSAFE_ENV`), the
      one exception to "the environment wins".
    - `endpoint`: Claude Code speaks only the Anthropic Messages API, which llama.cpp does not
      serve, so this takes a user-supplied Anthropic-compatible base URL (a LiteLLM-style proxy
      or any Anthropic-API gateway), a model id and an optional token → `ANTHROPIC_BASE_URL`,
      `ANTHROPIC_MODEL`, `ANTHROPIC_AUTH_TOKEN`.
    - Each mode keeps its own write-only token and model (`authToken` + `model`, `oauthToken` +
      `subscriptionModel`), so a switch never sends one mode's model id to the other's API. The
      browser sees only `hasAuthToken` / `hasOauthToken`, and its Save sends only the visible
      mode's fields.
    - The subscription token is readable by every command a worker runs (it is in the worker's
      env) and by every agent shell (`lettuce.json`). Claude Code's own
      `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` needs bubblewrap, which the image deliberately lacks
      (see the sandbox note in `AGENTS.md`), so it cannot help here. The exposure is documented
      in Settings and `docs/CONFIGURATION.md`, not mitigated.
  - **The preflight is `claude auth status --json`** and needs `{"loggedIn": true}` on stdout
    with exit 0 — measured on 2.1.285 and 2.1.289: any `ANTHROPIC_AUTH_TOKEN` value satisfies it,
    so in endpoint mode the shim injects a placeholder when none was configured (a proxy that
    checks the token fails honestly at request time); `CLAUDE_CODE_OAUTH_TOKEN` alone satisfies it
    too (`authMethod: "oauth_token"`), unvalidated, so a bad or expired subscription token also
    fails only at the first request. Disabled workers: the shim refuses every call with our message,
    which the task reports as "claude-code authentication is not ready: …".
  - **Runs live in Claude's own transcripts**, `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/
    <session-id>.jsonl` (slug = absolute cwd, non-alphanumerics → `-`), appended live. Session
    ids are plain UUIDv4 — not Codex's UUIDv7 — and the listing has no mtimes, so recency comes
    from each file's newest entry timestamp and "running" is a 5-minute-since-last-entry
    heuristic. `GET /api/claude/runs[/:sessionId]` parse it leniently (`claude/transcript.ts`;
    the format is internal to Claude Code and may change between versions). The task
    notification carries `agent_id=claude_<session id>`.
  - Pin site: `CLAUDE_CODE_VERSION` in compose (build arg + image tag), like `CODEX_VERSION` —
    separate from `LETTA_CODE_VERSION` and not checked by `check-version-pin`. The shim depends
    on the preflight shape and the stream-json flags; re-verify on every bump.
  - **A shim change reaches prod only with a new image tag.** The tag names version pins, not
    shim content, and `compose up` without `--build` keeps the old image — so a change to
    `claude-shim*.mjs` ships together with a `CLAUDE_CODE_VERSION` bump (subscription mode came
    with 2.1.289), and that recreates `app-server`.
