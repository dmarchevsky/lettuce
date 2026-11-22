import { describe, expect, test } from "bun:test";
import type { UpstreamConnection } from "../upstream/connection.ts";
import { SessionRegistry, type SessionSocket } from "./registry.ts";

/**
 * What happens to the requests that were in flight when the one upstream socket died.
 *
 * The fake upstream records every frame it is handed and can be flipped between ready and not, which is
 * the whole world this behavior needs: forward, drop, come back, look at what went out and what the tab
 * was told.
 */
function setup(ready = true) {
  const sent: Record<string, unknown>[] = [];
  const toBrowser: Record<string, unknown>[] = [];
  let isReady = ready;
  const upstream = {
    getState: () => "connected",
    getInfo: () => null,
    isReady: () => isReady,
    send: (frame: Record<string, unknown>) => {
      if (!isReady) throw new Error("App-server connection is not ready");
      sent.push(frame);
    },
    getGeneration: () => 1,
    isInternalRequest: () => false,
  } as unknown as UpstreamConnection;

  const registry = new SessionRegistry(upstream, 100, () => {});
  const socket: SessionSocket = {
    send: (data) => toBrowser.push(JSON.parse(data) as Record<string, unknown>),
    close: () => {},
  };
  const sessionId = registry.add(socket, { email: "someone@example.com" });
  return {
    registry,
    sent,
    sessionId,
    /** Only the error frames, so the hello frame is not in every assertion. */
    errors: () => toBrowser.filter((m) => m.type === "__bff_error"),
    down: () => {
      isReady = false;
    },
    up: () => {
      isReady = true;
    },
    send: (command: Record<string, unknown>) =>
      registry.handleSessionMessage(sessionId, JSON.stringify(command)),
  };
}

const userMessage = (clientMessageId: string, requestId = "web-1") => ({
  type: "input",
  request_id: requestId,
  runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
  payload: {
    kind: "create_message",
    messages: [{ role: "user", content: "hello", client_message_id: clientMessageId }],
  },
});

describe("forwarding", () => {
  test("a command refused while the app-server is down says it was never sent", () => {
    const { sent, errors, send, down } = setup();
    down();
    send(userMessage("cm-1"));
    expect(sent).toHaveLength(0);
    expect(errors()[0]).toMatchObject({ code: "not_sent", request_id: "web-1" });
  });

  test("an ordinary refusal carries no delivery code", () => {
    const { errors, send } = setup();
    send({ type: "not_a_real_command" });
    expect(errors()).toHaveLength(1);
    expect((errors()[0] as { code?: string }).code).toBeUndefined();
  });
});

describe("after a reconnect", () => {
  test("a de-dupable message is re-sent under the same request id", () => {
    const { registry, sent, send } = setup();
    send(userMessage("cm-1"));
    expect(sent).toHaveLength(1);
    registry.handleUpstreamReconnected();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  test("a mutation is never re-sent, and its tab is told the outcome is unknown", () => {
    const { registry, sent, errors, send } = setup();
    send({ type: "write_file", request_id: "web-2", path: "/work/a.txt", content: "x" });
    expect(sent).toHaveLength(1);
    registry.handleUpstreamReconnected();
    expect(sent).toHaveLength(1);
    expect(errors()[0]).toMatchObject({ code: "delivery_uncertain", request_id: "web-2" });
  });

  test("a request that already answered is not re-sent", () => {
    const { registry, sent, send } = setup();
    send(userMessage("cm-1"));
    const forwarded = sent[0] as { request_id: string };
    registry.handleUpstreamFrame({
      type: "input_accepted",
      request_id: forwarded.request_id,
      accepted: true,
    } as never);
    registry.handleUpstreamReconnected();
    expect(sent).toHaveLength(1);
  });

  test("one drop re-sends a frame once, the next reports it", () => {
    const { registry, sent, errors, send, down, up } = setup();
    send(userMessage("cm-1"));
    registry.handleUpstreamReconnected();
    expect(sent).toHaveLength(2);
    // Dropped again before the answer arrived: a second re-send cannot tell "not delivered" from
    // "delivered twice", so this one is reported instead.
    down();
    up();
    registry.handleUpstreamReconnected();
    expect(sent).toHaveLength(2);
    expect(errors()[0]).toMatchObject({ code: "delivery_uncertain", request_id: "web-1" });
  });

  test("a closed session is not reported to", () => {
    const { registry, errors, send, sessionId } = setup();
    send(userMessage("cm-1"));
    registry.remove(sessionId);
    registry.handleUpstreamReconnected();
    expect(errors()).toHaveLength(0);
  });
});
