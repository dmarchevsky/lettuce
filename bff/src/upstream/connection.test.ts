import { expect, test } from "bun:test";
import type { AppServerInfoResponseMessage } from "@letta-ai/letta-code/app-server-client";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import {
  createAppServerClient,
  OWNER_SYNC_TIMEOUT_MS,
  RESYNC_CONCURRENCY,
  SWEEP_SYNC_CONCURRENCY,
  SYNC_PACING_MS,
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
  syncStarts: number[] = [];
  /** The timeout each sync was given, so a test can read what the pass asked for. */
  syncTimeouts: (number | undefined)[] = [];
  /** The `request_id` of every sync, so a test can tell a sweep's from a reconnect's. */
  syncIds: string[] = [];
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
      // A refused sync RESOLVES with `success: false` — that is what upstream's
      // client does with any message carrying the request id, and what
      // letta-code's message-router answers a sync it will not run with.
      const settle = (): Promise<unknown> =>
        this.failSync
          ? Promise.resolve({ success: false, error: "Runtime is no longer active" })
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

function makeConnection(
  client: FakeClient,
  frames: WsProtocolMessage[] = [],
  // What the tests wait on is what a pass does, never how long it waits between
  // syncs — the pacing has its own tests, and this keeps the suite out of
  // seconds. Pass null to get production's own pacing.
  syncPacing: { pacingMs?: number } | null = { pacingMs: 0 },
) {
  const states: string[] = [];
  const logs: string[] = [];
  const upstream = new UpstreamConnection({
    url: "ws://fake:4500",
    onFrame: (frame) => frames.push(frame),
    onStateChange: (state) => states.push(state),
    log: (message) => logs.push(message),
    createClient: () => client,
    ...(syncPacing ? { syncPacing } : {}),
  });
  return { upstream, states, frames, logs };
}

/**
 * A connection whose sync pacing is overridden, so a test that waits on the gap
 * waits on milliseconds it chose rather than the half-second production waits.
 */
function makePacedConnection(
  client: FakeClient,
  syncPacing: { pacingMs?: number; ownerSyncTimeoutMs?: number; passBudgetMs?: number },
  sweepIntervalMs?: number,
) {
  const logs: string[] = [];
  const upstream = new UpstreamConnection({
    url: "ws://fake:4500",
    onFrame: () => {},
    onStateChange: () => {},
    log: (message) => logs.push(message),
    createClient: () => client,
    syncPacing,
    ...(sweepIntervalMs ? { sweepIntervalMs } : {}),
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
  client.syncHoldMs = 10;
  client.pages = [[{ id: "conv-1" }, { id: "conv-2" }]];
  // The default connection, so this also pins the production gap: a test that
  // overrode it everywhere would leave the value nobody runs to drift.
  const { upstream } = makeConnection(client, [], null);
  upstream.start();
  await waitFor("the sweep", () => client.syncedScopes().length === 2, 5000);

  // The 30 s default is what made a restart sweep look broken: the app-server
  // was slow, not stuck, and every timed-out sync had still subscribed its scope.
  expect(client.syncTimeouts).toEqual([OWNER_SYNC_TIMEOUT_MS, OWNER_SYNC_TIMEOUT_MS]);
  expect((client.syncStarts[1] as number) - (client.syncStarts[0] as number)).toBeGreaterThanOrEqual(
    SYNC_PACING_MS + client.syncHoldMs - 5,
  );
  upstream.stop();
});

test("a request that is not a sync gets answered while the sweep runs", async () => {
  const client = new FakeClient();
  const holdMs = 60;
  const pacingMs = 40;
  client.syncHoldMs = holdMs;
  client.pages = [Array.from({ length: 6 }, (_, i) => ({ id: `conv-${i}` }))];
  const { upstream } = makePacedConnection(client, { pacingMs });
  upstream.start();
  await waitFor("the sweep to start", () => client.syncStarts.length >= 1);

  // The point of pacing: the event loop is free between syncs, so anything else
  // the BFF needs is not stuck behind the whole pass. Paced, this answer lands
  // inside the first sync; unpaced it would wait for the last one — assert that
  // bound rather than a stopwatch number that only proves the fake is fast.
  const started = Date.now();
  await upstream.request({ type: "agent_list", request_id: "bff-mid-sweep" });
  const waited = Date.now() - started;
  expect(waited).toBeLessThan(holdMs + pacingMs);
  expect(client.syncStarts.length).toBeLessThan(6);
  upstream.stop();
});

test("a pass that runs out of its time budget leaves the rest to the next sweep", async () => {
  const client = new FakeClient();
  client.syncHoldMs = 300;
  client.pages = [Array.from({ length: 6 }, (_, i) => ({ id: `conv-${i}` }))];
  const { upstream, logs } = makePacedConnection(client, { pacingMs: 0, passBudgetMs: 100 });
  upstream.start();

  // A server that holds the socket but never answers would otherwise take the
  // full per-sync timeout times the whole backlog to say so, holding the
  // no-overlap flag the entire time.
  await waitFor("the pass to stop on its budget", () =>
    logs.some((l) => l.includes("Scope sweep:")),
  );
  const summary = logs.filter((l) => l.startsWith("Scope sweep:"));
  expect(summary.length).toBe(1);
  expect(summary[0]).toContain("not attempted");
  expect(summary[0]).toContain("out of time budget");
  expect(client.syncIds.length).toBeLessThan(6);
  upstream.stop();
});

test("a connection lost mid-pass stops it instead of failing every scope", async () => {
  const client = new FakeClient();
  client.syncHoldMs = 60;
  client.pages = [Array.from({ length: 12 }, (_, i) => ({ id: `conv-${i}` }))];
  const { upstream, logs } = makePacedConnection(client, { pacingMs: 0 });
  upstream.start();
  await waitFor("the sweep to start", () => client.syncStarts.length >= 1);

  client.drop();
  await waitFor("the pass to stop", () => logs.some((l) => l.includes("connection lost")));
  // The scopes never sent are not failed and not claimed: the reconnect
  // re-subscribes what was known and the next sweep picks up the rest.
  expect(client.syncIds.length).toBeLessThan(12);
  upstream.stop();
});

test("a sweep still running when the interval fires is skipped, not stacked", async () => {
  const client = new FakeClient();
  client.syncHoldMs = 40;
  // 6 conversations at 40 ms each outlasts a 15 ms interval several times over,
  // so the timer has to catch a running sweep rather than start another.
  client.pages = [Array.from({ length: 6 }, (_, i) => ({ id: `conv-${i}` }))];
  const { upstream, logs } = makePacedConnection(client, { pacingMs: 0 }, 15);
  upstream.start();

  await waitFor("an overlapping tick", () =>
    logs.some((l) => l.includes("previous sweep still running")),
  );
  expect(client.requests.filter((r) => r.type === "agent_list").length).toBeLessThan(4);
  upstream.stop();
});

test("a refused sync counts as a failure and says so as it happens", async () => {
  const client = new FakeClient();
  client.failSync = true;
  client.pages = [Array.from({ length: 10 }, (_, i) => ({ id: `conv-${i}` }))];
  const { upstream, logs } = makePacedConnection(client, { pacingMs: 0 });
  upstream.start();

  await waitFor("the sweep to fail through", () => client.syncIds.length === 10);
  await waitFor("the summary", () => logs.some((l) => l.startsWith("Scope sweep:")));
  // Upstream resolves a refusal, so a pass that only watched for rejections
  // would report all ten as synced — the one line an operator reads after a
  // restart would be the lie.
  const summary = logs.filter((l) => l.startsWith("Scope sweep:"));
  expect(summary.length).toBe(1);
  expect(summary[0]).toContain("0 synced, 10 failed");
  const details = logs.filter((l) => l.startsWith("Scope sweep failed for"));
  // Why, for the first few only, and when it happened rather than at the end.
  expect(details.length).toBe(3);
  expect(details[0]).toContain("Runtime is no longer active");
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
  // double the time a reconnect spends unable to deliver turns. It cannot stack
  // on a leftover sweep: a pass left running by the drop stops at its next check
  // (there is no connection to sync on), and the connect path awaits the
  // re-subscribe before it starts a sweep.
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
