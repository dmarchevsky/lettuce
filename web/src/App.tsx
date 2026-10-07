import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivitySheet } from "./components/ActivitySheet.tsx";
import { AgentEditor } from "./components/AgentEditor.tsx";
import { ApprovalSheet } from "./components/ApprovalSheet.tsx";
import { AuthPill } from "./components/AuthPill.tsx";
import { Composer } from "./components/Composer.tsx";
import { ContextGauge, ContextSheet } from "./components/ContextGauge.tsx";
import { FileViewer } from "./components/FileViewer.tsx";
import {
  type GlobalSection,
  GlobalSettings,
  isGlobalSection,
} from "./components/GlobalSettings.tsx";
import { Icon } from "./components/Icon.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { ModelPicker } from "./components/ModelPicker.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Switcher } from "./components/Switcher.tsx";
import type { PreparedImage } from "./lib/attachments.ts";
import { draftKey } from "./lib/draft.ts";
import { applyFavicon } from "./lib/favicon.ts";
import type { FeatureFlags } from "./lib/features.ts";
import { userHistory } from "./lib/input-history.ts";
import { type FilterGroup, filterEntries, toggleShown } from "./lib/messages.ts";
import { type RuntimeScope, scopeKey } from "./lib/protocol.ts";
import type { LinkState } from "./lib/session-client.ts";
import { readSettingsDeepLink } from "./lib/settings-link.ts";
import {
  readStructuredOutput,
  type StructuredOutputPreference,
  writeStructuredOutput,
} from "./lib/structured-output.ts";
import { readShowTimestamps, writeShowTimestamps } from "./lib/timestamps.ts";
import { useAgents } from "./state/use-agents.ts";
import { useContextLimit } from "./state/use-context-limit.ts";
import { useConversation } from "./state/use-conversation.ts";
import { useCurrentModel } from "./state/use-models.ts";
import { useSession } from "./state/use-session.ts";
import { AgentTab } from "./tabs/AgentTab.tsx";
import { FilesTab } from "./tabs/FilesTab.tsx";
import { MemoryTab } from "./tabs/MemoryTab.tsx";
import { TasksTab } from "./tabs/TasksTab.tsx";
import { ToolsTab } from "./tabs/ToolsTab.tsx";

interface Status {
  authenticated: boolean;
  auth_mode: "cf-access" | "dev-bypass" | "none";
  user: { email: string } | null;
  /** This build's release tag; present only when authenticated. */
  version?: string;
  /** Which integrations this deployment offers; absent (older BFF) = all on. */
  features?: FeatureFlags;
}

const TABS = ["Chat", "Files", "Tasks", "Memory", "Tools", "Agent"] as const;
type Tab = (typeof TABS)[number];

/**
 * How many times to retry a failed status fetch before giving up and asking.
 *
 * The common cause is transient — the BFF is restarting, the tunnel is
 * re-establishing, the laptop just woke — and a retry a second later succeeds.
 * But retrying forever against a genuinely broken server is a request loop, so
 * after this many attempts the user gets an explicit retry rather than silent
 * polling.
 */
const STATUS_MAX_AUTO_RETRIES = 3;
const STATUS_RETRY_DELAY_MS = 1500;

type StatusState =
  | { phase: "loading" }
  | { phase: "error"; reason: string }
  | { phase: "ready"; status: Status };

export function App() {
  const [state, setState] = useState<StatusState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setState({ phase: "loading" });

    fetch("/api/status")
      .then((response) => {
        if (!response.ok) throw new Error(`Status request failed (${response.status})`);
        return response.json() as Promise<Status>;
      })
      .then((status) => {
        if (!cancelled) setState({ phase: "ready", status });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          phase: "error",
          reason: cause instanceof Error ? cause.message : "Could not reach the server",
        });
        if (attempt < STATUS_MAX_AUTO_RETRIES) {
          retryTimer = setTimeout(() => setAttempt((n) => n + 1), STATUS_RETRY_DELAY_MS);
        }
      });

    return () => {
      cancelled = true;
      // The retry timer has to be cleared from the effect's own cleanup: a
      // `return` from inside a `.catch` callback goes nowhere, and the timer
      // would otherwise fire against an unmounted component.
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [attempt]);

  if (state.phase === "loading") {
    return (
      <main className="shell center">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (state.phase === "error") {
    // Previously a failed fetch set the status back to null, which rendered
    // "Loading…" forever: the app looked stuck on a spinner with no way out and
    // no indication that the server was unreachable rather than still working.
    return (
      <main className="shell center">
        <h1>Lettuce</h1>
        <p className="warning">Could not reach the server: {state.reason}</p>
        <p className="muted small">
          {attempt < STATUS_MAX_AUTO_RETRIES
            ? `Retrying in ${STATUS_RETRY_DELAY_MS / 1000}s…`
            : "Automatic retries are exhausted."}
        </p>
        <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
          Retry now
        </button>
      </main>
    );
  }

  const { status } = state;
  if (!status.authenticated) return <SignIn status={status} />;
  return <Workspace status={status} />;
}

function SignIn({ status }: { status: Status }) {
  return (
    <main className="shell center">
      <h1>Lettuce</h1>
      {status.auth_mode === "dev-bypass" ? (
        <>
          <p className="warning">
            Developer sign-in is enabled. This does <strong>not</strong> authenticate anyone — any
            visitor becomes the configured user. Unset <code>DEV_BYPASS_EMAIL</code> in
            <code>docker/.env</code> once real sign-in is configured.
          </p>
          <a className="button" href="/auth/login">
            Continue without signing in
          </a>
        </>
      ) : status.auth_mode === "cf-access" ? (
        <p className="muted">
          Not signed in. This instance is reached through Cloudflare Access — if you're seeing this
          on the tunnel, try reloading; direct access without Access is not supported.
        </p>
      ) : (
        <p className="warning">
          Nothing is configured to sign anyone in. This instance is running in local mode with no{" "}
          <code>DEV_BYPASS_EMAIL</code> set — add one to <code>docker/.env</code> and restart, or
          switch to cloudflared mode for real sign-in. See <code>docker/README.md</code>.
        </p>
      )}
    </main>
  );
}

function Workspace({ status }: { status: Status }) {
  const session = useSession(true);
  const agents = useAgents(session);
  // /clear creates a new conversation server-side instead of clearing this one,
  // so the UI has to follow it there or it sits on a conversation the runtime
  // has already moved off.
  const conversation = useConversation(session, agents.agentId, agents.conversationId, () => {
    void agents.adoptNewConversation();
  });

  const contextLimit = useContextLimit(
    session.request,
    agents.agentId,
    agents.conversationId,
    session.ready,
  );
  /** The context gauge's details: usage, and the limit to change. */
  const [contextOpen, setContextOpen] = useState(false);

  const [tab, setTab] = useState<Tab>("Chat");
  /** The responding-conversations list behind the pulsing status dot. */
  const [activityOpen, setActivityOpen] = useState(false);
  /** The agents-and-conversations menu (phone); see `Switcher`. */
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const openSwitcher = useCallback(() => setSwitcherOpen(true), []);
  const closeGlobalSettings = useCallback(() => setGlobalSettings(null), []);
  const [showModels, setShowModels] = useState(false);
  /** The New agent sheet. Editing an agent is the Agent tab's General section. */
  const [creatingAgent, setCreatingAgent] = useState(false);
  /** Settings shared by every agent: `null` = closed, else the section to open on. */
  const [globalSettings, setGlobalSettings] = useState<{ section?: GlobalSection } | null>(() => {
    // `?settings=google` — the link an agent gives when Google access is lost.
    const section = readSettingsDeepLink(isGlobalSection);
    return section ? { section } : null;
  });
  const [filters, setFilters] = useState<Set<FilterGroup>>(new Set());
  const [showTimestamps, setShowTimestamps] = useState(() => readShowTimestamps());
  /** Text an "Edit" put on its way to the composer; cleared once it lands. */
  const [prefill, setPrefill] = useState<string | null>(null);
  const clearPrefill = useCallback(() => setPrefill(null), []);
  const onShowTimestamps = useCallback((show: boolean) => {
    writeShowTimestamps(show);
    setShowTimestamps(show);
  }, []);
  /** A workspace file the agent linked in chat, open in the file viewer. */
  const [openFile, setOpenFile] = useState<string | null>(null);

  const scope: RuntimeScope | null =
    agents.agentId && agents.conversationId
      ? { agent_id: agents.agentId, conversation_id: agents.conversationId }
      : null;

  const inputHistory = useMemo(() => userHistory(conversation.entries), [conversation.entries]);

  /**
   * Structured-output state lives here, not in the Composer: the composer
   * unmounts on every tab switch, and a half-written schema would be lost with
   * it. Keyed per conversation exactly like the draft, and remembered so a
   * reload brings the same schema back.
   */
  const structuredKey = draftKey(agents.agentId, agents.conversationId);
  const [structured, setStructured] = useState<StructuredOutputPreference>(() =>
    readStructuredOutput(structuredKey),
  );

  // Switching conversation without leaving the Chat tab keeps this mounted, so
  // the lazy initialiser never re-runs — reload for the new conversation here.
  useEffect(() => {
    setStructured(readStructuredOutput(structuredKey));
  }, [structuredKey]);

  const onStructuredChange = useCallback(
    (text: string, enabled: boolean) => {
      const next: StructuredOutputPreference = { text, enabled };
      writeStructuredOutput(structuredKey, next);
      setStructured(next);
    },
    [structuredKey],
  );

  /**
   * Images staged for the next message, owned here for the same reason as the
   * structured-output schema: the composer unmounts on every tab switch and
   * a tray of picked photos must survive that. Not persisted — a reload
   * carrying half-chosen images back would be worse than losing them. Cleared
   * with the conversation switch, like the schema is re-read.
   */
  const [attachments, setAttachments] = useState<PreparedImage[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: structuredKey is the conversation's key; this fires per switch, not per render.
  useEffect(() => {
    setAttachments([]);
  }, [structuredKey]);

  // The open conversation already shows its own state in the composer; the
  // menu badge is for turns running somewhere you are not looking.
  const respondingElsewhere =
    session.activeScopes.size - (scope && session.activeScopes.has(scopeKey(scope)) ? 1 : 0);
  // Any active scope at all makes the status dot a way into the list.
  const respondingCount = session.activeScopes.size;

  // Lifted so the composer button and the picker share one source of truth —
  // switching model in the picker updates the button without a reload.
  const currentModel = useCurrentModel(session, agents.agentId, agents.conversationId);
  const modelLabel = currentModel.handle
    ? (currentModel.handle.split("/").pop() ?? currentModel.handle)
    : null;

  const visibleEntries = useMemo(
    () => filterEntries(conversation.entries, filters),
    [conversation.entries, filters],
  );

  const title =
    agents.conversations.find((c) => c.id === agents.conversationId)?.summary ?? "Lettuce";
  const agentName = agents.agents.find((a) => a.id === agents.agentId)?.name ?? null;

  const editAgent = (id: string) => {
    if (id !== agents.agentId) agents.selectAgent(id);
    setTab("Agent");
  };

  const toggleFilter = (group: FilterGroup) => {
    setFilters((current) => toggleShown(current, group));
  };

  const bypass = status.auth_mode === "dev-bypass";

  // The tab icon reports the link state, which matters most when this tab is
  // backgrounded on a phone — precisely when the socket tends to drop.
  useEffect(() => {
    applyFavicon(session.link);
  }, [session.link]);

  return (
    <div className="app">
      <Sidebar
        agents={agents}
        open={false}
        onClose={() => {}}
        onNewAgent={() => setCreatingAgent(true)}
        onEditAgent={editAgent}
        activeScopes={session.activeScopes}
        activeAgentIds={session.activeAgentIds}
        request={session.request}
      />

      <div className="main">
        <header className="topbar">
          {/* Where you are: the agent over the conversation. On a phone it is
              also a way into the switcher from every tab, not just Chat. */}
          <button
            type="button"
            className="where"
            onClick={openSwitcher}
            aria-label={
              respondingElsewhere > 0
                ? `${agentName ?? "Agent"}: ${title}. Switch — ${respondingElsewhere} responding elsewhere`
                : `${agentName ?? "Agent"}: ${title}. Switch agent or conversation`
            }
          >
            <span className="where-agent">
              {agentName ?? "No agent"}
              {respondingElsewhere > 0 ? <span className="activity-dot badge-dot" /> : null}
            </span>
            <h1 className="title">{title}</h1>
          </button>
          <ContextGauge
            usage={conversation.turnUsage}
            limit={contextLimit.limit}
            onOpen={() => {
              setContextOpen(true);
              void contextLimit.refresh();
            }}
          />
          {bypass ? <AuthPill email={status.user?.email} /> : null}
          <LinkPill
            link={session.link}
            busy={respondingCount > 0}
            count={respondingCount}
            onOpen={() => setActivityOpen(true)}
          />
          {/* Settings shared by every agent. The selected agent's own are its
              Agent tab; this is the one way into the rest, at every width. */}
          <button
            type="button"
            className="icon-button flat topbar-settings"
            onClick={() => setGlobalSettings({})}
            aria-label="Settings"
            title="Settings"
          >
            <Icon name="settings" />
          </button>
        </header>

        <nav className="tabs">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              className={name === tab ? "active" : ""}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </nav>

        {session.lastError ? (
          <p className="warning small dismissible" role="alert">
            <span>{session.lastError}</span>
            <button
              type="button"
              className="icon-button flat"
              onClick={session.clearError}
              aria-label="Dismiss error"
              title="Dismiss"
            >
              <Icon name="close" />
            </button>
          </p>
        ) : null}

        {tab === "Chat" ? (
          <>
            {conversation.error ? <p className="warning small">{conversation.error}</p> : null}

            <MessageList
              entries={visibleEntries}
              processing={conversation.processing}
              session={session}
              cwd={conversation.cwd}
              onOpenFile={setOpenFile}
              showTimestamps={showTimestamps}
              onEditMessage={setPrefill}
              onAnswerQuestion={conversation.answerQuestions}
            />

            {conversation.queue.length > 0 ? (
              <div className="queue">
                <span className="tag">
                  {conversation.queue.some((item) => item.paused) ? "Paused" : "Queued"}
                </span>
                {conversation.queue.some((item) => item.paused) ? (
                  <button
                    type="button"
                    className="queued resume-queue"
                    title="Resume queued messages"
                    onClick={() => conversation.resumeQueue()}
                  >
                    Resume
                    <Icon name="refresh" />
                  </button>
                ) : null}
                {conversation.queue.map((item) => (
                  <span key={item.id} className={`queued${item.paused ? " paused" : ""}`}>
                    <span className="queued-dot" aria-hidden="true" />
                    <button
                      type="button"
                      className="queued-remove"
                      title="Remove from queue"
                      onClick={() => conversation.removeQueued(item.id)}
                      aria-label={`Remove queued message: ${item.content.slice(0, 40)}`}
                    >
                      {item.content.slice(0, 40)}
                      <Icon name="close" />
                    </button>
                    {item.source === "user" ? (
                      // Upstream has no promote command; this stops the turn
                      // and resends the queue with this message at the head.
                      <button
                        type="button"
                        className="queued-force"
                        title="Stop and send this now"
                        onClick={() => void conversation.forceSend(item.id)}
                        aria-label={`Force send queued message: ${item.content.slice(0, 40)}`}
                      >
                        <Icon name="send" />
                      </button>
                    ) : null}
                  </span>
                ))}
              </div>
            ) : null}

            <Composer
              disabled={!scope || !session.ready}
              processing={conversation.processing}
              draftKey={draftKey(agents.agentId, agents.conversationId)}
              structuredText={structured.text}
              structuredEnabled={structured.enabled}
              structuredSupported={session.appServerInfo?.capabilities.structured_outputs ?? false}
              onStructuredChange={onStructuredChange}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              onSend={(text, responseFormat, images) => {
                void conversation.sendMessage(text, responseFormat, images);
                // Name the conversation after the first thing said in it. No-op
                // once it has a title, so a manual rename always wins.
                if (agents.conversationId && text) {
                  agents.autoTitleConversation(agents.conversationId, text);
                }
              }}
              onAbort={() => void conversation.abort()}
              stopping={conversation.stopping}
              turn={{
                entries: conversation.entries,
                queue: conversation.queue,
                cwd: conversation.cwd,
                turnStartedAt: conversation.turnStartedAt,
                lastActivityAt: conversation.lastActivityAt,
                usage: conversation.turnUsage,
              }}
              filters={filters}
              onToggleFilter={toggleFilter}
              onClearFilters={() => setFilters(new Set())}
              showTimestamps={showTimestamps}
              onShowTimestamps={onShowTimestamps}
              permissionMode={conversation.permissionMode}
              onPermissionMode={conversation.setPermissionMode}
              commands={conversation.commands}
              onRunCommand={(id, args) => conversation.runCommand(id, args)}
              onOpenModels={() => setShowModels(true)}
              modelsDisabled={!scope}
              modelLabel={modelLabel}
              history={inputHistory}
              prefill={prefill}
              onOpenSwitcher={openSwitcher}
              onPrefillApplied={clearPrefill}
            />
          </>
        ) : tab === "Files" ? (
          <FilesTab session={session} cwd={conversation.cwd} agentId={agents.agentId} />
        ) : tab === "Tasks" ? (
          <TasksTab
            session={session}
            agentId={agents.agentId}
            conversationId={agents.conversationId}
            backgroundProcesses={conversation.backgroundProcesses}
            onStopMonitor={conversation.stopMonitor}
            conversations={agents.conversations}
            features={status.features}
          />
        ) : tab === "Memory" ? (
          <MemoryTab session={session} agentId={agents.agentId} />
        ) : tab === "Tools" ? (
          <ToolsTab
            agents={agents}
            features={status.features}
            onOpenGlobalSettings={(section) =>
              setGlobalSettings({ section: section as GlobalSection })
            }
          />
        ) : (
          <AgentTab
            session={session}
            agents={agents}
            conversationId={agents.conversationId}
            cwd={conversation.cwd}
            skillsVersion={conversation.skillsVersion}
            onOpenGlobalSettings={(section) => setGlobalSettings({ section })}
          />
        )}
      </div>

      {/* Before the approval sheet: an approval that arrives while Settings is
          open has to land on top of it, not hide underneath. */}
      {globalSettings ? (
        <GlobalSettings
          session={session}
          agentId={agents.agentId}
          cwd={conversation.cwd}
          skillsVersion={conversation.skillsVersion}
          user={status.user}
          authMode={status.auth_mode}
          version={status.version}
          features={status.features}
          initialSection={globalSettings.section}
          onClose={closeGlobalSettings}
        />
      ) : null}

      {activityOpen ? (
        <ActivitySheet session={session} agents={agents} onClose={() => setActivityOpen(false)} />
      ) : null}

      {conversation.approvals.length > 0 ? (
        <ApprovalSheet
          // Keyed by request id so a fresh approval always mounts fresh —
          // without this, an approval answered mid-deny moved straight to the
          // next queued approval on the same component instance, carrying
          // over its denying/reason state.
          key={conversation.approvals[0]!.requestId}
          approval={conversation.approvals[0]!}
          onRespond={conversation.respondToApproval}
        />
      ) : null}

      {openFile ? (
        <FileViewer
          session={session}
          path={openFile}
          onClose={() => setOpenFile(null)}
          key={openFile}
        />
      ) : null}

      {showModels ? (
        <ModelPicker
          session={session}
          scope={scope}
          currentModel={currentModel}
          toolsetPreference={conversation.toolsetPreference}
          availableToolsets={conversation.availableToolsets}
          onClose={() => setShowModels(false)}
        />
      ) : null}

      {contextOpen ? (
        <ContextSheet
          usage={conversation.turnUsage}
          limit={contextLimit.limit}
          agentName={agentName}
          processing={conversation.processing}
          onApply={contextLimit.apply}
          onClose={() => setContextOpen(false)}
        />
      ) : null}

      {switcherOpen ? (
        <Switcher
          agents={agents}
          session={session}
          onClose={() => setSwitcherOpen(false)}
          onNewAgent={() => {
            setSwitcherOpen(false);
            setCreatingAgent(true);
          }}
          onEditAgent={(id) => {
            setSwitcherOpen(false);
            editAgent(id);
          }}
        />
      ) : null}

      {creatingAgent ? (
        <AgentEditor session={session} agents={agents} onClose={() => setCreatingAgent(false)} />
      ) : null}
    </div>
  );
}

/**
 * The link state as a dot: green live, amber spinner while connecting or
 * reconnecting, red offline — the label is the tooltip and the accessible
 * name. It used to be a text pill, which cost the top bar the room it now
 * uses to say which agent and conversation you are in. Signed out stays
 * words and a button: it is the one state that needs you to act. While any
 * conversation is responding it pulses and becomes a button into the list of
 * what is running; with nothing running it is the same passive dot as ever.
 */
function LinkPill({
  link,
  busy,
  count,
  onOpen,
}: {
  link: LinkState;
  busy: boolean;
  count: number;
  onOpen: () => void;
}) {
  const map: Record<LinkState, { label: string; tone: string }> = {
    live: { label: "Live", tone: "ok" },
    connecting: { label: "Connecting…", tone: "warn" },
    reconnecting: { label: "Reconnecting…", tone: "warn" },
    resyncing: { label: "Resyncing…", tone: "warn" },
    offline: { label: "Offline", tone: "bad" },
    "signed-out": { label: "Sign in again", tone: "bad" },
  };
  const { label, tone } = map[link];
  // Signed out is the one state a tap can fix: a reload goes through the
  // login. Reached when the automatic reload already ran recently, or the
  // page was hidden when the login expired. It outranks busy: a dead session
  // has nothing worth listing.
  if (link === "signed-out") {
    return (
      <button type="button" className={`pill as-button ${tone}`} onClick={() => location.reload()}>
        {label}
      </button>
    );
  }
  if (busy) {
    const busyLabel = `${count} conversation${count === 1 ? "" : "s"} responding — show`;
    return (
      <button
        type="button"
        className={`link-dot ${tone} busy`}
        onClick={onOpen}
        aria-label={busyLabel}
        title={busyLabel}
      />
    );
  }
  return (
    <span
      className={`link-dot ${tone}${tone === "warn" ? " spinning" : ""}`}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
