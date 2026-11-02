import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivitySheet } from "./components/ActivitySheet.tsx";
import { AgentAvatar } from "./components/AgentAvatar.tsx";
import { AgentEditor } from "./components/AgentEditor.tsx";
import { ApprovalSheet } from "./components/ApprovalSheet.tsx";
import { AuthPill } from "./components/AuthPill.tsx";
import { BottomBar } from "./components/BottomBar.tsx";
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
import { NavRail } from "./components/NavRail.tsx";
import { PiRunsChip, usePiActiveRuns } from "./components/PiRunsChip.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { SignInScreen } from "./components/SignInScreen.tsx";
import { Switcher } from "./components/Switcher.tsx";
import { ToastLayer, toast } from "./components/Toast.tsx";
import type { PreparedImage } from "./lib/attachments.ts";
import { applyDocumentTitle } from "./lib/document-title.ts";
import { appendToDraft, draftKey, readDraft } from "./lib/draft.ts";
import { applyFavicon } from "./lib/favicon.ts";
import { type FeatureFlags, featureEnabled } from "./lib/features.ts";
import { userHistory } from "./lib/input-history.ts";
import { type FilterGroup, filterEntries, toggleShown } from "./lib/messages.ts";
import { readRunsDeepLink } from "./lib/pi.ts";
import { type Component, type RuntimeScope, scopeKey } from "./lib/protocol.ts";
import type { LinkState } from "./lib/session-client.ts";
import { readSettingsDeepLink } from "./lib/settings-link.ts";
import type { Access, Signin } from "./lib/signin.ts";
import {
  readStructuredOutput,
  type StructuredOutputPreference,
  writeStructuredOutput,
} from "./lib/structured-output.ts";
import { readPanelPin, runsEnabled, type Tab, writePanelPin } from "./lib/tabs.ts";
import { readShowTimestamps, writeShowTimestamps } from "./lib/timestamps.ts";
import { useAgentConversations } from "./state/use-agent-conversations.ts";
import { useAgents } from "./state/use-agents.ts";
import { useContextLimit } from "./state/use-context-limit.ts";
import { useContextSize } from "./state/use-context-size.ts";
import { useConversation } from "./state/use-conversation.ts";
import { useCurrentModel } from "./state/use-models.ts";
import { useSession } from "./state/use-session.ts";
import { useWide } from "./state/use-wide.ts";
import { AgentTab } from "./tabs/AgentTab.tsx";
import { FilesTab } from "./tabs/FilesTab.tsx";
import { RunsTab } from "./tabs/RunsTab.tsx";
import { TasksTab } from "./tabs/TasksTab.tsx";
import { ToolsTab } from "./tabs/ToolsTab.tsx";

interface Status {
  authenticated: boolean;
  /** How this instance is reached — the network half of the old single `mode`. */
  access: Access;
  /** How the visitor proved who they are, or `none`. */
  signin: Signin;
  /** `password` with no credential set yet: the first visitor claims the box. */
  setup_required: boolean;
  user: { email: string } | null;
  /** Interface the BFF socket is bound to; present only when authenticated. */
  host_bind?: string;
  /** The origin Access is expected to forward, when it is configured. */
  public_origin?: string;
  /** When the password was last set; only for `signin: password`. */
  password_updated_at?: string | null;
  /** This build's release tag; present only when authenticated. */
  version?: string;
  /** Which integrations this deployment offers; absent (older BFF) = all on. */
  features?: FeatureFlags;
  /** This deployment's components with their versions (Settings → About). */
  components?: Component[];
}

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
  if (!status.authenticated) {
    return <SignInScreen signin={status.signin} setupRequired={status.setup_required} />;
  }
  return <Workspace status={status} />;
}

function Workspace({ status }: { status: Status }) {
  const session = useSession(true);
  const agents = useAgents(session);
  const conversation = useConversation(session, agents.agentId, agents.conversationId);

  // A BFF error nothing else claimed is an event, so it is a toast: it says its
  // piece and leaves, instead of covering the transcript until someone finds the
  // dismiss button. The ring buffer and the transcript still hold the facts.
  useEffect(() => {
    if (!session.lastError) return;
    toast(session.lastError, "bad");
    session.clearError();
  }, [session]);

  const contextLimit = useContextLimit(
    session.request,
    agents.agentId,
    agents.conversationId,
    session.ready,
  );
  // The compaction numbers the gauge and the Context sheet share: the size the
  // server gives a request, what the model promises per reply, and the point the
  // conversation therefore compacts at.
  const contextSize = useContextSize(agents.agentId, agents.conversationId, session.ready);
  /** The context gauge's details: usage, and the limit to change. */
  const [contextOpen, setContextOpen] = useState(false);

  /** `?tab=runs&run=<id>`: the run card's and settle pushes' landing spot. */
  const [runsLink] = useState(readRunsDeepLink);
  const [tab, setTab] = useState<Tab>(runsLink.tab ? "Runs" : "Chat");
  /**
   * The desktop conversation panel: pinned is a column, unpinned is a peek.
   * Both are Chat-only — a conversation list next to the Files pane answers no
   * question — so `visible` is derived, not stored separately.
   */
  const wide = useWide();
  const [panelPinned, setPanelPinned] = useState(readPanelPin);
  const [panelPeek, setPanelPeek] = useState(false);
  /**
   * The agent the rail is resting on, whose conversations the one panel shows for
   * the moment. There is no second list anywhere: a hover borrows the panel that is
   * already there, and an unpinned panel is already a peek, so borrowing it is the
   * same verb pressing Chat is. A pinned panel is a column you are reading, so a
   * hover leaves it alone.
   */
  const [previewId, setPreviewId] = useState<string | null>(null);
  /** The pointer is inside the panel — what keeps a borrowed list on screen. */
  const panelHeld = useRef(false);
  const previewList = useAgentConversations(session.request);
  const loadPreview = previewList.load;
  // A name resting in the panel's bottom block borrows even while pinned (see
  // `hoverPanelAgent`): the pointer is already inside the column you are reading,
  // which is an ask a sweep past the rail is not.
  const panelRest = useRef(false);
  const previewAgent =
    tab === "Chat" &&
    previewId &&
    previewId !== agents.agentId &&
    (!panelPinned || panelRest.current)
      ? (agents.agents.find((agent) => agent.id === previewId) ?? null)
      : null;
  const panelVisible = tab === "Chat" && (panelPinned || panelPeek || previewAgent !== null);
  useEffect(() => {
    if (previewId) loadPreview(previewId);
  }, [previewId, loadPreview]);
  const previewFromRail = useCallback((agentId: string | null) => {
    if (agentId) {
      setPreviewId(agentId);
      return;
    }
    // The pointer left the avatar. If it landed in the panel, the panel is holding
    // the borrowed list and it stays; otherwise the panel returns to its own agent —
    // and a peek a hover opened goes away with the hover, the same way.
    setPreviewId((current) => (panelHeld.current ? current : null));
  }, []);
  // The open agent's own avatar is not a borrow — it is "show me my conversations", and
  // borrowing the panel for the agent it already belongs to read-only took the New button and
  // the verbs away and sent the row click down the switch path, which empties the list.
  const ownAvatar = useCallback(() => {
    setPreviewId(null);
    setPanelPeek(true);
  }, []);
  const holdPanel = useCallback((held: boolean) => {
    panelHeld.current = held;
    if (!held) {
      panelRest.current = false;
      setPreviewId(null);
      // The hover mark belongs to the held list; a pointer that left the panel
      // must not leave a face lit in the rail with no list beside it.
      setHeldAgent(null);
    }
  }, []);
  /**
   * The seam is bidirectional: a face in the rail borrows the panel (above), and a
   * NAME in the panel's bottom block borrows its conversations into the list and
   * marks the rail's face. Unlike the rail's sweep, this one is honored while
   * pinned — resting on a name inside the panel is deliberate.
   */
  const hoverPanelAgent = useCallback((agentId: string | null) => {
    setHeldAgent(agentId);
    panelRest.current = agentId !== null;
    setPreviewId(agentId);
  }, []);
  /** Choosing from a borrowed list is a switch: that agent, that conversation. */
  const previewPick = useCallback(
    (agentId: string, conversationId: string) => {
      agents.selectAgent(agentId);
      agents.selectConversation(conversationId);
      setPreviewId(null);
    },
    [agents],
  );
  // A kept-open secondary pane is now about a different agent, and these panes are
  // anchored to a conversation — Files to its directory, Tasks to its runs. With
  // nothing selected they show a fallback path or nothing, so the switch finishes the
  // job and takes the agent's most recent conversation, which is the one the panel
  // would have offered first. Chat is left alone: there the empty selection is the point.
  const { conversationId, conversations, selectConversation } = agents;
  useEffect(() => {
    if (tab === "Chat" || conversationId) return;
    const first = conversations[0];
    if (!first) return;
    selectConversation(first.id);
  }, [tab, conversationId, conversations, selectConversation]);

  const openPanel = useCallback(() => setPanelPeek(true), []);
  // Unpinning is not closing: you are looking at the panel when you press it, so
  // it stays open as a peek. (It used to vanish on the un-pin, which made the pin
  // button — inside the panel — the thing you had just made unreachable.)
  const togglePanelPin = useCallback(() => {
    // Pinning a borrowed panel would keep another agent's list as the column you decided
    // to keep — the borrow is a hover, and a hover is not a decision.
    setPreviewId(null);
    setPanelPinned((current) => {
      writePanelPin(!current);
      if (current) setPanelPeek(true);
      return !current;
    });
  }, []);

  /**
   * The one pane switcher, shared by the rail and the phone bar.
   *
   * A secondary pane always puts the panel away (it is Chat's), and on Chat an
   * unpinned panel toggles — pressing Chat again is how you put the peek back.
   */
  const selectPane = useCallback(
    (next: Tab) => {
      // A borrow belongs to the rail and to Chat; changing pane ends it.
      setPreviewId(null);
      if (next === "Chat") {
        // Pinned, Chat has nothing to do (the panel is already there). Unpinned,
        // Chat is a toggle: pressing it while the peek is open puts it back.
        setPanelPeek(!panelPinned && !(tab === "Chat" && panelPeek));
      } else {
        setPanelPeek(false);
      }
      setTab(next);
    },
    [panelPinned, panelPeek, tab],
  );

  /** The rail's all cell: Chat's panel, on screen, its full agent list at the foot. */
  const showAllAgents = useCallback(() => {
    if (tab !== "Chat") selectPane("Chat");
    openPanel();
  }, [tab, selectPane, openPanel]);

  // An unpinned panel is a popover, and popovers get out of the way when you
  // press anywhere else. Pinned, it is a column and stays put. The band is NOT
  // "anywhere else": its own name is the toggle, and dismissing here first
  // would make the click under it re-open what the pointer just closed.
  useEffect(() => {
    if (!wide || !panelVisible || panelPinned) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".sidebar, .rail, .band")) return;
      setPanelPeek(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [wide, panelVisible, panelPinned]);

  // One pushed feed feeds both the Runs tab dot and the topbar chip; the
  // socket only carries pi frames while the feature is on.
  const piEnabled = featureEnabled(status?.features, "pi");
  useEffect(() => {
    session.setPiWatch(piEnabled);
  }, [session, piEnabled]);
  const piActive = usePiActiveRuns(piEnabled);
  /** Whether this deployment has any coding worker, which is what makes `Runs` a pane. */
  const runsFeature = runsEnabled(status?.features);
  /** The responding-conversations list behind the pulsing status dot. */
  const [activityOpen, setActivityOpen] = useState(false);
  /** The agents-and-conversations menu (phone); see `Switcher`. */
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const openSwitcher = useCallback(() => setSwitcherOpen(true), []);

  /**
   * The bottom agent blocks — the rail's and the panel's — are one row across
   * the column seam. The rail's takes every pixel between the fixed divider
   * (which sits directly under the Settings button) and the foot of the column
   * — CSS `flex: 1`, not a row-count formula: what fits is the layout's
   * business. App only measures the rail and hands the number across the seam,
   * so the two hairlines land on one pixel row whatever the window is.
   */
  const [agentBlock, setAgentBlock] = useState(168);
  /**
   * The pointer resting on an agent's name in the panel's bottom block: the
   * rail marks that avatar. The pair answers “which agent” as one control —
   * the borrow marks the other way, an amber row for a rail hover.
   */
  const [heldAgent, setHeldAgent] = useState<string | null>(null);
  // The two blocks mirror each other's scroll when the window clamps them. The
  // guard keeps the mirror from echoing: setting the other's scrollTop fires its
  // scroll event, which would otherwise fire a copy straight back.
  const railBlockRef = useRef<HTMLDivElement | null>(null);
  const panelBlockRef = useRef<HTMLDivElement | null>(null);
  const scrollMirror = useRef<"rail" | "panel" | null>(null);
  const syncAgentScroll = (source: "rail" | "panel") => {
    if (scrollMirror.current) return;
    const from = source === "rail" ? railBlockRef.current : panelBlockRef.current;
    const to = source === "rail" ? panelBlockRef.current : railBlockRef.current;
    if (!from || !to || to.scrollTop === from.scrollTop) return;
    scrollMirror.current = source;
    to.scrollTop = from.scrollTop;
    requestAnimationFrame(() => {
      scrollMirror.current = null;
    });
  };
  // The rail's block is the source of truth for the shared height; the panel's
  // mirrors it. (Below the desktop breakpoint the rail is display:none and
  // measures 0 — the panel is hidden there too.)
  useEffect(() => {
    const el = railBlockRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const h = Math.round(el.getBoundingClientRect().height);
      setAgentBlock((prev) => (Math.abs(prev - h) < 1 ? prev : h));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // A height change can leave a stale scrollTop misaligning the pair: both start over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: agentBlock is the trigger, not a read — the effect resets the scroll boxes themselves.
  useEffect(() => {
    if (railBlockRef.current) railBlockRef.current.scrollTop = 0;
    if (panelBlockRef.current) panelBlockRef.current.scrollTop = 0;
  }, [agentBlock]);
  /**
   * The band's identity is the panel verb on desktop — never the phone sheet:
   * ensure the Chat pane and bring the panel (a pinned one simply stays), and
   * clicking again closes a peek or borrow that is currently open.
   */
  const identityClick = useCallback(() => {
    if (!wide) {
      openSwitcher();
      return;
    }
    if (tab === "Chat" && (panelPinned || panelPeek || previewAgent !== null)) {
      // The panel is already here: clicking the name puts it away. A pinned
      // panel gives up its pin in the same click — asking to hide while pinned
      // means you mean it, and the pin button still re-pins one click away.
      setPanelPeek(false);
      setPreviewId(null);
      if (panelPinned) {
        writePanelPin(false);
        setPanelPinned(false);
      }
      return;
    }
    selectPane("Chat");
  }, [wide, openSwitcher, tab, panelPinned, panelPeek, previewAgent, selectPane]);
  /** New conversation for the agent a list is showing — the switcher's "with X". */
  const newConversationWith = useCallback(
    async (agentId: string) => {
      if (!agentId) return;
      setPreviewId(null);
      if (agentId === agents.agentId) {
        await agents.createConversation();
        return;
      }
      agents.selectAgent(agentId);
      const response = await session.request<{ conversation?: { id?: string } }>(
        "conversation_create",
        { body: { agent_id: agentId } },
      );
      await agents.refreshConversations(agentId);
      const id = response?.conversation?.id;
      if (typeof id === "string") agents.selectConversation(id);
    },
    [agents, session],
  );
  // A bottom-block row is the same "who" the rail's avatar is: the borrow ends,
  // the agent switches if it must, and its list — with verbs — becomes the panel's own.
  const pickPanelAgent = useCallback(
    (agentId: string) => {
      setPreviewId(null);
      if (agentId !== agents.agentId) agents.selectAgent(agentId);
    },
    [agents],
  );
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
  /** Whether the open agent has a conversation answering — its avatar says so. */
  const agentResponding = session.activeAgentIds.has(agents.agentId ?? "");

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

  // SIGNIN=none mints a session for whoever reaches the socket, which is only
  // safe because boot refuses it on any other bind. The pill says so on every
  // screen, since nothing else on the page distinguishes it from a real login.
  const unauthenticated = status.signin === "none";

  // The tab icon reports the link state, which matters most when this tab is
  // backgrounded on a phone — precisely when the socket tends to drop.
  useEffect(() => {
    applyFavicon(session.link);
  }, [session.link]);

  // The tab title names the open agent, so a strip of tabs says which is which.
  useEffect(() => {
    applyDocumentTitle(agentName);
  }, [agentName]);

  /** The top bar, hoisted so one component serves both widths: a band across
   * the whole desktop window, the old in-column topbar on a phone. */
  const topbar = (
    <header className={wide ? "topbar band" : "topbar"}>
      {/* The agent's face, in the corner the eye starts at, opening the same
              switcher its own name beside it does. Phone only: on desktop the rail
              is a column of these, and one more in the header would be a duplicate.
              It left the bottom bar because an agent you cannot see is an agent you
              lose track of — the bar's letter-sized glyph never said which agent. */}
      <button
        type="button"
        className="where-avatar"
        onClick={openSwitcher}
        aria-label={
          agentResponding
            ? `${agentName ?? "Agent"}: switch agent or conversation, responding`
            : `${agentName ?? "Agent"}: switch agent or conversation`
        }
        title="Agents and conversations"
      >
        <AgentAvatar
          agentId={agents.agentId ?? ""}
          name={agentName ?? ""}
          pref={agents.agentId ? agents.avatars[agents.agentId] : undefined}
          className="where-avatar-face"
          ariaHidden
        >
          {agentResponding ? <span className="activity-dot" /> : null}
        </AgentAvatar>
      </button>
      {/* Where you are: the agent over the conversation. On a phone it is
              also a way into the switcher from every tab, not just Chat. */}
      <button
        type="button"
        className="where"
        onClick={identityClick}
        aria-label={
          wide
            ? `${agentName ?? "Agent"}: ${title}. ${panelVisible ? "Hide" : "Show"} conversations`
            : respondingElsewhere > 0
              ? `${agentName ?? "Agent"}: ${title}. Switch — ${respondingElsewhere} responding elsewhere`
              : `${agentName ?? "Agent"}: ${title}. Switch agent or conversation`
        }
        title={wide ? (panelVisible ? "Hide conversations" : "Show conversations") : undefined}
      >
        <span className="where-agent">
          {agentName ?? "No agent"}
          {respondingElsewhere > 0 ? <span className="activity-dot badge-dot" /> : null}
        </span>
        <h1 className="title">{title}</h1>
        {/* No chevron: on desktop the name is the panel toggle (click shows or
                hides), and on a phone it opens the switcher — in both cases the
                button says what it does in its accessible name, and the caret
                only cluttered the corner the eye starts at. */}
      </button>
      <ContextGauge
        usage={conversation.turnUsage}
        limit={contextLimit.limit}
        accounting={contextSize.accounting}
        onOpen={() => {
          setContextOpen(true);
          void contextLimit.refresh();
          void contextSize.refresh();
        }}
      />
      {unauthenticated ? <AuthPill email={status.user?.email} /> : null}
      <LinkPill
        link={session.link}
        busy={respondingCount > 0}
        count={respondingCount}
        onOpen={() => setActivityOpen(true)}
      />
      {featureEnabled(status.features, "pi") ? (
        <PiRunsChip active={piActive} onOpen={() => selectPane("Runs")} />
      ) : null}
    </header>
  );

  return (
    <div className="app">
      {wide ? topbar : null}
      <NavRail
        agents={agents}
        activeAgentIds={session.activeAgentIds}
        runsEnabled={runsFeature}
        tab={tab}
        onSelectPane={selectPane}
        onOpenPanel={openPanel}
        onPreviewAgent={previewFromRail}
        onOwnAvatar={ownAvatar}
        onOpenSettings={() => setGlobalSettings({})}
        onShowAll={showAllAgents}
        onEditAgent={editAgent}
        heldAgentId={heldAgent}
        onHoverAgent={(agentId) => setHeldAgent(agentId)}
        blockRef={railBlockRef}
        onBlockScroll={() => syncAgentScroll("rail")}
      />
      <Sidebar
        agents={agents}
        visible={panelVisible}
        activeScopes={session.activeScopes}
        pinned={panelPinned}
        onTogglePin={togglePanelPin}
        preview={
          previewAgent
            ? {
                agentId: previewAgent.id,
                name: previewAgent.name,
                conversations: previewList.conversations,
                loading: previewList.loading,
                failed: previewList.failed,
              }
            : null
        }
        onPreviewPick={previewPick}
        onHold={holdPanel}
        blockHeight={agentBlock}
        blockRef={panelBlockRef}
        onBlockScroll={() => syncAgentScroll("panel")}
        onHoverAgent={hoverPanelAgent}
        heldAgentId={heldAgent}
        onNewAgent={() => setCreatingAgent(true)}
        onNewConversation={newConversationWith}
        onPickAgent={pickPanelAgent}
      />

      <div className="main">
        {/* On desktop the top bar is hoisted into the grid's band above every
            column; the phone keeps it inside .main, exactly where it was. */}
        {wide ? null : topbar}

        {/* A BFF error no request claimed (a rate limit, a command the browser
            allowlist refused) is an event, not a state: it is a toast now, so it
            says its piece and gets out of the way instead of covering the
            transcript until someone notices the dismiss button. */}

        {tab === "Chat" ? (
          <>
            {conversation.error ? (
              <p className="warning small dismissible" role="alert">
                <span>{conversation.error}</span>
                <button
                  type="button"
                  className="icon-button flat"
                  onClick={conversation.clearError}
                  aria-label="Dismiss error"
                  title="Dismiss"
                >
                  <Icon name="close" />
                </button>
              </p>
            ) : null}

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
                {/* No “Queued”/“Paused” label and no per-chip steer: one
                    yellow pill at the strip's left edge stops the turn and
                    starts the queue from its head — the rest follow in
                    order (upstream has no per-item promote, so “make THIS
                    next” for a later item is still what edit + delete are
                    for). A parked queue shows Resume instead. */}
                {conversation.queue.some((item) => item.source === "user" && !item.paused) ? (
                  <button
                    type="button"
                    className="queued steer-pill"
                    title="Steer — stop this turn and start the queued messages now"
                    onClick={() => {
                      const target = conversation.queue.find(
                        (item) => item.source === "user" && !item.paused,
                      );
                      if (target) void conversation.forceSend(target.id);
                    }}
                  >
                    <Icon name="send" />
                    Steer
                  </button>
                ) : null}
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
                    <span className="queued-text" title={item.content}>
                      <span>{item.content}</span>
                    </span>
                    {item.source === "user" ? (
                      // Edit: out of the queue, back into the input box — the
                      // same affordance as “Edit” on a sent message. Text
                      // returns; attached images do not survive the trip.
                      <button
                        type="button"
                        className="queued-act"
                        title="Edit — put it back in the input"
                        onClick={() => {
                          conversation.removeQueued(item.id);
                          setPrefill(item.content);
                        }}
                        aria-label={`Edit queued message: ${item.content.slice(0, 40)}`}
                      >
                        <Icon name="edit" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="queued-act"
                      title="Delete from queue"
                      onClick={() => conversation.removeQueued(item.id)}
                      aria-label={`Delete queued message: ${item.content.slice(0, 40)}`}
                    >
                      <Icon name="close" />
                    </button>
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
                liveSubagents: conversation.liveSubagents,
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
              onNewConversation={() => void agents.createConversation()}
              onOpenModels={() => setShowModels(true)}
              modelsDisabled={!scope}
              modelLabel={modelLabel}
              history={inputHistory}
              prefill={prefill}
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
            liveSubagents={conversation.liveSubagents}
            onStopMonitor={conversation.stopMonitor}
            onStopSubagent={conversation.stopSubagent}
            conversations={agents.conversations}
            onAskAgent={(text) => {
              // After any unsent text, not over it; the Composer remounts on Chat
              // and takes the prefill over the draft it reloads.
              const key = draftKey(agents.agentId, agents.conversationId);
              setPrefill(appendToDraft(key ? readDraft(key) : "", text));
              setTab("Chat");
            }}
            agentIds={agents.agents.map((agent) => agent.id)}
          />
        ) : tab === "Runs" ? (
          <RunsTab
            backgroundProcesses={conversation.backgroundProcesses}
            features={status.features}
            initialRunId={runsLink.run}
          />
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

        {/* The phone's navigation lives under the composer, where a thumb is:
            the top strip it replaces could not say six panes at 390px. */}
        <BottomBar
          agentName={agentName}
          tab={tab}
          onSelectPane={selectPane}
          onOpenSettings={() => setGlobalSettings({})}
          runsEnabled={runsFeature}
          runsRunning={piActive}
        />
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
          access={status.access}
          signin={status.signin}
          hostBind={status.host_bind}
          publicOrigin={status.public_origin}
          passwordUpdatedAt={status.password_updated_at}
          version={status.version}
          features={status.features}
          components={status.components}
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
          accounting={contextSize.accounting}
          processing={conversation.processing}
          onSetSize={contextSize.setSize}
          onSaved={() => void contextLimit.refresh()}
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

      <ToastLayer />
    </div>
  );
}

/**
 * The link state as a dot: green live, amber spinner while connecting or
 * reconnecting, red offline — the label is the tooltip and the accessible
 * name. It used to be a text pill, which cost the top bar the room it now
 * uses to say which agent and conversation you are in. Signed out stays
 * words and a button: it is the one state that needs you to act. While any
 * conversation is responding the whole slot pulses and becomes one button into
 * the list of what is running; with nothing running it is the same passive dot as
 * ever.
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
    // The whole slot is the button: the dot alone was a 10px target with a word
    // beside it that looked like the control and was not one.
    return (
      <button
        type="button"
        className="topbar-status busy"
        onClick={onOpen}
        aria-label={busyLabel}
        title={busyLabel}
      >
        <span className={`link-dot ${tone} busy`} aria-hidden="true" />
        <span className="topbar-word">{count} responding</span>
      </button>
    );
  }
  return (
    <span className="topbar-status">
      <span
        className={`link-dot ${tone}${tone === "warn" ? " spinning" : ""}`}
        role="img"
        aria-label={label}
        title={label}
      />
      {/* The dot is the state at every width; the word only where there is room
          for it, so the state is never colour alone on a wide screen. */}
      <span className="topbar-word">{label}</span>
    </span>
  );
}
