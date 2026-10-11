import { expect, test } from "bun:test";
import type { AppServerInfoResponseMessage } from "@letta-ai/letta-code/app-server-client";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { type UpstreamClient, UpstreamConnection } from "./connection.ts";

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
  /** Refuse every sync, to exercise the failure path. */
  failSync = false;
  private messageHandler: ((message: WsProtocolMessage) => void) | null = null;
  private disconnectHandler: (() => void) | null = null;
  private page = 0;

  connect(): Promise<unknown> {
    this.connects += 1;
    if (this.failConnect) return Promise.reject(new Error("app-server down"));
    this.page = 0;
    return Promise.resolve(this);
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
  requestRaw(command: Record<string, unknown>): Promise<unknown> {
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
      return Promise.resolve(
        this.failSync ? { success: false, error: "no such conversation" } : { success: true },
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
  const upstream = new UpstreamConnection({
    url: "ws://fake:4500",
    onFrame: (frame) => frames.push(frame),
    onStateChange: (state) => states.push(state),
    createClient: () => client,
  });
  return { upstream, states, frames };
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

test("nothing is sent before the socket is up", () => {
  const client = new FakeClient();
  const { upstream } = makeConnection(client);
  expect(() => upstream.send({ type: "cron_list" })).toThrow(/not ready/);
  expect(client.sent).toEqual([]);
});
