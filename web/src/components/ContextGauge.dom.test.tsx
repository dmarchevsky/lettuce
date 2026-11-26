/**
 * The two things this sheet could not say before, both proven by mounting rather
 * than by reading the component (a render claim read off source is how four flows
 * shipped a wrong one): a conversation **past** its compaction point rendered
 * exactly like one at it — a full amber bar either way — and a window the engine
 * was not using rendered as though it were, so the sheet's own numbers looked
 * self-consistent while nothing compacted.
 */
import { describe, expect, test } from "bun:test";
import type { ContextAccounting } from "../lib/context-size.ts";
import type { TurnUsage } from "../lib/usage.ts";
import { click, mount, settle } from "../test/harness.tsx";
import { ContextGauge, ContextSheet } from "./ContextGauge.tsx";

const usage = (contextTokens: number): TurnUsage => ({
  promptTokens: 2_254,
  cachedTokens: 459_154,
  lastPromptTokens: 231_908,
  lastCachedTokens: 229_684,
  cacheReported: true,
  completionTokens: 3_071,
  reasoningTokens: 1_966,
  steps: 2,
  contextTokens,
});

const accounting = (over: Partial<ContextAccounting> = {}): ContextAccounting => ({
  context: 262_144,
  source: "typed",
  maxOutput: 32_768,
  compactAt: 225_280,
  window: 241_664,
  typed: { agent: null, conversation: 262_144 },
  typedScope: "conversation",
  automatic: { context: 262_144, compactAt: 225_280 },
  mismatch: null,
  ...over,
});

const limit = { tokens: 241_664, source: "conversation" as const };

describe("ContextGauge", () => {
  test("past the compaction point it says over, in the class and the label", async () => {
    const h = await mount(
      <ContextGauge
        usage={usage(234_979)}
        limit={limit}
        accounting={accounting()}
        onOpen={() => {}}
      />,
    );
    expect(h.find(".ctx-gauge")?.className).toContain("over");
    expect(h.text(".ctx-gauge-label")).toBe("235k / 225k over");
    expect(h.find(".ctx-bar > i")?.getAttribute("style")).toContain("100%");
    expect(h.find(".ctx-gauge")?.getAttribute("aria-label")).toContain("9,699 past");
  });

  test("exactly at the point is warn, not over", async () => {
    const h = await mount(
      <ContextGauge
        usage={usage(225_280)}
        limit={limit}
        accounting={accounting()}
        onOpen={() => {}}
      />,
    );
    expect(h.find(".ctx-gauge")?.className).toContain("warn");
    expect(h.find(".ctx-gauge")?.className).not.toContain("over");
    expect(h.text(".ctx-gauge-label")).toBe("225k / 225k");
  });

  test("with no usage yet the gauge is still the way into the sheet", async () => {
    const h = await mount(
      <ContextGauge usage={null} limit={limit} accounting={accounting()} onOpen={() => {}} />,
    );
    expect(h.text(".ctx-gauge-label")).toBe("— / 225k");
  });
});

describe("ContextSheet", () => {
  test("a mismatch is said out loud, and the verb fixes the right scope", async () => {
    const sizes: Array<{ tokens: number | null; scope: "agent" | "conversation" }> = [];
    const h = await mount(
      <ContextSheet
        usage={usage(234_979)}
        limit={limit}
        accounting={accounting({
          window: 262_144,
          compactAt: 229_376,
          mismatch: { window: 262_144, refusedAt: 229_376, engineAt: 245_760, armedLate: true },
        })}
        processing={false}
        onSetSize={async (tokens, scope) => {
          sizes.push({ tokens, scope });
          return "ok";
        }}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    );
    expect(h.text(".ctx-big")).toContain("5,603 over");
    expect(h.text(".ctx-big")).toContain("102% to compacting");
    expect(h.find(".ctx-bar.big")?.className).toContain("over");
    const hint = h.find(".ctx-hint.warn");
    expect(hint?.textContent).toContain("229,376");
    expect(hint?.textContent).toContain("245,760");
    expect(hint?.textContent).toContain("This conversation carries its own size");

    const fix = h.button("Fix the window");
    expect(fix).not.toBeNull();
    await settle(() => click(fix as HTMLButtonElement));
    // The fix is the same write the sizer does: the size stands, the window moves.
    expect(sizes).toEqual([{ tokens: 262_144, scope: "conversation" }]);
  });

  test("a window that only compacts early is said plainly, with no verb", async () => {
    // The other direction is context left on the table, not a conversation
    // headed for an error, and it gets no button.
    const h = await mount(
      <ContextSheet
        usage={usage(100_000)}
        limit={{ tokens: 107_520, source: "conversation" }}
        accounting={accounting({
          window: 107_520,
          compactAt: 91_136,
          mismatch: { window: 107_520, refusedAt: 229_376, engineAt: 91_136, armedLate: false },
        })}
        processing={false}
        onSetSize={async () => "ok"}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    );
    expect(h.find(".ctx-hint.warn")).toBeNull();
    expect(h.byText("Fix the window")).toBeNull();
    expect(h.text(".ctx-hint:not(.warn)")).toContain("gives up context sooner");
  });

  test("with the window in force there is no alarm and no verb", async () => {
    const h = await mount(
      <ContextSheet
        usage={usage(148_000)}
        limit={limit}
        accounting={accounting()}
        processing={false}
        onSetSize={async () => "ok"}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    );
    expect(h.find(".ctx-hint.warn")).toBeNull();
    expect(h.byText("Fix the window")).toBeNull();
    // The ordinary hint stays: a typed size still offers to go back to automatic.
    expect(h.byText("Use automatic")).not.toBeNull();
  });
});
