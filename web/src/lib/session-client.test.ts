import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AuthProbe } from "./auth-probe.ts";
import {
  BffRequestError,
  type LinkState,
  SessionClient,
  type SessionClientEvents,
} from "./session-client.ts";

/** Just enough of a WebSocket to drive the client's lifecycle by hand. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  /** Whatever the client wrote, so a test can read the `request_id` it minted. */
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  /** The server refused or the network failed before the handshake. */
  fail(code = 1006) {
    this.onclose?.({ code });
  }
}

const saved = {
  WebSocket: globalThis.WebSocket,
  document: globalThis.document,
  window: globalThis.window,
};
const noop = () => {};
Object.assign(globalThis, {
  WebSocket: FakeSocket,
  document: { visibilityState: "visible", addEventListener: noop, removeEventListener: noop },
  window: { addEventListener: noop, removeEventListener: noop },
});
afterAll(() => Object.assign(globalThis, saved));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(probeResult: AuthProbe) {
  const states: LinkState[] = [];
  const onAuthExpired = mock(() => {});
  const probe = mock(async () => probeResult);
  const events = {
    onFrame: noop,
    onStateChange: (link: LinkState) => states.push(link),
    onResyncRequired: noop,
    onHello: noop,
    onAppServerInfo: noop,
    onError: noop,
    onActivity: noop,
    onPiProgress: noop,
    onAuthExpired,
  } satisfies SessionClientEvents;
  const client = new SessionClient("ws://test/ws", events, probe);
  client.start();
  return { client, states, onAuthExpired, probe, latest: () => FakeSocket.instances.at(-1)! };
}

beforeEach(() => {
  FakeSocket.instances = [];
});

describe("SessionClient sign-in expiry", () => {
  test("close code 4401 signs out at once, without probing or retrying", async () => {
    const { client, states, onAuthExpired, probe, latest } = setup("ok");
    latest().fail(4401);
    await tick();
    expect(states.at(-1)).toBe("signed-out");
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
    client.stop();
  });

  test("one failed open just retries; the second asks why", async () => {
    const { client, probe, latest } = setup("unreachable");
    latest().fail();
    await tick();
    expect(probe).not.toHaveBeenCalled();
    // Retry fires on the backoff timer.
    await new Promise((resolve) => setTimeout(resolve, 350));
    latest().fail();
    await tick();
    expect(probe).toHaveBeenCalledTimes(1);
    client.stop();
  });

  test("a probe that finds the login expired signs out and stops retrying", async () => {
    const { client, states, onAuthExpired, latest } = setup("expired");
    latest().fail();
    await new Promise((resolve) => setTimeout(resolve, 350));
    latest().fail();
    await tick();
    expect(states.at(-1)).toBe("signed-out");
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    const sockets = FakeSocket.instances.length;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(FakeSocket.instances).toHaveLength(sockets);
    client.stop();
  });

  test("a probe that finds the login fine keeps reconnecting", async () => {
    const { client, states, onAuthExpired, latest } = setup("ok");
    latest().fail();
    await new Promise((resolve) => setTimeout(resolve, 350));
    latest().fail();
    await tick();
    expect(onAuthExpired).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe("reconnecting");
    const sockets = FakeSocket.instances.length;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(FakeSocket.instances.length).toBeGreaterThan(sockets);
    client.stop();
  });
});

describe("SessionClient request failures", () => {
  /** Open the fake socket and start one request, returning its promise and the id it went out under. */
  function ask(client: SessionClient, socket: FakeSocket, type = "input") {
    socket.readyState = FakeSocket.OPEN;
    const pending = client.request(type, { runtime: { agent_id: "a", conversation_id: "c" } });
    // The rejection is expected in these tests; asserting on it is the point, not an unhandled one.
    void pending.catch(() => {});
    const id = (JSON.parse(socket.sent.at(-1)!) as { request_id: string }).request_id;
    return { pending, id };
  }

  test("a refusal answering the request rejects with the delivery code the BFF sent", async () => {
    const { client, latest } = setup("ok");
    const socket = latest();
    const { pending, id } = ask(client, socket);
    socket.onmessage?.({
      data: JSON.stringify({
        type: "__bff_error",
        request_id: id,
        code: "delivery_uncertain",
        message: "The app-server connection dropped before it confirmed this.",
      }),
    });
    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BffRequestError);
    expect((error as BffRequestError).code).toBe("delivery_uncertain");
    expect((error as Error).message).toContain("dropped before it confirmed");
    client.stop();
  });

  test("an ordinary refusal keeps the message and carries no code", async () => {
    // Deliberate: only an explicit answer marks a message. A refusal the BFF made for some other reason
    // (a rate limit, a path it would not read) must not read as an undelivered send.
    const { client, latest } = setup("ok");
    const socket = latest();
    const { pending, id } = ask(client, socket, "read_file");
    socket.onmessage?.({
      data: JSON.stringify({ type: "__bff_error", request_id: id, message: "Not allowed" }),
    });
    const error = await pending.catch((cause: unknown) => cause);
    expect((error as Error).message).toBe("Not allowed");
    expect((error as BffRequestError).code).toBeUndefined();
    client.stop();
  });

  test("an error for a request nobody has waits to the app's error surface", async () => {
    const errors: { message: string }[] = [];
    const events = {
      onFrame: noop,
      onStateChange: noop,
      onResyncRequired: noop,
      onHello: noop,
      onAppServerInfo: noop,
      onError: (error: { message: string }) => errors.push(error),
      onActivity: noop,
      onPiProgress: noop,
      onAuthExpired: noop,
    } satisfies SessionClientEvents;
    const client = new SessionClient("ws://test/ws", events, async () => "ok" as AuthProbe);
    client.start();
    const socket = FakeSocket.instances.at(-1)!;
    socket.readyState = FakeSocket.OPEN;
    client.send({ type: "abort_message" });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "__bff_error",
        code: "not_sent",
        message: "App-server is not connected",
      }),
    });
    expect(errors.map((e) => e.message)).toEqual(["App-server is not connected"]);
    client.stop();
  });
});

describe("SessionClient upstream-state frames", () => {
  test("an upstream-only transition reaches onStateChange even when the link does not move", async () => {
    // The recovery path of an outage where the BFF socket never dropped:
    // offline -> connecting -> connected. The middle frame moves only the
    // server state; swallowing it left the derived status stuck on the
    // previous server label through the reconnect.
    const seen: [LinkState, string][] = [];
    const events = {
      onFrame: noop,
      onStateChange: (link: LinkState, upstream: string) => seen.push([link, upstream]),
      onResyncRequired: noop,
      onHello: noop,
      onAppServerInfo: noop,
      onError: noop,
      onActivity: noop,
      onPiProgress: noop,
      onAuthExpired: noop,
    } satisfies SessionClientEvents;
    const client = new SessionClient("ws://test/ws", events, async () => "ok" as AuthProbe);
    client.start();
    const socket = FakeSocket.instances.at(-1)!;
    socket.onopen?.();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "__bff_resume_result",
        from_seq: null,
        latest_seq: 0,
        replayed: 0,
        resync_required: false,
      }),
    });
    for (const state of ["disconnected", "connecting", "connected"]) {
      socket.onmessage?.({ data: JSON.stringify({ type: "__bff_upstream_state", state }) });
    }
    expect(seen).toEqual([
      ["live", "connecting"],
      ["offline", "disconnected"],
      // link stays "offline" while the server reconnects — but the server
      // state moved, and the caller must see it.
      ["offline", "connecting"],
      ["live", "connected"],
    ]);
    client.stop();
  });
});
