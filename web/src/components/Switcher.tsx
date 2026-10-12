import { useCallback, useEffect, useMemo, useState } from "react";
import { agentActivity } from "../lib/activity.ts";
import { initialOf, tintFor } from "../lib/agent-tint.ts";
import { groupByDate, listDate, visibleConversations } from "../lib/conversation-groups.ts";
import { statsOf, useAgentStats } from "../state/use-agent-stats.ts";
import type { AgentSummary, AgentsApi } from "../state/use-agents.ts";
import { useBackToClose } from "../state/use-back-to-close.ts";
import type { SessionApi } from "../state/use-session.ts";
import { AgentMenu } from "./AgentMenu.tsx";
import { ConversationMenu } from "./ConversationMenu.tsx";
import { DeleteAgentSheet } from "./DeleteAgentSheet.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  agents: AgentsApi;
  session: SessionApi;
  onClose: () => void;
  onNewAgent: () => void;
  onEditAgent: (agentId: string) => void;
}

/**
 * Agents and conversations in one full-screen menu, opened from the composer
 * (and the top bar). The selected agent's conversations fill the screen, as
 * cards sectioned by date; your agents sit at the bottom, in thumb reach.
 * Tapping an agent switches to it — `use-agents` then opens its most recent
 * conversation — and the list follows. Each list starts with its own "new"
 * card, in one shared style.
 */
export function Switcher({ agents, session, onClose, onNewAgent, onEditAgent }: Props) {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** An agent's ⋯ menu, with the button it hangs from. */
  const [agentMenu, setAgentMenu] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const [deleting, setDeleting] = useState<AgentSummary | null>(null);
  /** Archived agents are hidden until asked for. */
  const [showArchivedAgents, setShowArchivedAgents] = useState(false);
  const closeAgentMenu = useCallback(() => setAgentMenu(null), []);
  const [busy, setBusy] = useState(false);
  // Back closes an open ⋯ menu first, then the switcher — never the app.
  useBackToClose(onClose);
  useBackToClose(() => setMenuFor(null), menuFor !== null);
  // An open agent menu closes itself on Back, Escape and presses elsewhere
  // (`AgentMenu`); the Escape below only must not close the switcher too.
  const [switchedTo, setSwitchedTo] = useState<string | null>(null);

  const stats = useAgentStats(session.request, agents.agents, true);
  const current = agents.agents.find((agent) => agent.id === agents.agentId) ?? null;
  const activity = agentActivity(
    session.activeScopes,
    agents.agentId,
    agents.conversations.map((conversation) => conversation.id),
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (agentMenu) setAgentMenu(null);
      else if (menuFor) setMenuFor(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agentMenu, menuFor, onClose]);

  const archivedCount = agents.conversations.filter((c) => c.archived).length;
  const liveCount = agents.conversations.length - archivedCount;
  const groups = useMemo(
    () =>
      groupByDate(
        visibleConversations(agents.conversations, {
          showArchived,
          query,
          responding: activity.responding,
        }),
      ),
    [agents.conversations, showArchived, query, activity.responding],
  );

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const pickAgent = (agent: AgentSummary) => {
    setMenuFor(null);
    setQuery("");
    if (agent.id === agents.agentId) return;
    agents.selectAgent(agent.id);
    setSwitchedTo(agent.name);
  };

  const agentLine = (agent: AgentSummary) => {
    const own = agent.id === agents.agentId ? statsOf(agents.conversations) : stats.get(agent.id);
    const parts: string[] = [];
    if (own) parts.push(`${own.count} conversation${own.count === 1 ? "" : "s"}`);
    return { parts, lastActive: own?.lastActive };
  };

  return (
    <div className="switcher" role="dialog" aria-modal="true" aria-label="Agents and conversations">
      <div className="switcher-panel">
        {/* The same header as every menu sheet: title left, ✕ right. */}
        <header className="switcher-bar">
          <h2>{current?.name ?? "Conversations"}</h2>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        <label className="switcher-search">
          <Icon name="search" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${liveCount} conversations`}
            aria-label="Search conversations"
          />
        </label>

        <div className="switcher-list">
          {switchedTo ? (
            <p className="switcher-hint">
              Switched to {switchedTo} · opened its most recent conversation
            </p>
          ) : null}

          <button
            type="button"
            className="switcher-new"
            disabled={busy || !agents.agentId}
            onClick={() =>
              void guard(async () => {
                await agents.createConversation();
                onClose();
              })
            }
          >
            <Icon name="plus" />
            <span>New conversation{current ? ` with ${current.name}` : ""}</span>
          </button>

          {activity.inDefault ? (
            <p className="activity-note small muted">
              <span className="activity-dot" aria-hidden="true" /> Responding in the agent's default
              conversation (a scheduled or channel turn — not listed)
            </p>
          ) : null}

          {groups.map((group) => (
            <section key={group.label}>
              <h3 className="switcher-group">{group.label}</h3>
              {group.items.map((conversation) => {
                const open = conversation.id === agents.conversationId;
                const responding = activity.responding.has(conversation.id);
                return (
                  <div
                    key={conversation.id}
                    className={`switcher-card conversation${open ? " selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="switcher-card-main"
                      onClick={() => {
                        agents.selectConversation(conversation.id);
                        onClose();
                      }}
                    >
                      <span className="switcher-card-title">{conversation.summary}</span>
                      <span className="switcher-card-meta">
                        {listDate(conversation.updatedAt)}
                        {conversation.archived ? " · archived" : ""}
                        {responding ? <span className="responding"> · responding…</span> : null}
                      </span>
                    </button>
                    {/* The current conversation, marked like any pick-one choice. */}
                    {open ? <Icon name="check" className="switcher-check" /> : null}
                    <button
                      type="button"
                      className="switcher-more"
                      aria-label={`More for ${conversation.summary}`}
                      aria-expanded={menuFor === conversation.id}
                      onClick={() =>
                        setMenuFor((current) =>
                          current === conversation.id ? null : conversation.id,
                        )
                      }
                    >
                      <Icon name="more" />
                    </button>
                    {menuFor === conversation.id ? (
                      <ConversationMenu
                        agents={agents}
                        conversation={conversation}
                        busy={busy}
                        guard={guard}
                        onClose={() => setMenuFor(null)}
                      />
                    ) : null}
                  </div>
                );
              })}
            </section>
          ))}

          {groups.length === 0 ? (
            <p className="muted small switcher-empty">
              {query.trim() ? "No conversation matches." : "No conversations yet."}
            </p>
          ) : null}

          {archivedCount > 0 ? (
            <button
              type="button"
              className="switcher-archived"
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
            </button>
          ) : null}
          {agents.error ? (
            <p className="warning small" role="alert">
              <span>{agents.error}</span>
              <button type="button" className="link" onClick={() => void agents.refreshAgents()}>
                Try again
              </button>
            </p>
          ) : null}
        </div>

        <section className="switcher-agents" aria-label="Agents" onScroll={closeAgentMenu}>
          <h3 className="switcher-group">Agents</h3>
          <button type="button" className="switcher-new" disabled={busy} onClick={onNewAgent}>
            <Icon name="plus" />
            <span>New agent</span>
          </button>
          {agents.agents
            .filter((agent) => !agents.archivedAgents.has(agent.id))
            .concat(
              showArchivedAgents
                ? agents.agents.filter((agent) => agents.archivedAgents.has(agent.id))
                : [],
            )
            .map((agent) => {
              const selected = agent.id === agents.agentId;
              const archived = agents.archivedAgents.has(agent.id);
              const { parts, lastActive } = agentLine(agent);
              const responding = session.activeAgentIds.has(agent.id);
              return (
                <div
                  key={agent.id}
                  className={`switcher-card agent${selected ? " selected" : ""}${archived ? " archived" : ""}`}
                >
                  <button
                    type="button"
                    className="switcher-card-main"
                    onClick={() => pickAgent(agent)}
                    aria-current={selected ? "true" : undefined}
                  >
                    <span className="switcher-avatar" style={{ background: tintFor(agent.id) }}>
                      {initialOf(agent.name)}
                    </span>
                    <span className="switcher-agent-text">
                      <span className="switcher-card-title">
                        {agents.pinned.has(agent.id) ? (
                          <Icon name="pin" className="switcher-pin" />
                        ) : null}
                        {agent.name}
                        {archived ? <span className="tag muted archived-tag">archived</span> : null}
                      </span>
                      <span className="switcher-card-meta">
                        {parts.join(" · ")}
                        {responding ? (
                          <span className="responding">
                            {parts.length ? " · " : ""}responding now
                          </span>
                        ) : lastActive ? (
                          `${parts.length ? " · " : ""}last active ${listDate(lastActive)}`
                        ) : null}
                      </span>
                    </span>
                    {selected ? <Icon name="check" className="switcher-check" /> : null}
                  </button>
                  <button
                    type="button"
                    className="switcher-more"
                    data-agent-more={agent.id}
                    aria-label={`More for ${agent.name}`}
                    aria-haspopup="menu"
                    aria-expanded={agentMenu?.id === agent.id}
                    onClick={(event) => {
                      const anchor = event.currentTarget.getBoundingClientRect();
                      setMenuFor(null);
                      setAgentMenu((current) =>
                        current?.id === agent.id ? null : { id: agent.id, anchor },
                      );
                    }}
                  >
                    <Icon name="more" />
                  </button>
                  {agentMenu?.id === agent.id ? (
                    <AgentMenu
                      agentName={agent.name}
                      pinned={agents.pinned.has(agent.id)}
                      archived={archived}
                      anchor={agentMenu.anchor}
                      placement="above"
                      onEdit={() => onEditAgent(agent.id)}
                      onTogglePin={() =>
                        void agents.setPinned(agent.id, !agents.pinned.has(agent.id))
                      }
                      onToggleArchive={() => void agents.setAgentArchived(agent.id, !archived)}
                      onDelete={() => setDeleting(agent)}
                      onClose={closeAgentMenu}
                    />
                  ) : null}
                </div>
              );
            })}
          {archivedAgentCount(agents) > 0 ? (
            <button
              type="button"
              className="switcher-archived"
              onClick={() => setShowArchivedAgents((v) => !v)}
            >
              {showArchivedAgents
                ? "Hide archived agents"
                : `Show archived agents (${archivedAgentCount(agents)})`}
            </button>
          ) : null}
        </section>
      </div>
      {deleting ? (
        <DeleteAgentSheet agents={agents} agent={deleting} onClose={() => setDeleting(null)} />
      ) : null}
    </div>
  );
}

/** Archived agents that still exist: a stale id in the BFF's list is not one. */
function archivedAgentCount(agents: AgentsApi): number {
  return agents.agents.filter((agent) => agents.archivedAgents.has(agent.id)).length;
}
