import { type CSSProperties, type Ref, useEffect, useMemo, useRef, useState } from "react";
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
   * second list beside the panes. The door is the band's gear, in App. */
  settingsOpen: boolean;
  /** Which section the pane is showing — the rail marks it. */
  settingsSection: GlobalSection;
  /** Gated the way the pane gates its chips: a section whose compose token is off
   * gets no cell here either. */
  features?: FeatureFlags;
  onPickSection: (section: GlobalSection) => void;
  /** The sections rail's Back cell: put Settings away, back to Chat. */
  onCloseSettings: () => void;
  /** The `all` cell: the conversation panel with the full agent list — a toggle, so
   * it also needs to know whether the panel is up. */
  onShowAll: () => void;
  panelVisible: boolean;
  onEditAgent: (agentId: string) => void;
  /**
   * The agent whose *name* in the conversation panel's bottom block the pointer
   * rests on: the rail marks that avatar, so the pair reads as one selection
   * control (the reverse direction — a rail hover marking the panel row — is
   * the borrow's row highlight). App owns the state; the rail only shows it.
   */
  heldAgentId: string | null;
  /** The pointer entered/left one of this rail's faces: App marks the matching
   * NAME in the conversation panel too — hover highlights one row across both
   * halves, whichever half the pointer is in. */
  onHoverAgent: (agentId: string | null) => void;
  /** This block's scroll element — App mirrors its scrollTop with the panel's. */
  blockRef: Ref<HTMLDivElement>;
  onBlockScroll: () => void;
}

/** The panes the rail offers, in order. `Runs` is inserted only when enabled. */
function paneItems(runsEnabled: boolean): { tab: Tab; label: string; icon: IconName }[] {
  const items: { tab: Tab; label: string; icon: IconName }[] = [
    { tab: "Chat", label: "Chat", icon: "chats" },
    { tab: "Files", label: "Files", icon: "folder" },
    { tab: "Tasks", label: "Tasks", icon: "task" },
  ];
  if (runsEnabled) items.push({ tab: "Runs", label: "Runs", icon: "terminal" });
  items.push(
    { tab: "Tools", label: "Tools", icon: "model" },
    { tab: "Agent", label: "Agent", icon: "shield" },
  );
  return items;
}

/**
 * The desktop rail: the panes on top, the agents anchored at the bottom.
 *
 * One column answers "which pane" and "which agent", and it shares its bottom
 * row with the conversation panel beside it: the agent block is content-height
 * and rides the foot above the all-cell, and the seam divider above it — one
 * hairline across both columns — is the block's own top border, so it rides
 * the first agent and the panel mirrors the block's measured height.
 * Chat is primary in the literal sense: it is the default pane, the only one with
 * a composer, and the only one with a panel.
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
  onShowAll,
  panelVisible,
  onEditAgent,
  heldAgentId,
  onHoverAgent,
  blockRef,
  onBlockScroll,
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
    // Another agent answers "who", not "where". Switching while you are looking at
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
        <AllCell onShowAll={onShowAll} panelVisible={panelVisible} word="All agents" />
      </nav>
    );
  }

  return (
    <nav className="rail" aria-label="Sections and agents">
      {panes.map((pane) => (
        <button
          key={pane.tab}
          type="button"
          className={`rail-item${tab === pane.tab ? " active" : ""}`}
          aria-current={tab === pane.tab ? "page" : undefined}
          onClick={() => onSelectPane(pane.tab)}
        >
          <Icon name={pane.icon} />
          {pane.label}
        </button>
      ))}

      {/* No divider element here: the seam hairline is .rail-agents' own
          border-top — the same 1px box edge the panel's agent block carries,
          so the two blocks are congruent and their rows ride one line. */}
      <div
        ref={blockRef}
        className="rail-agents"
        onScroll={() => {
          setMenu(null);
          onBlockScroll();
        }}
      >
        {visible.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={[
              "rail-agent",
              agent.id === agents.agentId ? "active" : "",
              agent.id === heldAgentId ? "held" : "",
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
                "--agent": resolveAvatar(agent.id, agent.name, agents.avatars[agent.id]).background,
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
              onHoverAgent(agent.id);
              if (agent.id === agents.agentId) armOwn();
              else armPreview(agent.id);
            }}
            onPointerLeave={() => {
              onHoverAgent(null);
              leaveAvatar();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ agent, anchor: event.currentTarget.getBoundingClientRect() });
            }}
          >
            <AgentAvatar agentId={agent.id} name={agent.name} pref={agents.avatars[agent.id]} />
          </button>
        ))}
      </div>

      {/* The all cell is not part of the scrolling list: it is the fixed verb at the
          foot of the column — pressing it brings the conversation panel with the full
          agent list and pressing it again puts the panel away (on desktop there is no
          sheet any more), and it never scrolls out of reach. There is no new-agent cell
          in the rail: New-agent lives in the panel's list, where the agents are. */}
      <AllCell onShowAll={onShowAll} panelVisible={panelVisible} />

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
 * The all cell, shared by both rails: the conversation panel with the full agent
 * list, and the same press putting it away. It is the one cell that survives the
 * rail changing subject — it is not a member of the list, it is the column's verb.
 */
function AllCell({
  onShowAll,
  panelVisible,
  word,
}: {
  onShowAll: () => void;
  panelVisible: boolean;
  /** The wide Settings column names its verbs; the square rail has no room for one. */
  word?: string;
}) {
  return (
    <button
      type="button"
      className="rail-agent rail-all"
      onClick={onShowAll}
      title={
        panelVisible
          ? "Hide the conversations panel"
          : "All agents: the full list in the conversation panel"
      }
      aria-label="Conversations panel"
      aria-pressed={panelVisible}
    >
      <Icon name="menu" />
      {word ? <span className="rail-all-word">{word}</span> : null}
    </button>
  );
}
