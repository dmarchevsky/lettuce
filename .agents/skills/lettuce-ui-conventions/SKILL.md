---
name: lettuce-ui-conventions
description: 'lettuce UI conventions that are ours: pin/archive lists live in the BFF, not the agent; a viewport-fixed AgentMenu; the desktop rail — one 184px column of 30px rows (`--rail-row`): named panes, an AGENTS group of face+name rows, and a worded ☰ foot cell that TOGGLES the conversation drawer (a pinned column or an unpinned peek), the column becoming Settings'' sections while that pane is open; a phone bar of five equal slots under a header carrying the open agent''s face (`.where-avatar`); the gear IS the link light and the door to Settings, and a non-Chat pane''s fixed corner `.pane-close` is what its bar keeps clear; both nav surfaces stay mounted and CSS picks one: ui-check reads the open agent from `.rail-agent.active[data-agent-id]`; the settings split (Agent, Tools, the Settings pane); no native checkbox (.menu-row-box / .chip-check). Read before touching NavRail, Sidebar, BottomBar, AgentMenu, the Agent/Tools/Settings tabs, settings-sections.ts or tabs.ts.'
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
  share.** Desktop gets a `--rail-w` (184px) **rail** (`NavRail`: the named panes (Chat, Files,
  Tasks, Tools, Agent) up top, then an `AGENTS` group word with one **face+name row per agent**
  (face at 22px, the name taking the room), then `＋ New agent`, then a fixed ☰ cell docked at the
  foot outside the scroll). **Every slot is one row** (`--rail-row`, 30px, glyph then word,
  left-aligned). The rail used to be a 56px strip of icon-only squares whose agent names lived in a
  *second* copy of the same list inside the panel, and that pair needed a mirrored height, a
  mirrored scrollTop and a shared hover mark to pass for one control — the machinery is deleted and
  the row language the Settings column already proved carries the whole rail. There is no Settings
  cell: the band's gear is the door, and **while Settings is the open pane the rail is a different
  list** — Back at the head, the sections in the same rows under their group words, the same ☰ at
  the foot. The agent block is content-height and rides the foot: a short list sits on the ☰, a long
  one shrinks back and  scrolls. **The ☰ is a toggle and it is worded** (`Conversations`): with no drawer up it goes to Chat
  and brings the drawer; with one up it puts it away, and a pinned drawer gives up its pin in the
  same click (`aria-pressed` is the drawer's visibility) — the identity button's precedent, since
  asking to hide a pinned column means you mean it. The word is the point: a bare ☰ under a column
  of words reads as a stray glyph, and the cell that said *All agents* now says what it opens. There is no More, because a rail has room to name every
  pane. A secondary pane always carries a fixed **corner close** (`.pane-close`, top-right under the
  band's hairline, the sheet's own glyph) whose verb is back to Chat, and the band's title names that
  pane while it is up; `.main` grows `.closable` so the pane's own `.pane-bar` pads its right end
  clear of it — an X over a chip is a control nobody can press, and `ui-check` proves the corner is
  clear at both widths. **An avatar answers
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
  no scope for the same reason. **Runs is per-agent too**: a run's owner is derived from the
  workspace it ran in (`bff/src/runs/attribution.ts` — a coding worker inherits its launching
  runtime's cwd, and a UI runtime's cwd is `/work/<agent-id>`), so the pane shows the open agent's
  Codex, Claude and remote-pi runs and nothing else. Its **one** control is a small link at the
  pane's top right — `show all`, which reads `<agent> only` while everything is showing; the scope is
  a look, never stored, and it resets when you switch agents. A run with no workspace owner (cron- and
  channel-fired workers run in `/work` itself) surfaces only under `show all`, reading `no agent`.
  Beside the rail sits the **drawer** (`Sidebar`), Chat's, holding conversations and nothing else —
  there is no agent list in it, because the rail is that list. It names whose list it is at its head
  (`.panel-owner`: the agent, then `N conversations`, the count left out while it is still unknown).
  A secondary pane puts it away, and the pin (in the tool row under the owner; localStorage,
  **unpinned by default** — the rail carries the names now, so the drawer is something you reach
  for, not something you live beside) decides its shape: pinned it is a column of the grid
  (`--panel-w`), unpinned it is a **peek** floating over the transcript with a shadow
  (`--drawer-w`), and it puts itself away when you press outside it or choose something in it —
  choosing is what closes a peek, since it was opened to answer that one question. The exception is
  the top band, whose  identity button IS the show/hide verb (clicking it while pinned unpins and hides). It stays **mounted** when hidden — its
  polling is what fills `activeScopes`, so an agent that is answering still lights its avatar.
  **There is one conversation drawer, its New button says whose list it shows, and a hover
  borrows it.** The drawer's only head line is its owner; the New button reads `New conversation with X` while a
  borrowed list is up — a list silent about whose it is makes the next click a gamble.
  Resting on an avatar (120ms of deliberate rest, mouse only) asks `App` to show that agent's
  list in the same drawer (`previewId` + `onPreviewAgent`, lists from `use-agent-conversations.ts`),
  read-only while borrowed: no archive, no rename — those belong to the agent whose panel this is.
  The **open** agent's own avatar is never borrowed — resting on it is "give me my own list
  back" (`onOwnAvatar`: peek open, full verbs, New button), because borrowing an agent its own
  drawer already showed took the verbs away and sent the row click down the switch path, which
  emptied the list. A rail-face borrow is honoured only while the drawer is **unpinned** (a pinned
  column is what you are reading, and it does not change agents under you) and only on Chat;  you are reading; a pane change or a pin click clears the borrow; the panel holds the borrow
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
  ui-check reads the open agent from `.rail-agent.active[data-agent-id]`. **`.rail` is two
  components wearing one class name:** the nav column is `nav.rail`, while the transcript's
  tool-rail (`MessageList`, `PiRunSheet`) is a different component that shares the bare `.rail` —
  a CSS edit naming `.rail` unscoped leaks across, in both directions (a tool-rail rule gave the
  nav a 2px border-left once; a nav rule reaches the entries the other way). So the entry rail is
  scoped `.entry .rail` and the nav's responsive rules are tagged `nav.rail`; `styles.css`
  comments both leaks at their rules.
- **Settings are split by scope, and the split is the UI's only statement of it.** The **Agent** tab
  (`web/src/tabs/AgentTab.tsx`) holds what belongs to the selected agent: General (name, model, base
  system prompt, delete), Secrets, Reflection, and the Skills it sees. The **Tools** tab
  (`web/src/tabs/ToolsTab.tsx`) holds which shared tool families that agent is offered and what each
  one points at *for it*. **Settings** (`web/src/tabs/SettingsTab.tsx`) is a **pane**, not a modal: it
  used to be a full-screen dialog over the pane you were reading, which put a second navigation system
  on top of the first (the rail kept showing panes you could not reach while Settings carried its own
  list of sections beside them). Now `tab === "Settings"`, the band's `.topbar-gear` is the door and
  the toggle back, the rail holds the sections while it is open, and a phone gets wrapping chips with
  short names over the section. The Settings rail is the same column in the same row language as the
  pane rail — one row of icon + full `label`, group words flush-left — because a list of words needs
  a column that can hold one, and the phone's chips and the rail share `short`. `web/src/lib/settings-sections.ts` is the one registry — `label` for the pane's title and
  the rail's row, `short` for the chip, the icon, and the compose-token
  gate — because rail cell, chip and title are three renderings of one list that cannot be allowed to
  drift. It holds what every agent shares — providers,
  web search, MCP servers, Google, Codex/Claude workers, global skills — plus this device's
  notifications and an About. Where a new setting goes is decided by its backend key, not by taste:
  keyed by `agent_id` → Agent tab; a BFF file or an app-server-wide command → Settings; `runtime`
  scope → next to the conversation (the composer). Feature-gated sections (web search, Google, the
  coding workers) render from `features` in `/api/status`, so a compose token that is off hides the
  whole section from **both** the rail and the chips (`visibleGroups`, called by each). The open
  section is App's, remembered per device — the pane has no default.
- **The band's right cluster is one control, not two.** The gear wears the derived link status
  (`deriveLinkStatus`): its colour is the connection, the glyph turns while the connection is working
  on, and its title carries the words — so there is no separate status dot to hunt for when the app
  says something is wrong. The states a button must never swallow keep elements of their own: the busy
  `N responding` slot (`.topbar-status.busy`, left of the gear) and the signed-out pill. A passive
  light that names nothing and answers no click is decoration; the idle dot was retired.
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
