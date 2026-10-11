import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentActivity } from "../lib/activity.ts";
import { initialOf, tintFor } from "../lib/agent-tint.ts";
import { groupByDate, listDate, visibleConversations } from "../lib/conversation-groups.ts";
import { statsOf, useAgentStats } from "../state/use-agent-stats.ts";
import type { AgentSummary, AgentsApi } from "../state/use-agents.ts";
import type { SessionApi } from "../state/use-session.ts";
import { useWide } from "../state/use-wide.ts";
import { AgentMenu } from "./AgentMenu.tsx";
import { ConversationMenu } from "./ConversationMenu.tsx";
import { DeleteAgentSheet } from "./DeleteAgentSheet.tsx";
import { Icon } from "./Icon.tsx";
import { ToggleRow } from "./MenuRow.tsx";

interface Props {
  agents: AgentsApi;
  open: boolean;
  onClose: () => void;
  onNewAgent: () => void;
  onEditAgent: (agentId: string) => void;
  /** Scope keys of conversations with a response in progress; see `SessionApi.activeScopes`. */
  activeScopes: ReadonlySet<string>;
  activeAgentIds: ReadonlySet<string>;
  /** For every agent's conversation count; see `useAgentStats`. */
  request: SessionApi["request"];
}

export function Sidebar({
  agents,
  open,
  onClose,
  onNewAgent,
  onEditAgent,
  activeScopes,
  activeAgentIds,
  request,
}: Props) {
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** An agent row's ⋯ menu, hung from its button. */
  const [agentMenu, setAgentMenu] = useState<{ agent: AgentSummary; anchor: DOMRect } | null>(null);
  const closeAgentMenu = useCallback(() => setAgentMenu(null), []);
  const [deleting, setDeleting] = useState<AgentSummary | null>(null);
  /** Archived agents are hidden until asked for. */
  const [showArchivedAgents, setShowArchivedAgents] = useState(false);
  const archivedAgentCount = agents.agents.filter((agent) =>
    agents.archivedAgents.has(agent.id),
  ).length;
  // Counts for every agent. Only fetched at the desktop width: the sidebar
  // stays mounted, hidden, on a phone, where the switcher has its own.
  const wide = useWide();
  const stats = useAgentStats(request, agents.agents, wide);
  const agentRows = agents.agents
    .filter((agent) => !agents.archivedAgents.has(agent.id))
    .concat(
      showArchivedAgents
        ? agents.agents.filter((agent) => agents.archivedAgents.has(agent.id))
        : [],
    );
  const listRef = useRef<HTMLUListElement>(null);

  // An open ⋯ menu closes on Escape or a press anywhere outside it (its own
  // button toggles it), and scrolls into view: the list clips it otherwise.
  useEffect(() => {
    if (!menuFor) return;
    const row = listRef.current?.querySelector<HTMLElement>("li.menu-open");
    row?.querySelector(".switcher-menu")?.scrollIntoView({ block: "nearest" });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuFor(null);
    };
    const onPointer = (event: PointerEvent) => {
      if (!row?.contains(event.target as Node)) setMenuFor(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [menuFor]);

  const activity = agentActivity(
    activeScopes,
    agents.agentId,
    agents.conversations.map((conversation) => conversation.id),
  );

  // The switcher's list, laid out for a column: the same filter, search and
  // date sections, so desktop and phone never show two different lists.
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
  const liveCount = agents.conversations.filter((c) => !c.archived).length;

  // A busy conversation the list has never heard of was created after it was
  // fetched (a cron that starts a new conversation per run). Refetch once per
  // such id; if it still is not there, the notice below says so instead.
  const refetchedFor = useRef(new Set<string>());
  const unlistedKey = activity.unlisted.join(",");
  useEffect(() => {
    const agentId = agents.agentId;
    if (!agentId || !unlistedKey) return;
    const fresh = unlistedKey.split(",").filter((id) => !refetchedFor.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) refetchedFor.current.add(id);
    void agents.refreshConversations(agentId);
  }, [agents.agentId, unlistedKey, agents.refreshConversations]);

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {open ? (
        <button type="button" className="scrim" onClick={onClose} aria-label="Close" />
      ) : null}

      <aside className={`sidebar${open ? " open" : ""}`}>
        {/* Agents on a panel of their own — round avatars, a count, a left
            bar for the open one — so the list never reads as more
            conversations. Each row has its own ⋯ (`AgentMenu`). */}
        <div className="sidebar-section sidebar-agents">
          <div className="row-between">
            <span className="section-label">Agents</span>
            <button
              type="button"
              className="button ghost compact"
              disabled={busy}
              onClick={onNewAgent}
              aria-label="New agent"
            >
              <Icon name="plus" /> New
            </button>
          </div>
          <ul className="agent-list" onScroll={closeAgentMenu}>
            {agents.agents.length === 0 ? <li className="muted small pad">No agents</li> : null}
            {agentRows.map((agent) => {
              const selected = agent.id === agents.agentId;
              const archived = agents.archivedAgents.has(agent.id);
              const responding = activeAgentIds.has(agent.id);
              // The open agent's count comes from its own list, which is
              // always current; the others from the last stats fetch.
              const count = (selected ? statsOf(agents.conversations) : stats.get(agent.id))?.count;
              const menuOpen = agentMenu?.agent.id === agent.id;
              return (
                <li
                  key={agent.id}
                  data-agent-id={agent.id}
                  className={[
                    "agent-row",
                    selected ? "active" : "",
                    archived ? "archived" : "",
                    menuOpen ? "menu-open" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <button
                    type="button"
                    className="agent-row-main"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => {
                      if (!selected) agents.selectAgent(agent.id);
                      onClose();
                    }}
                  >
                    <span className="agent-avatar" style={{ background: tintFor(agent.id) }}>
                      {initialOf(agent.name)}
                    </span>
                    <span className="agent-row-name">
                      {agents.pinned.has(agent.id) ? (
                        <Icon name="pin" className="switcher-pin" />
                      ) : null}
                      {agent.name}
                    </span>
                    {archived ? <span className="tag muted archived-tag">archived</span> : null}
                    {responding ? (
                      <span
                        className="activity-dot"
                        role="img"
                        aria-label="Responding"
                        title="Responding…"
                      />
                    ) : count !== undefined ? (
                      <span className="agent-row-count" title={`${count} conversations`}>
                        {count}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="icon-button flat agent-more"
                    data-agent-more={agent.id}
                    aria-label={`More for ${agent.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={(event) => {
                      const anchor = event.currentTarget.getBoundingClientRect();
                      setMenuFor(null);
                      setAgentMenu((current) =>
                        current?.agent.id === agent.id ? null : { agent, anchor },
                      );
                    }}
                  >
                    <Icon name="more" />
                  </button>
                </li>
              );
            })}
          </ul>
          {archivedAgentCount > 0 ? (
            <button
              type="button"
              className="link sidebar-archived-agents"
              onClick={() => setShowArchivedAgents((v) => !v)}
            >
              {showArchivedAgents
                ? "Hide archived agents"
                : `Show archived agents (${archivedAgentCount})`}
            </button>
          ) : null}
          {agentMenu ? (
            <AgentMenu
              agentName={agentMenu.agent.name}
              pinned={agents.pinned.has(agentMenu.agent.id)}
              archived={agents.archivedAgents.has(agentMenu.agent.id)}
              anchor={agentMenu.anchor}
              placement="below"
              onEdit={() => onEditAgent(agentMenu.agent.id)}
              onTogglePin={() =>
                void agents.setPinned(agentMenu.agent.id, !agents.pinned.has(agentMenu.agent.id))
              }
              onToggleArchive={() =>
                void agents.setAgentArchived(
                  agentMenu.agent.id,
                  !agents.archivedAgents.has(agentMenu.agent.id),
                )
              }
              onDelete={() => setDeleting(agentMenu.agent)}
              onClose={closeAgentMenu}
            />
          ) : null}
          {deleting ? (
            <DeleteAgentSheet agents={agents} agent={deleting} onClose={() => setDeleting(null)} />
          ) : null}
        </div>

        <div className="sidebar-section grow">
          <div className="row-between">
            <span className="section-label">Conversations</span>
            <button
              type="button"
              className="button ghost compact"
              disabled={busy || !agents.agentId}
              onClick={() => void guard(agents.createConversation)}
              aria-label="New conversation"
            >
              <Icon name="plus" /> New
            </button>
          </div>

          <label className="switcher-search sidebar-search">
            <Icon name="search" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${liveCount} conversations`}
              aria-label="Search conversations"
            />
          </label>

          <ul className="conversations" ref={listRef}>
            {/* The default conversation is never listed and cannot be opened
              (see lib/activity.ts), so it can only be reported here. */}
            {activity.inDefault ? (
              <li className="activity-note small muted">
                <span className="activity-dot" aria-hidden="true" />
                Responding in the agent's default conversation (a scheduled or channel turn — not
                listed)
              </li>
            ) : null}
            {activity.unlisted.length > 0 ? (
              <li className="activity-note small muted">
                <span className="activity-dot" aria-hidden="true" />
                Responding in {activity.unlisted.length === 1 ? "a conversation" : "conversations"}{" "}
                not in this list
              </li>
            ) : null}
            {groups.flatMap((group) => [
              <li key={`group:${group.label}`} className="conversation-group">
                {group.label}
              </li>,
              ...group.items.map((conversation) => {
                const archived = conversation.archived;
                const responding = activity.responding.has(conversation.id);
                return (
                  <li
                    key={conversation.id}
                    data-conversation-id={conversation.id}
                    className={[
                      "conversation-row",
                      conversation.id === agents.conversationId ? "active" : "",
                      menuFor === conversation.id ? "menu-open" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <button
                      type="button"
                      className="conversation-name"
                      onClick={() => {
                        agents.selectConversation(conversation.id);
                        onClose();
                      }}
                    >
                      {responding ? (
                        <span
                          className="activity-dot"
                          role="img"
                          aria-label="Responding"
                          title="Responding…"
                        />
                      ) : null}
                      <span className="conversation-title">{conversation.summary}</span>
                      {archived ? <span className="tag muted">archived</span> : null}
                      <span className="conversation-date muted small">
                        {listDate(conversation.updatedAt)}
                      </span>
                    </button>

                    <button
                      type="button"
                      className="icon-button flat conversation-more"
                      aria-label={`More for ${conversation.summary}`}
                      aria-haspopup="menu"
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
                  </li>
                );
              }),
            ])}
            {groups.length === 0 ? (
              <li className="muted pad">
                {query.trim() ? "No conversation matches." : "No conversations"}
              </li>
            ) : null}
          </ul>

          <ToggleRow title="Show archived" checked={showArchived} onChange={setShowArchived} />
        </div>

        {agents.error ? <p className="warning small">{agents.error}</p> : null}
      </aside>
    </>
  );
}
