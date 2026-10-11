import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import type { AppServerInfoResponseMessage } from "@letta-ai/letta-code/app-server-client";
import type {
  GetTreeResponseMessage,
  WsProtocolMessage,
} from "@letta-ai/letta-code/app-server-protocol";
import { errorMessage } from "../errors.ts";
import type { UpstreamConnection, UpstreamState } from "../upstream/connection.ts";
import { type ActiveScope, ActivityTracker } from "./activity.ts";
import { FrameBuffer, frameScopeKey, scopeKeyOf } from "./buffer.ts";
import { withModifiedTimes } from "./file-stat.ts";
import {
  ALLOWED_SESSION_COMMANDS,
  type BffServerMessage,
  executeCommandViolation,
  FILE_PATH_FIELDS,
  isBffResumeCommand,
  isBffWatchingCommand,
  SEQ_FIELD,
  WORKSPACE_ROOT,
  withWebClientPreferences,
  workspaceViolation,
} from "./protocol.ts";
import { type Lstat, symlinkViolation } from "./symlink-guard.ts";

export interface SessionSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SessionUser {
  email: string;
}

interface Session {
  id: string;
  user: SessionUser;
  socket: SessionSocket;
  /** Scopes this session cares about; empty means "everything". */
  scopes: Set<string>;
  /**
   * BFF request ids this session is awaiting, mapped to its own original id.
   * `path` is remembered only for `get_tree` requests, so the response
   * handler can resolve entries' absolute paths for a modified/size stat.
   */
  pendingRequests: Map<string, { originalId: string; path?: string }>;
  /**
   * What this session has on screen — the only input to push suppression.
   * Deliberately separate from `scopes` above: that set drives replay and frame
   * fan-out, only ever grows, and treats "none declared yet" as everything,
   * none of which answers "is somebody looking at this right now".
   */
  watching: { scopeKey: string | null; visible: boolean };
  /** Sliding-window timestamps for rate limiting. */
  recentCommands: number[];
  /** Set once the session is throttled, so we complain only once. */
  throttled: boolean;
}

/**
 * A client-side render loop once sent ~88,000 commands and drove the
 * app-server to a 2GB heap and a fatal OOM, twice. The app-server applies no
 * backpressure of its own, so the BFF enforces it: a misbehaving browser
 * should degrade itself, never the agent runtime.
 */
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_COMMANDS = 120;

/**
 * Ceiling on the requests one browser session may have in flight.
 *
 * A pending entry is removed when its answer arrives, and upstream does not
 * always answer — the file commands with a malformed field get no response at
 * all — so without a ceiling a desktop tab open for a week keeps one entry per
 * hung request forever. Dropping the oldest only costs a late answer the id
 * translation it would have needed, which is what an orphaned answer is anyway.
 */
const MAX_PENDING_PER_SESSION = 500;

/**
 * Routes frames between many short-lived browser sessions and the one permanent
 * upstream connection.
 *
 * Browser sockets come and go constantly (tab switches, phone sleep, network
 * changes). None of that reaches the app-server: a session closing unregisters
 * it here and nothing else happens. See CLAUDE.md for why that matters.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly buffer: FrameBuffer;
  private readonly activity = new ActivityTracker();
  /**
   * Mod-contributed `execute_command` ids the app-server has advertised, learned
   * from `update_device_status.mod_commands`.
   *
   * The app-server's default case routes an unknown id to a mod lookup, so a
   * mod command is real only if the server said it exists. Tracking what was
   * advertised keeps the BFF boundary and the composer palette in step: the
   * browser can run exactly the mod commands it was shown, and nothing else.
   * Cleared when the upstream drops, so a stale list can never outlive the
   * runtime that advertised it; the reconnect forces a fresh device status.
   */
  private readonly advertisedMods = new Set<string>();
  private requestCounter = 0;

  constructor(
    private readonly upstream: UpstreamConnection,
    frameBufferSize: number,
    private readonly log: (message: string) => void,
    /** Where the workspace is mounted in this process; see `symlink-guard.ts`. */
    private readonly workspaceMount: string = WORKSPACE_ROOT,
    /** Injectable so the guard is testable without a real symlinked tree. */
    private readonly lstat: Lstat = lstatSync,
  ) {
    this.buffer = new FrameBuffer(frameBufferSize);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Whether somebody is looking at this conversation right now: a *visible*
   * session with it on screen. Anything less — a hidden tab, a tab on another
   * conversation, a tab that has not reported yet — does not suppress a push.
   *
   * This used to ask whether any session was merely *subscribed*, which a
   * backgrounded desktop tab stays for hours because it never drops its
   * WebSocket. One open tab therefore suppressed every push, on every device.
   */
  isScopeWatched(scopeKey: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.watching.visible && session.watching.scopeKey === scopeKey) return true;
    }
    return false;
  }

  get latestSeq(): number {
    return this.buffer.latestSeq;
  }

  add(socket: SessionSocket, user: SessionUser): string {
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      user,
      socket,
      scopes: new Set(),
      // Nothing on screen until the client says otherwise, so a session that
      // never reports suppresses nothing.
      watching: { scopeKey: null, visible: true },
      pendingRequests: new Map(),
      recentCommands: [],
      throttled: false,
    });
    this.log(`Session ${id} opened for ${user.email} (${this.sessions.size} active)`);

    this.sendTo(socket, {
      type: "__bff_hello",
      session_id: id,
      user,
      upstream: this.upstream.getState(),
      app_server_info: this.upstream.getInfo(),
      latest_seq: this.buffer.latestSeq,
      active: this.activity.snapshot(),
    });
    return id;
  }

  /**
   * Drop a browser session. Deliberately does NOT touch the upstream
   * connection: in-flight turns, queued messages and pending approvals all
   * belong to the BFF's connection and must survive.
   */
  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.log(`Session ${sessionId} closed (${this.sessions.size} active)`);
  }

  /** Conversations with a turn in progress, across the whole app-server. */
  activeScopes(): ActiveScope[] {
    return this.activity.snapshot();
  }

  /** Handle one raw text message from a browser session. */
  handleSessionMessage(sessionId: string, raw: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendTo(session.socket, { type: "__bff_error", message: "Malformed JSON" });
      return;
    }

    if (isBffResumeCommand(parsed)) {
      void this.handleResume(session, parsed.from_seq, parsed.scopes);
      return;
    }

    if (isBffWatchingCommand(parsed)) {
      session.watching = {
        scopeKey: parsed.scope
          ? scopeKeyOf(parsed.scope.agent_id, parsed.scope.conversation_id)
          : null,
        visible: parsed.visible,
      };
      return;
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      this.sendTo(session.socket, { type: "__bff_error", message: "Missing command type" });
      return;
    }

    const command = parsed as Record<string, unknown> & { type: string; request_id?: unknown };

    if (this.isRateLimited(session)) {
      this.sendTo(session.socket, {
        type: "__bff_error",
        message: `Rate limit exceeded: more than ${RATE_LIMIT_MAX_COMMANDS} commands in ${
          RATE_LIMIT_WINDOW_MS / 1000
        }s. Slow down and retry.`,
        ...(typeof command.request_id === "string" ? { request_id: command.request_id } : {}),
      });
      return;
    }

    if (!ALLOWED_SESSION_COMMANDS.has(command.type)) {
      this.sendTo(session.socket, {
        type: "__bff_error",
        message: `Command "${command.type}" is not permitted from a browser session`,
        ...(typeof command.request_id === "string" ? { request_id: command.request_id } : {}),
      });
      return;
    }

    if (command.type === "execute_command") {
      const violation = executeCommandViolation(command.command_id, this.advertisedMods);
      if (violation) {
        this.sendTo(session.socket, {
          type: "__bff_error",
          message: violation,
          ...(typeof command.request_id === "string" ? { request_id: command.request_id } : {}),
        });
        return;
      }
    }

    // The app-server imposes no root on file operations, so the workspace
    // boundary is enforced here or nowhere.
    const violation = workspaceViolation(command);
    if (violation) {
      this.sendTo(session.socket, {
        type: "__bff_error",
        message: violation,
        ...(typeof command.request_id === "string" ? { request_id: command.request_id } : {}),
      });
      return;
    }

    // Lexical containment is not enough: a symlink inside /work resolves
    // outside it while looking perfectly ordinary to the check above, and the
    // app-server follows links without resolving them.
    const symlink = this.symlinkEscapeFor(command);
    if (symlink) {
      this.sendTo(session.socket, {
        type: "__bff_error",
        message: symlink,
        ...(typeof command.request_id === "string" ? { request_id: command.request_id } : {}),
      });
      return;
    }

    if (!this.upstream.isReady()) {
      this.sendTo(session.socket, {
        type: "__bff_error",
        message: "App-server is not connected",
        ...(typeof command.request_id === "string" ? { request_id: command.request_id } : {}),
      });
      return;
    }

    // Track the scope so replays can be narrowed to what this session shows.
    const scopeKey = frameScopeKey(command as unknown as WsProtocolMessage);
    if (scopeKey) session.scopes.add(scopeKey);

    // Opt the conversation into the async AskUserQuestion tool before anything
    // else touches the frame (see `withWebClientPreferences`).
    const outbound: Record<string, unknown> = withWebClientPreferences({ ...command });
    if (typeof command.request_id === "string") {
      this.requestCounter += 1;
      const bffRequestId = `bff-${session.id.slice(0, 8)}-${this.requestCounter}`;
      session.pendingRequests.set(bffRequestId, {
        originalId: command.request_id,
        ...(command.type === "get_tree" && typeof command.path === "string"
          ? { path: command.path }
          : {}),
      });
      while (session.pendingRequests.size > MAX_PENDING_PER_SESSION) {
        const oldest = session.pendingRequests.keys().next();
        if (oldest.done) break;
        session.pendingRequests.delete(oldest.value);
      }
      outbound.request_id = bffRequestId;
    }

    try {
      this.upstream.send(outbound as Record<string, unknown> & { type: string });
    } catch (error) {
      this.sendTo(session.socket, {
        type: "__bff_error",
        message: errorMessage(error),
        ...(typeof command.request_id === "string" ? { request_id: command.request_id } : {}),
      });
    }
  }

  /**
   * The symlink refusal for a path-bearing command, or null.
   *
   * Only runs for paths already known to be under the workspace root — a path
   * outside it was refused above. `workspaceMount` is where the BFF's read-only
   * bind of the same host directory is mounted; it defaults to the workspace
   * root itself, which is correct in the container.
   */
  private symlinkEscapeFor(command: Record<string, unknown> & { type: string }): string | null {
    const field = FILE_PATH_FIELDS.get(command.type);
    if (!field) return null;
    const raw = command[field];
    if (typeof raw !== "string" || raw === "") return null;
    if (raw !== WORKSPACE_ROOT && !raw.startsWith(`${WORKSPACE_ROOT}/`)) return null;
    return symlinkViolation(raw, this.workspaceMount, this.lstat);
  }

  /** Handle one frame arriving from the app-server. */
  handleUpstreamFrame(frame: WsProtocolMessage): void {
    if (this.activity.observe(frame)) this.broadcastActivity();
    this.rememberAdvertisedMods(frame);

    const requestId = (frame as { request_id?: unknown }).request_id;

    // A correlated response belongs to exactly one session.
    if (typeof requestId === "string") {
      for (const session of this.sessions.values()) {
        const pending = session.pendingRequests.get(requestId);
        if (pending === undefined) continue;
        session.pendingRequests.delete(requestId);

        const relayed =
          pending.path !== undefined && frame.type === "get_tree_response"
            ? withGetTreeModifiedTimes(frame, pending.path)
            : frame;

        this.sendTo(session.socket, {
          ...relayed,
          request_id: pending.originalId,
        } as unknown as BffServerMessage);
        return;
      }
      // Not a session's response. If we issued the request ourselves, the
      // response is BFF-internal and must stop here: it is not broadcast-worthy,
      // and buffering it would replay whole file contents (a `read_file`
      // response) to sessions that never asked. See
      // `UpstreamConnection.isInternalRequest`.
      if (this.upstream.isInternalRequest(requestId)) return;

      // Otherwise the session that asked has gone away. Fall through: some
      // frames carry a request_id and are still broadcast-worthy, and an
      // orphaned response is harmless to buffer.
    }

    // Unsolicited frame: sequence it, buffer it for resume, fan it out.
    const scopeKey = frameScopeKey(frame);
    const buffered = this.buffer.append(frame, scopeKey);
    const payload = { ...frame, [SEQ_FIELD]: buffered.seq };

    for (const session of this.sessions.values()) {
      if (scopeKey && session.scopes.size > 0 && !session.scopes.has(scopeKey)) {
        continue;
      }
      this.sendTo(session.socket, payload as unknown as BffServerMessage);
    }
  }

  /**
   * Fold the mod command list out of a device-status frame into the allowlist
   * input. Only string `id`s count; a malformed payload advertises nothing.
   */
  private rememberAdvertisedMods(frame: WsProtocolMessage): void {
    if (frame.type !== "update_device_status") return;
    const mods = (frame as { device_status?: { mod_commands?: unknown } }).device_status
      ?.mod_commands;
    if (!Array.isArray(mods)) return;
    for (const raw of mods) {
      if (!raw || typeof raw !== "object") continue;
      const id = (raw as { id?: unknown }).id;
      if (typeof id === "string" && id) this.advertisedMods.add(id);
    }
  }

  /** Every session gets the whole set, whatever conversation it has open. */
  private broadcastActivity(): void {
    const message = { type: "__bff_activity" as const, active: this.activity.snapshot() };
    for (const session of this.sessions.values()) this.sendTo(session.socket, message);
  }

  broadcastUpstreamState(state: UpstreamState, info: AppServerInfoResponseMessage | null): void {
    // With the upstream gone nothing is known to be running; the reconnect's
    // forced device-status replay rebuilds the set.
    if (state !== "connected") this.advertisedMods.clear();
    if (state !== "connected" && this.activity.clear()) this.broadcastActivity();
    for (const session of this.sessions.values()) {
      this.sendTo(session.socket, {
        type: "__bff_upstream_state",
        state,
        app_server_info: info,
      });
    }
  }

  private async handleResume(
    session: Session,
    fromSeq: number | null,
    scopes: { agent_id: string; conversation_id: string }[] | undefined,
  ): Promise<void> {
    if (scopes) {
      session.scopes = new Set(scopes.map((s) => scopeKeyOf(s.agent_id, s.conversation_id)));
    }

    const scopeKeys = session.scopes.size > 0 ? session.scopes : undefined;
    const result = this.buffer.replayFrom(fromSeq, scopeKeys);

    this.sendTo(session.socket, {
      type: "__bff_resume_result",
      from_seq: fromSeq,
      latest_seq: result.latestSeq,
      replayed: result.frames.length,
      resync_required: result.resyncRequired,
    });

    // Yield to the event loop between frames. Without this the whole replay is
    // one synchronous run of JSON.stringify calls, during which no other
    // session gets serviced — a long replay would freeze everyone else for its
    // duration. `setImmediate` keeps the replay ordered while letting queued
    // I/O for other sessions interleave.
    for (const entry of result.frames) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      // The replay now yields, so the session may have gone away mid-way. Its
      // socket is dead and continuing would only churn; the next reconnect
      // replays from wherever the client actually got to.
      if (!this.sessions.has(session.id)) return;
      this.sendTo(session.socket, {
        ...entry.frame,
        [SEQ_FIELD]: entry.seq,
      } as unknown as BffServerMessage);
    }

    if (result.frames.length > 0 || result.resyncRequired) {
      this.log(
        `Session ${session.id} resumed from ${fromSeq}: ` +
          `${result.frames.length} frames replayed` +
          (result.resyncRequired ? ", resync required" : ""),
      );
    }
  }

  /** Sliding window over one session's recent commands. */
  private isRateLimited(session: Session): boolean {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    while (session.recentCommands.length > 0 && session.recentCommands[0]! < cutoff) {
      session.recentCommands.shift();
    }

    if (session.recentCommands.length >= RATE_LIMIT_MAX_COMMANDS) {
      if (!session.throttled) {
        session.throttled = true;
        this.log(
          `Session ${session.id} throttled: ${session.recentCommands.length} commands in ` +
            `${RATE_LIMIT_WINDOW_MS / 1000}s (likely a client render loop)`,
        );
      }
      return true;
    }

    session.recentCommands.push(now);
    session.throttled = false;
    return false;
  }

  private sendTo(socket: SessionSocket, message: BffServerMessage | Record<string, unknown>): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A dead browser socket is routine (backgrounded tab). The close handler
      // unregisters it; nothing upstream is affected.
    }
  }
}

/** Merge real mtimes and sizes into a `get_tree_response`'s entries; see `file-stat.ts`. */
function withGetTreeModifiedTimes(
  frame: GetTreeResponseMessage,
  root: string,
): GetTreeResponseMessage {
  if (!frame.entries) return frame;
  return { ...frame, entries: withModifiedTimes(root, frame.entries) };
}
