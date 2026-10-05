# Remote pi worker — implementation plan

Status: **DRAFT — spike pending**. Sections 1–2 are settled; sections 3–5 fill in as the
spike and design decisions land. This document is the deliverable of the "remote pi worker"
planning goal: a validated plan, not an implementation. No `bff/`, `web/` or `docker/` code
ships with this PR.

## 1. Goal and confirmed contract

Add a **remote pi worker** to Lettuce: a Letta agent dispatches a coding task to a
[pi](https://github.com/earendil-works/pi) installation that lives on a **remote host**,
reaches it over **SSH only**, can **iterate on the same pi session** with follow-ups, and
Lettuce shows runs and transcripts at **Codex/Claude-worker parity**.

Confirmed decisions (operator, 2026-10-05):

- **Deliverable:** this plan plus spike evidence captured against a real operator-provided
  host that already has pi installed. No skeleton code ships.
- **Dispatch contract:** the Letta agent dispatches to the remote pi (upstream cannot be
  patched, so a native `subagent_type: "pi"` is impossible). The mechanism — masquerade shim
  vs BFF-native tool — is chosen in § 4.
- **UX bar:** Codex/Claude parity — a Tasks run list, a transcript viewer fed from the
  worker's own session files, and session-resume follow-ups.
- **Out of scope:** a human-interactive pi chat UI, pi-orchestrates-pi, provisioning pi on
  the remote host, anything installed on the remote beyond pi itself.

## 2. Prior art and constraints

### 2.1 Upstream letta-code (pinned 0.34.1, read-only)

- `letta-code/src/tools/impl/external-coding-agent.ts`
  - `EXTERNAL_CODING_AGENT_TYPES = ["claude-code", "codex"]` — **the set is closed**. The
    executable is hard-coded (`"claude"` / `"codex"` from PATH), and so are the preflights
    (`claude auth status --json` must print `{"loggedIn": true}`; `codex --version` must
    exit 0). There is **no knob to point a worker at a different CLI**, so "pi as a
    subagent" must either reuse one of the two slots or live outside the `Task` machinery.
  - External worker agent ids are `<prefix>_<session id>` with a strict UUID pattern
    (`NATIVE_SESSION_ID_PATTERN`, prefixes `claude_` / `codex_`). Anything the task
    notification reports for `agent_id` must be a UUID session id for the link to parse.
  - The claude-code launch shape: `claude --print --verbose --input-format stream-json
    --output-format stream-json --permission-mode acceptEdits --allowed-tools …
    [--model X] [--resume <id>]`, prompt on stdin. `--resume <session id>` is how
    follow-ups (`SendAgentMessage`) continue a worker.
  - `letta-code/src/tools/impl/claude-stream-session.ts` additionally keeps long-lived
    streaming claude sessions with steering; resume is again `--resume <sessionId>`.
- Consequence: a "pi masquerading as claude-code" would **collide with the real Claude Code
  worker** (exactly one `claude` on PATH, one preflight, one `claude_` id namespace), and
  would have to translate claude stream-json ⇄ pi's protocol both ways. This is decision
  material for § 4, recorded here as the cost of the masquerade path.

### 2.2 The worker pattern we must reach parity with

- PATH shims (`docker/codex/codex-shim.mjs`, `docker/codex/claude-shim.mjs`): preflight
  contract, `lettuce.json` switch, env injection. The BFF renders config into the
  letta-home mount on save and on every upstream connect
  (`bff/src/codex/settings.ts` — `apiKey` never returns to a browser).
- Run viewers parse the CLI's own transcript files leniently:
  `bff/src/claude/transcript.ts` (Claude session jsonl, 5-min recency heuristic for
  "running") and `bff/src/codex/rollout.ts`, served by
  `GET /api/claude/runs[/:sessionId]` and `GET /api/codex/runs[/:threadId]`
  (`bff/src/index.ts`), with a Tasks run list and a polling transcript sheet in `web/`.
  **For a remote worker there is no local transcript file** — § 4 must decide where the
  jsonl lives (pull from the remote host vs capture the stdout stream locally).
- cwd of spawned workers: `/work/<agent-id>` for UI conversations, `/work` for cron/channel
  runtimes — relevant only if a shim runs locally and ssh-es out.

### 2.3 pi's headless contract (pi docs @ 1.0.3)

- **Modes** (`docs/cli-integration.md`): print (final text; nonzero exit on
  error/abort stop reason; auto-selected when stdin/stdout are not TTYs), `--mode json`
  (one-shot JSONL events then exit), `--mode rpc` (long-lived bidirectional JSONL over
  stdio), and the SDK. All modes share the same sessions and tools.
- **JSON mode** (`docs/json.md`): strict JSONL, LF framing only; stdout is JSONL-only,
  diagnostics go to stderr. **The first record is a session header carrying the session
  `id`** — so a dispatch over SSH learns the remote session id from the stream itself.
  Events: `agent_start` / `turn_start` / `message_start|update|end` (deltas, authoritative
  on `message_end`) / `tool_execution_*` / `agent_end` / `agent_settled` (end of automatic
  work). Caveat for implementers: split on LF only — Node `readline` mis-splits on Unicode
  line separators pi allows inside strings.
- **Sessions** (`docs/sessions.md`, `docs/session-format.md`): JSONL under
  `~/.pi/agent/sessions/--<cwd-slug>--/<timestamp>_<uuid>.jsonl` by default (overridable
  with `--session-dir` / `PI_CODING_AGENT_SESSION_DIR`); the session id is a **UUID** —
  which satisfies letta-code's agent-id pattern if we ever need it. Continuation is
  `pi --session <id|path> "next prompt"` (or `--continue` for newest in cwd); the file is
  appended live, so **incremental fetch-back over SSH yields a growing transcript** — the
  same shape the Claude viewer consumes locally today.
- **RPC mode** is the upgrade path for interactive-ish iteration (steering, `get_state`),
  and works over any stdio pipe — including one over SSH. Deferred: one-shot json +
  `--session` resume covers the confirmed UX bar with far less state.
- Remote-host prerequisites are the whole installation story: pi installed and its
  providers configured non-interactively (settings/env), plus a working directory for pi to
  operate in. Nothing else may be installed there — no daemon, no watcher, no helper; every
  remote action is a plain `ssh host pi …` invocation.

### 2.4 Environment facts (measured on the pinned images, 2026-10-05)

- The app-server image (`letta/letta:0.34.1` + our additions) **has `/usr/bin/ssh`** — a
  worker shim spawned by letta-code could ssh out directly.
- The BFF image (`oven/bun` base, `docker/bff.Dockerfile`) **has no ssh client**. BFF-driven
  dispatch (§ 4 option B) means adding `openssh-client` to the BFF image (ours to change)
  or a pure-JS SSH implementation.
- Keys/config must live under `LETTA_STATE_DIR` (the one host root for durable state), and
  the Settings-save pattern (§ 2.2) is the precedent for storing a host, user, port and
  private key server-side without ever returning the secret to a browser.
- Virtual compose profile tokens (`codex`, `claude`) are the precedent for gating a worker
  feature; a `pi` token would follow `AGENTS.md` "Compose profiles are the one feature
  list".
- SSH hardening baseline (client-side only, standard OpenSSH): key-only auth
  (`BatchMode=yes`, no passphrase agent — a dedicated unencrypted deploy key or ssh-agent
  decision in § 4), pinned `known_hosts` (`StrictHostKeyChecking=yes`), no password auth,
  optional `ControlMaster`/`ControlPersist` to amortize connection setup across follow-ups.

## 3. Spike evidence

_Pending task-0 (host access), task-2 (single-shot), task-3 (session iteration +
fetch-back). Recorded here as command + trimmed output, no hostnames, IPs (outside RFC
5737) or keys._

## 4. Design decisions

_Pending. Options to compare, at minimum: (A) masquerade `claude-code` slot with a pi
bridge shim (upstream subagent machinery for free; costs: collides with real Claude Code
worker, bidirectional protocol translation, claude_ id namespace); (B) BFF-native mod
tools `pi_run` / `pi_send` on the loopback route (clean, our code end to end, native
session ids; costs: no Task/update_subagent_state machinery, needs ssh client in the BFF
image); (C) agent-shell path — a global skill instructing the agent to `ssh host pi …`
directly (zero new code; no parity UI, no structure). Plus sub-decisions: transcript
collection (fetch-back of remote jsonl vs capture stdout jsonl locally), settings shape,
profile token, timeouts and cancellation (note: killing the local ssh process does not
kill the remote pi — must decide remote kill semantics)._

## 5. Implementation milestones

_Pending § 4._

## 6. Open questions

- Which host/key will the operator provide for the spike, and under which SSH user?
- Should a finished run's full transcript be copied down to the BFF (durable in
  `LETTA_STATE_DIR`) or fetched lazily from the remote on each viewer poll?
- Cancellation semantics: does Lettuce ever stop a running remote pi, and if so is
  `ssh … pkill -f` acceptable within the "nothing installed on the remote" rule?
