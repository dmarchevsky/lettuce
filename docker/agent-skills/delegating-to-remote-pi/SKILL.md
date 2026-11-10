---
name: delegating-to-remote-pi
description: Load this before handing work to the Remote Pi worker with pi_run or pi_send — a pi coding agent on another machine, reached over SSH, with its own shell, files, extensions and git credentials. It says how to write a prompt that stands alone, why you end your turn instead of polling or scheduling a cron, what each terminal state (completed, detached, failed, cancelled) obliges you to do, what stopping a run kills and what merely closing the capture does not, how to fetch what the run produced, and what to do when the worker is off or this agent may not use it.
---

# Delegating work to the Remote Pi worker

A **Remote Pi worker** is the pi coding agent on another machine, reached over SSH. It works in the
host and folder configured for *you* (Agent → Tools → Remote Pi), with its own shell, files,
extensions and git credentials — or lacking them. It sees nothing of this conversation.

## When to use it

- Work that belongs on that machine: its checkout, its toolchain, its docker, its git remote.
- A job long enough that you want to keep talking to the user while it runs.

Do it yourself when it is a one- or two-command job (`pi_exec` asks the human every time; `pi_ls` and
`pi_fetch` only look), or when the work needs your memory, your skills or the user — the worker has
none of those.

## Starting a run

`pi_run {prompt}` starts a fresh session; `pi_send {session, prompt}` continues one, so the remote
keeps its context. Both ask the human to approve. The answer carries a **run id** and a **session id**
— name both when you tell the user what you dispatched.

Write the prompt so it stands alone:

- what to do, in which directory or repo, and what "done" means (tests pass, PR open, a file exists);
- what to report back, and in what shape — its last message is what reaches you;
- what it must **not** do without asking (push a protected branch, tag, deploy, delete).

A long prompt is fine.

**Keep the run id whole.** The tools take the full id from `pi_run`'s answer. Eight characters is not
an id: reports and logs print eight for display, and handing one back gets "No remote-pi run".

## Then end your turn

When a run ends — finishing, failing, being stopped, or losing its capture — its verdict, its last
message and the files it touched arrive in this conversation as a task notification, and that starts
your next turn. So after `pi_run` or `pi_send`: **say what you dispatched, and stop.** Do not poll
with `pi_status`, do not sleep-and-check, and do not schedule a cron or reminder to watch a run — the
report is the wake-up, and a cron turn may land in a different conversation. Every terminal state is
reported; no news means it is still running.

`pi_status {run}` (state, progress, what it is doing now) and `pi_log {run}` (its last stream lines)
are for when the user asks "how far along is it?". They are not for waiting.

## The commands

- `pi_run {prompt, model?}` / `pi_send {session, prompt}` — dispatch and continue. A `pi_send` onto a
  session with a live run queues behind it on the remote, so send only after that run has been reported.
- `pi_status {run}`, `pi_log {run, tail?}`, `pi_result {run, transcript?}` — progress, the last lines,
  and the full final message (`transcript: true` for the whole run).
- `pi_fetch {run, path, save}` — one file the run produced, up to 25 MB, inside its workdir. `save`
  also lands it in your own workspace (`pi/<run>/<name>`) — do that for anything you must read or edit.
  `pi_ls {run, path?}` lists the workdir (the listing is cut at 8 KB, so list a subfolder, not a huge
  root). Either tool also takes `session` instead of `run`.
- `pi_stop {run}` — **kills the pi process on the worker** and records the run `cancelled`; the session
  stays resumable either way. It refuses when no remote pid was recorded. `pi_stop {run, detach: true}`
  only closes the capture — the remote is not killed, but it dies writing to the stream that just
  closed, so detaching is *not* a way to let work finish unwatched. Say which you did.
- `pi_exec {command, timeout_seconds?}` — one raw command in its workdir for the `git log` / `cat` jobs
  that need no agent turn. The human approves every call; a minute is the ceiling and only ~100 KB of
  output comes back, so longer work belongs in a run.

## Reading the result

| State | What it means | What you do |
| --- | --- | --- |
| `completed` | it finished its turn | Read `last said`, or `pi_result` for all of it; `pi_fetch` the files. |
| `detached` | the capture closed: `detach: true`, the ssh died, or the server restarted | **Do not repeat the work blind.** A detached run survives only briefly once its stream closes, so it may have edited files in that window. Read `error:` to see which case it was, check `pi_log`, then the remote's real state (`pi_exec` for `git status`, or a short `pi_send` asking for it), and continue the **same session**. |
| `cancelled` | stopped with `pi_stop`, or a runtime/event budget was hit (`error: budget exceeded …`) | It was killed; a best-effort kill is not proof it died, so check the remote before repeating anything. |
| `failed` | pi exited non-zero (`error: pi exited 137`, plus what stderr said), or nothing was captured at all | Pass on the `error:` text — there is a reason there now, so do not invent one. With a session id you can `pi_send` to pick up where it got; without one, fix the cause and dispatch again. |

Report what the `error:` line and exit code say rather than inventing a cause, and do not chop the work
into many tiny "is it still alive?" runs because one went quiet.

## A run that looks stuck

Silence is normal — a build, a test suite, a slow model. `quiet 4m — nothing written, ssh alive`
followed by `remote pi pid 4123 is running (S 12:03 9.1)` is the worker itself confirming the process
is there. Silence is not a hang. Wait for the report unless the user asks you to stop it; `pi_stop`
then really stops it.

## If it cannot start

- `The remote pi worker is disabled (Settings → Remote Pi).` means it is switched off **or half
  configured** — an empty host or user, a folder that is not an absolute path, or no key all read that
  way. **Settings → Remote Pi** owns all of it. Tell the user; never configure ssh, hosts or keys yourself.
- `The run failed to start: …` is usually the connection (host key, refused key, unreachable host).
  Pass the text on; the **Check host** button in Settings → Remote Pi diagnoses it.
- If the `pi_*` tools are not in your tool list at all, this agent is not allowed to use them
  (Agent → Tools). Say so and do the work another way — do not look for a side route to the same machine.

The user can watch every run live (the run card in this conversation, and the Runs tab), so summarise
what the worker did and found; do not paste its log back.
