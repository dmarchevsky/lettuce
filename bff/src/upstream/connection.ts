import type {
  AppServerInfoResponseMessage,
  AppServerSocketConstructor,
} from "@letta-ai/letta-code/app-server-client";
import { AppServerClient } from "@letta-ai/letta-code/app-server-client";
import type {
  AgentListResponseMessage,
  ConversationListResponseMessage,
  WsProtocolMessage,
} from "@letta-ai/letta-code/app-server-protocol";
import WebSocket from "ws";
import { errorMessage } from "../errors.ts";
import { scopeKeyOf } from "../session/buffer.ts";

export type UpstreamState = "connecting" | "connected" | "disconnected";

/**
 * The slice of `AppServerClient` this class uses, and the seam its tests drive.
 *
 * Everything the connection does — reconnect, re-subscribe, sweep, internal-id
 * bookkeeping — is behaviour worth pinning down, and none of it is observable
 * without controlling what the far end says. Production leaves `createClient`
 * alone and gets the real client over a real socket.
 */
export interface UpstreamClient {
  /**
   * Why the socket itself last failed, when the client knows more than its
   * rejection says. Present on the production client only (see
   * `createAppServerClient`); a test fake need not implement it.
   */
  failureDetail?(): string | null;
  connect(): Promise<unknown>;
  close(): void;
  onMessage(handler: (message: WsProtocolMessage) => void): () => void;
  onDisconnect(handler: () => void): () => void;
  sendRaw(command: Record<string, unknown>): void;
  requestRaw(
    command: Record<string, unknown>,
    options: { timeoutMs?: number; predicate?: (message: WsProtocolMessage) => boolean },
  ): Promise<unknown>;
  info(): Promise<AppServerInfoResponseMessage>;
}

export interface UpstreamOptions {
  url: string;
  onFrame: (frame: WsProtocolMessage) => void;
  onStateChange: (state: UpstreamState, info: AppServerInfoResponseMessage | null) => void;
  log?: (message: string) => void;
  /** Builds the client. Tests inject a fake one; production gets the real one. */
  createClient?: (url: string) => UpstreamClient;
}

/** What a socket-level error event actually says, under either runtime. */
function describeSocketError(event: unknown): string {
  if (event instanceof Error) return event.message;
  if (event && typeof event === "object") {
    const record = event as { message?: unknown; error?: unknown };
    if (typeof record.message === "string") return record.message;
    if (record.error != null) return String(record.error);
  }
  return String(event);
}

/**
 * The real client, wrapped so that a failed handshake cannot end the process.
 *
 * Bun aliases `ws` onto its own WebSocket implementation, and that implementation
 * decides whether an `error` event is "unhandled" by counting **EventEmitter**
 * listeners. Upstream's client never registers one: `attachSocketListener`
 * (`@letta-ai/letta-code` `dist/app-server-client.js`) prefers `addEventListener`
 * whenever the socket has it, and Bun's does. So when the handshake fails — the
 * app-server not listening yet, which is what a docker-daemon boot hands this
 * process before `depends_on: condition: service_healthy` means anything — the
 * event reaches an EventEmitter with zero `error` listeners and EventEmitter
 * throws it:
 *
 * ```text
 * error: Unhandled error. (ErrorEvent { isTrusted: [Getter] })
 *     at emitError (node:events:60:30)
 * ```
 *
 * That is an uncaught exception, so the BFF exits 1 even though the rejection a
 * few lines below is handled — and node, running the identical code, only ever
 * rejects. Measured on bun 1.4.2 / node 22: keeping **one** permanent ws-style
 * listener on the socket is what stops it; `socket.onerror = …` and
 * `addEventListener("error", …)` both leave the count at zero and still crash.
 *
 * The listener also keeps the reason the rejection loses. Under bun the rejection
 * reads `App-server WebSocket failed to open: [object ErrorEvent]`, while the
 * event carries `WebSocket connection to 'ws://…' failed: Failed to connect`.
 */
class HandshakeTolerantClient implements UpstreamClient {
  private lastError: string | null = null;
  /**
   * The same client as this class's own seam. One boundary cast, for the command
   * and option types the seam states loosely on purpose: the caller owns
   * `request_id` allocation and always supplies `type`, so `Record<string,
   * unknown>` is what flows here even though upstream's signatures ask for more.
   */
  private readonly upstream: UpstreamClient;

  constructor(client: AppServerClient) {
    this.upstream = client as unknown as UpstreamClient;
    // `socket.on` is optional in upstream's own `AppServerSocketLike` because a
    // browser WebSocket has no EventEmitter API; the one built above always does.
    client.socket.on?.("error", (event) => {
      this.lastError = describeSocketError(event);
    });
  }

  failureDetail(): string | null {
    return this.lastError;
  }

  connect(): Promise<unknown> {
    return this.upstream.connect();
  }
  close(): void {
    this.upstream.close();
  }
  onMessage(handler: (message: WsProtocolMessage) => void): () => void {
    return this.upstream.onMessage(handler);
  }
  onDisconnect(handler: () => void): () => void {
    return this.upstream.onDisconnect(handler);
  }
  sendRaw(command: Record<string, unknown>): void {
    this.upstream.sendRaw(command);
  }
  requestRaw(
    command: Record<string, unknown>,
    options: { timeoutMs?: number; predicate?: (message: WsProtocolMessage) => boolean },
  ): Promise<unknown> {
    return this.upstream.requestRaw(command, options);
  }
  info(): Promise<AppServerInfoResponseMessage> {
    return this.upstream.info();
  }
}

/** The real client: no `authToken`, deliberately. The app-server listens on
 * loopback without `--ws-auth`, because `letta channel-gateway` cannot send a
 * token and would be locked out; nothing outside the shared network namespace
 * can reach it (docker/compose.yml). An unauthenticated upgrade carrying
 * `Origin` is rejected outright, which `ws` never sends unasked — and which is
 * why a browser cannot connect directly.
 *
 * `webSocket` is the seam that lets a test prove the tolerance is attached without
 * a real socket; production never passes it.
 */
export function createAppServerClient(
  url: string,
  webSocket: AppServerSocketConstructor = WebSocket as unknown as AppServerSocketConstructor,
): UpstreamClient {
  const client = new AppServerClient({ url, WebSocket: webSocket });
  // Constructed before anything awaits: the handshake cannot fail before this
  // listener exists, because no event is delivered while this frame is on the stack.
  return new HandshakeTolerantClient(client);
}

const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 15_000;
/**
 * How often one long outage repeats itself in the log. Backoff caps at 15 s, so
 * an app-server that stays down would otherwise print four lines a minute forever
 * — `/readyz` answers `app-server connecting|disconnected` for anyone who wants
 * the state rather than the noise.
 */
const CONNECT_FAILURE_LOG_EVERY = 20;

/** Whether the Nth consecutive failed connect earns a log line (exported for tests). */
export function shouldLogConnectFailure(failures: number): boolean {
  return failures === 1 || failures % CONNECT_FAILURE_LOG_EVERY === 0;
}
/** Cron itself only ticks every 60s, so a sweep well slower than that still
 * finds a new conversation quickly without hammering the app-server. */
const SCOPE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** Matches the `limit: 100` already used by the browser's own
 * agent_list/conversation_list calls (use-agents.ts); conversations are walked
 * with the list's own cursor, agents are not. */
const SCOPE_SWEEP_LIST_LIMIT = 100;
/** How far one sweep will page a single agent's conversations. The list is
 * newest-first, so this is only there so a long-lived install with hundreds of
 * conversations still reaches the older ones — the ones a cron wrote weeks ago
 * and a browser has never opened. */
const SCOPE_SWEEP_MAX_PAGES = 10;
/**
 * How many never-before-seen scopes one sweep will subscribe.
 *
 * Without a cap a sweep is O(agents x conversations) — serial syncs at 30s
 * timeout each. A large install would spend hours hammering the
 * one connection the whole app shares, and each new scope is a `sync` that can
 * resume an interrupted turn, so the work also translates into LLM load. The
 * cap turns that into a bounded burst per interval; whatever is left over is
 * picked up by the next sweep, and a scope is never synced twice because
 * `rememberScope` records it on the way out.
 *
 * The first sweep after a connect gets the larger budget because it starts from
 * nothing: at the steady 50-per-5-minutes rate a BFF that restarts would leave
 * every conversation unsubscribed for tens of minutes, and a cron turn in that
 * window produces no push, no activity dot and no interrupted-turn resume.
 */
const SCOPE_SWEEP_MAX_NEW_SCOPES = 50;
const SCOPE_SWEEP_MAX_NEW_SCOPES_INITIAL = 500;
/**
 * How many owner `sync` commands one pass keeps in flight.
 *
 * Both the reconnect re-subscribe and the scope sweep used to await one sync at
 * a time, and each is answered with a full state replay for its scope. A
 * long-lived BFF knows every conversation it has ever touched, so one
 * app-server restart was a thousand round trips deep — minutes during which
 * `sweepInFlight` stayed true, so a conversation created in that window was not
 * subscribed either, and no push came from its turns. Eight bounds the burst the
 * scope cap already bounds and shortens the pass by an order of magnitude. The
 * replies are independent scopes matched by request id, so their order means
 * nothing; `request()` registers each id before it sends.
 */
const SYNC_CONCURRENCY = 8;
/**
 * Ceiling on remembered internal request ids. Generous relative to real traffic
 * (a sweep of 100 agents x 100 conversations is ~10k ids) so eviction only
 * ever kicks in on a pathological run, and cheap either way: these are short
 * strings.
 */
const MAX_INTERNAL_REQUEST_IDS = 20_000;

/**
 * The single, permanent connection to the app-server.
 *
 * THIS CONNECTION MUST NEVER BE CLOSED WHILE THE PROCESS IS ALIVE.
 *
 * The app-server ties turn ownership, queue entries, pending approvals and
 * terminals to the connection that created them. When a connection closes,
 * `cleanupListenerConnection` (letta-code: src/websocket/listener/connection-lifecycle.ts)
 * cancels the in-flight turn for every conversation it owned unless another
 * subscribed connection remains, drops its queued messages, and rejects its
 * pending approvals.
 *
 * Browser sessions therefore multiplex over this one connection rather than
 * holding their own. A phone backgrounding a tab drops only its browser-facing
 * socket; the app-server never observes a disconnect, so the agent keeps working.
 */
export class UpstreamConnection {
  private client: UpstreamClient | null = null;
  private state: UpstreamState = "connecting";
  private info: AppServerInfoResponseMessage | null = null;
  private retryMs = INITIAL_RETRY_MS;
  /** Failed connect attempts since the last success — see `CONNECT_FAILURE_LOG_EVERY`. */
  private connectFailures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** Times the upstream socket has been established. Must stay 1 in a healthy run. */
  private generation = 0;
  /** Scopes this connection has touched; re-subscribed after a reconnect. */
  private readonly knownScopes = new Map<string, { agent_id: string; conversation_id: string }>();
  /**
   * Request ids issued by `request()` — BFF-internal round trips, never made on
   * behalf of a browser session. Their responses carry the id right back, and
   * unless the frame router recognises them as internal they fall through to
   * the unsolicited-frame path and get broadcast to every session and written
   * into the replay buffer. For `read_file` that means whole file contents
   * reaching sessions that never asked for them.
   *
   * Entries are kept rather than dropped when the request settles: the router
   * sees the response before the promise resolves, but a late or duplicated
   * frame with the same id must not become broadcast-worthy either. The set is
   * FIFO-bounded so a long-lived process cannot grow it without limit.
   */
  private readonly internalRequestIds = new Set<string>();
  /**
   * Set while a sweep is running. `setInterval` fires on wall-clock time and
   * does not care whether the previous callback finished, so without this a
   * sweep slower than the interval piles up new sweeps without bound, each
   * enumerating the same agent and conversation lists.
   */
  private sweepInFlight = false;
  /** Whether the post-connect sweep has finished — see the initial budget. */
  private initialSweepDone = false;

  constructor(private readonly options: UpstreamOptions) {}

  getState(): UpstreamState {
    return this.state;
  }

  getInfo(): AppServerInfoResponseMessage | null {
    return this.info;
  }

  /**
   * How many times we have connected upstream. A browser disconnect must never
   * increment this — see the class comment.
   */
  getGeneration(): number {
    return this.generation;
  }

  isReady(): boolean {
    return this.state === "connected" && this.client !== null;
  }

  start(): void {
    this.stopped = false;
    this.connect();
    // Periodic in addition to the post-connect sweep below: a conversation
    // created after boot (by cron, or a channel gateway) has no other hook
    // that would ever subscribe this connection to it.
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => {
        if (this.isReady()) void this.subscribeToAllScopes();
      }, SCOPE_SWEEP_INTERVAL_MS);
    }
  }

  /** Only for process shutdown. Never call this in response to a browser event. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.client?.close();
    this.client = null;
    this.setState("disconnected");
  }

  /**
   * Forward a command upstream. The caller owns `request_id` allocation — see
   * SessionRegistry, which rewrites browser-supplied ids into BFF-owned ones.
   */
  send(command: Record<string, unknown> & { type: string }): void {
    if (!this.client || this.state !== "connected") {
      throw new Error("App-server connection is not ready");
    }
    this.rememberScope(command);
    this.client.sendRaw(command);
  }

  /**
   * Send a command the BFF issued on its own behalf, not for a browser session.
   *
   * Same as `send()` plus internal-id bookkeeping: the response carries the id
   * back, and without registering it the router would treat that response as an
   * unsolicited frame and broadcast it. Use this whenever the BFF originates the
   * request but does not need the answer.
   */
  sendInternal(command: Record<string, unknown> & { type: string; request_id: string }): void {
    if (!this.client || this.state !== "connected") {
      throw new Error("App-server connection is not ready");
    }
    this.rememberScope(command);
    this.rememberInternalRequest(command.request_id);
    this.client.sendRaw(command);
  }

  /** A BFF-internal request/response round trip (not on behalf of a session). */
  async request<T extends WsProtocolMessage>(
    command: Record<string, unknown> & { type: string; request_id: string },
    timeoutMs = 30_000,
  ): Promise<T> {
    if (!this.client || this.state !== "connected") {
      throw new Error("App-server connection is not ready");
    }
    this.rememberScope(command);
    this.rememberInternalRequest(command.request_id);
    return (await this.client.requestRaw(command, {
      timeoutMs,
      predicate: (message): message is never =>
        Boolean(
          message &&
            typeof message === "object" &&
            (message as { request_id?: unknown }).request_id === command.request_id,
        ),
    })) as unknown as T;
  }

  /**
   * Record that this connection issued `requestId` itself, so the frame router
   * can tell an internal response from an unsolicited frame.
   *
   * `Set` iteration order is insertion order, so eviction drops the oldest id —
   * the one whose response is long past and least likely to turn up again.
   */
  private rememberInternalRequest(requestId: string): void {
    this.internalRequestIds.add(requestId);
    while (this.internalRequestIds.size > MAX_INTERNAL_REQUEST_IDS) {
      const oldest = this.internalRequestIds.values().next();
      if (oldest.done) break;
      this.internalRequestIds.delete(oldest.value);
    }
  }

  /**
   * Whether `requestId` belongs to a BFF-internal round trip rather than to a
   * browser session. Such a response must not be relayed, buffered, or
   * broadcast; see `internalRequestIds`.
   */
  isInternalRequest(requestId: string): boolean {
    return this.internalRequestIds.has(requestId);
  }

  private rememberScope(command: Record<string, unknown>): void {
    const runtime = command.runtime;
    if (!runtime || typeof runtime !== "object") return;
    const scope = runtime as { agent_id?: unknown; conversation_id?: unknown };
    if (typeof scope.agent_id !== "string" || typeof scope.conversation_id !== "string") {
      return;
    }
    this.knownScopes.set(scopeKeyOf(scope.agent_id, scope.conversation_id), {
      agent_id: scope.agent_id,
      conversation_id: scope.conversation_id,
    });
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private setState(state: UpstreamState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange(state, this.info);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState("connecting");

    let client: UpstreamClient;
    try {
      client = (this.options.createClient ?? createAppServerClient)(this.options.url);
    } catch (error) {
      this.log(`Upstream construction failed: ${errorMessage(error)}`);
      this.scheduleRetry();
      return;
    }

    this.client = client;
    client.onMessage((message) => this.options.onFrame(message));
    client.onDisconnect(() => {
      this.log("Upstream connection closed; reconnecting");
      this.client = null;
      this.setState("disconnected");
      this.scheduleRetry();
    });

    void client
      .connect()
      .then(async () => {
        this.retryMs = INITIAL_RETRY_MS;
        this.connectFailures = 0;
        this.generation += 1;
        this.info = await client.info();
        this.setState("connected");
        this.log(
          `Upstream connected: letta-code ${this.info.letta_code_version}, ` +
            `backend=${this.info.backend}, protocol=${this.info.protocol_version}`,
        );
        // Re-subscribe to every scope we owned before the drop, so the
        // app-server routes their events back to us.
        await this.resubscribe();
        // Then pick up every scope we've never touched at all — see
        // `subscribeToAllScopes`'s own doc comment for why this exists.
        void this.subscribeToAllScopes();
      })
      .catch((error) => {
        this.logConnectFailure(error, client);
        this.client = null;
        this.setState("disconnected");
        this.scheduleRetry();
      });
  }

  /**
   * One line per failed connect, then a quieter rhythm — an app-server that is
   * still booting is the normal case at container start, not an incident, and it
   * stays normal for as long as it takes.
   *
   * The client's own socket reason is preferred when the rejection has none: under
   * bun the rejection is `App-server WebSocket failed to open: [object
   * ErrorEvent]`, which says nothing an operator can act on.
   */
  private logConnectFailure(error: unknown, client: UpstreamClient): void {
    this.connectFailures += 1;
    if (!shouldLogConnectFailure(this.connectFailures)) return;
    const tally = this.connectFailures === 1 ? "" : ` (×${this.connectFailures})`;
    let message = errorMessage(error);
    if (/\[object \w+\]$/.test(message)) {
      const detail = client.failureDetail?.();
      if (detail) message = message.replace(/\[object \w+\]$/, detail);
    }
    this.log(`Upstream connect failed${tally}: ${message}`);
  }

  /**
   * A `sync` command carrying a runtime scope re-subscribes this connection to
   * that scope (letta-code: listener/message-router.ts subscribes on any scoped
   * command) and replays the listener's in-memory state for it.
   *
   * `resume_interrupted_turn` marks the sync as coming from the conversation's
   * execution owner, which this connection always is — it is the only one the
   * app-server ever sees. After an app-server restart, a turn that died with
   * only replay-unsafe tool calls pending (Bash, MessageChannel) is then
   * continued at once with those calls denied, instead of the denials waiting
   * for a user message that a cron or Telegram conversation may never get
   * (letta-code: listener/recovery-sync.ts, sync-replay.ts). It is a no-op
   * when nothing was interrupted or a turn is live. Browser syncs are not
   * given the flag: they stay observer syncs, as upstream intends.
   */
  private syncAsOwner(
    scope: { agent_id: string; conversation_id: string },
    requestId: string,
  ): Promise<unknown> {
    return this.request({
      type: "sync",
      request_id: requestId,
      runtime: scope,
      recover_approvals: true,
      resume_interrupted_turn: true,
      force_device_status: true,
    });
  }

  /**
   * Owner-sync `scopes`, `SYNC_CONCURRENCY` at a time. A scope whose sync throws
   * is logged and skipped: one conversation that refuses must not stop the rest
   * of the pass, which is what the per-scope try/catch has always meant.
   */
  private async syncScopes(
    scopes: readonly { agent_id: string; conversation_id: string }[],
    idPrefix: string,
    failureWhat: string,
  ): Promise<void> {
    for (let i = 0; i < scopes.length; i += SYNC_CONCURRENCY) {
      await Promise.all(
        scopes.slice(i, i + SYNC_CONCURRENCY).map(async (scope) => {
          try {
            await this.syncAsOwner(
              scope,
              `bff-${idPrefix}-${scope.agent_id}-${scope.conversation_id}-${Date.now()}`,
            );
          } catch (error) {
            this.log(
              `${failureWhat} ${scopeKeyOf(scope.agent_id, scope.conversation_id)}: ${errorMessage(error)}`,
            );
          }
        }),
      );
    }
  }

  private resubscribe(): Promise<void> {
    return this.syncScopes([...this.knownScopes.values()], "resync", "Re-subscribe failed for");
  }

  /**
   * The app-server only routes a scope's frames to connections already
   * subscribed to it (`TO_SUBSCRIBERS`, letta-code:
   * websocket/listener/connection.ts), and subscribing happens only as a
   * side effect of sending a scoped command. This connection only ever sends
   * one because a browser session touched that `{agent_id, conversation_id}`
   * — so a cron-fired or channel-gateway-fired turn on a conversation no
   * browser has ever opened is otherwise invisible here, and push triggers
   * (turn-watcher.ts, approval-watcher.ts) never see it.
   *
   * There is no wildcard "subscribe to everything" command in the protocol
   * (`BROADCAST` exists as a routing constant but is never referenced), so
   * enumeration is the only mechanism available: page through every agent's
   * conversations and `sync` any scope not already in `knownScopes` — the
   * same call `resubscribe()` makes per known scope, just for scopes this
   * connection hasn't seen yet.
   *
   * The sync is deliberately an OWNER sync (`resume_interrupted_turn`), not an
   * observer sync. This is the only path by which a cron- or gateway-fired
   * conversation the browser has never opened gets subscribed at all, so after
   * an app-server restart it is also the only thing that would resume a turn
   * left with replay-unsafe calls pending — and those conversations may never
   * receive a user message to unstick them. Downgrading it to an observer sync
   * here would hang exactly the cases the flag exists for. The burst that
   * creates is bounded by the sweep's scope cap, and each scope is
   * resumed at most once.
   */
  private async subscribeToAllScopes(): Promise<void> {
    if (this.sweepInFlight) {
      this.log("Scope sweep: previous sweep still running, skipping this tick");
      return;
    }
    this.sweepInFlight = true;
    // A sweep that ends early (its very first request failed) leaves the flag
    // down, so the next tick still gets the larger budget rather than spending
    // another ten sweeps catching up from a restart.
    const initial = !this.initialSweepDone;
    try {
      await this.sweepOnce(initial);
      this.initialSweepDone = true;
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async sweepOnce(initial: boolean): Promise<void> {
    const budget = initial ? SCOPE_SWEEP_MAX_NEW_SCOPES_INITIAL : SCOPE_SWEEP_MAX_NEW_SCOPES;
    // Counts ATTEMPTS, not successes: a scope whose sync times out still spent
    // the full timeout against the shared connection, so bounding only the
    // successes would still allow a run of failures to consume the sweep.
    let attempts = 0;
    let agents: { id: string }[];
    try {
      const response = await this.request<AgentListResponseMessage>({
        type: "agent_list",
        request_id: `bff-sweep-agents-${Date.now()}`,
        query: { limit: SCOPE_SWEEP_LIST_LIMIT },
      });
      agents = response.success ? response.agents : [];
      if (agents.length >= SCOPE_SWEEP_LIST_LIMIT) {
        this.log(
          `Scope sweep: the app-server listed ${agents.length} agents, the sweep's page size — ` +
            `only the first ${SCOPE_SWEEP_LIST_LIMIT} are examined`,
        );
      }
    } catch (error) {
      this.log(`Scope sweep: agent_list failed: ${errorMessage(error)}`);
      return;
    }

    // Scanned first, then synced: the cap bounds how many owner syncs one pass
    // starts, and `syncScopes` is what keeps that burst bounded and short.
    const pending: { agent_id: string; conversation_id: string }[] = [];
    scanning: for (const agent of agents) {
      const conversations = await this.listConversationIds(agent.id);
      if (conversations === null) continue;

      for (const conversationId of conversations) {
        const scopeKey = scopeKeyOf(agent.id, conversationId);
        if (this.knownScopes.has(scopeKey)) continue;
        if (attempts >= budget) {
          this.log(
            `Scope sweep: hit the ${budget}-scope cap; ` +
              `the rest will be picked up on the next sweep`,
          );
          break scanning;
        }
        attempts += 1;
        pending.push({ agent_id: agent.id, conversation_id: conversationId });
      }
    }
    await this.syncScopes(pending, "sweep-sync", "Scope sweep: sync failed for");
  }

  /**
   * Every conversation id of one agent, newest first, walked with the list's own
   * `after` cursor up to `SCOPE_SWEEP_MAX_PAGES` pages. Without the walk a
   * conversation older than the first page is never subscribed at all, so a cron
   * writing to it stays invisible to every push trigger.
   *
   * Null when the first page failed (the caller moves on to the next agent);
   * whatever was collected when a later page fails is still returned.
   */
  private async listConversationIds(agentId: string): Promise<string[] | null> {
    const ids: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < SCOPE_SWEEP_MAX_PAGES; page += 1) {
      let conversations: { id: string }[];
      try {
        const response = await this.request<ConversationListResponseMessage>({
          type: "conversation_list",
          request_id: `bff-sweep-conversations-${agentId}-${Date.now()}`,
          query: {
            agent_id: agentId,
            limit: SCOPE_SWEEP_LIST_LIMIT,
            ...(after ? { after } : {}),
          },
        });
        if (!response.success) {
          this.log(`Scope sweep: conversation_list refused for ${agentId}: ${response.error}`);
          break;
        }
        conversations = response.conversations ?? [];
      } catch (error) {
        this.log(`Scope sweep: conversation_list failed for ${agentId}: ${errorMessage(error)}`);
        // A failed first page means nothing is known about this agent; a later
        // page failing still leaves the pages already walked worth syncing.
        return page === 0 ? null : ids;
      }

      for (const conversation of conversations) ids.push(conversation.id);
      if (conversations.length < SCOPE_SWEEP_LIST_LIMIT) break;
      const last = conversations.at(-1);
      // A cursor the backend did not honour would repeat the same page forever.
      if (!last || last.id === after) break;
      after = last.id;
    }
    return ids;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}
