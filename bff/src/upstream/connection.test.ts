import { expect, test } from "bun:test";
import type { AppServerInfoResponseMessage } from "@letta-ai/letta-code/app-server-client";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import {
  createAppServerClient,
  shouldLogConnectFailure,
  type UpstreamClient,
  UpstreamConnection,
} from "./connection.ts";

const INFO = {
  letta_code_version: "0.0.0-test",
  backend: "local",
  protocol_version: 1,
} as unknown as AppServerInfoResponseMessage;

/** The far end, on demand: what it answers, and everything it was asked. */
class FakeClient implements UpstreamClient {
  readonly sent: Record<string, unknown>[] = [];
  readonly requests: Record<string, unknown>[] = [];
  connects = 0;
  closes = 0;
  /** Served to `agent_list`. */
  agents: { id: string }[] = [{ id: "agent-1" }];
  /** Pages served to `conversation_list`, in cursor order. */
  pages: { id: string }[][] = [];
  failConnect = false;
  /** What a refused connect rejects with; bun's shape is the interesting one. */
  connectError = new Error("app-server down");
  /** What the socket's own error listener saw, as `failureDetail()`. */
  socketDetail: string | null = null;
  /** Refuse every sync, to exercise the failure path. */
  failSync = false;
  /**
   * Hold each `sync` this long, so a test can watch how many run at once.
   * Zero answers immediately, which is what every other test expects.
   */
  syncHoldMs = 0;
  inFlightSyncs = 0;
  maxInFlightSyncs = 0;
  /** Wall-clock ms when each `sync` reached the client, in arrival order. */
  readonly syncStarts: number[] = [];
  /** The options each `requestRaw` was given, indexed like `requests`. */
  readonly requestOptions: { timeoutMs?: number }[] = [];
  /** The `request_id` of every sync, so a test can tell a sweep's syncs from a
   * reconnect's. */
  readonly syncIds: string[] = [];
  /** `requestRaw` options recorded only for the syncs, so a test can read the
   * timeout the BFF asked for without re-parsing the command. */
  readonly syncTimeouts: (number | undefined)[] = [];
  private messageHandler: ((message: WsProtocolMessage) => void) | null = null;
  private disconnectHandler: (() => void) | null = null;
  private page = 0;

  connect(): Promise<unknown> {
    this.connects += 1;
    if (this.failConnect) return Promise.reject(this.connectError);
    this.page = 0;
    return Promise.resolve(this);
  }
  failureDetail(): string | null {
    return this.socketDetail;
  }
  close(): void {
    this.closes += 1;
  }
  onMessage(handler: (message: WsProtocolMessage) => void): () => void {
    this.messageHandler = handler;
    return () => {};
  }
  onDisconnect(handler: () => void): () => void {
    this.disconnectHandler = handler;
    return () => {};
  }
  sendRaw(command: Record<string, unknown>): void {
    this.sent.push(command);
  }
  info(): Promise<AppServerInfoResponseMessage> {
    return Promise.resolve(INFO);
  }
  requestRaw(
    command: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    this.requests.push(command);
    this.requestOptions.push(options);
    const query = command.query as { after?: string } | undefined;
    if (command.type === "agent_list")
      return Promise.resolve({ success: true, agents: this.agents });
    if (command.type === "conversation_list") {
      // A real cursor moves the window; an ignored one would repeat a page.
      if (query?.after === undefined) this.page = 0;
      const conversations = this.pages[this.page] ?? [];
      this.page += 1;
      return Promise.resolve({ success: true, conversations });
    }
    if (command.type === "sync") {
      this.syncStarts.push(Date.now());
      this.syncTimeouts.push(options.timeoutMs);
      this.syncIds.push(String(command.request_id));
      this.inFlightSyncs += 1;
      this.maxInFlightSyncs = Math.max(this.maxInFlightSyncs, this.inFlightSyncs);
      // Rejected, not resolved with `success: false`: the app-server refusing a
      // sync is an error on the wire, and resolving would count it as synced.
      const settle = (): Promise<unknown> =>
        this.failSync
          ? Promise.reject(new Error("no such conversation"))
          : Promise.resolve({ success: true });
      if (!this.syncHoldMs) {
        this.inFlightSyncs -= 1;
        return settle();
      }
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          this.inFlightSyncs -= 1;
          settle().then(resolve, reject);
        }, this.syncHoldMs),
      );
    }
    return Promise.reject(new Error(`unexpected request: ${String(command.type)}`));
  }

  /** The app-server going away, as the client sees it. */
  drop(): void {
    this.disconnectHandler?.();
  }
  emit(frame: WsProtocolMessage): void {
    this.messageHandler?.(frame);
  }
  /** Every `sync` this client was asked for, as scope keys. */
  syncedScopes(): string[] {
    return this.requests
      .filter((r) => r.type === "sync")
      .map((r) => {
        const runtime = r.runtime as { agent_id: string; conversation_id: string };
        return `${runtime.agent_id}::${runtime.conversation_id}`;
      });
  }
}

async function waitFor(what: string, done: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeConnection(client: FakeClient, frames: WsProtocolMessage[] = []) {
  const states: string[] = [];
  const logs: string[] = [];
  const upstream = new UpstreamConnection({
    url: "ws://fake:4500",
    onFrame: (frame) => frames.push(frame),
    onStateChange: (state) => states.push(state),
    log: (message) => logs.push(message),
    createClient: () => client,
    // Every other test here is about what a pass does, not how long it waits
    // between syncs; the pacing itself has its own tests below.
    syncPacing: { pacingMs: 0 },
  });
  return { upstream, states, frames, logs };
}

/** The pacing production uses, restated here so a test would fail if a source
 * default drifted: syncs are paced one at a time because the app-server blocks
 * while answering one (see the doc comment on `SWEEP_SYNC_CONCURRENCY`). */
const SWEEP_SYNC_CONCURRENCY = 1;
const RESYNC_CONCURRENCY = 2;
const OWNER_SYNC_TIMEOUT_MS = 120_000;

/**
 * A connection whose sync pacing is overridden, so a test that waits on the gap
 * waits on milliseconds it chose rather than the half-second production waits.
 */
function makePacedConnection(
  client: FakeClient,
  syncPacing: { pacingMs?: number; ownerSyncTimeoutMs?: number },
) {
  const logs: string[] = [];
  const upstream = new UpstreamConnection({
    url: "ws://fake:4500",
    onFrame: () => {},
    onStateChange: () => {},
    log: (message) => logs.push(message),
    createClient: () => client,
    syncPacing,
  });
  return { upstream, logs };
}

test("a connect syncs every conversation of every agent, following the list cursor", async () => {
  const client = new FakeClient();
  // 130 conversations, so the walk has to page past the first page and the
  // first sweep has to be allowed past the steady per-sweep cap.
  client.pages = [
    Array.from({ length: 100 }, (_, i) => ({ id: `conv-${i}` })),
    Array.from({ length: 30 }, (_, i) => ({ id: `conv-${100 + i}` })),
  ];
  const { upstream, states } = makeConnection(client);
  upstream.start();

  await waitFor("the sweep to finish", () => client.syncedScopes().length === 130);
  expect(upstream.getState()).toBe("connected");
  expect(upstream.getGeneration()).toBe(1);
  // "connecting" is the state the class starts in, so the first connect does
  // not broadcast it again — only real changes reach the sessions.
  expect(states).toEqual(["connected"]);
  expect(upstream.getInfo()).toBe(INFO);

  const listRequests = client.requests.filter((r) => r.type === "conversation_list");
  expect(listRequests.length).toBe(2);
  expect((listRequests[1] as { query: { after?: string } }).query.after).toBe("conv-99");

  // The owner sync is what resumes an interrupted turn on a conversation no
  // browser ever opened — it is not an observation.
  const firstSync = client.requests.find((r) => r.type === "sync");
  expect(firstSync).toMatchObject({ resume_interrupted_turn: true, recover_approvals: true });
  upstream.stop();
});

test("a dropped socket reconnects and re-subscribes the scopes it already knew", async () => {
  const client = new FakeClient();
  client.pages = [[{ id: "conv-1" }, { id: "conv-2" }]];
  const { upstream } = makeConnection(client);
  upstream.start();
  await waitFor("the first sweep", () => client.syncedScopes().length === 2);

  client.drop();
  expect(upstream.getState()).toBe("disconnected");

  // INITIAL_RETRY_MS is 500ms of real time — the reconnect backoff is part of
  // what this pins down, so it is waited out rather than faked away.
  await waitFor("the reconnect", () => upstream.getGeneration() === 2, 5000);
  await waitFor(
    "the re-subscribe",
    () => client.syncedScopes().filter((key) => key === "agent-1::conv-1").length === 2,
  );
  expect(client.connects).toBe(2);
  upstream.stop();
});

test("the sweep runs one sync at a time and leaves a gap between them", async () => {
  const client = new FakeClient();
  const holdMs = 30;
  const pacingMs = 60;
  client.syncHoldMs = holdMs;
  client.pages = [Array.from({ length: 6 }, (_, i) => ({ id: `conv-${i}` }))];
  const { upstream } = makePacedConnection(client, { pacingMs });
  upstream.start();

  await waitFor("the whole sweep", () => client.syncedScopes().length === 6, 5000);
  // Not a batch and not serial-by-accident: exactly one in flight, the number
  // production asks for.
  expect(client.maxInFlightSyncs).toBe(SWEEP_SYNC_CONCURRENCY);
  expect(client.syncStarts.length).toBe(6);
  // The gap is measured between one sync finishing and the next starting, so the
  // app-server gets holdMs + pacingMs of quiet between them.
  for (let i = 1; i < client.syncStarts.length; i += 1) {
    const gap = (client.syncStarts[i] as number) - (client.syncStarts[i - 1] as number);
    expect(gap).toBeGreaterThanOrEqual(holdMs + pacingMs - 5);
  }
  upstream.stop();
});

test("the pass asks for a timeout a slow sync can actually fit in", async () => {
  const client = new FakeClient();
  client.pages = [[{ id: "conv-1" }]];
  const { upstream } = makeConnection(client);
  upstream.start();
  await waitFor("the sweep", () => client.syncedScopes().length === 1);

  // The 30 s default is what made a restart sweep look broken: the app-server
  // was slow, not stuck, and every timed-out sync had still subscribed its scope.
  expect(client.syncTimeouts).toEqual([OWNER_SYNC_TIMEOUT_MS]);
  upstream.stop();
});

test("a request that is not a sync gets answered while the sweep runs", async () => {
  const client = new FakeClient();
  client.syncHoldMs = 60;
  client.pages = [Array.from({ length: 6 }, (_, i) => ({ id: `conv-${i}` }))];
  const { upstream } = makePacedConnection(client, { pacingMs: 40 });
  upstream.start();
  await waitFor("the sweep to start", () => client.syncStarts.length >= 1);

  // The point of pacing: the event loop is free between syncs, so anything else
  // the BFF needs is not stuck behind the whole pass.
  const started = Date.now();
  await upstream.request({ type: "agent_list", request_id: "bff-mid-sweep" });
  expect(Date.now() - started).toBeLessThan(50);
  upstream.stop();
});

test("a sweep that fails says so once, not once per conversation", async () => {
  const client = new FakeClient();
  client.failSync = true;
  client.pages = [Array.from({ length: 10 }, (_, i) => ({ id: `conv-${i}` }))];
  const { upstream, logs } = makePacedConnection(client, { pacingMs: 0 });
  upstream.start();

  await waitFor("the sweep to fail through", () => client.syncIds.length === 10);
  const sweep = logs.filter((line) => line.startsWith("Scope sweep:"));
  expect(sweep.length).toBe(1);
  expect(sweep[0]).toContain("0 synced, 10 failed");
  // Why, for the first few only — the tally is what an operator reads, the
  // per-scope reasons are for the third conversation in a row that says.
  expect(sweep[0]).toContain("+7 more");
  upstream.stop();
});

test("a reconnect re-subscribes at the slightly higher concurrency it asks for", async () => {
  const client = new FakeClient();
  client.pages = [Array.from({ length: 6 }, (_, i) => ({ id: `conv-${i}` }))];
  const { upstream } = makePacedConnection(client, { pacingMs: 5 });
  upstream.start();
  await waitFor("the first sweep", () => client.syncedScopes().length === 6);
  client.maxInFlightSyncs = 0;
  client.syncHoldMs = 20;

  client.drop();
  await waitFor("the reconnect", () => upstream.getGeneration() === 2, 5000);
  await waitFor("the re-subscribe", () => client.syncedScopes().length >= 12, 8000);
  // Bounded by what resync asks for, and actually concurrent — serial here would
  // double the time a reconnect spends unable to deliver turns.
  expect(client.maxInFlightSyncs).toBeLessThanOrEqual(RESYNC_CONCURRENCY);
  expect(client.maxInFlightSyncs).toBeGreaterThan(1);
  upstream.stop();
});

test("a failing app-server is retried until it answers", async () => {
  const client = new FakeClient();
  client.failConnect = true;
  const { upstream } = makeConnection(client);
  upstream.start();
  await waitFor("the first retry", () => client.connects >= 2, 5000);
  expect(upstream.getState()).toBe("disconnected");
  expect(upstream.isReady()).toBe(false);
  upstream.stop();
});

test("an outage says itself once, not once per retry", async () => {
  const client = new FakeClient();
  client.failConnect = true;
  const { upstream, logs } = makeConnection(client);
  upstream.start();
  await waitFor("the first retry", () => client.connects >= 2, 5000);
  const failures = logs.filter((line) => line.startsWith("Upstream connect failed"));
  // Two refused connects, one line: the first failure is reported and the
  // repetition is not, for as long as the app-server stays down.
  expect(failures.length).toBe(1);
  expect(failures[0]).toContain("app-server down");
  upstream.stop();
});

test("the socket's own reason stands in when the rejection carries none", async () => {
  const client = new FakeClient();
  client.failConnect = true;
  // What bun actually rejects with: the EventTarget event, stringified.
  client.connectError = new Error("App-server WebSocket failed to open: [object ErrorEvent]");
  client.socketDetail =
    "WebSocket connection to 'ws://127.0.0.1:4500/ws' failed: Failed to connect";
  const { upstream, logs } = makeConnection(client);
  upstream.start();

  await waitFor("the failure to be logged", () => logs.length > 0);
  expect(logs[0]).toContain("failed: Failed to connect");
  expect(logs[0]).not.toContain("[object ErrorEvent]");
  upstream.stop();
});

test("the failure log keeps the first and every twentieth", () => {
  expect(shouldLogConnectFailure(1)).toBe(true);
  expect([2, 3, 19].every(shouldLogConnectFailure)).toBe(false);
  expect(shouldLogConnectFailure(20)).toBe(true);
  expect(shouldLogConnectFailure(40)).toBe(true);
});

test("an internal request id is known, a browser's is not, and the set stays bounded", async () => {
  const client = new FakeClient();
  const { upstream } = makeConnection(client);
  upstream.start();
  await waitFor("the connect", () => upstream.isReady());

  upstream.sendInternal({ type: "cron_list", request_id: "bff-internal-1" });
  upstream.send({ type: "cron_list", request_id: "from-a-browser" });
  expect(upstream.isInternalRequest("bff-internal-1")).toBe(true);
  expect(upstream.isInternalRequest("from-a-browser")).toBe(false);

  // The ceiling exists so a process that lives for weeks cannot grow the set
  // without end; the oldest id — the one whose answer is long past — goes first.
  const ids = Array.from({ length: 20_001 }, (_, i) => `bff-bulk-${i}`);
  for (const id of ids) upstream.sendInternal({ type: "cron_list", request_id: id });
  expect(upstream.isInternalRequest("bff-internal-1")).toBe(false);
  expect(upstream.isInternalRequest(ids[0] as string)).toBe(false);
  expect(upstream.isInternalRequest(ids[20_000] as string)).toBe(true);
  upstream.stop();
});

test("the production client attaches to the socket's own error event", () => {
  // Version-independent half of the regression: bun 1.3.0 (CI's pin) lets a refused
  // handshake through as a plain rejection, so only the listener itself can be
  // asserted everywhere. It is what bun's shim counts, and it has to be there at
  // construction — before any handshake has had the chance to fail.
  const attached: string[] = [];
  class RecordedSocket {
    readyState = 0;
    send(): void {}
    close(): void {}
    // Both halves of the EventTarget API, so upstream's listener helper prefers
    // them over `on` — which is exactly what leaves bun's error count at zero.
    addEventListener(): void {}
    removeEventListener(): void {}
    on(type: string): void {
      attached.push(type);
    }
  }
  createAppServerClient("ws://127.0.0.1:4599/ws", RecordedSocket as never);
  expect(attached).toEqual(["error"]);
});

test("nothing is sent before the socket is up", () => {
  const client = new FakeClient();
  const { upstream } = makeConnection(client);
  expect(() => upstream.send({ type: "cron_list" })).toThrow(/not ready/);
  expect(client.sent).toEqual([]);
});
