---
name: delegating-to-claude-code
description: Load this before handing a self-contained coding job (write or fix code, run tests, refactor, investigate a repo) to a Claude Code worker with the Agent/Task tool and subagent_type "claude-code" — it says how to launch one, how to follow up or steer it, and what to do when Claude Code workers are disabled.
---

# Delegating coding work to a Claude Code worker

A **Claude Code worker** is the Claude Code CLI running as one of your background subagents. It
works in your current working directory with a shell and file editing, signed in with the user's
Claude subscription or pointed at an Anthropic-compatible endpoint (whichever they configured), and
reports back to this conversation when it finishes.

## When to use one

- A well-scoped coding job that takes many shell steps: implement a function and its tests,
  fix a failing build, refactor a module, dig through a repository to answer a question.
- You want to keep working (or talking to the user) while it runs.

Do the work yourself instead when it is a one- or two-command job, or when it needs your
memory, your skills or a conversation with the user — the worker has none of those.

## Launching

Use your Agent/Task tool with `subagent_type: "claude-code"`, a short `description`, and a `prompt`
that stands alone: the worker sees nothing of this conversation. Say which directory and files,
what "done" means (e.g. "tests pass"), and what to report back.

- It always runs in the background; its result arrives later as a task notification.
- Do not use `mcp: { inherit: true }`: it only forwards your per-agent MCP list, which is empty
  here. If the worker needs web search or another shared MCP server, say so in the prompt and
  give it the wrapper: `sh /root/.letta/skills/mcp-servers/scripts/mcp.sh` (see the
  `mcp-servers` skill for its commands). It runs in the same container, so it can call it.
- Do not pass `agent_id` or `conversation_id` — Claude Code workers cannot take them.

## Following up

The launch receipt contains an agent id like `claude_<uuid>`. Send it a message with
`SendAgentMessage` to steer a run that is still going, or to give a finished worker a follow-up
job — it resumes the same Claude Code session and still remembers the earlier work.

## If it fails at once

`Claude Code workers are disabled. Enable them in the web UI under Settings → Claude Code.` means
exactly that: tell the user, and do the work yourself meanwhile. Do not try to install, configure
or log in to Claude Code yourself — the web UI owns its configuration and rewrites it.

An authentication error from the worker (401, "invalid", "expired" or "OAuth token" in the
message) means the saved token no longer works: subscription tokens expire after a year. A
usage-limit or rate-limit error means the subscription's quota is spent for now. In either case
tell the user, who fixes it in Settings → Claude Code, and do the work yourself meanwhile.

`Claude Code workers are turned off for this agent` is a per-agent choice the user made in the web
UI (Agent → Tools). Tell the user and do the work yourself. Do not run `claude` from a shell to
get around it.

The user can watch every command a worker runs in the web UI (Tasks → Claude runs), so there is
no need to paste its whole log back; summarise what it did and what it found.
