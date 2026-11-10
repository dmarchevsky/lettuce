---
name: delegating-to-remote-pi
description: 'Remote pi worker mechanics — the pi_run / pi_send dispatch tools and the pi_status, pi_log, pi_result, pi_fetch, pi_ls, pi_stop, pi_exec watchers in bff/src/pi/service.ts, why a dispatched run ends your turn instead of being polled or cron-watched, the full-UUID run id the tools need while every report prints only eight characters, what completed / detached / failed / cancelled each oblige you to do, what stopping a run kills and what detaching the capture does not, budget-exceeded cancellations, the 25 MB pi_fetch and 200 KB pi_exec caps, and the off-state messages that mean the `pi` compose token or Settings → Remote Pi is missing. Read before handing work to the remote pi worker, or when a run looks quiet, stuck, detached or failed.'
---

# Delegating work to the remote pi agent

The **remote pi worker** is the pi coding agent on another machine, reached over SSH. It works in
the folder and on the host configured for *this agent* (Agent → Tools → Remote Pi; another agent may
point somewhere else). It has its own shell, files, extensions and git credentials — or lacks them.
It sees nothing of this conversation, so the prompt is all it gets.

Implementation: `bff/src/pi/service.ts` (the tools, the settle report, the caps) and
`bff/src/pi/runner.ts` (the ssh capture, the states, the budget). Design prose:
`docs/remote-pi-plan.md`, `docs/remote-pi-live-plan.md`.

**Out of scope here:** relaying a **dev-flow** checkpoint from a remote run (Approve? / Verified? /
Release? / Finish? arriving through `pi_send`). Its own skill covers it — do not improvise a gate
answer into a prompt.

## When to use it

- Coding or ops work that belongs on that machine — its checkout, its toolchain, its docker, its
  git remote.
- A job long enough that you want to keep talking to the user meanwhile.

Do it yourself instead when it is a one-line look (`pi_exec`, which asks the human every time, or
`pi_ls` / `pi_fetch`), or when the work needs your memory, your skills or the user.

## The commands

Run states everywhere: `running` `completed` `detached` `failed` `cancelled`.

| Command | What it does |
| --- | --- |
| `pi_run {prompt, model?}` | Starts a **fresh session** on this agent's host and workdir. Returns immediately with the run id, the session id, `user@host` and the workdir. `model` overrides the remote pi's own default. Needs the human's approval. |
| `pi_send {session, prompt}` | Continues an existing session, so the remote keeps its context. Needs approval. A send onto a session with a **live** run queues behind it on the remote — send only after that run has been reported. |
| `pi_status {run}` | State, session, `events N`, start and last activity. While running: `quiet Nm — no output, ssh still alive` once the stream has been silent a minute, then `now: <tool>: <input>` and `last said:`. When finished: the last assistant text. |
| `pi_log {run, tail?}` | Tail of the captured stream, formatted (`→ Bash {…}`, `← …`, `assistant: …`). Default 40 records, max 200. Read from the BFF's own capture — no ssh, cheap. |
| `pi_result {run, transcript?}` | The final assistant message, read back over the last 1 MB of the capture (30 000-char cap); `transcript: true` returns the whole run with each step's command input/output shortened (60 000-char cap). |
| `pi_fetch {run\|session, path, save?}` | One file the run produced, max **25 MB**, confined to the configured workdir. Gives a link for the human; `save` also writes it into **your** workspace at `./pi/<run8>/<name>` — do that for anything you must read or edit. |
| `pi_ls {run\|session, path?}` | Listing inside the workdir (default `.`); the remote truncates it silently at 8 KB, so list a subdirectory rather than a huge root. |
| `pi_stop {run, force?}` | Default is **detach**: Lettuce stops capturing, the remote pi **keeps running** and stays resumable. `force: true` kills the remote process (recorded `cancelled`) and refuses when the remote pid was never seen. |
| `pi_exec {command, timeout_seconds?}` | One raw shell command in the remote workdir, for the `git log` / `mv` / `cat` ops that do not need an agent turn. **Asks the human every call**; 30 s default, clamped 5–120; the capture caps at 200 KB and only the first 100 KB of stdout is shown. |

`pi_wait` is retired: it is no longer offered, and a legacy call returns the status at once with the
instruction that made waiting unnecessary. Do not call it, and do not call `pi_status` in a loop.

The whole set is off when `COMPOSE_PROFILES` has no `pi` token, and per-agent access is the same
Tools-tab gate as any other tool — a project `flow-guard` rule may deny them, which is a fact to
relay, not to route around.

## Starting a run

`pi_run {prompt}` starts fresh; `pi_send {session, prompt}` resumes. **Keep the full run id** — the
tools take the whole UUID. Eight characters is not an id: a report, a `pi_log` header and the Runs
list all print eight characters (the Runs list's is a *session* prefix), and handing one back gets
"No remote-pi run" from `pi_status` and a refusal from `pi_fetch`. The full id comes from `pi_run`'s
own answer — the run card links the run but never prints its id — so copy it out of the tool result
and keep it in your reply to the user.

Write the prompt so it stands alone:

- what to do, in which directory or repo, and what "done" means (tests pass, PR open, a file exists);
- what to report back and in what shape — it lands here as the run's last message;
- what it must **not** do without asking (push `main`, tag, deploy, delete);
- and, for work the remote host cannot finish alone, that it should say so rather than improvise.

A long prompt is fine — it travels on ssh stdin, not on a command line.

```
pi_run {prompt: "In /home/dima/work/lettuce, add a --json flag to scripts/check-pin-upstream.ts
so its report can be parsed. Done means `bun run check-docs` and `bun run typecheck` pass and the
branch has one commit with the flag documented in the command table. Report: branch, commit SHA,
the two command outputs, and anything you could not do and why. Do not push, tag or deploy."}
```

## Then end your turn — the result comes to you

**This is the rule people break.** When a run ends — finishing, failing, being stopped, or losing its
capture — Lettuce posts a `<task-notification>` into **the conversation that dispatched it** (not
necessarily the one you are in now, which is what makes a cron turn awkward):

```
remote pi run 1a2b3c4d completed (exit 0) — <first line of your prompt>
last said: <its final message, 300 chars>
files the run touched in the workdir: …
```

That message starts your next turn. So after `pi_run` / `pi_send`:

- **End your turn.** Say what you dispatched and that you will report when it settles.
- **Do not poll.** No `pi_status` loop, no sleep-and-check.
- **Do not schedule a cron, reminder or wake-up to watch a run.** The report *is* the wake-up, and a
  cron turn may land in a different conversation, leaving two threads of one job.
- Every terminal state is reported, `detached` and `failed` included. No news is the run still going.
  (The report needs a dispatching conversation to land in — a run with none has nowhere to report.)

`pi_status` / `pi_log` are for when **the user asks** "how far along is it?". They are not for waiting.

## Reading the report

| State | Meaning | What you do |
| --- | --- | --- |
| `completed` | pi finished its turn | Read `last said`; `pi_result {run}` for the full message, `transcript: true` for the whole run; `pi_fetch` for files. |
| `failed` | **nothing was captured** — the channel never came up, or ssh died before pi printed a line | Read `error:` and pass it on. There is no session id to resume, so fix the cause and dispatch again. A pi that produced output and then died is `detached`, not this. |
| `detached` | Lettuce stopped capturing it (stopped, ssh lost, BFF restarted, or the remote died) | **Do not re-run the work blind** — the remote may be alive and still editing. Check `pi_status` and `pi_log`, then the real state of the remote (`pi_exec` for `git status`, or a short `pi_send` asking for it). Resume the **same session**. |
| `cancelled` | force-stopped, or `error: budget exceeded (20 min runtime)` | The BFF tried to kill the remote process; a best-effort kill is not proof it died, so check the remote as above before repeating anything. |

Do not invent a cause. "The SSH channel drops after N minutes" is a theory, not a finding — report
what the `error:` line and the exit code say. If a pattern appears, tell the user and let them look;
do not re-plan the work around it into many tiny "is it still alive?" runs.

The limits behind those two lines are Settings → Remote Pi values: `maxEvents` (default 200 000)
and `maxRuntimeMinutes` (default **0** = no runtime cap). A budget hit records `cancelled`, not an
error mid-work.

## A run that looks stuck

Long silences are normal — a build, a test suite, a slow model, a linter extension on the remote.
`quiet Nm — no output, ssh still alive` means the process is alive and has printed nothing; it is not
a hang.

- Wait for the report. If the user wants it stopped, `pi_stop {run}` only stops watching (the remote
  may keep going) and `pi_stop {run, force: true}` kills the remote pi too — say which you used.
- Never start a second run of the **same work** while one is live, and never duplicate a detached
  one before checking what it already changed. Different work on a different session is fine.

## If it fails at once

- `The remote pi worker is off: COMPOSE_PROFILES has no `pi` token.` — this install lacks the
  feature. `The remote pi worker is disabled (Settings → Remote Pi).` — the worker is switched
  off **or its connection is incomplete**: an empty host or user, a workdir that is not an absolute
  path, or no deploy key all read as disabled (per-agent host: Agent → Tools → Remote Pi). Tell the
  user; do not configure SSH keys, hosts or settings yourself, the web UI owns them.
- `The run failed to start: …` — the run was created and captured nothing, usually ssh (host key,
  refused key, unreachable host). `Could not start the remote-pi run: …` — the spawn itself threw.
  Pass the text on; **Check host** in Settings → Remote Pi names which.
- `Run <id> is not being captured by this BFF (state: …)` — a detach was asked for a run that is
  already terminal. Nothing to stop; read the report.

The user can watch every run live (the run card here, and the Runs tab), so summarise what pi did and
found — do not paste its log back.
