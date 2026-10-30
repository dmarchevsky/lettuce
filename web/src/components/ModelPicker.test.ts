import { describe, expect, test } from "bun:test";
import { filterGroups, toolsetLabel } from "./ModelPicker.tsx";

const toolset = (id: string, label: string, featured = true) => ({
  id,
  label,
  description: "",
  featured,
});

describe("toolsetLabel", () => {
  const toolsets = [
    toolset("auto", "Auto"),
    toolset("full", "Full"),
    toolset("x", "Hidden one", false),
  ];

  test("the toolset in force is named by its own label", () => {
    expect(toolsetLabel("full", toolsets)).toBe("Full");
  });

  test("nothing chosen yet reads as Auto", () => {
    // The preference is "auto" until the first device-status frame reports a
    // choice, and `null` is before that frame entirely.
    expect(toolsetLabel("auto", [])).toBe("Auto");
    expect(toolsetLabel(null, toolsets)).toBe("Auto");
  });

  test("a toolset that is not offered still does not crash the header", () => {
    // A preference set before the endpoint changed what it serves: the header is
    // the only place the user can see what is in force while it is collapsed.
    expect(toolsetLabel("gone", toolsets)).toBe("Auto");
  });

  test("a non-featured toolset in force is still named", () => {
    expect(toolsetLabel("x", toolsets)).toBe("Hidden one");
  });
});

describe("filterGroups", () => {
  const model = (handle: string, label: string) => ({ id: handle, handle, label, description: "" });
  const groups = [
    {
      provider: "openrouter",
      models: [
        model("openrouter/anthropic/claude-opus-4.5", "Anthropic: Claude Opus 4.5"),
        model("openrouter/moonshotai/kimi-k2.6", "MoonshotAI: Kimi K2.6"),
      ],
    },
    { provider: "llama.cpp", models: [model("llama.cpp/Gemma-4", "Gemma-4")] },
  ];

  test("no query keeps every group whole", () => {
    expect(filterGroups(groups, " ")).toEqual(
      groups.map((group) => ({ ...group, total: group.models.length })),
    );
  });

  test("a group with no match is dropped, and the rest keep their total", () => {
    expect(filterGroups(groups, "opus")).toEqual([
      { provider: "openrouter", models: [groups[0]!.models[0]!], total: 2 },
    ]);
  });

  test("the handle counts, not only the label", () => {
    // The row hides a handle that repeats its label, so the vendor in an
    // OpenRouter handle is matched even where no title names it.
    expect(filterGroups(groups, "moonshotai/").map((group) => group.models.length)).toEqual([1]);
    expect(filterGroups(groups, "llama.cpp").map((group) => group.provider)).toEqual(["llama.cpp"]);
  });
});
