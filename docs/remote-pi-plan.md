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
- Native tools reach agents as **mods** (`bff/src/internal-tools/mod.ts`): a file in the
  app-server's `~/.letta/mods` whose tools POST args to the loopback-only
  `http://127.0.0.1:<bff>/internal/tools/<name>` route; the work lives in the BFF. Listener
  turns (chats, crons, channel) get mod tools; **subagent turns do not** (providers-only
  profile). A mod cannot import npm packages and reloads only on `reload`.
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

_Pending task-0 (host access). Recorded here as command + trimmed output, no hostnames,
IPs (outside RFC 5737) or keys._

Runbook the spike will execute (`HOST` = operator-provided `user@host[:port]`, everything
local-machine `ssh`, nothing installed on the remote):

```bash
SSH='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10'
# 0. readiness: $SSH HOST 'pi --version' && $SSH HOST 'mkdir -p ~/lettuce-pi-spike'
# 2. Spike A, single-shot json mode:
$SSH HOST 'cd ~/lettuce-pi-spike && pi --mode json "Reply with exactly: PI-SPIKE-OK"' \
  > spike-a.jsonl                     # first line is the session header, last agent_settled
# 3. Spike B, iteration on the same session:
sid=$(head -1 spike-a.jsonl | jq -r .id)
$SSH HOST "cd ~/lettuce-pi-spike && pi --mode json --session $sid \
  'What word did I just ask you to reply with?'" > spike-b.jsonl   # answer must be PI-SPIKE-OK
# 3b. locate + fetch back the growing transcript:
$SSH HOST "ls ~/.pi/agent/sessions/*/*${sid}*.jsonl"
$SSH HOST "cat <that path>" > fetched.jsonl   # superset of spike-a+spike-b events
# cancellation probe: start a long run, kill local ssh mid-run, then check whether the
# remote pi process survived — decides whether § 4 needs explicit remote-kill semantics.
```

Dev-machine prerequisites checked (2026-10-05): local OpenSSH 10.0p2 (ControlMaster,
BatchMode supported), local pi 1.0.3 as flag reference. The dev machine currently has **no
SSH private keys or config** — the operator must supply the key or point at one.

## 4. Design decisions

**Decision pending** spike + operator pick. Options compared:

| | Mechanism | Upstream machinery | Costs |
|---|---|---|---|
| **A** | Masquerade: shim on PATH bridging the claude-code launch shape → `ssh host pi --mode json` (and stream-json ⇄ pi event translation both ways) | Full `Task` subagent machinery: `subagent_type: "claude-code"`, `update_subagent_state`, `claude_<uuid>` link, `--resume` follow-ups via `SendAgentMessage` | Collides head-on with the real Claude Code worker — one `claude` on PATH, one preflight, one id namespace; bidirectional protocol translation of an internal, version-drifting format |
| **B** | BFF-native mod tools (`pi_run`, `pi_send`, `pi_status`, `pi_runs`) on the loopback mod route; BFF spawns ssh, captures pi jsonl, owns run state | None from upstream; parity UI (Tasks list + viewer) is built by us over the captured jsonl, same viewer pattern as `bff/src/claude/transcript.ts` | Needs ssh client in the bff image (image is ours — today it has none); mod tools block their turn, so long runs must return a run id and be polled (`pi_run` starts, `pi_send` follows up on a session); subagent turns cannot see mod tools, so dispatch happens on the agent's own turns (fine — that's where dispatch lives) |
| **C** | Global skill: agent shells `ssh host pi …` itself (app-server image already has `/usr/bin/ssh`) | none | zero structure: no parity UI, no settings/switch, key lives in the container, nothing for the BFF to show |

Direction of travel (pre-spike, not yet binding): **B**. A's only unique benefit is reusing
upstream's Task plumbing at the price of hijacking another worker's identity; B keeps every
moving part in code we own, gets the UUID session id natively from pi's json header, and
reaches the confirmed UX bar through the existing viewer pattern.

Sub-decisions § 4 must settle (spike informs 1 and 4):

1. **Transcript collection**: capture the ssh stdout jsonl in the BFF as the run's durable
   copy (durable under `LETTA_STATE_DIR`, viewer never touches the remote) vs lazy
   fetch-back of the remote `~/.pi/agent/sessions/...` file per poll. Spike B measures
   whether fetch-back mid-run is as reliable as stream capture.
2. **Settings shape** (modeled on `bff/src/codex/settings.ts`): `enabled`, `host`, `port`,
   `user`, private key (stored server-side under the state dir, never returned to a
   browser — the `apiKey` precedent), `workdir`, optional `model`; plus a `known_hosts`
   pin with a first-connect TOFU affordance (`StrictHostKeyChecking=yes` always).
3. **Feature gate**: a `pi` virtual compose profile token, effective-enabled = token AND
   stored switch, exactly like `codex`/`claude` (Settings save route 404s while off).
   Unlike codex/claude, nothing needs baking into the *app-server* image for option B —
   the transport lives in the BFF (whose image gains `openssh-client`).
4. **Cancellation / liveness**: killing the local ssh does not reliably kill remote pi
   (spike probe records actual behavior). Decide whether Lettuce ever kills remote runs
   (`ssh host kill <pid>` — still within the nothing-installed rule) or simply detaches.
5. **Timeouts**: mod-call turn timeout vs detached run — the BFF should run ssh in the
   background and let tools poll, mirroring how Claude viewer treats "running" as recency.

## 5. Implementation milestones

_Drafted against option B (re-cut only if the spike overturns the choice). Each slice is a
PR per `AGENTS.md` workflow; the operator's container test is the merge gate on each._

0. **Spike** — done in this planning goal; its evidence fixes the transcript-collection and
   cancellation sub-decisions.
1. **BFF core** — `bff/src/pi/`: settings module mirroring `bff/src/codex/settings.ts`
   (schema, save/load, never echo the key), `pi` virtual profile token in
   `config.features`, ssh runner that spawns `ssh` (bff image gains `openssh-client`),
   streams the run's stdout jsonl into a durable per-run file under the state dir, and
   handlers for `pi_run` / `pi_send` / `pi_status` behind `/internal/tools/`. Gate:
   `bun run verify` + unit tests with a faked ssh runner.
2. **Mod + gating** — render the pi tools mod (disabled when the token or switch is off),
   per-agent tool-access rows, `enabled:false` semantics on token loss. Gate: `verify`,
   plus a live check that a chat turn can `pi_run` against the spike host.
3. **Runs + viewer** — lenient parser for pi's json event stream (json.md is the wire
   contract), `GET /api/pi/runs[/:sessionId]`, Tasks list row and transcript sheet
   (pattern: `bff/src/claude/transcript.ts` + its `web/` viewer); the `pi_run` tool return
   carries the session/run id so the transcript entry links to the run. Gate: `verify`,
   `ui-check`.
4. **Settings UI** — Settings → Remote pi worker (host/port/user/key/workdir/model, enabled
   switch, known_hosts TOFU pin), hidden when the `pi` token is off. Gate: `ui-check`,
   `deploy-check` after merge.
5. **Docs + follow-ups** — `README.md` / `docs/CONFIGURATION.md` entries, CHANGELOG per
   slice; follow-up work if the spike demands remote-kill: `pi_stop` as a separate slice.

## 6. Open questions

- Which host/key will the operator provide for the spike, and under which SSH user?
- Should a finished run's full transcript be copied down to the BFF (durable in
  `LETTA_STATE_DIR`) or fetched lazily from the remote on each viewer poll?
- Cancellation semantics: does Lettuce ever stop a running remote pi, and if so is
  `ssh … pkill -f` acceptable within the "nothing installed on the remote" rule?
