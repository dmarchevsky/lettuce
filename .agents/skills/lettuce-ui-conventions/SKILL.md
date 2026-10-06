---
name: lettuce-ui-conventions
description: 'lettuce UI conventions that are ours, not the protocol''s: pin and archive lists kept in the BFF (pinned-agents.json / archived-agents.json, /api/agents/flags, archive only hides), the single AgentMenu fixed to the viewport because both agent lists scroll in boxes that clip, the two sidebar lists and the .agent-row language with the 3px active bar, useAgentStats only at the desktop width, the three-way split of settings (Agent tab: General/Secrets/Reflection/Skills; Tools tab: per-agent tool families with the on/off box on each chip; global Settings: providers/search/MCP/Google/workers/global skills), the rule that nothing uses a native checkbox (aria-pressed plus .menu-row-box / .chip-check instead), and ui-check reading the open agent from .agent-row.active[data-agent-id]. Read before touching web/src/components/AgentMenu, web/src/tabs/AgentTab.tsx, web/src/tabs/ToolsTab.tsx, components/GlobalSettings.tsx, the sidebar agent/conversation lists, use-agents, or bff/src/agents/id-list.ts.'
---

# Agent list and sidebar UI conventions

Loaded from `AGENTS.md`. Pinning and archiving are not in the app-server protocol, so the whole feature is ours.

Extracted from `AGENTS.md`; keep both in sync when you change either, and keep `docs/upstream-notes.md` pointers working.

- **Pinning and archiving an agent are not in the protocol, so both are ours.** letta-code
  keeps a pinned list in `settings.json` for its CLI picker, but the app-server only sets it at
  creation (`create_agent.pin_global`), and it has no agent archive — its `hidden` flag marks
  subagents (and hidden agents leave `agent_list`), so it must not be borrowed. The BFF keeps
  two id lists (`bff/src/agents/id-list.ts`: `pinned-agents.json`, `archived-agents.json` on
  `bff-data`; `GET /api/agents/flags`, `PUT /api/agents/{pins,archived}/:id`; archiving also
  unpins). Archive only hides: crons, memory and conversations carry on. One `AgentMenu`
  (Edit, Pin, Archive, Delete) serves the phone switcher (opening above its ⋯) and every row of
  the desktop sidebar's agent list (opening below); it is fixed to the viewport because both
  agent lists scroll in boxes of their own, which clip an absolute menu, and closes itself on
  Back, Escape and presses elsewhere. `use-agents` returns `agents` pinned-first; both lists
  hide archived agents behind "Show archived agents (N)".
- **The desktop sidebar is two lists with one row language, told apart by where they sit.**
  There is no agent dropdown: agents are rows (`.agent-row`: round avatar, name, conversation
  count or a responding dot, ⋯) on a panel of their own (`.sidebar-agents`, `--surface-2`,
  capped at a third of the height); conversations stay on the sidebar's background with dates.
  Both mark the open row with a 3px left bar. Counts for other agents come from `useAgentStats`,
  fetched only at the desktop width (`useWide`) — the sidebar stays mounted, hidden, on a
  phone. ui-check reads the open agent from `.agent-row.active[data-agent-id]`.
- **Settings are split by scope, and the split is the UI's only statement of it.** The **Agent** tab
  (`web/src/tabs/AgentTab.tsx`) holds what belongs to the selected agent: General (name, model, base
  system prompt, delete), Secrets, Reflection, and the Skills it sees. The **Tools** tab
  (`web/src/tabs/ToolsTab.tsx`) holds which shared tool families that agent is offered and what each
  one points at *for it*. **Settings**, the top
  bar's gear (`components/GlobalSettings.tsx`, full screen; wrapping chips with short names on a
  phone, the grouped list beside the section on desktop), holds what every agent shares — providers,
  web search, MCP servers, Google, Codex/Claude workers, global skills — plus this device's
  notifications and an About. Where a new setting goes is decided by its backend key, not by taste:
  keyed by `agent_id` → Agent tab; a BFF file or an app-server-wide command → Settings; `runtime`
  scope → next to the conversation (the composer). Feature-gated sections (web search, Google, the
  coding workers) render from `features` in `/api/status`, so a compose token that is off hides the
  whole section rather than showing a disabled one.
- **The Tools tab is chips-with-a-box, not a form.** Each family (Google, Codex, Claude, Remote Pi)
  is a `.chip-pair`: a small box button that allows or blocks the family, then a chip that opens its
  pane. The box writes the access record immediately — a toggle has no other fields to wait for —
  while a pane with several fields (Remote Pi's own host/workdir) has its own **Save**. Both halves
  of the pair are `<button>`s: nothing in the app uses `<input type="checkbox">` (the platform box
  renders in its own colour and size), so state is a boolean ARIA attribute plus a CSS class —
  `aria-pressed` with `.menu-row-box.on` for a menu row, `role="checkbox"` + `aria-checked` with
  `.chip-check.on` for a chip box, which is what `ui-check` counts (`input[type=checkbox]` must be
  0 anywhere in the DOM). The Agent tab's chip list is exactly
  `General/Secrets/Reflection/Skills` since Tools moved out, and `GlobalSettings`'s
  `SHARED_NOTE` has to name **both** per-agent tabs.
