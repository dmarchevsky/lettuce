import { describe, expect, test } from "bun:test";
import type { UpstreamConnection } from "../upstream/connection.ts";
import { type RegistryOptions, SessionRegistry, type SessionSocket } from "./registry.ts";

/**
 * `isScopeWatched` decides whether a push is sent or silently dropped, so these
 * pin down the one thing that must be true: only a *visible* session with the
 * conversation on screen suppresses a notification.
 *
 * It used to ask whether any session was merely subscribed. A backgrounded
 * desktop tab keeps its WebSocket open for hours, so one open tab suppressed
 * every push on every device — the bug these exist to keep fixed.
 */
const fakeUpstream = {
  getState: () => "connected",
  getInfo: () => null,
  isReady: () => true,
  send: () => {},
  isInternalRequest: () => false,
} as unknown as UpstreamConnection;

function setup() {
  const registry = new SessionRegistry(fakeUpstream, 100, () => {});
  const socket: SessionSocket = { send: () => {}, close: () => {} };
  const open = () => registry.add(socket, { email: "someone@example.com" });
  const watch = (id: string, visible: boolean, scope: { a: string; c: string } | null) =>
    registry.handleSessionMessage(
      id,
      JSON.stringify({
        type: "__bff_watching",
        visible,
        scope: scope ? { agent_id: scope.a, conversation_id: scope.c } : null,
      }),
    );
  return { registry, open, watch };
}

const SCOPE = "agent-1::conv-1";
const here = { a: "agent-1", c: "conv-1" };
const elsewhere = { a: "agent-1", c: "conv-2" };

describe("isScopeWatched", () => {
  test("a visible session with the conversation on screen is watching", () => {
    const { registry, open, watch } = setup();
    watch(open(), true, here);
    expect(registry.isScopeWatched(SCOPE)).toBe(true);
  });

  test("a hidden tab is not watching, even though its socket is still open", () => {
    const { registry, open, watch } = setup();
    watch(open(), false, here);
    expect(registry.isScopeWatched(SCOPE)).toBe(false);
  });

  test("a visible session on another conversation is not watching this one", () => {
    const { registry, open, watch } = setup();
    watch(open(), true, elsewhere);
    expect(registry.isScopeWatched(SCOPE)).toBe(false);
  });

  test("a session that never reported watches nothing", () => {
    const { registry, open } = setup();
    open();
    expect(registry.isScopeWatched(SCOPE)).toBe(false);
  });

  test("one visible session is enough, among hidden ones", () => {
    const { registry, open, watch } = setup();
    watch(open(), false, here);
    watch(open(), true, here);
    expect(registry.isScopeWatched(SCOPE)).toBe(true);
  });

  test("issuing scoped commands does not by itself count as watching", () => {
    // `session.scopes` still grows for replay and fan-out; push suppression
    // deliberately no longer rides on it.
    const { registry, open } = setup();
    const id = open();
    registry.handleSessionMessage(
      id,
      JSON.stringify({
        type: "conversation_messages_list",
        runtime: { agent_id: here.a, conversation_id: here.c },
      }),
    );
    expect(registry.isScopeWatched(SCOPE)).toBe(false);
  });

  test("a closed session stops watching", () => {
    const { registry, open, watch } = setup();
    const id = open();
    watch(id, true, here);
    registry.remove(id);
    expect(registry.isScopeWatched(SCOPE)).toBe(false);
  });
});

/**
 * Activity must reach every session, not only those subscribed to the busy
 * conversation — the whole point is to show turns running elsewhere.
 */
describe("activity broadcast", () => {
  function recordingSocket() {
    const sent: { type: string; active?: unknown }[] = [];
    const socket: SessionSocket = { send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
    return { socket, sent };
  }
  const busy = {
    type: "update_device_status",
    runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
    device_status: { is_processing: true },
  } as never;
  const active = [{ agent_id: "agent-1", conversation_id: "conv-1" }];

  test("a session subscribed elsewhere still hears about it, and late joiners get it in hello", () => {
    const registry = new SessionRegistry(fakeUpstream, 100, () => {});
    const early = recordingSocket();
    const id = registry.add(early.socket, { email: "someone@example.com" });
    registry.handleSessionMessage(
      id,
      JSON.stringify({
        type: "__bff_resume",
        from_seq: null,
        scopes: [{ agent_id: "agent-1", conversation_id: "conv-2" }],
      }),
    );

    registry.handleUpstreamFrame(busy);
    expect(early.sent.filter((m) => m.type === "__bff_activity").map((m) => m.active)).toEqual([
      active,
    ]);

    const late = recordingSocket();
    registry.add(late.socket, { email: "someone@example.com" });
    expect(late.sent.find((m) => m.type === "__bff_hello")?.active).toEqual(active);
  });

  test("an upstream drop clears the set", () => {
    const registry = new SessionRegistry(fakeUpstream, 100, () => {});
    const tab = recordingSocket();
    registry.add(tab.socket, { email: "someone@example.com" });
    registry.handleUpstreamFrame(busy);
    registry.broadcastUpstreamState("disconnected", null);
    expect(tab.sent.filter((m) => m.type === "__bff_activity").at(-1)?.active).toEqual([]);
  });
});

/**
 * A response to a request the BFF made itself is not a browser's response, and
 * it is not an unsolicited frame either. Without the internal-id check it fell
 * through to the broadcast path, so a `bff-download-*` `read_file_response`
 * carried whole file contents to every connected session — and into the replay
 * buffer, where a later reconnect replayed them again.
 */
describe("internal upstream responses", () => {
  function fileResponse(requestId: string) {
    return {
      type: "read_file_response",
      request_id: requestId,
      path: "/work/agent-1/secret.md",
      content: "TOP SECRET",
      success: true,
    } as never;
  }

  function setup(ids: string[]) {
    const upstream = {
      getState: () => "connected",
      getInfo: () => null,
      isReady: () => true,
      send: () => {},
      isInternalRequest: (id: string) => ids.includes(id),
    } as unknown as UpstreamConnection;
    const registry = new SessionRegistry(upstream, 100, () => {});
    const sent: Record<string, unknown>[] = [];
    const socket: SessionSocket = { send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
    registry.add(socket, { email: "someone@example.com" });
    return { registry, sent };
  }

  test("an internal response is neither relayed nor buffered", () => {
    const { registry, sent } = setup(["bff-download-abc"]);
    expect(sent.map((m) => m.type)).toEqual(["__bff_hello"]);

    registry.handleUpstreamFrame(fileResponse("bff-download-abc"));

    expect(sent.map((m) => m.type)).toEqual(["__bff_hello"]);
    expect(registry.latestSeq).toBe(0);
  });

  test("an orphaned response for a departed session still falls through", () => {
    const { registry, sent } = setup([]);
    registry.handleUpstreamFrame(fileResponse("web-1"));
    expect(sent).toHaveLength(2);
    expect(registry.latestSeq).toBe(1);
  });
});

/**
 * The lexical clamp says a path is under /work; that says nothing about whether
 * a component of it is a symlink pointing elsewhere. The app-server resolves
 * nothing — `read_file` reads straight through — so the BFF has to check the
 * components itself or the workspace boundary is decorative.
 */
describe("symlink escape", () => {
  test("a planted link inside the workspace cannot be read through", () => {
    const upstream = {
      getState: () => "connected",
      getInfo: () => null,
      isReady: () => true,
      send: () => {},
      isInternalRequest: () => false,
    } as unknown as UpstreamConnection;
    const sent: Record<string, unknown>[] = [];
    const socket: SessionSocket = { send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
    const registry = new SessionRegistry(
      upstream,
      100,
      () => {},
      "/work",
      (path: string) => ({
        isSymbolicLink: () => path === "/work/agent-1/link",
      }),
    );
    const id = registry.add(socket, { email: "someone@example.com" });

    registry.handleSessionMessage(
      id,
      JSON.stringify({
        type: "read_file",
        request_id: "r1",
        path: "/work/agent-1/link/settings.json",
      }),
    );
    const refusal = sent.find((m) => m.request_id === "r1");
    expect(refusal?.type).toBe("__bff_error");
    expect(String(refusal?.message)).toContain("symlink");
  });

  test("a real path with no links still goes through", () => {
    const upstream = {
      getState: () => "connected",
      getInfo: () => null,
      isReady: () => true,
      send: () => {},
      isInternalRequest: () => false,
    } as unknown as UpstreamConnection;
    const sent: Record<string, unknown>[] = [];
    const socket: SessionSocket = { send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
    const registry = new SessionRegistry(
      upstream,
      100,
      () => {},
      "/work",
      () => ({
        isSymbolicLink: () => false,
      }),
    );
    const id = registry.add(socket, { email: "someone@example.com" });

    registry.handleSessionMessage(
      id,
      JSON.stringify({ type: "read_file", request_id: "r2", path: "/work/agent-1/notes.md" }),
    );
    expect(sent.find((m) => m.type === "__bff_error" && m.request_id === "r2")).toBeUndefined();
  });
});

describe("broadcastPiProgress", () => {
  function piSetup() {
    const registry = new SessionRegistry(fakeUpstream, 100, () => {});
    const sent: Record<string, unknown>[] = [];
    const socket: SessionSocket = { send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
    const open = () => registry.add(socket, { email: "someone@example.com" });
    const watchPi = (id: string, pi: boolean) =>
      registry.handleSessionMessage(
        id,
        JSON.stringify({ type: "__bff_watching", scope: null, visible: true, pi }),
      );
    return { registry, sent, open, watchPi };
  }

  test("the facts factory is never called while nobody opted in", async () => {
    const { registry, open } = piSetup();
    open();
    let built = false;
    await registry.broadcastPiProgress(() => {
      built = true;
      return { runId: "r1" };
    });
    expect(built).toBe(false);
  });

  test("an opted-in session receives the frame, others do not", async () => {
    const { registry, sent, open, watchPi } = piSetup();
    const watcher = open();
    open();
    watchPi(watcher, true);
    await registry.broadcastPiProgress(() => ({ runId: "r1", state: "running" }));
    const frames = sent.filter((m) => m.type === "__bff_pi_progress");
    // `add` greets each session with a hello; only the watcher gets a frame.
    expect(frames).toHaveLength(1);
    expect(frames[0]?.runId).toBe("r1");
  });

  test("opting back out stops the frames", async () => {
    const { registry, sent, open, watchPi } = piSetup();
    const id = open();
    watchPi(id, true);
    watchPi(id, false);
    await registry.broadcastPiProgress(() => ({ runId: "r1" }));
    expect(sent.filter((m) => m.type === "__bff_pi_progress")).toHaveLength(0);
  });
});

/**
 * A repeat `runtime_start` asks the app-server for a state replay it has already
 * done for this connection, and on a slow disk that replay is seconds during
 * which nobody else is answered. The BFF can answer it locally; these pin both
 * the answer and every case that must still go upstream.
 */
describe("repeat runtime_start", () => {
  const scope = { agent_id: "agent-1", conversation_id: "conv-1" };
  const cwd = "/work/agent-1";
  const start = (requestId: string, extra: Record<string, unknown> = {}) => ({
    type: "runtime_start",
    request_id: requestId,
    ...scope,
    wait_for_replay: true,
    cwd,
    ...extra,
  });
  const status = (isProcessing: boolean) =>
    ({
      type: "update_device_status",
      runtime: scope,
      device_status: { is_processing: isProcessing },
    }) as never;
  const queued = {
    type: "update_queue",
    runtime: scope,
    queue: [{ id: "q1" }],
  } as never;

  function setup(options: RegistryOptions = {}) {
    const forwarded: Record<string, unknown>[] = [];
    const sent: Record<string, unknown>[] = [];
    const clock = { now: 1_000, generation: 1 };
    const upstream = {
      getState: () => "connected",
      getInfo: () => null,
      isReady: () => true,
      send: (frame: Record<string, unknown>) => forwarded.push(frame),
      isInternalRequest: () => false,
      getGeneration: () => clock.generation,
    } as unknown as UpstreamConnection;
    const registry = new SessionRegistry(upstream, 100, () => {}, undefined, undefined, {
      cacheNow: () => clock.now,
      ...options,
    });
    const socket: SessionSocket = { send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
    const id = registry.add(socket, { email: "someone@example.com" });
    const ask = (command: Record<string, unknown>) =>
      registry.handleSessionMessage(id, JSON.stringify(command));
    /** Ask once, let the app-server say yes, then route whatever it said after. */
    const startOnce = (frames: never[] = []) => {
      ask(start("web-1"));
      registry.handleUpstreamFrame({
        type: "runtime_start_response",
        request_id: forwarded[0]?.request_id,
        success: true,
      } as never);
      for (const frame of frames) registry.handleUpstreamFrame(frame);
      sent.length = 0;
    };
    return { registry, forwarded, sent, ask, startOnce, clock };
  }

  test("the first open goes upstream: nothing is remembered yet", () => {
    const { ask, forwarded } = setup();
    ask(start("web-1"));
    expect(forwarded).toHaveLength(1);
  });

  test("the next open is answered here, with the live state the replay was for", () => {
    const { forwarded, sent, ask, startOnce } = setup();
    startOnce([status(true), queued]);

    ask(start("web-2"));

    expect(forwarded).toHaveLength(1);
    expect(sent.map((m) => m.type)).toEqual([
      "update_device_status",
      "update_queue",
      "runtime_start_response",
    ]);
    const reply = sent.at(-1) as Record<string, unknown>;
    expect(reply.request_id).toBe("web-2");
    expect(reply.success).toBe(true);
    expect(reply.answered_from_cache).toBe(true);
    expect(reply.runtime).toEqual(scope);
  });

  test("the newest status is the one handed over", () => {
    const { sent, ask, startOnce } = setup();
    startOnce([status(true), status(false)]);

    ask(start("web-2"));

    expect(sent.filter((m) => m.type === "update_device_status")).toHaveLength(1);
    expect(sent[0]?.device_status).toEqual({ is_processing: false });
  });

  test("another cwd is another runtime, so it goes upstream", () => {
    const { forwarded, ask, startOnce } = setup();
    startOnce([status(false)]);
    ask(start("web-2", { cwd: "/elsewhere" }));
    expect(forwarded).toHaveLength(2);
  });

  test("a start carrying anything else is the app-server's question", () => {
    const { forwarded, ask, startOnce } = setup();
    startOnce([status(false)]);
    ask(start("web-2", { mode: "acceptEdits" }));
    expect(forwarded).toHaveLength(2);
  });

  test("a new upstream connection is a different answer", () => {
    const { forwarded, ask, startOnce, clock } = setup();
    startOnce([status(false)]);
    clock.generation += 1;
    ask(start("web-2"));
    expect(forwarded).toHaveLength(2);
  });

  test("an upstream drop invalidates the answer even at the same generation", () => {
    const { forwarded, ask, startOnce, registry } = setup();
    startOnce([status(false)]);
    registry.broadcastUpstreamState("disconnected", null);
    registry.broadcastUpstreamState("connected", null);
    ask(start("web-2"));
    expect(forwarded).toHaveLength(2);
  });

  test("a start the app-server refused is never remembered as a success", () => {
    const { forwarded, ask, registry } = setup();
    ask(start("web-1"));
    registry.handleUpstreamFrame({
      type: "runtime_start_response",
      request_id: forwarded[0]?.request_id,
      success: false,
      error: "No such conversation",
    } as never);
    registry.handleUpstreamFrame(status(false));

    ask(start("web-2"));

    expect(forwarded).toHaveLength(2);
  });

  test("a busy conversation that has gone silent asks the server again", () => {
    const { forwarded, sent, ask, startOnce, clock } = setup();
    startOnce([status(true)]);
    clock.now += 61_000;

    ask(start("web-2"));

    expect(forwarded).toHaveLength(2);
    expect(sent.map((m) => m.type)).not.toContain("runtime_start_response");
  });

  test("an idle conversation stays answerable however long it sits", () => {
    const { forwarded, ask, startOnce, clock } = setup();
    startOnce([status(false)]);
    clock.now += 600_000;
    ask(start("web-2"));
    expect(forwarded).toHaveLength(1);
  });

  test("RUNTIME_START_CACHE=off puts every start back upstream", () => {
    const { forwarded, ask, startOnce } = setup({ cacheRuntimeStart: false });
    startOnce([status(false)]);
    ask(start("web-2"));
    expect(forwarded).toHaveLength(2);
  });
});
