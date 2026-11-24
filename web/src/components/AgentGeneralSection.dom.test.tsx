/**
 * The staged-form case r18 merged in from r32: two consecutive fresh reviews each found three save-path defects
 * in this screen while 15 pure-helper tests stayed green — because the bugs lived in what the form *shows* and
 * what it *sends*, which a pure test of the parse helpers cannot see. These three assertions are the shape of
 * that class: invalid input disables Save, a rejected save keeps what was typed and says so, and a Save sends
 * exactly the parts that changed.
 *
 * The fakes below are the whole seam: `AgentsApi` and `SessionApi` are the props the component is handed, and the
 * step limit is a BFF `fetch`, so the test owns every call the save path can make.
 */
import { afterEach, expect, test } from "bun:test";
import type { AgentDetail, AgentsApi } from "../state/use-agents.ts";
import type { SessionApi } from "../state/use-session.ts";
import { click, mount, pick as setSelect, settle, type } from "../test/harness.tsx";
import { AgentGeneralSection } from "./AgentGeneralSection.tsx";
import { ToastLayer } from "./Toast.tsx";

interface Calls {
  updateAgent: Array<{ id: string; draft: unknown }>;
  saveAgentCompaction: Array<{ id: string; record: Record<string, unknown> }>;
  setAvatar: Array<{ id: string; pref: unknown }>;
  stepLimitWrites: Array<number | null>;
}

interface Fixture {
  handle: Awaited<ReturnType<typeof mount>>;
  calls: Calls;
  /** The name / step-limit / drop-percent inputs and the Save button, by their labels. */
  field(label: string): HTMLElement;
  save(): HTMLButtonElement | null;
  toast(): string;
}

function detail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: "a1",
    name: "Ada",
    system: "You are Ada.",
    modelHandle: null,
    compaction: {
      mode: "sliding_window",
      slidingWindowPercent: 30,
      source: { mode: "sliding_window", sliding_window_percentage: 0.3 },
    },
    ...over,
  };
}

/** Mount the screen with every write recorded; `save` and `stepLimit` decide what fails. */
async function setup(
  options: { saveFails?: boolean; stepLimit?: number | null } = {},
): Promise<Fixture> {
  const calls: Calls = {
    updateAgent: [],
    saveAgentCompaction: [],
    setAvatar: [],
    stepLimitWrites: [],
  };
  const agents = {
    agents: [],
    conversations: [],
    agentId: "a1",
    conversationId: null,
    loading: false,
    error: null,
    selectAgent: () => {},
    selectConversation: () => {},
    refreshAgents: async () => {},
    refreshConversations: async () => {},
    refreshAvatars: async () => {},
    avatars: {},
    pinned: new Set<string>(),
    setPinned: async () => {},
    retrieveAgent: async () => detail(),
    createAgent: async () => ({ id: "a2", faceFailed: false }),
    updateAgent: async (id: string, draft: unknown) => {
      calls.updateAgent.push({ id, draft });
      if (options.saveFails) throw new Error("upstream said no");
    },
    saveAgentCompaction: async (id: string, record: Record<string, unknown>) => {
      calls.saveAgentCompaction.push({ id, record });
    },
    setAvatar: async (id: string, pref: unknown) => {
      // The pref is recorded, so a test can see exactly what Save staged for the face.
      calls.setAvatar.push({ id: `${id}`, pref });
      void pref;
    },
    deleteAgent: async () => {},
  } as unknown as AgentsApi;

  const session = {
    ready: true,
    request: async () => ({ entries: [] }),
    send: () => {},
  } as unknown as SessionApi;

  const previousFetch = globalThis.fetch;
  // One route answers for the whole screen: the step-limit setting, GET to read and PUT to write.
  globalThis.fetch = (async (_url: unknown, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      const sent = JSON.parse(String(init?.body)) as { limit: number | null };
      calls.stepLimitWrites.push(sent.limit);
      return Response.json({ limit: sent.limit });
    }
    return Response.json({ limit: options.stepLimit ?? null });
  }) as typeof globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  const handle = await mount(
    <>
      <AgentGeneralSection session={session} agents={agents} agentId="a1" />
      <ToastLayer />
    </>,
  );
  await settle();

  return {
    handle,
    calls,
    field: (label) =>
      handle.all("label.field, div.field").find((el) => (el.textContent ?? "").startsWith(label)) ??
      (() => {
        throw new Error(`no field labelled ${label}`);
      })(),
    save: () => handle.button("Save"),
    toast: () => handle.find(".toast")?.textContent?.trim() ?? "",
  };
}

test("an unparseable limit disables Save instead of saving as something else", async () => {
  // Loaded with a limit, so emptying the field is a real change and "no change" cannot be what disables Save.
  const f = await setup({ stepLimit: 8 });
  const limit = f.field("Model call limit").querySelector("input") as HTMLInputElement;
  expect(limit.value).toBe("8");

  await type(limit, "12");
  expect((f.save() as HTMLButtonElement).disabled).toBe(false);

  // "0" and junk are both not a limit — and neither may be sent as "no limit".
  await type(limit, "0");
  expect((f.save() as HTMLButtonElement).disabled).toBe(true);
  await type(limit, "1e");
  expect((f.save() as HTMLButtonElement).disabled).toBe(true);

  // Empty is a whole different thing: it *is* a value (no limit), so Save is offered and the write sends null.
  await type(limit, "");
  expect((f.save() as HTMLButtonElement).disabled).toBe(false);
  f.handle.unmount();
});

test("a rejected save keeps what was typed and says it failed", async () => {
  const f = await setup({ saveFails: true });
  const name = f.field("Name").querySelector("input") as HTMLInputElement;

  await type(name, "Ada Lovelace");
  await click(f.save()!);
  await settle();

  // The typed value survives: a form that resets on failure throws the edit away.
  expect(name.value).toBe("Ada Lovelace");
  expect(f.toast()).toContain("Could not save");
  expect(f.toast()).toContain("upstream said no");
  expect(f.calls.updateAgent.length).toBe(1);
  f.handle.unmount();
});

test("a name-only save sends the name and nothing else", async () => {
  const f = await setup();
  const name = f.field("Name").querySelector("input") as HTMLInputElement;

  await type(name, "Ada Lovelace");
  await click(f.save()!);
  await settle();

  expect(f.calls.updateAgent).toEqual([
    { id: "a1", draft: { name: "Ada Lovelace", system: "You are Ada.", modelHandle: null } },
  ]);
  // The compaction record is its own write: an untouched form must not rewrite it.
  expect(f.calls.saveAgentCompaction.length).toBe(0);
  expect(f.calls.setAvatar.length).toBe(0);
  expect(f.calls.stepLimitWrites.length).toBe(0);
  expect(f.toast()).toBe("Saved — agents see it on their next turn");
  f.handle.unmount();
});

test("a staged system-prompt edit rides the same Save (and typing into a <textarea> reaches React)", async () => {
  const f = await setup();
  const textarea = f.field("Base system prompt").querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe("You are Ada.");

  // The harness's `type` must use the textarea's own value setter; the input one throws inside the
  // DOM after assigning, so the edit would land in the field and never reach React — Save would stay
  // disabled and the test would read like a broken form.
  await type(textarea, "You are Ada, and you check sources.");
  expect((f.save() as HTMLButtonElement).disabled).toBe(false);

  await click(f.save()!);
  await settle();

  expect(f.calls.updateAgent[0]?.draft).toMatchObject({
    system: "You are Ada, and you check sources.",
  });
  f.handle.unmount();
});

test("a mode switch that hides the percentage writes the loaded fraction, not junk", async () => {
  const f = await setup();
  const select = f.field("Compaction").querySelector("select") as HTMLSelectElement;
  expect(f.field("Drop per compaction (%)")).toBeDefined();

  const name = f.field("Name").querySelector("input") as HTMLInputElement;
  await type(name, "Ada Lovelace");
  // "all" has no drop-percentage field; whatever the hidden field held must not be sent as a new value.
  await type(f.field("Drop per compaction (%)").querySelector("input") as HTMLInputElement, "junk");
  await setSelect(select, "all");
  expect(
    f.handle.all("label.field").some((el) => (el.textContent ?? "").startsWith("Drop per")),
  ).toBe(false);

  await click(f.save()!);
  await settle();

  expect(f.calls.saveAgentCompaction.length).toBe(1);
  const record = f.calls.saveAgentCompaction[0]?.record ?? {};
  expect(record.mode).toBe("all");
  expect(record.sliding_window_percentage).toBeCloseTo(0.3, 5);
  f.handle.unmount();
});
