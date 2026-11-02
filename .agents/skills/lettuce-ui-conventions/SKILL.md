---
name: lettuce-ui-conventions
description: 'lettuce UI conventions that are ours, not the protocol''s: pin/archive lists live in the BFF, not the agent; one viewport-fixed AgentMenu (agent surfaces clip it: above a phone ⋯, beside a rail avatar); the desktop rail — panes + Settings up top, a faces-only agent column docked at the foot by a fixed all-agents cell — beside a Chat-only pin-toggleable conversation panel ending in the same agents as a row-aligned names block; a phone bar of five equal slots under a header whose left corner carries the open agent's face (`.where-avatar`) as the switcher entry; both nav surfaces stay mounted and CSS picks one, so ui-check reads the open agent from .rail-agent.active[data-agent-id]; the three-way settings split (Agent, Tools, global Settings); no native checkbox anywhere (aria-pressed + .menu-row-box / .chip-check). Read before touching web/src/components/AgentMenu, NavRail, BottomBar, Sidebar, tabs/AgentTab.tsx, tabs/ToolsTab.tsx, GlobalSettings.tsx, lib/tabs.ts, use-agents, or bff/src/agents/id-list.ts.'
---

# Agent list and sidebar UI conventions

Loaded from `AGENTS.md`. Pinning and archiving are not in the app-server protocol, so the whole feature is ours.

- **Pinning and archiving an agent are not in the protocol, so both are ours.** letta-code
  keeps a pinned list in `settings.json` for its CLI picker, but the app-server only sets it at
  creation (`create_agent.pin_global`), and it has no agent archive — its `hidden` flag marks
  subagents (and hidden agents leave `agent_list`), so it must not be borrowed. The BFF keeps
  two id lists (`bff/src/agents/id-list.ts`: `pinned-agents.json`, `archived-agents.json` on
  `bff-data`; `GET /api/agents/flags`, `PUT /api/agents/{pins,archived}/:id`; archiving also
  unpins). Archive only hides: crons, memory and conversations carry on. One `AgentMenu`
  (Edit, Pin, Archive, Delete) serves the phone switcher (opening above its ⋯), every rail avatar
  (opening beside it — the rail is a narrow column, and an avatar's verbs are a right-click), and
  the switcher's rows; it is fixed to the viewport because the agent surfaces scroll in boxes of
  their own, which clip an absolute menu, and closes itself on Back, Escape and presses elsewhere.
  `use-agents` returns `agents` pinned-first; the rail, the bar and the panel hide archived agents,
  and only the phone switcher brings them back behind "archived agents (N)" — on desktop an
  archived agent has no way back yet (that entry retired with the all-in-one panel list; tracked as
  its own follow-up flow).
- **Navigation is two surfaces, one per width, and `web/src/lib/tabs.ts` is the pane list they
  share.** Desktop gets a 74px **rail** (`NavRail`: the named panes (Chat, Files, Tasks, Tools, Agent)
  with Settings under them, then the seam divider, then a **faces-only** agent column — no labels,
  the name lives in the panel row beside each face — and a fixed ☰ all-agents cell docked at the
  foot outside the scroll. The agent block is content-height and rides the foot: a short list sits
  on the ☰, a long one shrinks back to under Settings and scrolls. There is no More, because a
  rail has room to name every pane. **An avatar answers
  *who*, not *where*:** picking another agent keeps the pane you are on (Files stays Files, with
  their files), because being thrown to Chat made the avatars a place you dared not click while
  something else was open; on Chat it opens the panel, and the open agent's own avatar is the
  "back to my conversations" verb that still jumps to Chat. A kept-open pane has to **follow**
  the agent, which is two mechanics and one exception: the anchor (`App`'s effect takes that
  agent's most recent conversation when a secondary pane is open with nothing selected — Files
  is a conversation's directory and Tasks its runs, and the panel that would supply one is
  hidden there), and Files' own reset (`agentId` changes → the root and its tree clear **to the
  agent's workspace, not to null**: a child's effects run before its parent's, so clearing let
  the init effect recapture the previous agent's `cwd`). `use-conversation` clears `cwd` with
  no scope for the same reason. **Runs is not per-agent** — its lists are the BFF's Codex,
  Claude and remote-pi runs across every agent. One `--rail-cell` (44px) is the shared row
  height of a rail cell and the panel's name row, and the two agent blocks are congruent boxes —
  the seam is each block's own `border-top`, and `App` mirrors the rail block's measured height
  onto the panel — so a face's and a name's centers land on one line, and one hover lights both
  halves at once with a plain row background (no accent or amber bars). Beside it the **panel** (`Sidebar`) belongs to Chat:
  conversations on top (a tool row with New and the pin, then search), and the same agents again as
  a names-only block docked at its foot, `＋ New-agent` under it. A secondary pane puts it away,
  and the pin (in that tool row; localStorage, pinned by default) decides whether Chat keeps it as
  a column or treats it as a peek that closes on a press anywhere else — except the top band, whose
  identity button IS the show/hide verb (clicking it while pinned unpins and hides). It stays **mounted** when hidden — its
  polling is what fills `activeScopes`, so an agent that is answering still lights its avatar.
  **There is one conversation panel, its New button says whose list it shows, and a hover
  borrows it.** The panel wears no head; the New button reads `New conversation with X` while a
  borrowed list is up — a list silent about whose it is makes the next click a gamble.
  Resting on an avatar (120ms of deliberate rest, mouse only) asks `App` to show that agent's
  list in the same panel (`previewId` + `onPreviewAgent`, lists from `use-agent-conversations.ts`),
  read-only while borrowed: no archive, no rename — those belong to the agent whose panel this is.
  The **open** agent's own avatar is never borrowed — resting on it is "give me my own list
  back" (`onOwnAvatar`: peek open, full verbs, New button), because borrowing an agent its own
  panel already showed took the verbs away and sent the row click down the switch path, which
  emptied the list. A rail-face borrow is honoured only while the panel is **unpinned** (a pinned
  column is what you are reading, and it does not change agents under you) and only on Chat, while
  the panel's own name-row hover is honoured even pinned — the pointer is already inside the column
  you are reading; a pane change or a pin click clears the borrow; the panel holds the borrow
  while the pointer is inside it (`onHold`), and a press or a pointer-out puts it back. Avatar to
  avatar is **one gesture, not a close and an open**: the close armed by leaving the first never
  runs, and once a list is up the next replaces it at once — the 120ms prices an *opening*, not a
  change of mind, and a panel that blinks back to your own list mid-move is the bug.
  Below 900px both are `display: none` and the
  **bottom bar** (`BottomBar`) is the navigation: five equal slots — Chat, Files,
  Tasks, Tools, then More holding Agent, Runs and Settings — and no avatar, because
  a letter in a bar never said which agent it meant. The open agent's **face** is in
  the header's left corner (`.where-avatar`, hidden from 900px, `tintFor` + `initialOf`
  + the responding dot) and opens the same switcher the agent-name button beside it
  does. Identity lives in the header; the bar is panes and nothing else.
  Both nav surfaces stay mounted and CSS picks one, the way the sidebar always did, so `ui-check`
  reads state at either width. Conversation verbs are a hover-revealed `.conversation-archive`
  glyph beside the ⋯ on desktop and the ⋯ alone on a phone (there is no hover on a touch device),
  and archived conversations come back through the centred `.sidebar-archived` link. Counts for
  agents other than the open one come from `useAgentStats`, fetched when the switcher opens.
  ui-check reads the open agent from `.rail-agent.active[data-agent-id]`.
- **Settings are split by scope, and the split is the UI's only statement of it.** The **Agent** tab
  (`web/src/tabs/AgentTab.tsx`) holds what belongs to the selected agent: General (name, model, base
  system prompt, delete), Secrets, Reflection, and the Skills it sees. The **Tools** tab
  (`web/src/tabs/ToolsTab.tsx`) holds which shared tool families that agent is offered and what each
  one points at *for it*. **Settings** (`components/GlobalSettings.tsx`, full screen; wrapping chips
  with short names on a phone, the grouped list beside the section on desktop; reached from the
  rail's pane list on desktop and the More sheet on a phone), holds what every agent shares — providers,
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
  `SHARED_NOTE` has to name **both** per-agent tabs. Inside a settings section body
  `.section-note` is a **heading** (12px bold, like "Change password") and the prose that
  explains the rows is `.section-copy` — their inset and size, with the banner's code chip —
  so a section is rows, one statement, one provenance line; a `p.warning` that also carries a
  `.section-note` renders the banner's text at heading weight, which is what made a section
  read as clutter.
