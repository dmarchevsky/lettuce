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
import { isLoopbackHostname } from "../auth/origin.ts";
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
  /**
   * Capability token for the app-server's `--ws-auth`, sent as
   * `Authorization: Bearer <token>` on the upgrade. `null`/`undefined` means the
   * unauthenticated loopback default (see `createAppServerClient`).
   */
  authToken?: string | null;
  onFrame: (frame: WsProtocolMessage) => void;
  onStateChange: (state: UpstreamState, info: AppServerInfoResponseMessage | null) => void;
  log?: (message: string) => void;
  /** Builds the client. Tests inject a fake one; production gets the real one. */
  createClient?: (url: string, options?: UpstreamClientOptions) => UpstreamClient;
  /**
   * Overrides the pacing of owner syncs and the ceiling on one of them. Only
   * tests need it: the defaults are tuned to a real app-server's freeze, and a
   * test asserting a 500 ms gap would just be a slow test.
   */
  syncPacing?: { pacingMs?: number; ownerSyncTimeoutMs?: number; passBudgetMs?: number };
  /** How often the periodic sweep runs. Tests shorten it to exercise the
   * overlap guard without waiting five minutes; production leaves it alone. */
  sweepIntervalMs?: number;
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

/** The real client. `authToken` is the app-server's `--ws-auth` capability token,
 * handed to upstream's client, which turns it into an `Authorization: Bearer`
 * header on the upgrade and **throws on a blank string** — so "unset" arrives here
 * as `undefined`, never `""`.
 *
 * It is `undefined` in the container, deliberately: the BFF joins the app-server's
 * network namespace and reaches it on loopback with no `--ws-auth`, because
 * `letta channel-gateway` cannot send a token and would be locked out; nothing
 * outside that namespace can reach it (docker/compose.yml). An unauthenticated
 * upgrade carrying `Origin` is rejected outright, which `ws` never sends unasked —
 * and which is why a browser cannot connect directly.
 *
 * A token is what lets the BFF point at an app-server on **another host**, and it
 * only fixes this one socket: everything that calls back into the BFF still calls
 * its loopback (`internal-tools/`), so web search, the Google tools, the MCP
 * bridge and the coding workers stay absent. `remoteAppServerNotice` says that out
 * loud at boot, and `docs/CONFIGURATION.md` ("Remote app-server") spells it out.
 *
 * Named options, not positionals: the old `(url, webSocket)` shape already had one
 * second argument, and a token swapped places with it silently — an upstream build
 * then crashes in `appServerSocketOptions` on whatever landed there. `webSocket`
 * is the seam that lets a test prove the tolerance is attached without a real
 * socket; production never passes it.
 */
export interface UpstreamClientOptions {
  authToken?: string | null;
  WebSocket?: AppServerSocketConstructor;
}

export function createAppServerClient(
  url: string,
  options: UpstreamClientOptions = {},
): UpstreamClient {
  const client = new AppServerClient({
    url,
    WebSocket: options.WebSocket ?? (WebSocket as unknown as AppServerSocketConstructor),
    ...(options.authToken ? { authToken: options.authToken } : {}),
  });
  // Constructed before anything awaits: the handshake cannot fail before this
  // listener exists, because no event is delivered while this frame is on the stack.
  return new HandshakeTolerantClient(client);
}

/**
 * The boot warning for a remote app-server, or `null` when there is nothing to say.
 *
 * It fires on the shape that loses features **silently**: an app-server on another
 * host with no capability token, where the handshake is simply refused and every
 * callback the mods make into the BFF lands on the wrong loopback. A token fixes
 * only the first half, so the message names both — an operator who reads "set a
 * token" and stops there would still find web search missing and no explanation.
 *
 * A non-loopback host with a token gets no line on purpose: on a trusted LAN an
 * unauthenticated-but-private app-server is a legitimate choice, and a warning that
 * cries there too is a warning people learn to ignore.
 */
export function remoteAppServerNotice(
  url: string,
  authToken: string | null | undefined,
): string | null {
  if (authToken) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // Not a URL we can judge; the connect attempt itself will report the problem.
    return null;
  }
  if (isLoopbackHostname(host)) return null;
  return (
    `app-server at ${url} is not on loopback and no token is set: ` +
    `if it was started with --ws-auth the WebSocket is refused — set ` +
    `LETTA_APP_SERVER_TOKEN to its capability token. Note that a token fixes only ` +
    `this connection: the agent tools that call back into the BFF (web search, page ` +
    `reading, Google, the MCP bridge, the Codex/Claude worker policy) reach it on ` +
    `loopback only, and the search/Google sidecars, the agent workspaces and the ` +
    `coding-worker CLIs live in this stack — a remote app-server has none of them. ` +
    `See docs/CONFIGURATION.md ("Remote app-server").`
  );
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
 *
 * Paced — see `SWEEP_SYNC_CONCURRENCY` — a sweep of the whole budget runs long,
 * N × (sync + gap), which on prod's disk is about half an hour for 500 scopes
 * and so overruns `SCOPE_SWEEP_INTERVAL_MS` by a wide margin. That is deliberate
 * and bounded: `sweepInFlight` makes the overlapping ticks no-ops rather than a
 * second pass over the same lists, the cap still bounds how much one pass
 * starts, and everything left over is picked up by the next tick. It is also no
 * worse than what it replaces — the app-server serialized those syncs either
 * way, and one that timed out was still being worked through, resume flag and
 * all. What a slow first sweep does cost is that a conversation created during
 * it waits for the next tick to be subscribed, and `SYNC_PASS_BUDGET_MS` is what
 * stops a server that answers nothing from holding the flag indefinitely.
 */
const SCOPE_SWEEP_MAX_NEW_SCOPES = 50;
const SCOPE_SWEEP_MAX_NEW_SCOPES_INITIAL = 500;
/**
 * How long to wait between owner `sync` commands.
 *
 * Owner syncs are paced rather than batched because the app-server **blocks**
 * while answering one: a `sync` replays its scope's state and takes about 3.5 s
 * there, nearly all of it in synchronous `fsync` calls on the main thread
 * (`durable-file-lock.ts`; upstream letta-ai/letta-code#5623), and while it runs
 * the app-server answers nothing else on **any** connection. Concurrency buys
 * nothing against a serial, blocking server — eight syncs at a time is the same
 * 8 × 3.5 s of freeze, but past the request timeout, so the BFF abandons syncs
 * the app-server is still working through, a backlog grows on the one connection
 * every browser shares, and every unrelated request queues behind it. One at a
 * time with a gap between them keeps that freeze to one sync at a time and leaves
 * the event loop free to answer what arrives in between.
 */
export const SWEEP_SYNC_CONCURRENCY = 1;
/** A reconnect must re-subscribe everything it knew before the next sweep starts,
 * so it gets two in flight where the steady-state sweep takes one. */
export const RESYNC_CONCURRENCY = 2;
/** Breathing room between syncs, during which the app-server is free to answer
 * anything else that was waiting. */
export const SYNC_PACING_MS = 500;
/**
 * Ceiling on one owner sync, generously above what one takes. The 30 s default
 * in `request()` is what made a restart sweep look broken: the app-server was
 * slow, not stuck, and every abandoned sync was still subscribed the scope and
 * still being worked through when the timeout fired.
 */
export const OWNER_SYNC_TIMEOUT_MS = 120_000;
/**
 * Ceiling on one pass, so a server that holds the socket open but answers
 * nothing cannot hold `sweepInFlight` — and so the next sweep — hostage for
 * 500 timeouts' worth of hours. Whatever the budget cut off is retried on the
 * next tick, which is the point of the cap rather than a reason to wait it out.
 */
const SYNC_PASS_BUDGET_MS = 10 * 60 * 1000;
/**
 * How many failures of one pass get their reason spelled out. A whole sweep
 * failing — the usual case on a slow disk — used to print one line per scope and
 * buried everything else in the log; the tally below says how often, these say
 * why.
 */
const SYNC_PASS_FAILURE_DETAIL = 3;
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
      }, this.options.sweepIntervalMs ?? SCOPE_SWEEP_INTERVAL_MS);
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
      client = (this.options.createClient ?? createAppServerClient)(this.options.url, {
        authToken: this.options.authToken ?? undefined,
      });
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
  private async syncAsOwner(
    scope: { agent_id: string; conversation_id: string },
    requestId: string,
  ): Promise<void> {
    const response = (await this.request(
      {
        type: "sync",
        request_id: requestId,
        runtime: scope,
        recover_approvals: true,
        resume_interrupted_turn: true,
        force_device_status: true,
      },
      this.options.syncPacing?.ownerSyncTimeoutMs ?? OWNER_SYNC_TIMEOUT_MS,
    )) as { success?: unknown; error?: unknown };
    // The client resolves anything carrying the request id, refused included
    // (letta-code: listener/message-router.ts answers a sync it will not run
    // with `{success: false, error}`), so a refusal is only a failure if this
    // caller says so. Without this a pass reports a scope it never subscribed as
    // synced, which is exactly the line an operator reads after a restart.
    if (response && response.success === false) {
      const why = typeof response.error === "string" ? response.error : "refused";
      throw new Error(`sync refused: ${why}`);
    }
  }

  /**
   * The two owner-sync passes, named so a log line says which one it is about.
   * `sweep` subscribes scopes this connection has never seen; `resync` re-subscribes
   * the ones it knew, after a reconnect, and always runs before the sweep that
   * follows the connect.
   */
  private syncPass(idPrefix: "resync" | "sweep-sync", what: string, concurrency: number) {
    return { idPrefix, what, concurrency };
  }

  /**
   * Owner-sync `scopes`, `concurrency` at a time, each started
   * `syncPacingMs` after the previous one finishes. A scope whose sync fails is
   * logged as it happens and skipped: one conversation that refuses must not stop
   * the rest of the pass, which is what the per-scope try/catch has always meant.
   *
   * A shared cursor and `concurrency` workers, not batches: batches wait for the
   * slowest of each batch, which with one sync in flight is the same as serial
   * but with a worse failure story. Each worker rests for the pacing gap after
   * every sync it finishes, so the gap is between sync *completions* and the
   * app-server gets its share of the event loop whatever the concurrency is.
   *
   * Two ways a pass stops early, both of which keep `sweepInFlight` from being
   * held for hours over a pass that is going nowhere: the connection dropped (the
   * reconnect re-subscribes what matters, and the remaining scopes were never
   * even sent), or the wall-clock budget ran out (a server that accepts the
   * socket but never answers would otherwise take 500 × the timeout to say so).
   * Whatever was not attempted is left for the next tick — a scope is only
   * remembered as seen when its sync was actually sent.
   */
  private async syncScopes(
    scopes: readonly { agent_id: string; conversation_id: string }[],
    pass: { idPrefix: string; what: string; concurrency: number },
  ): Promise<void> {
    if (!scopes.length) return;
    const started = Date.now();
    const budgetMs = this.options.syncPacing?.passBudgetMs ?? SYNC_PASS_BUDGET_MS;
    const pacingMs = this.options.syncPacing?.pacingMs ?? SYNC_PACING_MS;
    let next = 0;
    let synced = 0;
    let failed = 0;
    let stopped: string | null = null;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stopped) return;
        if (!this.isReady()) {
          stopped = "connection lost";
          return;
        }
        if (Date.now() - started > budgetMs) {
          stopped = "out of time budget";
          return;
        }
        const i = next++;
        if (i >= scopes.length) return;
        const scope = scopes[i] as { agent_id: string; conversation_id: string };
        const scopeKey = scopeKeyOf(scope.agent_id, scope.conversation_id);
        try {
          await this.syncAsOwner(
            scope,
            `bff-${pass.idPrefix}-${scope.agent_id}-${scope.conversation_id}-${Date.now()}`,
          );
          synced += 1;
        } catch (error) {
          failed += 1;
          // Spoken when it happens, not at the end: a pass against a server that
          // answers nothing takes the whole timeout per scope, and a summary that
          // only arrives hours later says nothing to anyone watching the log.
          if (failed <= SYNC_PASS_FAILURE_DETAIL) {
            this.log(`${pass.what} failed for ${scopeKey}: ${errorMessage(error)}`);
          }
        }
        if (pacingMs && next < scopes.length) {
          await new Promise((resolve) => setTimeout(resolve, pacingMs));
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(Math.max(pass.concurrency, 1), scopes.length) }, () =>
        worker(),
      ),
    );
    const notAttempted = scopes.length - synced - failed;
    const parts = [`${synced} synced`, `${failed} failed`];
    if (notAttempted > 0) parts.push(`${notAttempted} not attempted`);
    parts.push(`${Math.round((Date.now() - started) / 1000)} s`);
    if (stopped) parts.push(stopped);
    this.log(`${pass.what}: ${parts.join(", ")}`);
  }

  private resubscribe(): Promise<void> {
    return this.syncScopes(
      [...this.knownScopes.values()],
      this.syncPass("resync", "Re-subscribe", RESYNC_CONCURRENCY),
    );
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
    // starts, and `syncScopes` is what spaces them out so the pass does not
    // monopolise the app-server.
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
    await this.syncScopes(
      pending,
      this.syncPass("sweep-sync", "Scope sweep", SWEEP_SYNC_CONCURRENCY),
    );
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
