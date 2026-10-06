---
name: lettuce-per-agent-tool-access
description: 'lettuce per-agent tool access mechanics: agent-tool-access.json on bff-data, and the three letta-code hooks that carry it — mod `isEnabled(ctx)` to hide a tool, `letta.permissions.register` to deny Task/Agent with subagent_type codex or claude-code and SendAgentMessage follow-ups, and the x-letta-agent-id header every mod call sends. Read before touching bff/src/agents/tool-access.ts, the policy mod, the MCP bridge''s per-agent filtering, or the Tools tab. Availability, not isolation — agent shells are unconfined.'
---

# Per-agent tool access (the Tools tab)

Loaded from `AGENTS.md`. Settings decide what exists; this narrows who is offered it.

Extracted from `AGENTS.md`; keep both in sync when you change either, and keep `docs/upstream-notes.md` pointers working.

- **Per-agent tool access (the Tools tab) narrows Google, Codex, Claude Code and Remote Pi through
  the mods, with no upstream change.** Settings → Codex workers, → Claude Code workers, → Google and
  → Remote Pi decide what exists; each agent can be cut down from there (Google full / read-only /
  off, Codex, Claude Code and Remote Pi allowed / blocked). The BFF
  keeps it in `agent-tool-access.json` on `bff-data` (`bff/src/agents/tool-access.ts`, only
  non-default entries), and a save re-renders the mods and sends one `reload`. Three upstream
  hooks carry it (0.33.3):
  - **Hiding a tool:** `letta.tools.register({ isEnabled(ctx) })` is called per turn with the
    listener's mod context, whose `ctx.agent.id` is the agent (`filterAvailableModToolsRegistry`).
    `renderToolsMod`'s `hidden` map bakes agent → tool names in. A hidden tool is left out of
    that turn's schemas.
  - **Denying a call:** `letta.permissions.register({ check(event) })` sees `event.agentId` and
    `event.args`. Its `deny` replaces the built-in decision in `checkPermissionWithHooks`, in
    **every** permission mode, Unrestricted included. A Codex worker is not a tool of its own;
    it is `subagent_type: "codex"` on Task/Agent, plus `SendAgentMessage` to `codex_<uuid>` for
    follow-ups (same shape for Claude Code with `"claude-code"` and `claude_<uuid>`). So
    `lettuce-agent-policy.mjs` (`bff/src/codex/policy-mod.ts`) matches on the
    arguments, not the tool name.
  - **Knowing the caller:** every mod call sends `x-letta-agent-id` from `ctx.agent.id`
    (`internal-tools/mod.ts`), and handlers get it as `ToolCallContext`. The MCP bridge filters
    its catalog per agent (`toolsForAgent`: off drops the Google server, read-only its writes),
    and the curated Google handlers re-check in case a mod is stale. A call with no header gets
    the default.

  This is availability, not isolation. Agent shells are unconfined, so a blocked agent can
  still reach `google-mcp:8000`, the `mcp-servers` skill wrapper, or `codex` / `claude` on PATH.
  The skill
  wrapper is also global and cannot be narrowed per agent. Entries of deleted agents are not
  pruned, like pins; they are harmless.
- **Enable/disable has exactly one home: `agent-tool-access.json`.** The Tools tab's chip box is the
  only thing that writes it, so a pane and a checkbox can never disagree about whether an agent gets
  a family. Anything else per-agent is a *different* record with its own file, and must not grow an
  `enabled` field of its own. Remote Pi's is `$PI_DIR/agents.json`
  (`bff/src/pi/agent-settings.ts`): `{ agentId: { mode, host, port, user, pathPrepend, workdir,
  model } }`, only non-default entries, merged over the global pi record at tool-call time by
  `PiService.settingsFor(agentId)` from the same `x-letta-agent-id`. So a `pi_run` needs the global
  switch on and its own agent not blocked, and then works in *its* folder on *its* host with the
  global deploy key — the key is never per-agent, and `pi_send` resolves the host from the run that
  made the session (`DirPiRunStore.findBySession`, recorded as `PiRunMeta.agentId`), because a pi
  session id is a file on one machine.
