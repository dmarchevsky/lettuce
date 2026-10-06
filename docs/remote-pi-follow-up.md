# Remote Pi follow-up — per-agent settings and the Settings/Agent UI pass

Plan for the branch `fix/pi-follow-up`. The first commit on this branch was the prod
investigation fix (`Features:` log, the Agent → Tools pi flip being dropped). This document
covers the work the operator asked for after it. Screenshots of the current screens:
`.ui-check/` before-shots (`before-pi-global-*`, `before-agent-tools-*`).

## 1. What is being asked, and the decisions inside it

| Ask | Decision |
| --- | --- |
| Per-agent Remote Pi: own workdir, optionally a different host | Per-agent **override record** keyed by agent id, stored by the BFF beside the pi settings. Each field inherits from the global one when blank, so "own workdir only" is one field and "own host" is a few. |
| Rename "Remote pi worker" → "Remote Pi" | Section label, phone chip, Agent → Tools row, README/CONFIGURATION/ui-check strings. The compose token stays `pi` (renaming it would break every `docker/.env`). |
| "Allow pi" off should disable the fields | Fields render `disabled` while the switch is off, with a one-line hint. New pattern in this app (Codex/Claude/Google do not gate their fields) — deliberate, and easy to backport later. |
| Separate the generate-key and paste-a-key flows | One select — **Deploy key: Lettuce-generated (recommended)** / **My own private key** — and only the chosen branch renders. No more "…or paste an existing private key" appearing under an already-generated key. |
| Copy public key as a small in-field button | The public key becomes a one-line mono input with a `Copy` `.button.compact` inside its right edge; select-on-focus stays as the fallback for insecure origins (where the clipboard is blocked). |
| Show host status after changes | A **Check host** action that runs a real `ssh` probe and reports a `.pill.ok/.warn/.bad` line; the form remembers that it changed since the last check and says so. |
| "Verify & pin host key" vs "Save" | See § 4 — they do different things, and one of them should fire automatically. |

## 2. Per-agent settings (the only part with new state)

**Where it lives.** Under **Agent → Tools**, on the Remote Pi row — the same place the agent is
already told whether it gets the pi tools at all, and already keyed by `agent_id`, which is what
`AGENTS.md` ("a new setting goes where its backend key is") asks for. The row becomes:

```
Remote Pi
[ Global settings (worker@pi-host) ▾ ]     Allowed (this agent's own settings) / Blocked
   ↓ when "own settings" is picked, the override fields expand in place
   Host        [ (empty = worker@pi-host) ]
   Port        [ (empty = 22) ]
   User        [ (empty = worker) ]
   Workdir     [ /home/worker/pi-research ]      ← the field almost everyone needs
   PATH prefix [ (empty = /home/worker/.nvm/bin) ]
   Model       [ (empty = global / pi default) ]
   Save
```

- The select's labels carry the resolved truth, so a glance says which host an agent will use.
- Blank means inherit; the placeholder shows what it will inherit. Validation stays the server's
  (an override is only saved when the resulting effective settings are complete).
- An override cannot exist while the global worker is off, because the global record holds the
  deploy key and the pinned host keys. When global is off the row says so and links to
  Settings → Remote Pi (the existing `onOpenGlobalSettings` pattern).

**Backend.**

- `bff/src/pi/agent-overrides.ts` — `PiAgentOverride` (all fields optional, `enabled: "global" |
  "own" | "off"`), stored in `$PI_DIR/agents.json` next to `settings.json`, same write-private
  pattern, lenient parse, `DELETE` removes the entry.
- `effectivePiSettings(global, override)` in `pi/settings.ts` — field-by-field merge, plus the
  `source` (`global` / `agent`) so the UI and the tool answers can say where a run went.
- `PiService.settingsFor(agentId)`; the four handlers already receive `context.agentId`
  (`internal-tools/http.ts` sends `x-letta-agent-id`), so `pi_run` resolves per agent with no new
  protocol anywhere. `pi_status` and `pi_stop` keep reading the run's own record, never settings.
- **`pi_send` must follow the session's host**: a pi session id exists on the host that created
  it. The run store gains `agentId` and `host`, and `pi_send` resolves the session from the run
  that produced it and reuses that host/workdir/PATH; a session lettuce never saw falls back to
  the agent's effective settings and says so in the answer.
- `PiRunMeta` gains `agentId` and `host`; `summarizePiRun` and the Tasks list show them, so a run
  from each agent is distinguishable (the per-agent ask makes this necessary, not cosmetic).
- Routes (all gated on `features.pi` like the existing pi routes):
  `GET|PUT /api/pi/agents/:agentId`, `DELETE /api/pi/agents/:agentId`,
  and `GET /api/pi/settings` grows `agents: [{ agentId, host, workdir }]` so the global section
  can say "2 agents use their own settings".
- **Key custody does not fork.** One lettuce-held deploy key, whose public half must be in every
  remote's `authorized_keys`. Per-agent keys would double the secrets on the volume and double
  the operator's manual steps for no access gain (any agent that can call `pi_run` can use the
  host it resolves to). Per-agent *host* override is what was asked for; per-agent *key* is left
  out unless the operator says otherwise.

## 3. Global Settings → Remote Pi, re-laid out

```
Remote Pi
Agents dispatch coding tasks to a pi on another host over SSH …          (unchanged intro)

┌ Remote Pi                                    [switch] ┐
│ Agents may dispatch coding tasks to the remote pi     │  off ⇒ every field below is disabled
└───────────────────────────────────────────────────────┘
worker@pi-host:22 · pi v0.9.1 · checked 4 min ago        [pill.ok]     ← § 4, after any edit: "changed since last check" [pill.warn]

Host  [pi-host.example.net]   Port [22]   User [worker]
Workdir      [/home/worker/pi]      (hint: pi itself must already be installed there)
PATH prefix  [/home/worker/.nvm/bin] (hint: a non-interactive ssh shell usually misses pi/node)
Model        [ (the remote pi's own default) ]

Deploy key   [ Lettuce-generated (recommended) ▾]
  Public key — add to the remote's ~/.ssh/authorized_keys
  [ ssh-ed25519 AAAA… ​​lettuce-pi-worker  [Copy] ]   ← one line, button inside the field
  [Rotate key pair…]      (two-click confirm, unchanged wording)

or, when "My own private key" is selected:
  [ textarea: paste the OpenSSH private key ]  [Clear stored key…]

[ Save ]   [ Check & pin host key ]           [ Recent runs → Tasks ]
```

Consistency notes, all taken from what already exists: `.pill.ok/.warn/.bad` for the status,
`ToggleRow` for the switch, `.button.compact` for the in-field Copy,
`.field input.mono-input` for the mono one-liner, and the "Try a search" block in
Settings → Web search as the precedent for an in-section action whose result is printed under it
(`<pre className="tool-args">`). Dirty-aware Save (`disabled` until something changed) matches
`GoogleSection.isDirty` and Agent → Tools.

## 4. "Verify & pin host key" vs "Save" — and what to do about it

They are different operations and both stay, but today the pairing is a trap:

- **Save** writes the record (`$PI_DIR/settings.json`) and re-renders the pi mod. It touches no
  network.
- **Verify & pin host key** is a network operation against the host *currently in the form*:
  `ssh-keyscan` and append the answer to `$PI_DIR/known_hosts`. It is the deliberate
  trust-on-first-use moment, it survives no save, and it is **required** — every run uses
  `StrictHostKeyChecking=yes`, so a saved-but-unpinned host makes every run fail.

That is the bug in the current layout: saving a new host is easy, and the failure only appears on
the agent's next run. The fix is not to merge them — pinning must stay an explicit human action —
but to make the pair impossible to get wrong:

1. **Save runs a check afterwards** and reports in the same status line: reachable and pinned →
   `ok`; not pinned → the line says "host key not pinned" and the primary button becomes
   **Check & pin host key**.
2. **Check & pin** does keyscan-then-probe in one action and prints both results; the probe is
   `ssh <flags> 'command -v pi && pi --version'`, which validates the host key, the key, and the
   PATH prefix in one round trip. Pinning refuses to silently replace a different pinned key: on a
   mismatch it reports the old and new fingerprints and needs a second click.
3. Check accepts **unsaved** form values (host/port/user come from the draft), so you can test
   before saving; the stored key is always the key used, and pasting a *new* private key says
   "save it first, then check".
4. Results persist server-side per `user@host:port` (`$PI_DIR/checks.json`: when, ok, detail),
   because Settings is device-independent: the phone should not say "never checked" after the
   laptop checked a minute ago. Changing a field marks the record stale rather than erasing it.
5. Pin state is shown: `pinned SHA256:ab12…34`, so a host-key rotation is visible instead of
   mysterious.

## 5. Other UI/UX items worth taking (small, same files)

- Save disabled until dirty; "unsaved changes" wording consistent with Google/Codex.
- Inline required-field hints (absolute workdir, host+user) instead of a 400 from the server after
  pressing Save.
- `pi_run`'s tool description names the resolved host so the model can say where a task landed.
- Agent → Tools: the Remote Pi row states the effective config (`global worker@pi-host`, or
  `own: pi-other:22 /home/x`), with the existing link to Settings when global is off.
- Tasks run rows show the agent and the host (needs § 2's meta fields).
- Terminology sweep: "Remote pi worker" → "Remote Pi" everywhere it is a label (docs, README,
  `scripts/ui-check.ts` strings); the word "worker" stays in code names and in the mod title.

## 6. Order of work on this branch

| Commit | Contents | Gate |
| --- | --- | --- |
| A | Rename + disable-when-off + deploy-key select + in-field Copy + dirty Save | `verify`, `ui-check`, screenshots |
| B | `checks.json`, probe, pin mismatch handling, status pills, Save-then-check | `verify`, live check against a real host |
| C | `agent-overrides.ts`, effective merge, routes, `pi_send` session-host rule, run meta, Agent → Tools form | `verify` + live per-agent run |
| D | Docs (README, CONFIGURATION), ui-check assertions for the new controls, final screenshots | `verify`, `check-docs` |

`bump:minor` for the branch as a whole (new user-facing capability). One PR, operator container
test before it is pushed, per `AGENTS.md`.

## 7. Open questions for the operator

1. Per-agent form: inside **Agent → Tools** (proposed, no new tab) or its own **Agent → Remote Pi**
   chip?
2. Per-agent **deploy key** in scope, or one lettuce key for every host (proposed)?
3. Is "fields disabled while the switch is off" wanted for Codex/Claude/Google too, now or later?
