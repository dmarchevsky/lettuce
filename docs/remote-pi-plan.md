# Remote pi worker — implementation plan

Status: **plan complete — spike evidence included; awaiting operator review** (§ 6).
This document is the deliverable of the "remote pi worker" planning goal: a validated
plan, not an implementation. No `bff/`, `web/` or `docker/` code ships with this PR.

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
- **Exactly one ssh implementation, and it is a binary, not a library.** Inventory
  (2026-10-06): the lettuce dependency graph carries **no JS ssh library at all**
  (`ssh2`/`node-ssh`/`sshpk` absent from `bun.lock`); this feature's `Bun.spawn(["ssh", …])`
  in `bff/src/pi/service.ts` is lettuce's only ssh use, and upstream letta-code likewise
  only ever shells the system OpenSSH (`GIT_SSH_COMMAND="ssh -o BatchMode=yes"` for git).
  Image inventory: app-server and channel-gateway (`letta/letta` base) ship `/usr/bin/ssh`;
  `bff` gains `openssh-client` via apt on this branch; `google-mcp` and `ddg-mcp` have none
  (measured). Decision: the spawned OpenSSH client stays the one transport — a JS library
  would re-implement BatchMode, pinned-host verification and agent signing while losing
  `SSH_AUTH_SOCK` inheritance and `IdentityAgent`/`ControlMaster` for free.
- SSH hardening baseline (client-side only, standard OpenSSH): key-only auth
  (`BatchMode=yes`, a dedicated unencrypted deploy key generated by the BFF — § 4),
  pinned `known_hosts` (`StrictHostKeyChecking=yes`), no password auth,
  optional `ControlMaster`/`ControlPersist` to amortize connection setup across follow-ups.

## 3. Spike evidence

Executed 2026-10-05 against the operator-designated host: **this same dev machine, reached
over real SSH as `<user>@localhost`** (the operator chose loopback over a distant host).
Every action was a plain non-interactive `ssh` command with a dedicated ed25519 deploy key,
`BatchMode=yes` and a pinned `known_hosts`; nothing was installed on the "remote".
**Caveat to carry into implementation:** loopback exercises the full SSH auth/exec path but
not a network hop — latency, flaky-link reconnects and MTU behavior remain untested.

### 3.1 Readiness

- `ssh <user>@localhost 'pi --version'` **fails on a bare remote shell**: the non-
  interactive PATH has no pi and only an old node (v20 → `SyntaxError` inside pi). With an
  explicit PATH prefix (`env PATH=<node22-bin>:<pi-bin>:$PATH pi …`) → `1.0.3`. **The
  dispatch command must carry a PATH prefix (or absolute pi path) — this is a settings
  field, not an assumption** (feeds § 4 sub-decision 2).
- Local OpenSSH 10.0p2 (BatchMode, ControlMaster available); pinned `known_hosts` via
  `ssh-keyscan` + `StrictHostKeyChecking=yes` worked from the first connection.

### 3.2 Spike A — single-shot `--mode json` over SSH

One command: `ssh … "cd ~/lettuce-pi-spike && env PATH=… pi --mode json 'Reply with
exactly: PI-SPIKE-OK'"` → exit 0 in ~16 s, 31 JSONL records on stdout.

```text
first record  {"type":"session","version":3,"id":"01a10e10-08ec-705d-a364-5cfa40e1a963",
               "timestamp":"2026-10-05T21:54:54.318Z","cwd":"/home/<user>/lettuce-pi-spike"}
last assistant message_end  {"stopReason":"stop","text":"PI-SPIKE-OK"}
stream ends   {"type":"agent_settled"}
```

The session UUID arrives in the stream header (§ 2.3 confirmed live) — the dispatcher learns
the remote session id from the run itself, no second query.

### 3.3 Spike B — session iteration + transcript fetch-back

- Second command `ssh … "cd ~/lettuce-pi-spike && env PATH=… pi --mode json --session
  01a10e10-08ec-705d-a364-5cfa40e1a963 'What exact word did I just ask you to reply with?
  Answer with that word only.'"` → exit 0; final assistant text **`PI-SPIKE-OK`** — the
  first run's context demonstrably carried across the SSH boundary (51 event records).
- Session file located on the remote: `~/.pi/agent/sessions/--home-<user>-lettuce-pi-spike--/
  2026-10-05T21-54-54-318Z_01a10e10-08ec-705d-a364-5cfa40e1a963.jsonl` (~50 KB).
- `ssh … cat <that file>` fetched it whole; it contains both turns' prompts and answers.
  **Nuance:** the session file is the durable **message tree** (8 entries), *not* the live
  event stream (31 + 51 records). A parity transcript viewer needs delta/tool events, so
  its source must be the captured ssh stdout; the session file is the durable conversation
  record and repair fallback.

### 3.4 Cancellation probe

Started a long remote run over ssh, then killed the local ssh mid-run: the remote pi
survived with the same PID (1538929) and kept working; killing it required an explicit
`ssh … kill <pid>` (then verified gone both sides). **Local kill detaches, it does not
cancel** — § 4 sub-decision 4 resolves v1 semantics around this.

### 3.5 Capture custody and host cleanup

The raw captures (full `spike-a.jsonl`, `spike-b.jsonl`, the fetched durable session file,
the probe's truncated local stream and the probe run's remote session file) are kept
durable in `~/.local/share/lettuce-remote-pi-spike/` on the spike host — deliberately not
in the repo, since they embed prompts, provider usage and user paths. Everything the spike
added to the host — the deploy key (both halves and its `authorized_keys` line), the
`~/lettuce-pi-spike` workdir and its pi session directory — was removed after the captures
were secured; re-verified: key auth is refused and no spike paths or stray processes
remain. Any implementation-phase spike (milestone gates below) must repeat this
cleanup duty; it is part of the nothing-installed rule.

## 4. Design decisions

**Chosen: option B — BFF-native pi tools (`pi_run` / `pi_send` / `pi_status`).** Options
compared:

| | Mechanism | Verdict |
|---|---|---|
| **A** | Masquerade: shim on PATH bridging the claude-code launch shape → `ssh host pi --mode json`, translating claude stream-json ⇄ pi events both ways | **Rejected.** Its only unique benefit is reusing upstream's Task plumbing (`subagent_type: "claude-code"`, `update_subagent_state`, `claude_<uuid>` link, `SendAgentMessage` resume) — bought by hijacking the real Claude Code worker's single PATH slot, preflight and `claude_` id namespace (§ 2.1), plus bidirectional translation of an internal, version-drifting format. Two workers cannot share one identity. |
| **B** | BFF-native mod tools on the loopback route; the BFF spawns ssh, captures the run's stdout jsonl under the state dir, owns run state | **Chosen.** Every moving part is code we own; the UUID session id arrives natively in the json header (§ 3.2); iteration is `pi --session <uuid>` (spike-proven § 3.3); the parity UX is the existing viewer pattern (`bff/src/claude/transcript.ts` shape) rebuilt over the captured stream; no app-server-image change at all. Costs: `openssh-client` joins the BFF image (ours to change); long runs must be detached + polled because a mod call blocks its turn; dispatch lives on the agent's own turns, not upstream subagent turns (mods don't reach subagents, § 2.2) — which is exactly where dispatch belongs. |
| **C** | Global skill: the agent shells `ssh host pi …` itself (app-server image has `/usr/bin/ssh`) | **Rejected.** Zero structure: no parity UI, no settings/switch, no key custody, nothing for the BFF to show — fails the confirmed UX bar and the secret-handling rules outright. |

Parity mapping (what "Codex/Claude parity" concretely means under B):

| Codex/Claude worker element | remote-pi equivalent |
|---|---|
| CLI's own transcript file parsed by the viewer | BFF-captured per-run jsonl (the ssh stdout), parsed leniently against pi's json.md |
| `GET /api/codex/runs[/:threadId]` | `GET /api/pi/runs[/:sessionId]` |
| task notification carries `agent_id=codex_<thread>` (and `claude_<session>`) | the `pi_run` tool result carries the session UUID, and the transcript entry links `pi_<session uuid>` to the viewer (upstream only parses `claude_`/`codex_` prefixes, § 2.1 — so the link is ours, not letta-code's) |
| follow-ups resume via `--resume` | `pi_send {session, prompt}` runs `pi --mode json --session <uuid>` |
| "running" = 5-min recency heuristic | stronger: the capture process is ours — `running` means the ssh child is alive |

Sub-decisions, resolved:

1. **Transcript collection** — the BFF-captured stdout jsonl is the run record (viewer
   never touches the remote); the remote session file stays the durable conversation store
   and a repair fallback via `ssh cat` (both spike-proven, § 3.3).
2. **Settings shape & key custody** (`bff/src/pi/settings.ts`, modeled on
   `bff/src/codex/settings.ts`) — **the key is lettuce-held**: the BFF generates a
   single-purpose ed25519 pair (`PiService.generateKeyPair`, `ssh-keygen` is already in
   its image), stores the private half 0600 on `bff-data`, and serves only `hasKey` +
   `publicKey` to the browser — Settings shows the public line to paste into the remote's
   `authorized_keys`, with a two-click rotate. Pasting an existing PEM stays available and
   the served `publicKey` is always re-derived from the stored key (`ssh-keygen -y`,
   lenient: unparseable ⇒ shown as "no public key", never a stale lie).
   An ssh-agent mode was implemented and **dropped by operator decision 2026-10-06**
   (unattended simplicity and no socket plumbing into the container outweighed
   zero-storage custody). Plus `enabled`, `host`, `port`, `user`, `pathPrepend` (the PATH
   prefix § 3.1 proved mandatory), `workdir`, optional `model`; `known_hosts` pinned with
   a first-connect TOFU affordance, `StrictHostKeyChecking=yes` + `BatchMode=yes` always.
3. **Feature gate**: a `pi` virtual compose profile token, effective-enabled = token AND
   stored switch, exactly like `codex`/`claude` (Settings save route 404s while off).
   Unlike codex/claude, nothing needs baking into the *app-server* image — the transport
   lives in the BFF (whose image gains `openssh-client`).
4. **Cancellation / liveness** — per the § 3.4 probe, v1 is **detach-only**: stopping a
   view or giving up kills the local ssh child and marks the run "detached" (the remote pi
   finishes its turn and its session stays resumable via `pi_send`). An explicit remote
   kill (`ssh host kill <pid>` — still nothing-installed) becomes an optional `pi_stop`
   tool later if the operator wants it.
5. **Timeouts / blocking**: mod calls never wait on a run. `pi_run` / `pi_send` start the
   ssh detached and return `{runId, sessionId}` immediately; `pi_status` reports
   `running | detached | completed | failed` from the capture process + stream tail; the
   viewer polls the captured jsonl. ssh hardening flags per § 2.4.

## 5. Implementation milestones

_Drafted against option B (re-cut only if the spike overturns the choice). Each slice is a
PR per `AGENTS.md` workflow; the operator's container test is the merge gate on each._

0. **Spike** — done in this planning goal (§ 3); its evidence fixed the
   transcript-collection and cancellation sub-decisions.
1. **BFF core** — `bff/src/pi/`: settings module mirroring `bff/src/codex/settings.ts`
   (schema incl. `pathPrepend` per § 3.1, save/load, never echo the key), `pi` virtual
   profile token in `config.features`, ssh runner that spawns `ssh` detached (bff image
   gains `openssh-client`), streams the run's stdout jsonl into a durable per-run file
   under the state dir, and handlers for `pi_run` / `pi_send` / `pi_status` behind
   `/internal/tools/`. Gate: `bun run verify` + unit tests with a faked ssh runner.
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

Resolved during the spike and § 4: host = operator's dev machine over loopback SSH; runs
and transcripts are collected by capturing the ssh stdout in the BFF; cancellation is
detach-only for v1.

For the operator to settle before implementation:

- **Real distance**: loopback proved the auth/exec path, not a network hop. Should
  milestone 1 be validated against a genuinely remote host before merge?
- **Key custody** — **resolved (2026-10-06)**: a dedicated unencrypted key generated by
  the BFF and held on `bff-data` (0600) is the only model — an ssh-agent mode shipped
  briefly and was dropped by the operator. Blast radius is one machine-scoped key on a
  volume that lives outside the state-dir backup tar; rotation is one click (manual
  removal of the old line on the remote is part of it).
- **`pi_stop` scope**: is detach-only acceptable at launch, or does the operator want the
  explicit remote-kill slice in v1?
