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
import { Icon } from "./components/Icon.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { ModelPicker } from "./components/ModelPicker.tsx";
import { NavRail } from "./components/NavRail.tsx";
import { PiRunsChip, usePiActiveRuns } from "./components/PiRunsChip.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { SignInScreen } from "./components/SignInScreen.tsx";
import { Switcher } from "./components/Switcher.tsx";
import { ToastLayer, toast } from "./components/Toast.tsx";
import { resolveAvatar } from "./lib/agent-tint.ts";
import type { PreparedImage } from "./lib/attachments.ts";
import { applyDocumentTitle } from "./lib/document-title.ts";
import { appendToDraft, draftKey, readDraft } from "./lib/draft.ts";
import { friendlyServerError } from "./lib/errors.ts";
import { applyFavicon } from "./lib/favicon.ts";
import { type FeatureFlags, featureEnabled } from "./lib/features.ts";
import { markFreshConversation } from "./lib/fresh-conversations.ts";
import { userHistory } from "./lib/input-history.ts";
import { deriveLinkStatus } from "./lib/link-status.ts";
import { type FilterGroup, filterEntries, toggleShown } from "./lib/messages.ts";
import { readRunsDeepLink } from "./lib/pi.ts";
import {
  type Component,
  type ConnectionState,
  type RuntimeScope,
  scopeKey,
} from "./lib/protocol.ts";
import type { LinkState } from "./lib/session-client.ts";
import { readSettingsDeepLink } from "./lib/settings-link.ts";
import {
  type GlobalSection,
  isGlobalSection,
  isSectionVisible,
  readLastSection,
  visibleGroups,
  writeLastSection,
} from "./lib/settings-sections.ts";
import type { Access, Signin } from "./lib/signin.ts";
import {
  readStructuredOutput,
  type StructuredOutputPreference,
  writeStructuredOutput,
} from "./lib/structured-output.ts";
import {
  readPanelPin,
  readRailPin,
  runsEnabled,
  type Tab,
  writePanelPin,
  writeRailPin,
} from "./lib/tabs.ts";
import { readShowTimestamps, writeShowTimestamps } from "./lib/timestamps.ts";
import { useAgentConversations } from "./state/use-agent-conversations.ts";
import { useAgents } from "./state/use-agents.ts";
import { useBackToClose } from "./state/use-back-to-close.ts";
import { useContextLimit } from "./state/use-context-limit.ts";
import { useContextSize } from "./state/use-context-size.ts";
import { useConversation } from "./state/use-conversation.ts";
import { useCurrentModel } from "./state/use-models.ts";
import { useSession } from "./state/use-session.ts";
import { useWide } from "./state/use-wide.ts";
import { AgentTab } from "./tabs/AgentTab.tsx";
import { FilesTab } from "./tabs/FilesTab.tsx";
import { RunsTab } from "./tabs/RunsTab.tsx";
import { SettingsPane } from "./tabs/SettingsTab.tsx";
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
    toast(friendlyServerError(session.lastError), "bad");
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
  /** `?settings=google` — the link an agent gives when Google access is lost. Read
   * once, because it decides which pane the app opens on. */
  const [settingsLink] = useState(() => readSettingsDeepLink(isGlobalSection));
  const [tab, setTab] = useState<Tab>(() => {
    if (runsLink.tab) return "Runs";
    // A `?settings=google` link opens the pane it names, not Chat with a dialog over it.
    if (settingsLink) return "Settings";
    return "Chat";
  });
  /**
   * Which Settings section that pane shows. It has no default, so it resumes where
   * you left it — but only where this deployment can still configure it: a
   * remembered or deep-linked section behind a compose token that is off lands on
   * the first visible one.
   */
  const [settingsSection, setSettingsSection] = useState<GlobalSection>(() => {
    const wanted = settingsLink ?? readLastSection();
    if (wanted && isSectionVisible(wanted, status.features)) return wanted;
    return visibleGroups(status.features)[0]?.sections[0]?.id ?? "providers";
  });
  /**
   * The desktop conversation DRAWER: pinned is a column of the grid, unpinned is a
   * peek that floats over the transcript, and by default it is neither — it is shut,
   * because the rail now carries the agent names and the transcript is what wants
   * the width. Both are Chat-only — a conversation list next to the Files pane
   * answers no question — so `visible` is derived, not stored separately.
   */
  const wide = useWide();
  const [panelPinned, setPanelPinned] = useState(readPanelPin);
  const [panelPeek, setPanelPeek] = useState(false);
  /**
   * The desktop rail's shape, per device: pinned is the column of words, unpinned
   * is a glyph strip (the pin in the rail's AGENTS row flips it, and the choice
   * survives a reload like the drawer's pin does). The Settings rail is exempt —
   * its sections are words — so the collapse applies only while another pane is up.
   */
  const [railPinned, setRailPinned] = useState(readRailPin);
  /**
   * The agent the rail is resting on, whose conversations the one panel shows for
   * the moment. There is no second list anywhere: a hover borrows the panel that is
   * already there, and an unpinned panel is already a peek, so borrowing it is the
   * same verb pressing Chat is. A pinned panel is a column you are reading, so a
   * hover leaves it alone.
   */
  const [previewId, setPreviewId] = useState<string | null>(null);
  /** The pointer is inside the drawer — what keeps a borrowed list on screen. */
  const panelHeld = useRef(false);
  const previewList = useAgentConversations(session.request);
  const loadPreview = previewList.load;
  // A borrowed list is a hover's answer, so it is honoured only while the drawer is
  // unpinned: a pinned column is the one you chose to keep, and it does not change
  // agents under you. (It used to be allowed when the pointer rested inside the
  // drawer too — that was the panel's agent list talking back, and that list is gone.)
  const previewAgent =
    tab === "Chat" && previewId && previewId !== agents.agentId && !panelPinned
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
    if (!held) setPreviewId(null);
  }, []);
  /** An unpinned drawer was opened to answer one question; a pick answers it, so it
   * gets out of the way — the pinned column stays because you asked for it. */
  const pickConversationInDrawer = useCallback(() => {
    if (!panelPinned) setPanelPeek(false);
  }, [panelPinned]);
  /** Choosing from a borrowed list is a switch: that agent, that conversation. */
  const previewPick = useCallback(
    (agentId: string, conversationId: string) => {
      agents.selectAgent(agentId);
      agents.selectConversation(conversationId);
      setPreviewId(null);
      pickConversationInDrawer();
    },
    [agents, pickConversationInDrawer],
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

  const toggleRailPin = useCallback(() => {
    setRailPinned((current) => {
      writeRailPin(!current);
      return !current;
    });
  }, []);

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

  /**
   * The browser's Back closes the open window, and a secondary pane IS the open
   * window: while any pane other than Chat is up the pane area owns one history
   * entry (the shared BackStack's floor rank, so any sheet or menu opened over
   * the pane closes first), and Back steps back to Chat instead of leaving the
   * app. Switching panes does not add entries — one window, one step. Pressing
   * the corner X or a bar slot closes the pane on screen and the entry retires
   * the same way every other overlay's does.
   */
  useBackToClose(() => {
    selectPane("Chat");
  }, tab !== "Chat");

  /** The Settings column's ☰ at the foot: leave the pane and bring the conversation
   * drawer with you. It is a door, not a toggle — pressing it lands you on Chat with
   * the drawer up, so there is no second press here to undo the first. On Chat the
   * undo is the identity button in the band, which hides the drawer and gives up a
   * pin in the same click. */
  const showAllAgents = useCallback(() => {
    if (tab !== "Chat") selectPane("Chat");
    openPanel();
  }, [tab, selectPane, openPanel]);

  /** The rail's section cell: open a section and remember it as the one to resume. */
  const pickSettingsSection = useCallback((section: GlobalSection) => {
    setSettingsSection(section);
    writeLastSection(section);
  }, []);

  /** The rail's foot cell is the door into Settings. It is a door and not a toggle:
   * the cell is not on screen while Settings is the pane (the rail holds its sections
   * then), so the way out is the sections rail's Back cell or the corner X, and both
   * go back to Chat — remembering which pane opened Settings would be a fourth thing
   * for the rail's foot to remember, for a verb you cannot press twice. */
  const openSettingsPane = useCallback(() => selectPane("Settings"), [selectPane]);

  /** A link from another pane into one Settings section — the door's verb with the
   * section chosen for you, which is how "Google access lost" lands on Google. */
  const openSettings = useCallback(
    (section?: GlobalSection | string) => {
      if (typeof section === "string" && isGlobalSection(section)) pickSettingsSection(section);
      selectPane("Settings");
    },
    [pickSettingsSection, selectPane],
  );

  // An unpinned panel is a popover, and popovers get out of the way when you
  // press anywhere else. Pinned, it is a column and stays put. The identity
  // button is the one spot on the band that is NOT "anywhere else": it is the
  // toggle itself, and dismissing here first would make its click re-open what
  // the pointer just closed. The rest of the band (empty space, the gauge) is
  // ordinary elsewhere and dismisses normally.
  useEffect(() => {
    if (!wide || !panelVisible || panelPinned) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".sidebar, .rail, .topbar .where")) return;
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

  // There used to be a second copy of the agent list at the foot of the drawer, and
  // a block of plumbing to keep the two in step: a mirrored height, a mirrored
  // scrollTop, a "held" mark so one row lit in both columns at once. The rail is
  // the agent list now, so the plumbing is gone — which is the point of the change.
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
      const id = response?.conversation?.id;
      // Mark before the refresh — it can select this conversation itself.
      if (typeof id === "string") markFreshConversation(id);
      await agents.refreshConversations(agentId);
      if (typeof id === "string") agents.selectConversation(id);
    },
    [agents, session],
  );
  // A bottom-block row is the same "who" the rail's avatar is: the borrow ends,
  // the agent switches if it must, and its list — with verbs — becomes the panel's own.
  const [showModels, setShowModels] = useState(false);
  /** The New agent sheet. Editing an agent is the Agent tab's General section. */
  const [creatingAgent, setCreatingAgent] = useState(false);
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
  // The agent's colour, from the one resolver the avatar and the rail use. The
  // transcript needs it too: `--agent` is otherwise only ever set on the nav rail,
  // so the answer rail kept the root default green next to an avatar of any colour.
  const agentTint = agents.agentId
    ? resolveAvatar(agents.agentId, agentName ?? "", agents.avatars[agents.agentId]).background
    : null;
  /** The band's title: the conversation on Chat, the pane's own name everywhere else
   * (which for Settings is simply the pane's name). A secondary pane used to leave
   * the title saying "Lettuce" over a screen of MCP servers — the band named nothing,
   * which is what the corner X now closes. */
  const bandTitle = tab === "Chat" ? title : tab;

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

  // The tab icon reports the same derived status as the dot: on a phone this
  // tab spends most of its life backgrounded, and "the app-server is gone"
  // must not read as "your wifi is down" in the tab strip.
  useEffect(() => {
    applyFavicon(deriveLinkStatus(session.link, session.upstream).favicon);
  }, [session.link, session.upstream]);

  // The tab title names the open agent, so a strip of tabs says which is which.
  useEffect(() => {
    applyDocumentTitle(agentName);
  }, [agentName]);

  /** The top bar, hoisted so one component serves both widths: a band across
   * the whole desktop window, the old in-column topbar on a phone. */
  const topbar = (
    <header className={wide ? "topbar band" : "topbar"}>
      {/* The agent's face, in the corner the eye starts at — phone only: on
              desktop the rail is a column of these, and one more in the header
              would be a duplicate. On a phone it opens the same switcher its own
              name beside it does. It left the bottom bar because an agent you
              cannot see is an agent you lose track of — the bar's letter-sized
              glyph never said which agent. */}
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
            ? `${agentName ?? "Agent"}: ${bandTitle}. ${panelVisible ? "Hide" : "Show"} conversations`
            : respondingElsewhere > 0
              ? `${agentName ?? "Agent"}: ${bandTitle}. Switch — ${respondingElsewhere} responding elsewhere`
              : `${agentName ?? "Agent"}: ${bandTitle}. Switch agent or conversation`
        }
        title={wide ? (panelVisible ? "Hide conversations" : "Show conversations") : undefined}
      >
        <span className="where-agent">
          {agentName ?? "No agent"}
          {respondingElsewhere > 0 ? <span className="activity-dot badge-dot" /> : null}
        </span>
        <h1 className="title">{bandTitle}</h1>
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
        upstream={session.upstream}
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
    <div className={`app${railPinned || tab === "Settings" ? "" : " rail-collapsed"}`}>
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
        settingsOpen={tab === "Settings"}
        settingsSection={settingsSection}
        features={status.features}
        onPickSection={pickSettingsSection}
        onOpenSettings={openSettingsPane}
        onCloseSettings={() => selectPane("Chat")}
        onShowAll={showAllAgents}
        onEditAgent={editAgent}
        onNewAgent={() => setCreatingAgent(true)}
        railCollapsed={!railPinned && tab !== "Settings"}
        onToggleRailPin={toggleRailPin}
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
        onNewConversation={newConversationWith}
        onPickConversation={pickConversationInDrawer}
      />

      {/* `.closable` is not decoration: it is how the pane's own bar knows to stand
          clear of the corner X (see `.main.closable .pane-bar`). */}
      <div className={tab === "Chat" ? "main" : "main closable"}>
        {/* On desktop the top bar is hoisted into the grid's band above every
            column; the phone keeps it inside .main, exactly where it was. */}
        {wide ? null : topbar}

        {/* Every pane but the primary one gets a way out in the corner it is always
            in — the same glyph a sheet uses, and the same verb: back to Chat. The
            band used to carry this as a text button and it read as a seven-tab bar
            with the rail already beside it; a pane you can only leave by finding the
            right word in a list is a pane you feel stuck in. */}
        {tab === "Chat" ? null : (
          <button
            type="button"
            className="sheet-close pane-close"
            onClick={() => selectPane("Chat")}
            aria-label={`Close ${bandTitle} and back to Chat`}
            title={`Close ${bandTitle} and back to Chat`}
          >
            <Icon name="close" />
          </button>
        )}

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
              historyLoading={conversation.historyLoading}
              session={session}
              cwd={conversation.cwd}
              onOpenFile={setOpenFile}
              showTimestamps={showTimestamps}
              onEditMessage={setPrefill}
              onAnswerQuestion={conversation.answerQuestions}
              liveSubagents={conversation.liveSubagents}
              agentId={agents.agentId}
              agentTint={agentTint}
              onStopSubagent={conversation.stopSubagent}
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
            agentId={agents.agentId}
            agentName={agentName}
            agents={agents.agents}
          />
        ) : tab === "Settings" ? (
          <SettingsPane
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
            section={settingsSection}
            onPick={pickSettingsSection}
          />
        ) : tab === "Tools" ? (
          <ToolsTab
            agents={agents}
            features={status.features}
            onOpenGlobalSettings={openSettings}
          />
        ) : (
          <AgentTab
            session={session}
            agents={agents}
            conversationId={agents.conversationId}
            cwd={conversation.cwd}
            skillsVersion={conversation.skillsVersion}
            onOpenGlobalSettings={openSettings}
          />
        )}

        {/* The phone's navigation lives under the composer, where a thumb is:
            the top strip it replaces could not say six panes at 390px. */}
        <BottomBar
          agentName={agentName}
          tab={tab}
          onSelectPane={selectPane}
          onOpenSettings={() => selectPane("Settings")}
          runsEnabled={runsFeature}
          runsRunning={piActive}
        />
      </div>

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
 * The connection state as a dot: green live, amber spinner while connecting or
 * reconnecting, red offline — the label is the tooltip and the accessible
 * name. It used to be a text pill, which cost the top bar the room it now
 * uses to say which agent and conversation you are in. Signed out stays
 * words and a button: it is the one state that needs you to act. While any
 * conversation is responding the whole slot pulses and becomes one button into
 * the list of what is running; with nothing running it is the same passive dot as
 * ever.
 *
 * Both axes go into the label (`lib/link-status.ts`): a live browser socket
 * over a dead app-server says "App-server offline", not "Live".
 */
function LinkPill({
  link,
  upstream,
  busy,
  count,
  onOpen,
}: {
  link: LinkState;
  upstream: ConnectionState;
  busy: boolean;
  count: number;
  onOpen: () => void;
}) {
  const { label, tone } = deriveLinkStatus(link, upstream);
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
  // Idle: the light, and it is a control. It used to be a passive dot beside a
  // word, which is why it got read as decoration; clicking it now opens the same
  // list the busy slot does, so the corner answers "is it working" and "what is
  // answering" with one target, and says the state in a word wherever there is
  // room for one (colour is never the whole message).
  const idleLabel = `${label} — responding conversations`;
  return (
    <button
      type="button"
      className="topbar-status light"
      onClick={onOpen}
      aria-label={idleLabel}
      title={idleLabel}
    >
      <span
        className={`link-dot ${tone}${tone === "warn" ? " spinning" : ""}`}
        aria-hidden="true"
      />
      <span className="topbar-word">{label}</span>
    </button>
  );
}
