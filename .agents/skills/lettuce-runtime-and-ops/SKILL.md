---
name: lettuce-runtime-and-ops
description: 'lettuce runtime/ops mechanics: the LLM timeout bounds prefill and not generation (env names, parse rules, createLocalProviderFetch is dead code, a change recreates app-server), agent web apps on ports 3000-3099 with the serving-web-apps skill and the never-bind-mount-repo-files rule, agent-installed tools in /opt/agent-tools (image ENV, PATH appended, the profile.d re-append for login shells), and why "Subagent process exited with code unknown" means the spawn failed (init: true reaping, pids.max, EAGAIN, the spawn-diagnostics preload). Read before touching LLM timeout env, docker/compose.yml env for app-server, AGENT_APP_PORTS, the agent-tools ENV in docker/codex/Dockerfile, or debugging failing subagent spawns.'
---

# App-server runtime limits and ops traps

Loaded from `AGENTS.md`. Timeouts, ports, and the two things that break spawns.

- **The LLM timeout bounds prefill, not generation — and there is no idle timeout.** A
  streaming fetch resolves on headers, so the clock covers connect + queueing + prompt eval
  and stops the moment tokens start; a long generation is never cut off and a stalled stream is
  never rescued. `docker/compose.yml` raises the 5-minute default to 30 for the app-server.
  Env names, most specific first: `LETTA_CODE_OPENAI_COMPATIBLE_TIMEOUT_MS`,
  `OPENAI_COMPATIBLE_TIMEOUT_MS`, `LETTA_CODE_LOCAL_PROVIDER_TIMEOUT_MS`; a stored `timeout` on
  the provider record outranks all of them; values parse as ms, `600s`, `10m`, or `false` to
  disable — **an unparseable value throws**. A timeout **is** retryable (`"timed out"` in
  `RETRYABLE_LOCAL_PROVIDER_DETAIL_PATTERNS`); a GPU fault like
  `vk::Queue::submit: ErrorDeviceLost` classifies as `local_backend_error` and ends the turn.
  `createLocalProviderFetch` is dead code — do not "fix" a timeout by editing it. Changing this
  env means recreating `app-server`, which drops the BFF's permanent upstream connection.
  Internals walkthrough (`DEFAULT_LOCAL_PROVIDER_TIMEOUT_MS`, `fetchWithTimeout`, the dead
  `createLocalProviderFetch`): docs/upstream-notes.md#llm-timeout-internals.

- **Agent web apps: ports 3000-3099, taught by a skill.** A server an agent starts runs inside
  the app-server container, reachable from the LAN only on the published range 3000-3099
  (`AGENT_APPS_BIND`, default `0.0.0.0`). Agents learn it from the global skill
  `docker/agent-skills/serving-web-apps` — a skill because letta-code lists every skill's name
  and description in context each turn, so the rule reaches every agent, cron and channel
  turns included, without touching anyone's memory. It ships in the **bff image** and
  `bff/src/agent-skills.ts` writes it into `/root/.letta/skills/` over the upstream connection
  on every connect (`write_file` creates the directories), overwriting any agent edit.
  **Never bind-mount repo files into a service:** the prod deploy manager runs compose inside its own
  container, so a relative bind source (`./…`) names a path that does not exist on the host
  and the daemon mounts an empty directory — silently. Builds are fine (the context is
  streamed); anything from the repo must travel in an image. `AGENT_APP_PORTS` and
  `AGENT_APP_HOST` (the address to put in URLs, from `docker/.env`) are in the app-server env
  for it. No auth in front of those ports, and the processes die with the container. The
  skill's frontmatter `name` must match its directory.

- **Agent-installed tools live in `/opt/agent-tools`, by image ENV.** A recreate wipes the
  container layer, so `npm i -g` into `/usr/local` or the uv installer into `~/.local` did not
  last. `docker/codex/Dockerfile` sets `NPM_CONFIG_PREFIX`, `CARGO_HOME`, `GOBIN` and the
  `UV_*` dirs to `/opt/agent-tools`, the `tools/` bind mount under
  `LETTA_STATE_DIR`, and **appends** its bin dirs to `PATH`. Appended, never prepended: the
  container's own `letta server` resolves through `PATH`, so an agent's
  `npm i -g @letta-ai/letta-code` would otherwise replace the pinned server on the next start,
  and the `codex`/`claude` shims with it. ENV, not compose, so `docker exec` shells and anything
  else run from the image get the same view. **Login shells lose the PATH part:** Debian's
  `/etc/profile` resets `PATH` for root, and letta-code's `exec_command` tool and the coding
  workers run `bash -lc`, so `/etc/profile.d/agent-tools.sh` appends `AGENT_TOOLS_PATH` again
  (the other variables survive). uv is `only-managed`, so its tool environments never point at
  the image's `/usr/bin/python3`. Caches stay off the mount (uv's `~/.cache/uv` with
  `UV_LINK_MODE=copy`, Go's module cache under the default `GOPATH`), so a state backup carries
  only what cannot be downloaded again. A change to that block reaches a host with the next
  release's image tag, like any other image change. **Cron jobs get none of this env**
  (`PATH=/usr/bin:/bin`, not even `node`): `/usr/local/bin/agent-env` (`docker/codex/agent-env`)
  re-runs a command with PID 1's environment, i.e. the image ENV plus compose's, and is for cron
  only — agent shells take their env from letta-code's `getShellEnv`, which adds per-agent values
  PID 1 lacks. At every start the base image's entrypoint copies the files in
  `/root/.letta/system-cron/` into `/etc/cron.d` and never deletes one (stopping a job means
  removing both copies), and replaces root's crontab with `/root/.letta/system-crontab/root`,
  else `crontab -r`, so `crontab -e` is cleared. That folder is where a cron job survives, and
  what the Tasks tab lists read-only (`GET /api/system-cron`, `bff/src/system-cron.ts`): the skill's
  `# agent:` header names the owner, mapped to its top-level agent so a subagent's job is not
  orphaned. What
  no variable covers (verified release downloads, the Go toolchain replaced whole, uv for Python,
  Rust only prebuilt via cargo-binstall since the image has no C linker, `Wake` vs cron, no apt)
  is in `docker/agent-skills/installing-tools`. The image's own
  `npm install --global --prefix /opt/codex|/opt/claude-code` is explicit, so the new default
  prefix does not move it.

- **"Subagent process exited with code unknown before returning a result" = the spawn failed.**
  Subagents are child `letta` processes (`executeSubagent`); on Node a null exit code *and*
  signal comes only from the child's `error` event, and `spawnSubagentProcess` discards that
  error, so stderr is empty and no errno survives. Two things of ours around it:
  - `init: true` on `app-server`, so PID 1 reaps orphans. Without it, backgrounded processes
    stay zombies against the cgroup's `pids.max` until a recreate — near the cap, spawns fail
    with `EAGAIN`. Diagnosis story: docs/upstream-notes.md#zombie-eagain-diagnosis-2026-09-29.
  - `docker/codex/spawn-diagnostics.cjs`, preloaded into every node process in the image
    (`ENV NODE_OPTIONS=--require …` in the Dockerfile, never compose: a missing `--require`
    target kills every node process). It logs `[lettuce spawn-diag] spawn failed: <errno>
    file=… cwd=… pids=<current>/<max> zombies=<n>` to stderr, i.e. `docker logs` for the server
    and the "stderr tail" of a failing child's parent. Observe-only: it wraps
    `ChildProcess.prototype.emit` and never adds an `error` listener.
