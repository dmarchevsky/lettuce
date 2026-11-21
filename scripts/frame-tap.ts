/**
 * A live turn driver and a raw frame tap for the BFF's browser WebSocket.
 *
 * This exists because proving a wire-shape claim used to mean hand-writing a WS
 * driver every time, and one of those drivers produced **no frames and no
 * error** — a silent hang that ate ~35 minutes before anyone looked at the
 * socket itself. Everything here is designed against that failure:
 *
 * - every frame the socket receives goes through `onFrame` (and into `tap.frames`),
 *   so nothing can arrive unseen;
 * - a request that the BFF refuses (`__bff_error` carrying its `request_id`)
 *   rejects the awaited request instead of hanging;
 * - a turn that never settles throws with the frame types it *did* see, the
 *   conversation it was driving, and how long it waited.
 *
 * The endpoint and handshake are the browser's own (`bff/src/index.ts` `/ws`,
 * `web/src/lib/session-client.ts`): cookie-authenticated upgrade, then
 * `sync`/`runtime_start` to subscribe the session to a scope, then `input` with
 * `payload.kind: "create_message"`. A tap sends `__bff_watching` with
 * `visible: false` so a probe never suppresses the operator's push
 * notifications.
 *
 * Two levels:
 * - `openFrameTap` — connect, sign in, tap every frame for N seconds. No turn.
 * - `driveTurn` — subscribe, prompt, wait for the turn to settle, hand back the
 *   transcript and the terminal frames.
 *
 * Usage from another script:
 *
 * ```ts
 * import { driveTurn } from "./scripts/frame-tap.ts";
 * const turn = await driveTurn({ origin: "http://127.0.0.1:8090", prompt: "reply with exactly: pong" });
 * console.log(turn.terminal.map((f) => f.type), turn.reply);
 * ```
 *
 * Or drive one turn from the command line (reads the password the same way every
 * harness script does — `LETTUCE_TEST_PASSWORD` or the gitignored local file):
 *
 * ```
 * bun scripts/frame-tap.ts [origin] [--prompt "..."] [--agent <id>] [--conversation <id>] [--timeout 300]
 * ```
 */
import { frameScopeKey, scopeKeyOf } from "../bff/src/session/buffer.ts";
import { devSignIn, openDevSocket, requireTestPassword } from "./harness.ts";

/** Default: a local model can spend minutes prefilling before it answers. */
export const DEFAULT_TURN_TIMEOUT_MS = 300_000;
/** Same bound the web client puts on a request (`session-client.ts`). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface FrameTap {
  frames: Record<string, unknown>[];
  /** Every frame received so far, as compact type names — for failure messages. */
  seenTypes(): string;
  /** Send a raw command object upstream through the BFF. */
  send(command: Record<string, unknown> & { type: string }): void;
  /**
   * Send a command carrying a fresh `request_id` and resolve with the response
   * frame that carries it back (the BFF translates its own ids back to ours).
   * Rejects on `__bff_error` for that id, or on timeout naming every frame type
   * seen since it was sent — a refused command must never look like a hang.
   */
  request<T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    body?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs?: number,
    label?: string,
    /** Only frames captured at or after this index count — see below. */
    sinceIndex?: number,
  ): Promise<Record<string, unknown>>;
  close(): void;
}

export interface ConnectFrameTap {
  origin: string;
  /** Session cookie; default is `devSignIn(origin)` — the harness's own sign-in. */
  cookie?: string;
  /** Called for EVERY frame, control frames included, before anything else sees it. */
  onFrame?: (frame: Record<string, unknown>) => void;
  /** Subscribed scope: frames for other conversations are still tapped, but a tap with a scope announces it as not-visible. */
  scope?: { agent_id: string; conversation_id: string } | null;
  /** Reject if the socket has not received `__bff_hello` this long after connect. */
  connectTimeoutMs?: number;
}

let requestCounter = 0;

/**
 * Connect to `/ws` with a session and tap every frame.
 *
 * The tap is the primitive a probe wants when it only wants to listen: it
 * resolves once the socket is live (post-`__bff_hello`), and from then on every
 * frame goes to `onFrame` and into `frames`.
 */
export async function openFrameTap(opts: ConnectFrameTap): Promise<FrameTap> {
  const origin = opts.origin.replace(/\/$/, "");
  const cookie = opts.cookie ?? (await devSignIn(origin));
  const wsUrl = `${origin.replace(/^http/, "ws")}/ws`;
  const socket = openDevSocket(wsUrl, cookie);

  const frames: Record<string, unknown>[] = [];
  type Waiter = {
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
    timer?: ReturnType<typeof setTimeout>;
  };
  const waiters: Waiter[] = [];
  const pending = new Map<
    string,
    { resolve: (f: Record<string, unknown>) => void; reject: (e: Error) => void; sentAt: number }
  >();
  let settled = false;

  const bail = (error: Error) => {
    if (!settled) {
      // Never connected: the connect waiter below turns this into the hello
      // failure, and in-flight requests (there are none yet) would hang.
      for (const [, p] of pending) p.reject(error);
      pending.clear();
      return;
    }
    // Already connected: fail every waiter and every in-flight request, so a
    // close can never leave a probe waiting on a dead socket.
    for (const waiter of waiters.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer);
    }
    for (const [, p] of pending) p.reject(error);
    pending.clear();
  };

  const tap: FrameTap = {
    frames,
    seenTypes: () => frames.map((f) => String(f.type ?? "?")).join(", ") || "(nothing at all)",
    send(command) {
      socket.send(JSON.stringify(command));
    },
    request(type, body = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
      requestCounter += 1;
      const requestId = `tap-${process.pid}-${requestCounter}`;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.has(requestId)) return;
          pending.delete(requestId);
          reject(
            new Error(
              `${type} (${requestId}) was never answered in ${timeoutMs}ms. Frames since it was ` +
                `sent: ${
                  frames
                    .slice(sentIndex)
                    .map((f) => String(f.type ?? "?"))
                    .join(", ") || "(none)"
                }`,
            ),
          );
        }, timeoutMs);
        const sentIndex = frames.length;
        pending.set(requestId, {
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
          sentAt: Date.now(),
        });
        try {
          socket.send(JSON.stringify({ ...body, type, request_id: requestId }));
        } catch (cause) {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
      }) as Promise<any>;
    },
    waitFor(predicate, timeoutMs = 15_000, label = "frame", sinceIndex) {
      // `sinceIndex` is what keeps a settle-wait honest: the frames already
      // captured came *before* the caller acted, so a device-status idle from
      // the runtime start must not be read as the turn ending. Without it the
      // back-search is the convenience (an answer that already landed).
      const existing = sinceIndex === undefined ? frames.find(predicate) : undefined;
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter: Waiter = { predicate, resolve };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for ${label}. Frames ` +
                `${sinceIndex === undefined ? "since open" : `since capture #${sinceIndex}`}: ` +
                `${
                  (sinceIndex === undefined ? frames : frames.slice(sinceIndex))
                    .map((f) => String(f.type ?? "?"))
                    .join(", ") || "(nothing at all)"
                }`,
            ),
          );
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    close() {
      bail(new Error("Frame tap closed"));
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    },
  };

  socket.addEventListener("message", (event: MessageEvent) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    frames.push(frame);
    try {
      opts.onFrame?.(frame);
    } catch {
      /* a probe's callback must not kill the tap */
    }

    if (frame.type === "__bff_error") {
      const requestId = frame.request_id;
      if (typeof requestId === "string" && pending.has(requestId)) {
        const p = pending.get(requestId)!;
        pending.delete(requestId);
        p.reject(new Error(`${requestId}: ${String(frame.message ?? "bff error")}`));
        return;
      }
    }
    const requestId = frame.request_id;
    if (typeof requestId === "string" && pending.has(requestId)) {
      const p = pending.get(requestId)!;
      pending.delete(requestId);
      p.resolve(frame);
      return;
    }

    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i]!;
      if (waiter.predicate(frame)) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiters.splice(i, 1);
        waiter.resolve(frame);
      }
    }
  });
  socket.addEventListener("error", () => bail(new Error(`WebSocket error opening ${wsUrl}`)));
  socket.addEventListener("close", (event: CloseEvent) =>
    bail(
      new Error(
        `WebSocket closed (${event.code} ${event.reason || "no reason"}). Frames: ${tap.seenTypes()}`,
      ),
    ),
  );

  const helloTimeout = opts.connectTimeoutMs ?? 10_000;
  try {
    await tap.waitFor((f) => f.type === "__bff_hello", helloTimeout, "__bff_hello");
  } catch (error) {
    tap.close();
    throw new Error(
      `${wsUrl} never said hello (cookie ${cookie.split("=")[0]}). ${(error as Error).message} — ` +
        "a 4401 close means the session was refused; no frames at all means the BFF is not answering.",
    );
  }
  settled = true;
  // Announce the scope without claiming to be a visible tab: a watched scope
  // suppresses push notifications, and a probe is nobody's foreground tab.
  socket.send(
    JSON.stringify({
      type: "__bff_watching",
      scope: opts.scope ?? null,
      visible: false,
    }),
  );
  return tap;
}

export interface DriveTurnOptions {
  origin: string;
  prompt: string;
  /** Existing agent; default is `agent_list`'s first — the same fallback the UI uses. */
  agentId?: string;
  /** Existing conversation; default is a fresh `conversation_create`. */
  conversationId?: string;
  /** Workspace the runtime starts in; default `/work/<agentId>` like the web client. */
  cwd?: string;
  timeoutMs?: number;
  onFrame?: (frame: Record<string, unknown>) => void;
  /** Leave the tap open after settling and hand it back (a probe keeps listening). */
  keepOpen?: boolean;
}

export interface TurnResult {
  agentId: string;
  conversationId: string;
  frames: Record<string, unknown>[];
  /** Frames that ended the wait: `turn_finished`, or a device status saying idle. */
  terminal: Record<string, unknown>[];
  /** The messages the app-server stores for the conversation when the turn settled. */
  messages: Record<string, unknown>[];
  /** Last assistant text found in `messages` — a convenience, not a parse contract. */
  reply: string | null;
  tap: FrameTap | null;
  waitedMs: number;
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Same rule the web client's `readContentParts` uses: any part carrying text.
    return content
      .map((part) =>
        part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : "",
      )
      .join("");
  }
  return "";
};

/**
 * Wait for the turn the prompt started to end, and say which frame said so.
 *
 * `turn_finished` for this scope is the terminal frame (the push watcher settles
 * on it too). A device-status idle counts only after this window has seen the
 * conversation *working* — the app-server emits an idle status the moment a
 * runtime starts, and reading that as the end is how a driver reports a
 * 1-second "turn" with no reply.
 */
async function settleTurn(
  tap: FrameTap,
  sentIndex: number,
  mine: (frame: Record<string, unknown>) => boolean,
  timeoutMs: number,
  scope: { agent_id: string; conversation_id: string },
): Promise<Record<string, unknown>[]> {
  const sentAt = Date.now();
  const idle = (f: Record<string, unknown>) =>
    f.type === "update_device_status" &&
    (f as { device_status?: { is_processing?: unknown } }).device_status?.is_processing === false;
  try {
    const frame = await tap.waitFor(
      (f) =>
        mine(f) &&
        (f.type === "turn_finished" ||
          (idle(f) &&
            tap.frames
              .slice(sentIndex)
              .some((g) => mine(g) && !idle(g) && g.type === "update_device_status"))),
      timeoutMs,
      "the turn to settle",
      sentIndex,
    );
    return frame.type === "turn_finished"
      ? [frame]
      : [
          // The idle status won the race, but the frame that really ended the
          // turn is the one worth reporting first.
          ...tap.frames.slice(sentIndex).filter((f) => mine(f) && f.type === "turn_finished"),
          frame,
        ];
  } catch (error) {
    const seen = tap.frames.slice(sentIndex).map((f) => String(f.type));
    throw new Error(
      `Turn in ${scope.conversation_id} (agent ${scope.agent_id}) did not settle after ` +
        `${Math.round((Date.now() - sentAt) / 1000)}s. Frames since the prompt: ` +
        `${seen.join(", ") || "(NO FRAMES AT ALL — the prompt never reached a runtime)"}. ` +
        `Original: ${(error as Error).message}`,
    );
  }
}

/**
 * Drive one prompt through the BFF and wait for the turn to settle.
 *
 * Fails loudly: a refused command rejects with the BFF's message, and a turn
 * that never settles throws listing every frame type seen, the scope, and the
 * elapsed time.
 */
export async function driveTurn(opts: DriveTurnOptions): Promise<TurnResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const started = Date.now();
  const tap = await openFrameTap({ origin: opts.origin, onFrame: opts.onFrame });
  try {
    let agentId = opts.agentId;
    if (!agentId) {
      const listed = await tap.request("agent_list", { query: { limit: 100 } });
      const agents = Array.isArray(listed.agents)
        ? (listed.agents as Record<string, unknown>[])
        : [];
      if (listed.success === false || agents.length === 0) {
        throw new Error(
          `agent_list gave no agents to drive: ${JSON.stringify(listed).slice(0, 300)}`,
        );
      }
      agentId = String(agents[0]!.id);
    }

    let conversationId = opts.conversationId;
    if (!conversationId) {
      const created = await tap.request("conversation_create", { body: { agent_id: agentId } });
      const conversation = created.conversation as { id?: string } | undefined;
      if (created.success === false || !conversation?.id) {
        throw new Error(`conversation_create failed: ${JSON.stringify(created).slice(0, 300)}`);
      }
      conversationId = conversation.id;
    }

    const scope = { agent_id: agentId, conversation_id: conversationId };
    const mine = (frame: Record<string, unknown>) =>
      frameScopeKey(frame as never) === scopeKeyOf(agentId!, conversationId!);

    // Subscribe this session to the scope (the frame router only fans out to
    // sessions whose commands carried the scope), then start its runtime.
    await tap.request("sync", { runtime: scope, force_device_status: true });
    await tap.request("runtime_start", {
      ...scope,
      wait_for_replay: true,
      cwd: opts.cwd ?? `/work/${agentId}`,
    });

    const sentIndex = tap.frames.length;
    const sentAt = Date.now();
    tap.send({
      type: "input",
      runtime: scope,
      payload: {
        kind: "create_message",
        messages: [{ role: "user", content: opts.prompt, client_message_id: `tap-${sentAt}` }],
      },
    });

    const terminal = await settleTurn(tap, sentIndex, mine, timeoutMs, scope);

    const listed = await tap.request("conversation_messages_list", {
      conversation_id: conversationId,
      query: { limit: 200 },
    });
    const messages = Array.isArray(listed.messages)
      ? (listed.messages as Record<string, unknown>[])
      : [];
    let reply: string | null = null;
    for (const message of messages) {
      const assistant =
        message.role === "assistant" || message.message_type === "assistant_message";
      if (assistant) {
        const text = textOf(message.content);
        if (text.trim()) reply = text;
      }
    }

    if (!opts.keepOpen) tap.close();
    return {
      agentId,
      conversationId,
      frames: tap.frames,
      terminal,
      messages,
      reply,
      tap: opts.keepOpen ? tap : null,
      waitedMs: Date.now() - started,
    };
  } catch (error) {
    const context = `Frames during the attempt: ${tap.seenTypes()}`;
    tap.close();
    throw new Error(`${error instanceof Error ? error.message : error}\n  ${context}`, {
      cause: error,
    });
  }
}

// ── command line ─────────────────────────────────────────────────────────────
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const i = argv.indexOf(`--${flag}`);
    return i >= 0 ? (argv[i + 1] as string) : undefined;
  };
  // A bare positional origin, `harness.parseArgs` deliberately cannot express
  // alongside `--prompt <text>`: it gives any unknown flag's value away as a
  // positional, so `--timeout 240` would become the origin.
  const taken = new Set(
    ["prompt", "agent", "conversation", "timeout"]
      .map(read)
      .filter((v): v is string => typeof v === "string"),
  );
  const positionalArg = argv.find((a) => !a.startsWith("--") && !taken.has(a));
  const origin = positionalArg ?? "http://127.0.0.1:8090";
  if (process.env.LETTUCE_TEST_PASSWORD === undefined) {
    try {
      requireTestPassword("the frame tap");
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }
  }
  try {
    const result = await driveTurn({
      origin,
      prompt: read("prompt") ?? "reply with exactly: pong",
      agentId: read("agent"),
      conversationId: read("conversation"),
      timeoutMs: read("timeout") ? Number(read("timeout")) * 1000 : undefined,
      onFrame: (frame) => console.log(`  frame  ${String(frame.type ?? "?")}`),
    });
    console.log(
      `\nturn settled in ${(result.waitedMs / 1000).toFixed(1)}s — ` +
        `agent ${result.agentId}, conversation ${result.conversationId}`,
    );
    console.log(`terminal: ${result.terminal.map((f) => JSON.stringify(f.type)).join(", ")}`);
    console.log(
      `frame types: ${[...new Set(result.frames.map((f) => String(f.type)))].join(", ")}`,
    );
    console.log(`reply: ${JSON.stringify(result.reply)}`);
  } catch (error) {
    console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
