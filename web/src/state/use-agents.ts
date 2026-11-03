import {
  DEFAULT_CREATE_AGENT_PERSONALITIES,
  PERSONALITY_OPTIONS,
} from "@letta-ai/letta-code/agent-presets";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAgentFlags,
  orderByPins,
  saveAgentAvatar,
  saveArchivedAgent,
  savePinnedAgent,
} from "../lib/agent-flags.ts";
import type { AvatarPref } from "../lib/agent-tint.ts";
import { errorMessage, friendlyServerError } from "../lib/errors.ts";
import { markFreshConversation } from "../lib/fresh-conversations.ts";
import { upstreamReturned } from "../lib/link-status.ts";
import { readDeepLinkSelection, writeSelection } from "../lib/selection.ts";
import { conversationTitle } from "../lib/title.ts";
import { readAgentModelHandle } from "./use-models.ts";
import type { SessionApi } from "./use-session.ts";

export interface AgentSummary {
  id: string;
  name: string;
}

/**
 * The personalities `create_agent` accepts, straight from letta-code's
 * browser-safe `agent-presets` entry, so the dialog can never drift from what
 * the backend actually seeds.
 */
export const AGENT_PRESETS = DEFAULT_CREATE_AGENT_PERSONALITIES;
export type AgentPreset = (typeof AGENT_PRESETS)[number];

const presetDescriptions = new Map<string, string>(
  PERSONALITY_OPTIONS.map((option) => [option.id, option.description]),
);

/**
 * The preset's own description, shown under the picker in the New agent
 * dialog. Same string the created agent gets as its description. Empty if the
 * pinned letta-code version doesn't know the preset.
 */
export function agentPresetDescription(preset: AgentPreset): string {
  return presetDescriptions.get(preset) ?? "";
}

export interface AgentDetail {
  id: string;
  name: string;
  system: string;
  modelHandle: string | null;
}

export interface AgentDraft {
  name: string;
  system: string;
  modelHandle: string | null;
}

export interface ConversationSummary {
  id: string;
  summary: string;
  archived: boolean;
  updatedAt?: string;
  /**
   * Whether the conversation has a real name. `summary` carries an "Untitled"
   * placeholder when the server returned null, so without this a genuinely
   * untitled conversation is indistinguishable from one named "Untitled" —
   * and auto-titling could overwrite a name the user chose.
   */
  titled: boolean;
}

function readAgents(response: unknown): AgentSummary[] {
  const agents = (response as { agents?: unknown })?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const agent = raw as { id?: unknown; name?: unknown };
    if (typeof agent.id !== "string") return [];
    return [{ id: agent.id, name: typeof agent.name === "string" ? agent.name : agent.id }];
  });
}

export function readConversations(response: unknown): ConversationSummary[] {
  const conversations = (response as { conversations?: unknown })?.conversations;
  if (!Array.isArray(conversations)) return [];
  return conversations.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const conversation = raw as {
      id?: unknown;
      summary?: unknown;
      archived?: unknown;
      updated_at?: unknown;
    };
    if (typeof conversation.id !== "string") return [];
    const titled =
      typeof conversation.summary === "string" && conversation.summary.trim().length > 0;
    return [
      {
        id: conversation.id,
        summary: titled ? (conversation.summary as string) : "Untitled",
        titled,
        archived: conversation.archived === true,
        ...(typeof conversation.updated_at === "string"
          ? { updatedAt: conversation.updated_at }
          : {}),
      },
    ];
  });
}

/**
 * The app-server answers a rejected command with `success: false` rather than
 * closing the request, so a failure is only visible if we look for it.
 */
function assertOk(response: unknown, fallback: string): void {
  const result = response as { success?: unknown; error?: unknown } | null;
  if (result?.success === false) {
    throw new Error(typeof result.error === "string" ? result.error : fallback);
  }
}

function readAgentDetail(id: string, raw: unknown): AgentDetail {
  const agent = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id: typeof agent.id === "string" ? agent.id : id,
    name: typeof agent.name === "string" ? agent.name : id,
    system: typeof agent.system === "string" ? agent.system : "",
    modelHandle: readAgentModelHandle(agent),
  };
}

export interface AgentsApi {
  agents: AgentSummary[];
  conversations: ConversationSummary[];
  agentId: string | null;
  conversationId: string | null;
  loading: boolean;
  error: string | null;
  selectAgent: (agentId: string) => void;
  selectConversation: (conversationId: string) => void;
  refreshAgents: () => Promise<void>;
  refreshConversations: (agentId: string) => Promise<void>;
  retrieveAgent: (agentId: string) => Promise<AgentDetail>;
  createAgent: (preset: AgentPreset, draft: AgentDraft) => Promise<void>;
  updateAgent: (agentId: string, draft: AgentDraft) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  /** Agent ids pinned to the top of every agent list; `agents` is already in that order. */
  pinned: ReadonlySet<string>;
  setPinned: (agentId: string, pinned: boolean) => Promise<void>;
  /**
   * Agent ids hidden from the agent lists until asked for. Only the lists
   * change: an archived agent's crons, memory and conversations carry on.
   */
  archivedAgents: ReadonlySet<string>;
  setAgentArchived: (agentId: string, archived: boolean) => Promise<void>;
  /** Per-agent avatar choices, present only for agents that chose something. */
  avatars: Readonly<Record<string, AvatarPref>>;
  /** Writes one agent's choice; an empty pref resets it to the derived default. */
  setAvatar: (
    agentId: string,
    pref: { tint?: string | null; glyph?: string | null },
  ) => Promise<void>;
  createConversation: () => Promise<void>;
  renameConversation: (conversationId: string, summary: string) => Promise<void>;
  /** Name an untitled conversation after the first thing the user said. */
  autoTitleConversation: (conversationId: string, firstMessage: string) => void;
  setArchived: (conversationId: string, archived: boolean) => Promise<void>;
}

export function useAgents(session: SessionApi): AgentsApi {
  const { request, ready } = session;
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  // Seeded from the last visit, so a reload comes back where you were rather
  // than on whichever agent `agent_list` happens to return first — or, if a
  // push notification's `?agent=&conversation=` deep link is present, from
  // that instead (see `readDeepLinkSelection`). Read once, on mount: a stale
  // id here is harmless, because both refreshers below check their selection
  // against the list they just fetched.
  const [restored] = useState(readDeepLinkSelection);
  const [agentId, setAgentId] = useState<string | null>(restored.agentId);
  const [conversationId, setConversationId] = useState<string | null>(restored.conversationId);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAgents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await request("agent_list", { query: { limit: 100 } });
      const list = readAgents(response);
      setAgents(list);
      // A restored id is only good if the agent still exists — it may have been
      // deleted since, or from another browser. Falling back to the first is
      // what the selection did before it was remembered at all.
      setAgentId((current) => {
        if (current && list.some((agent) => agent.id === current)) return current;
        return list[0]?.id ?? null;
      });
    } catch (cause) {
      setError(friendlyServerError(errorMessage(cause)));
    } finally {
      setLoading(false);
    }
  }, [request]);

  const refreshConversations = useCallback(
    async (targetAgentId: string) => {
      setLoading(true);
      setError(null);
      try {
        const response = await request("conversation_list", {
          query: { agent_id: targetAgentId, limit: 100 },
        });
        const list = readConversations(response);
        setConversations(list);
        setConversationId((current) => {
          if (current && list.some((c) => c.id === current)) return current;
          const active = list.find((c) => !c.archived);
          return active?.id ?? list[0]?.id ?? null;
        });
      } catch (cause) {
        setError(friendlyServerError(errorMessage(cause)));
      } finally {
        setLoading(false);
      }
    },
    [request],
  );

  useEffect(() => {
    if (ready) void refreshAgents();
  }, [ready, refreshAgents]);

  // Pins, the archive and the avatar choices are the BFF's (HTTP), not the
  // app-server's: only the lists depend on them, so a failed load lists every
  // agent, unpinned, with its default face.
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [archivedIds, setArchivedIds] = useState<string[]>([]);
  const [avatarPrefs, setAvatarPrefs] = useState<Record<string, AvatarPref>>({});
  const loadFlags = useCallback(async () => {
    const flags = await fetchAgentFlags().catch(() => ({
      pinned: [],
      archived: [],
      avatars: {},
    }));
    setPinnedIds(flags.pinned);
    setArchivedIds(flags.archived);
    setAvatarPrefs(flags.avatars ?? {});
  }, []);
  useEffect(() => {
    if (ready) void loadFlags();
  }, [ready, loadFlags]);

  const setPinned = useCallback(
    async (target: string, pinned: boolean) => {
      // Optimistic, so the row moves on tap; the server's answer is the truth.
      setPinnedIds((current) => {
        const without = current.filter((id) => id !== target);
        return pinned ? [...without, target] : without;
      });
      try {
        setPinnedIds(await savePinnedAgent(target, pinned));
      } catch (cause) {
        setError(errorMessage(cause));
        await loadFlags();
      }
    },
    [loadFlags],
  );

  const orderedAgents = useMemo(() => orderByPins(agents, pinnedIds), [agents, pinnedIds]);
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const archivedSet = useMemo(() => new Set(archivedIds), [archivedIds]);

  const setAvatar = useCallback(
    async (target: string, pref: { tint?: string | null; glyph?: string | null }) => {
      // The server answers with the whole map, so every list showing this agent
      // — rail, switcher, sidebar, header — settles on the same face at once.
      try {
        setAvatarPrefs(await saveAgentAvatar(target, pref));
      } catch (cause) {
        setError(errorMessage(cause));
        await loadFlags();
      }
    },
    [loadFlags],
  );

  const setAgentArchived = useCallback(
    async (target: string, archived: boolean) => {
      setArchivedIds((current) => {
        const without = current.filter((id) => id !== target);
        return archived ? [...without, target] : without;
      });
      if (archived) setPinnedIds((current) => current.filter((id) => id !== target));
      // Archiving the agent on screen moves to the first one still listed,
      // rather than leaving the UI on an agent the lists no longer show.
      if (archived && agentId === target) {
        const next = orderedAgents.find(
          (agent) => agent.id !== target && !archivedIds.includes(agent.id),
        );
        if (next) {
          setAgentId(next.id);
          setConversationId(null);
          setConversations([]);
        }
      }
      try {
        const flags = await saveArchivedAgent(target, archived);
        setPinnedIds(flags.pinned);
        setArchivedIds(flags.archived);
      } catch (cause) {
        setError(errorMessage(cause));
        await loadFlags();
      }
    },
    [agentId, archivedIds, loadFlags, orderedAgents],
  );

  useEffect(() => {
    if (ready && agentId) void refreshConversations(agentId);
  }, [ready, agentId, refreshConversations]);

  // A returning app-server must be as loud a signal as a browser reconnect.
  // While it was gone every list fetch failed with "App-server is not
  // connected", and the only retry was `ready` toggling — which never happens
  // when the BFF socket stays up through an outage, so the error row sat there
  // until a manual reload. The rising edge of the BFF's own upstream state
  // refetches both lists; success clears the error string by itself.
  //
  // `ready` gates it: at boot the hello upstream flip arrives before the link
  // is live, and the two `ready` effects above already own that first fetch.
  const upstreamRef = useRef(session.upstream);
  useEffect(() => {
    const previous = upstreamRef.current;
    upstreamRef.current = session.upstream;
    if (!upstreamReturned(previous, session.upstream) || !ready) return;
    void refreshAgents();
    if (agentId) void refreshConversations(agentId);
  }, [ready, session.upstream, agentId, refreshAgents, refreshConversations]);

  // Remember the pair for the next visit. Writing the transient states too —
  // `selectAgent` blanks the conversation until its list arrives — is fine: the
  // very next resolution overwrites it, and a half-written pair still restores
  // correctly because the agent is what the conversation is looked up under.
  useEffect(() => {
    writeSelection({ agentId, conversationId });
  }, [agentId, conversationId]);

  const selectAgent = useCallback((next: string) => {
    setAgentId(next);
    setConversationId(null);
    setConversations([]);
  }, []);

  const retrieveAgent = useCallback(
    async (target: string) => {
      const response = await request<{ agent?: unknown }>("agent_retrieve", {
        agent_id: target,
      });
      assertOk(response, "Failed to load agent");
      return readAgentDetail(target, response?.agent);
    },
    [request],
  );

  /**
   * Model changes go through `update_model` scoped to the sentinel conversation
   * `"default"`, which the app-server treats as "the agent itself" and answers
   * with `applied_to: "agent"`. That path preserves the context window and
   * infers `provider_type` for OpenAI-compatible proxies; writing
   * `agent_update {model}` directly would skip all of it.
   */
  const applyAgentModel = useCallback(
    async (target: string, modelHandle: string) => {
      const response = await request("update_model", {
        runtime: { agent_id: target, conversation_id: "default" },
        payload: { model_id: modelHandle, model_handle: modelHandle },
      });
      assertOk(response, "Failed to set the model");
    },
    [request],
  );

  const createAgent = useCallback(
    async (preset: AgentPreset, draft: AgentDraft) => {
      const response = await request<{ agent_id?: string; name?: string }>("create_agent", {
        personality: preset,
        ...(draft.modelHandle ? { model: draft.modelHandle } : {}),
      });
      assertOk(response, "Failed to create the agent");

      const created = response?.agent_id;
      if (typeof created !== "string") throw new Error("Agent was created without an id");

      // The preset names the agent; apply the user's own name and prompt after.
      const body: Record<string, unknown> = {};
      if (draft.name.trim() && draft.name.trim() !== response?.name) body.name = draft.name.trim();
      if (draft.system.trim()) body.system = draft.system;
      if (Object.keys(body).length > 0) {
        assertOk(
          await request("agent_update", { agent_id: created, body }),
          "Agent created, but its name could not be applied",
        );
      }

      // A new agent opens on a conversation, ready to type in. It has none
      // otherwise: its default conversation is never listed, so the UI used
      // to land on an empty list with the composer disabled until "New"
      // was pressed. A failure here still leaves the agent created.
      let firstConversation: string | null = null;
      try {
        const opened = await request<{ conversation?: { id?: string } }>("conversation_create", {
          body: { agent_id: created },
        });
        assertOk(opened, "Agent created, but its first conversation could not be");
        firstConversation =
          typeof opened?.conversation?.id === "string" ? opened.conversation.id : null;
        if (firstConversation) markFreshConversation(firstConversation);
      } catch (cause) {
        setError(errorMessage(cause));
      }

      await refreshAgents();
      setAgentId(created);
      setConversations([]);
      // `refreshConversations` (run when the agent changes) keeps this
      // selection, since the new conversation is in the list it fetches.
      setConversationId(firstConversation);
    },
    [request, refreshAgents],
  );

  const updateAgent = useCallback(
    async (target: string, draft: AgentDraft) => {
      const response = await request("agent_update", {
        agent_id: target,
        body: { name: draft.name.trim(), system: draft.system },
      });
      assertOk(response, "Failed to update the agent");
      if (draft.modelHandle) await applyAgentModel(target, draft.modelHandle);
      await refreshAgents();
    },
    [request, refreshAgents, applyAgentModel],
  );

  const deleteAgent = useCallback(
    async (target: string) => {
      const response = await request("agent_delete", { agent_id: target });
      assertOk(response, "Failed to delete the agent");

      // `refreshAgents` only fills an empty selection, so a deleted *current*
      // agent has to be cleared first or the UI keeps pointing at a dead id.
      setAgents((current) => {
        const remaining = current.filter((agent) => agent.id !== target);
        setAgentId((selected) => (selected === target ? (remaining[0]?.id ?? null) : selected));
        return remaining;
      });
      setConversationId(null);
      setConversations([]);
      await refreshAgents();
    },
    [request, refreshAgents],
  );

  const createConversation = useCallback(async () => {
    if (!agentId) return;
    const response = await request<{ conversation?: { id?: string } }>("conversation_create", {
      body: { agent_id: agentId },
    });
    const id = response?.conversation?.id;
    // Mark before the refresh: `refreshConversations` selects the newest
    // conversation itself, and that selection must already see this id as
    // the fresh one it is.
    if (typeof id === "string") markFreshConversation(id);
    await refreshConversations(agentId);
    if (typeof id === "string") setConversationId(id);
  }, [agentId, request, refreshConversations]);

  const renameConversation = useCallback(
    async (target: string, summary: string) => {
      await request("conversation_update", {
        conversation_id: target,
        body: { summary },
      });
      if (agentId) await refreshConversations(agentId);
    },
    [agentId, request, refreshConversations],
  );

  /**
   * The app-server never titles a conversation — there is no protocol command
   * for it, and the `autoConversationTitles` setting is only read by the TUI.
   * So the client does it, once, and only while the conversation is untitled:
   * a name the user chose must never be overwritten.
   */
  const autoTitleConversation = useCallback(
    (target: string, firstMessage: string) => {
      const conversation = conversations.find((c) => c.id === target);
      if (!conversation || conversation.titled) return;
      const title = conversationTitle(firstMessage);
      if (!title) return;
      // Deliberately not awaited: a failed rename must not hold up a message.
      void renameConversation(target, title).catch(() => undefined);
    },
    [conversations, renameConversation],
  );

  // `conversation_list` ignores an `archived` query filter, so the archived
  // set is filtered client-side; only the write side is native.
  const setArchived = useCallback(
    async (target: string, archived: boolean) => {
      await request("conversation_update", {
        conversation_id: target,
        body: { archived },
      });
      if (agentId) await refreshConversations(agentId);
    },
    [agentId, request, refreshConversations],
  );

  return {
    agents: orderedAgents,
    conversations,
    agentId,
    conversationId,
    loading,
    error,
    selectAgent,
    selectConversation: setConversationId,
    refreshAgents,
    refreshConversations,
    retrieveAgent,
    createAgent,
    updateAgent,
    deleteAgent,
    pinned: pinnedSet,
    setPinned,
    archivedAgents: archivedSet,
    setAgentArchived,
    avatars: avatarPrefs,
    setAvatar,
    createConversation,
    renameConversation,
    autoTitleConversation,
    setArchived,
  };
}
