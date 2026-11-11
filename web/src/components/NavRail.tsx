import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { resolveAvatar } from "../lib/agent-tint.ts";
import type { FeatureFlags } from "../lib/features.ts";
import { type GlobalSection, visibleGroups } from "../lib/settings-sections.ts";
import type { Tab } from "../lib/tabs.ts";
import type { AgentSummary, AgentsApi } from "../state/use-agents.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { AgentMenu } from "./AgentMenu.tsx";
import { DeleteAgentSheet } from "./DeleteAgentSheet.tsx";
import type { IconName } from "./Icon.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  agents: AgentsApi;
  /** For the green dot on an avatar: any of that agent's conversations are responding. */
  activeAgentIds: ReadonlySet<string>;
  /** Whether the `Runs` pane exists at all on this deployment. */
  runsEnabled: boolean;
  tab: Tab;
  onSelectPane: (tab: Tab) => void;
  /** Tapping the open agent's avatar also brings the conversation panel back. */
  onOpenPanel: () => void;
  /** Resting on an avatar asks the one conversation panel to show that agent; `null`
   * is the pointer leaving. App decides whether the ask is honoured. */
  onPreviewAgent: (agentId: string | null) => void;
  /** Resting on the **open** agent's avatar asks for its own list back, not a borrow. */
  onOwnAvatar: () => void;
  /** Settings is a pane, and while it is the pane the rail holds its sections and
   * nothing else: the app has one navigation column, so the sections cannot be a
   * second list beside the panes; the door is this rail's own foot cell. */
  settingsOpen: boolean;
  /** Which section the pane is showing — the rail marks it. */
  settingsSection: GlobalSection;
  /** Gated the way the pane gates its chips: a section whose compose token is off
   * gets no cell here either. */
  features?: FeatureFlags;
  onPickSection: (section: GlobalSection) => void;
  /** The sections rail's Back cell: put Settings away, back to Chat. */
  onCloseSettings: () => void;
  /** The main rail's foot cell: Settings' door. There is no glyph for it in the
   * band any more — the column that names the panes names this one too. */
  onOpenSettings: () => void;
  /** Unpinned, the rail is a glyph-only strip (the pin in the AGENTS row toggles
   * it). Never true while Settings is the pane — that rail keeps its word rows. */
  railCollapsed: boolean;
  onToggleRailPin: () => void;
  /** The Settings column's ☰: leave the pane and bring the conversation drawer. */
  onShowAll: () => void;
  onEditAgent: (agentId: string) => void;
  /** New agent, at the foot of the agent list: the drawer that used to carry this
   * verb is usually shut, so the rail has to. */
  onNewAgent: () => void;
}

/** The panes the rail offers, in order. `Runs` is inserted only when enabled. */
function paneItems(runsEnabled: boolean): { tab: Tab; label: string; icon: IconName }[] {
  const items: { tab: Tab; label: string; icon: IconName }[] = [
    { tab: "Chat", label: "Chat", icon: "chats" },
    { tab: "Files", label: "Files", icon: "folder" },
    { tab: "Tasks", label: "Tasks", icon: "task" },
  ];
  if (runsEnabled) items.push({ tab: "Runs", label: "Runs", icon: "terminal" });
  items.push({ tab: "Agent", label: "Agent", icon: "shield" });
  return items;
}

/**
 * The desktop rail: the agents up top — "who" before "where" — the panes fixed
 * above the foot cell, and Settings' door on the foot.
 *
 * One column answers "which agent" and "which pane", in one row height. An agent
 * row carries a ⋯ at its right end, revealed on hover, which opens the same menu
 * a right-click does.
 *
 * The AGENTS row doubles as the column's head: its right corner carries the pin that
 * collapses the rail to an icon strip (the Settings rail never collapses — a
 * list of words needs a column that can hold one). Unpinned, words hide and
 * every row centers its glyph; `title` carries the word there. Chat is primary
 * in the literal sense: it is the default pane, the only one with a composer,
 * and the only one with a drawer.
 */
export function NavRail({
  agents,
  activeAgentIds,
  runsEnabled,
  tab,
  onSelectPane,
  onOpenPanel,
  onPreviewAgent,
  onOwnAvatar,
  settingsOpen,
  settingsSection,
  features,
  onPickSection,
  onCloseSettings,
  onOpenSettings,
  railCollapsed,
  onToggleRailPin,
  onShowAll,
  onEditAgent,
  onNewAgent,
}: Props) {
  const [menu, setMenu] = useState<{ agent: AgentSummary; anchor: DOMRect } | null>(null);
  const [deleting, setDeleting] = useState<AgentSummary | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A hover is a *deliberate* rest, not a sweep of the pointer down the rail: 120ms
  // is the point where passing through stops opening the panel. What it opens is the
  // one conversation panel, showing whichever agent is under the pointer — App decides
  // whether the ask is honoured (a pinned panel is already on screen, and a secondary
  // pane has no panel to give without changing the pane under someone who is reading).
  // The close waits 300ms so the pointer can cross the gap to the panel; if it arrives,
  // the panel reports the hold and the preview stays rather than snapping shut.
  // Which agent the panel is showing right now, as far as the rail knows: moving
  // from one avatar to the next is one gesture, not a close and an open.
  const shown = useRef<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armPreview = (agentId: string) => {
    // The close armed by leaving the avatar you came from never gets to run: a panel
    // that blinks back to your own list and opens again is a flicker, and the pointer
    // never asked for it. And once a list is already up, the next one replaces it at
    // once — the 120ms is the price of *opening*, not of changing your mind.
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(
      () => {
        shown.current = agentId;
        onPreviewAgent(agentId);
      },
      shown.current === null ? 120 : 0,
    );
  };
  const armOwn = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(onOwnAvatar, shown.current === null ? 120 : 0);
  };
  const leaveAvatar = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      shown.current = null;
      onPreviewAgent(null);
    }, 300);
  };
  // Whatever is pending when the rail goes away never becomes a panel.
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  // A menu hanging from an avatar moves with it, so anything that moves the avatar —
  // the window resizing, the shared block height changing — closes it rather than
  // leaving it floating in the old place.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [menu]);

  const pick = (agent: AgentSummary) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    shown.current = null;
    if (agent.id === agents.agentId) {
      // Same agent: the pane is already this agent's, so the useful verb is the
      // one thing the rail has left — bring the conversations back.
      onSelectPane("Chat");
      onOpenPanel();
      return;
    }
    // One agent answers "who", not "where". Switching while you are looking at
    // Files stays on Files, with the new agent's files: being thrown to Chat made the
    // avatars a place you dared not click while something else was open.
    agents.selectAgent(agent.id);
    if (tab === "Chat") onOpenPanel();
  };

  const visible = agents.agents.filter((agent) => !agents.archivedAgents.has(agent.id));
  const panes = paneItems(runsEnabled);
  const groups = useMemo(() => visibleGroups(features), [features]);

  // Settings is not a list stacked under the panes — it replaces them. The rail is
  // the app's one navigation column and it holds one subject at a time, which is
  // also what keeps it short enough to read: eleven sections, four group words, a
  // Back cell and the all cell fit a laptop window without scrolling.
  if (settingsOpen) {
    return (
      <nav className="rail rail-settings" aria-label="Settings sections">
        <button
          type="button"
          className="rail-item rail-back"
          onClick={onCloseSettings}
          title="Back to Chat"
          aria-label="Back to Chat"
        >
          <Icon name="back" />
          Back
        </button>
        <div className="rail-groups">
          {groups.map((group) => (
            <div className="rail-group" key={group.label}>
              <span className="rail-group-label">{group.label}</span>
              {group.sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={`rail-item rail-section${
                    settingsSection === section.id ? " active" : ""
                  }`}
                  aria-current={settingsSection === section.id ? "page" : undefined}
                  onClick={() => onPickSection(section.id)}
                >
                  <Icon name={section.icon} />
                  {section.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        <AllCell onShowAll={onShowAll} word="Conversations" />
      </nav>
    );
  }

  return (
    <nav
      className={`rail${railCollapsed ? " rail-collapsed" : ""}`}
      aria-label="Agents and sections"
    >
      {/* The agents ride the top: the block fills the room above the panes and
          scrolls on its own when the list outgrows it. Its head row carries the
          group word and — in the right corner, on the drawer pin's metrics — the
          pin that folds the rail down to glyphs. */}
      <div className="rail-agents" onScroll={() => setMenu(null)}>
        <div className="rail-agents-head">
          <span className="rail-group-label">Agents</span>
          <button
            type="button"
            className="col-pin"
            aria-pressed={!railCollapsed}
            onClick={onToggleRailPin}
            title={
              railCollapsed
                ? "Pin the rail open — show names again"
                : "Unpin to collapse the rail to icons"
            }
            aria-label={railCollapsed ? "Expand the rail" : "Collapse the rail"}
          >
            <Icon name="pin" />
          </button>
        </div>
        {visible.map((agent) => (
          <div key={agent.id} className="rail-agent-row">
            <button
              type="button"
              className={[
                "rail-agent",
                agent.id === agents.agentId ? "active" : "",
                agents.pinned.has(agent.id) ? "pinned" : "",
                activeAgentIds.has(agent.id) ? "responding" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-agent-id={agent.id}
              // The face's own tint, one level up: the active row's left bar (see
              // .rail-agent.active::before) is the agent's own color, and only
              // resolveAvatar knows it — same call AgentAvatar is about to make.
              style={
                {
                  "--agent": resolveAvatar(agent.id, agent.name, agents.avatars[agent.id])
                    .background,
                } as CSSProperties
              }
              title={
                agents.pinned.has(agent.id)
                  ? `${agent.name} (pinned) — conversations`
                  : `${agent.name} — conversations`
              }
              onClick={() => pick(agent)}
              onPointerEnter={(event) => {
                if (event.pointerType !== "mouse") return;
                if (agent.id === agents.agentId) armOwn();
                else armPreview(agent.id);
              }}
              onPointerLeave={leaveAvatar}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ agent, anchor: event.currentTarget.getBoundingClientRect() });
              }}
            >
              <AgentAvatar agentId={agent.id} name={agent.name} pref={agents.avatars[agent.id]}>
                {/* Pinned is a gold pushpin on the face — the same glyph the
                    switcher's rows already mark with, where a dot never fitted. It is
                    the FILLED twin, not the stroked rail verb: this one is a status mark
                    on a coloured disc, and a 12px outline there disappears. */}
                {agents.pinned.has(agent.id) ? (
                  <span className="agent-pin">
                    <Icon name="pin-solid" />
                  </span>
                ) : null}
              </AgentAvatar>
              <span className="rail-agent-name">{agent.name}</span>
            </button>
            {/* The agent's verbs, which until now only a right-click knew about. It
                  cannot live inside the row (a button cannot hold a button), so the row
                  wears it as a sibling and the pair shares the row's hover. Folded, the
                  56px strip has no room for a second glyph, so it hides there and
                  right-click remains the verb. */}
            <button
              type="button"
              className="rail-agent-more"
              data-agent-more
              aria-label={`More for ${agent.name}`}
              aria-haspopup="menu"
              aria-expanded={menu?.agent.id === agent.id}
              onClick={(event) => {
                const anchor = event.currentTarget.getBoundingClientRect();
                setMenu((current) => (current?.agent.id === agent.id ? null : { agent, anchor }));
              }}
            >
              <Icon name="more" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="rail-agent rail-new"
          onClick={onNewAgent}
          title="New agent"
        >
          <Icon name="plus" />
          New agent
        </button>
      </div>

      {/* The panes sit above the foot: the block's hairline above them is the one
          that ends the agents, and these rows answer "where" last, nearest the
          bottom where the steady things live. */}
      <div className="rail-panes">
        {panes.map((pane) => (
          <button
            key={pane.tab}
            type="button"
            className={`rail-item${tab === pane.tab ? " active" : ""}`}
            aria-current={tab === pane.tab ? "page" : undefined}
            title={railCollapsed ? pane.label : undefined}
            onClick={() => onSelectPane(pane.tab)}
          >
            <Icon name={pane.icon} />
            {pane.label}
          </button>
        ))}
      </div>

      {/* The foot cell, outside the scroll: Settings' door. It sits at the foot
          rather than among the panes because it is not a place you are — it is the
          one row that leaves the app's own rooms for its configuration, and it is
          where the column's other leave-the-room verb used to live. */}
      <button
        type="button"
        className="rail-agent rail-door rail-settings-cell"
        onClick={onOpenSettings}
        title="Settings — providers, search, MCP, Google, workers"
        aria-label="Settings"
      >
        <Icon name="settings" />
        <span className="rail-foot-word">Settings</span>
      </button>

      {menu ? (
        <AgentMenu
          agentName={menu.agent.name}
          pinned={agents.pinned.has(menu.agent.id)}
          archived={agents.archivedAgents.has(menu.agent.id)}
          anchor={menu.anchor}
          placement="beside"
          onEdit={() => {
            setMenu(null);
            if (menu.agent.id !== agents.agentId) agents.selectAgent(menu.agent.id);
            onEditAgent(menu.agent.id);
          }}
          onTogglePin={() => {
            setMenu(null);
            void agents.setPinned(menu.agent.id, !agents.pinned.has(menu.agent.id));
          }}
          onToggleArchive={() => {
            setMenu(null);
            void agents.setAgentArchived(menu.agent.id, !agents.archivedAgents.has(menu.agent.id));
          }}
          onDelete={() => {
            setMenu(null);
            setDeleting(menu.agent);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {deleting ? (
        <DeleteAgentSheet agents={agents} agent={deleting} onClose={() => setDeleting(null)} />
      ) : null}
    </nav>
  );
}

/**
 * The Settings column's foot cell: leave the pane and bring the conversation drawer
 * with you. A door and not a toggle — pressing it lands you on Chat with the drawer
 * up, so there is no second press here to undo the first. On Chat the undo is the
 * band's identity button, which hides the drawer and gives up a pin in one click,
 * which is why that one is `aria-pressed` and this one is not.
 */
function AllCell({ onShowAll, word }: { onShowAll: () => void; word?: string }) {
  return (
    <button
      type="button"
      className="rail-agent rail-all"
      onClick={onShowAll}
      title="Back to the conversations, with the list open"
      aria-label="Conversations"
    >
      <Icon name="menu" />
      {word ? <span className="rail-foot-word">{word}</span> : null}
    </button>
  );
}
