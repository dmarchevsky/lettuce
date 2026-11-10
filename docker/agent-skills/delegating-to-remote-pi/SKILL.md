---
name: delegating-to-remote-pi
description: Load this before handing work to the Remote Pi worker with pi_run or pi_send — a pi coding agent on another machine, reached over SSH, with its own shell, files, extensions and git credentials. It says how to write a prompt that stands alone, why you end your turn instead of polling or scheduling a cron, what each terminal state (completed, detached, failed, cancelled) obliges you to do, how to fetch what the run produced, and what to do when the worker is off or this agent may not use it.
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
- `pi_stop {run, force?}` — by default it only stops watching and **the remote keeps running**; with
  `force: true` the remote process is killed too. Say which you used.
- `pi_exec {command, timeout_seconds?}` — one raw command in its workdir for the `git log` / `cat` jobs
  that need no agent turn. The human approves every call; a minute is the ceiling and only ~100 KB of
  output comes back, so longer work belongs in a run.

## Reading the result

| State | What it means | What you do |
| --- | --- | --- |
| `completed` | it finished its turn | Read `last said`, or `pi_result` for all of it; `pi_fetch` the files. |
| `detached` | capturing stopped (stopped, ssh lost, server restarted) | **Do not repeat the work blind** — the remote may be alive and still editing. Check `pi_status` and `pi_log`, then the remote's real state (`pi_exec` for `git status`, or a short `pi_send` asking for it), and continue the **same session**. |
| `cancelled` | force-stopped, or a runtime/event budget was hit | The server tried to kill it; a failed kill is not proof it died, so check the remote before repeating anything. |
| `failed` | nothing was captured — the channel never came up | Pass on the `error:` text. There is no session to resume, so fix the cause and dispatch again. |

Report what the `error:` line and exit code say rather than inventing a cause, and do not chop the work
into many tiny "is it still alive?" runs because one went quiet.

## A run that looks stuck

Silence is normal — a build, a test suite, a slow model. `quiet 4m — no output, ssh still alive` means
the process is alive and has printed nothing; it is not a hang. Wait for the report unless the user
asks you to stop it.

## If it cannot start

- `The remote pi worker is disabled (…)` means it is switched off or not set up — **Settings → Remote
  Pi** owns the host, the folder and the key. Tell the user; never configure ssh, hosts or keys yourself.
- `The run failed to start: …` is usually the connection (host key, refused key, unreachable host).
  Pass the text on; the **Check host** button in Settings → Remote Pi diagnoses it.
- If the `pi_*` tools are not in your tool list at all, this agent is not allowed to use them
  (Agent → Tools). Say so and do the work another way — do not look for a side route to the same machine.

The user can watch every run live (the run card in this conversation, and the Runs tab), so summarise
what the worker did and found; do not paste its log back.
