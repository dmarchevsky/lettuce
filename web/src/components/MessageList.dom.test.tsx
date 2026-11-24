/**
 * The two render claims the last three flows could only prove by reading `MessageList.tsx`: a picture the agent
 * attached renders as a picture on its own row (not dropped by a row type that ignores `entry.images`), and a
 * delivery state says what actually happened — the round-3 review's headline was an ack the UI showed as
 * "Not sent" when the app-server had answered *no*, which is the opposite event.
 *
 * Both are pure claims about the rendered tree, and both were, until now, the kind of claim a review could only
 * make and a driver could only re-read.
 */
import { expect, test } from "bun:test";
import type { TranscriptEntry } from "../lib/messages.ts";
import type { SessionApi } from "../state/use-session.ts";
import { mount } from "../test/harness.tsx";
import { MessageList } from "./MessageList.tsx";

const session = {
  ready: true,
  request: async () => ({}),
  send: () => {},
  onFrame: () => () => {},
  onResync: () => () => {},
} as unknown as SessionApi;

function entry(over: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    id: "e1",
    kind: "user",
    date: "2026-11-24T10:00:00Z",
    seenAt: 1,
    text: "hello",
    ...over,
  } as TranscriptEntry;
}

function list(entries: TranscriptEntry[]) {
  return mount(
    <MessageList
      entries={entries}
      processing={false}
      session={session}
      cwd={null}
      onOpenFile={() => {}}
      onOpenPiRun={() => {}}
      showTimestamps={false}
      onEditMessage={() => {}}
      onResendMessage={() => {}}
      onAnswerQuestion={() => {}}
      agentId="a1"
      agentTint={undefined}
    />,
  );
}

test("a refused message says it was refused, not that it never arrived", async () => {
  const handle = await list([entry({ id: "u1", delivery: "refused" })]);
  const note = handle.find(".delivery-note");

  expect(note).not.toBeNull();
  const said = note?.textContent ?? "";
  expect(said).toContain("Not accepted");
  // The bug this stands guard against: the ack rendered as the other failure's words.
  expect(said).not.toContain("Not sent");
  handle.unmount();
});

test("a message that never reached the app-server says exactly that", async () => {
  const handle = await list([entry({ id: "u2", delivery: "unsent" })]);
  const said = handle.find(".delivery-note")?.textContent ?? "";
  expect(said).toContain("Not sent");
  expect(said).toContain("Send again");
  handle.unmount();
});

test("a delivered message carries no delivery note at all", async () => {
  const handle = await list([entry({ id: "u3" })]);
  expect(handle.find(".delivery-note")).toBeNull();
  expect(handle.text(".bubble")).toBe("hello");
  handle.unmount();
});

test("a message that carries a picture renders the picture beside its text", async () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/1wAAAAAASUVORK5CYII=";
  const handle = await list([
    entry({
      id: "u4",
      text: "look at this",
      images: [{ mediaType: "image/png", dataUrl: png }],
    }),
  ]);

  // The claim r18's third flow could only make by reading the row: a picture attached to a message reaches an
  // <img>, and the row that carries it still shows the text.
  const img = handle.find("img");
  expect(img).not.toBeNull();
  expect(img?.getAttribute("src") ?? "").toContain("data:image/png");
  expect(handle.text(".bubble")).toBe("look at this");
  handle.unmount();
});
