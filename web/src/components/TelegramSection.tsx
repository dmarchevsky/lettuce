import { useCallback, useEffect, useState } from "react";
import {
  approveTelegramPairing,
  describeExpiry,
  fetchTelegramStatus,
  ignoreTelegramPairing,
  removeTelegramRoute,
  saveTelegramAccount,
  senderLabel,
  type TelegramPending,
  type TelegramStatus,
} from "../lib/channels.ts";
import {
  type AgentSummary,
  type ConversationSummary,
  readAgents,
  readConversations,
} from "../state/use-agents.ts";
import type { SessionApi } from "../state/use-session.ts";
import { ToggleRow } from "./MenuRow.tsx";
import { toast } from "./Toast.tsx";

/**
 * Settings → Telegram: the bot, its pairings and its chat routes
 * (bff/src/channels/). Everything here writes the gateway's own state files —
 * `letta channels` on the host remains the fallback, never the front door.
 *
 * The two lists that bind chats to conversations pick from the live app-server
 * over the browser's own session; a pairing approved for an id that no longer
 * exists by the next message simply gets no answer, so the lists are fetched
 * fresh with the status rather than trusted from a cache.
 */

interface PairingPick {
  agentId: string;
  conversationId: string;
}

export function TelegramSection({ session }: { session: SessionApi }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [dmPolicy, setDmPolicy] = useState<"pairing" | "allowlist" | "open">("pairing");
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [conversations, setConversations] = useState<Record<string, ConversationSummary[]>>({});
  const [picks, setPicks] = useState<Record<string, PairingPick>>({});

  const load = useCallback(async () => {
    try {
      const next = await fetchTelegramStatus();
      setStatus(next);
      setDmPolicy(next.account?.dmPolicy ?? "pairing");
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (agents !== null) return;
    session
      .request("agent_list", { query: { limit: 100 } })
      .then((response) => setAgents(readAgents(response)))
      .catch(() => setAgents([]));
  }, [agents, session]);

  const loadConversations = useCallback(
    (agentId: string) => {
      if (conversations[agentId]) return;
      session
        .request("conversation_list", { query: { agent_id: agentId, limit: 100 } })
        .then((response) =>
          setConversations((current) => ({ ...current, [agentId]: readConversations(response) })),
        )
        .catch(() => setConversations((current) => ({ ...current, [agentId]: [] })));
    },
    [conversations, session],
  );

  // A bound chat reads as "Assistant · Daily log", not a conversation id — so
  // the agents the routes point at get their lists fetched for display too.
  useEffect(() => {
    for (const route of status?.routes ?? []) {
      if (route.agentId) loadConversations(route.agentId);
    }
  }, [status, loadConversations]);

  const act = async (action: () => Promise<unknown>, done: string | (() => string)) => {
    setBusy(true);
    try {
      await action();
      await load();
      toast(typeof done === "function" ? done() : done);
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "bad");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const account = status?.account ?? null;

  /** A route's conversation by name once its agent's list has arrived; the id until then. */
  const conversationLabel = (route: {
    agentId: string | null;
    conversationId: string | null;
  }): string => {
    const list = route.agentId ? conversations[route.agentId] : undefined;
    const found = list?.find((conversation) => conversation.id === route.conversationId);
    return found ? found.summary : (route.conversationId ?? "—");
  };

  const save = () => {
    const trimmed = token.trim();
    void act(
      async () => {
        await saveTelegramAccount({
          ...(trimmed ? { token: trimmed } : {}),
          dmPolicy,
        });
        setToken("");
      },
      account
        ? "Saved — the gateway reloads with it in a few seconds."
        : // The token is regex-checked, never asked Telegram: a wrong one saves
          // and simply leaves the bot silent. Say who can actually tell.
          "Saved — now message the bot. If it stays silent, the token is wrong; the gateway’s log says so.",
    );
  };

  const chooseAgent = (code: string, agentId: string) => {
    loadConversations(agentId);
    setPicks((current) => ({
      ...current,
      [code]: {
        agentId,
        conversationId: current[code]?.agentId === agentId ? current[code].conversationId : "",
      },
    }));
  };

  const chooseConversation = (code: string, agentId: string, conversationId: string) =>
    setPicks((current) => ({ ...current, [code]: { agentId, conversationId } }));

  const approve = (pending: TelegramPending) => {
    const pick = picks[pending.code];
    if (!pick?.conversationId) return;
    let notified = false;
    void act(
      async () => {
        notified = (await approveTelegramPairing(pending.code, pick.agentId, pick.conversationId))
          .notified;
        setPicks(({ [pending.code]: _dropped, ...rest }) => rest);
      },
      // The bot speaks for itself when the notice went out; when it could
      // not, say what the user must do instead of pretending.
      () =>
        notified
          ? `Paired — ${senderLabel(pending)} was told in their chat.`
          : `Paired — ${senderLabel(pending)} can message now (the notice did not reach them).`,
    );
  };

  if (!status) {
    return (
      <>
        {message ? (
          <p className="small bad pad" role="alert">
            <span>{message}</span>
          </p>
        ) : (
          <p className="muted pad">Loading…</p>
        )}
        <div className="pad-x">
          <button type="button" className="button ghost" onClick={() => void load()}>
            Reload
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="muted small pad">
        Lets a Telegram chat drive a conversation: messages arrive as turns for the bound agent, and
        the agent can reply with its <code>MessageChannel</code> tool — cron digests and
        notifications included.{" "}
        {account?.displayName
          ? `One bot, ${account.displayName}.`
          : "The gateway container exists because this deployment enabled the telegram profile; nothing is configured yet."}
      </p>

      {account ? (
        <div className="pad-x">
          <ToggleRow
            title="Telegram channel"
            description="Off stops the bot within ~10 seconds; chats stay paired."
            checked={account.enabled}
            disabled={busy}
            onChange={(next) =>
              void act(
                () => saveTelegramAccount({ enabled: next }),
                next
                  ? "On — the gateway reloads with the bot."
                  : "Off — the bot stops; pairings survive.",
              )
            }
          />
        </div>
      ) : null}

      {account ? (
        <p className="small pad">
          Running with bot token <span className="mono">••••{account.tokenTail ?? "?"}</span> —
          saved to the gateway&apos;s state, where agents on this server can read it. Changes apply
          when the gateway reloads; this page cannot see the gateway itself.
        </p>
      ) : null}

      <p className="section-note">{account ? "Bot settings" : "Connect a bot"}</p>
      <div className="pad-x">
        <label className="field">
          {account ? "Replace bot token" : "Bot token"}
          <input
            type="password"
            value={token}
            placeholder="123456:ABC-…"
            autoComplete="off"
            onChange={(event) => setToken(event.target.value)}
          />
          {!account ? (
            <span className="muted small">
              From @BotFather. Saved to the gateway&apos;s state; the UI never shows it back.
            </span>
          ) : null}
        </label>
        <label className="field">
          Who may start a chat
          <select
            value={dmPolicy}
            onChange={(event) =>
              setDmPolicy(event.target.value as "pairing" | "allowlist" | "open")
            }
          >
            <option value="pairing">Pairing — new chats get a code you approve here</option>
            <option value="allowlist">Allowlist — only the users you list</option>
            <option value="open">Open — anyone who finds the bot talks to the agent</option>
          </select>
        </label>
        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={busy || (!account && !token.trim())}
            onClick={() => void save()}
          >
            {account ? "Save" : "Save & connect"}
          </button>
        </div>
      </div>

      {!account ? (
        <p className="small pad">
          Message the bot once after saving and the pairing appears below with its code — no
          container steps: the runtime installs itself when the gateway starts.
        </p>
      ) : null}

      {status.pending.length > 0 ? (
        <>
          <p className="section-note">Pending pairings</p>
          <div className="pad-x">
            {status.pending.map((pending) => {
              const pick = picks[pending.code];
              const known = pick ? (conversations[pick.agentId] ?? null) : null;
              const expiry = describeExpiry(pending.expiresAt);
              return (
                <div key={pending.code}>
                  <p className="small">
                    {senderLabel(pending)} — code <span className="mono">{pending.code}</span>
                    {expiry ? `, ${expiry}` : ""} · chat{" "}
                    <span className="mono">{pending.chatId}</span>
                  </p>
                  <label className="field">
                    Bind to agent
                    <select
                      value={pick?.agentId ?? ""}
                      disabled={busy}
                      onChange={(event) => chooseAgent(pending.code, event.target.value)}
                    >
                      <option value="" disabled>
                        {agents === null
                          ? "Loading agents…"
                          : agents.length === 0
                            ? "No agents"
                            : "Choose an agent"}
                      </option>
                      {agents?.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Conversation
                    <select
                      value={pick?.conversationId ?? ""}
                      disabled={busy || !pick?.agentId}
                      onChange={(event) =>
                        pick && chooseConversation(pending.code, pick.agentId, event.target.value)
                      }
                    >
                      <option value="" disabled>
                        {pick && known === null
                          ? "Loading…"
                          : known && known.length === 0
                            ? "No conversations"
                            : "Choose a conversation"}
                      </option>
                      {known?.map((conversation) => (
                        <option key={conversation.id} value={conversation.id}>
                          {conversation.summary}
                          {conversation.archived ? " (archived)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="button-row">
                    <button
                      type="button"
                      className="button"
                      disabled={busy || !pick?.conversationId}
                      onClick={() => approve(pending)}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="button ghost"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => ignoreTelegramPairing(pending.code),
                          "Ignored — the code will not pair.",
                        )
                      }
                    >
                      Ignore
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {status.routes.length > 0 ? (
        <>
          <p className="section-note">Chats</p>
          <div className="pad-x">
            <ul className="menu-list">
              {status.routes.map((route) => (
                <li key={`${route.chatId}`}>
                  <div className="menu-row">
                    <span className="menu-row-text">
                      <span className="menu-row-title">
                        Chat <span className="mono">{route.chatId}</span>
                        {!route.enabled ? " (disabled)" : ""}
                      </span>
                      <span className="menu-row-desc">
                        {agentName(agents, route.agentId)} · {conversationLabel(route)}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="button ghost compact"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => removeTelegramRoute(route.chatId),
                          "Unbound — messages from that chat stop reaching the agent.",
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </>
  );
}

function agentName(agents: AgentSummary[] | null, agentId: string | null): string {
  if (!agentId) return "no agent";
  return agents?.find((agent) => agent.id === agentId)?.name ?? agentId;
}
