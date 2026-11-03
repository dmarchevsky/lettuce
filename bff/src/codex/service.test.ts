import { describe, expect, test } from "bun:test";
import {
  type CodexFileIo,
  getCodexRun,
  listCodexRuns,
  loadCodexSettings,
  reapplyCodexSettings,
  saveCodexSettings,
} from "./service.ts";
import { CODEX_CONFIG_PATH, CODEX_SETTINGS_LEGACY_PATH, CODEX_SETTINGS_PATH } from "./settings.ts";

function memoryIo(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const io: CodexFileIo = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => {
      writes.push(path);
      files.set(path, content);
    },
    listFiles: async (dir) => {
      const names = [...files.keys()]
        .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/"))
        .map((path) => path.slice(dir.length + 1));
      return names.length ? names : null;
    },
  };
  return { io, files, writes };
}

const READY = { baseUrl: "http://h/v1", model: "m", enabled: true };

describe("saving settings", () => {
  test("writes Codex's files before the switch the shim reads", async () => {
    const { io, writes } = memoryIo();
    await saveCodexSettings(io, READY);
    // The switch is written last — and mirrored under its pre-rename name, so a
    // shim baked into an older app-server image still finds it.
    expect(writes.slice(-2)).toEqual([CODEX_SETTINGS_PATH, CODEX_SETTINGS_LEGACY_PATH]);
    expect(writes).toContain(CODEX_CONFIG_PATH);
  });

  test("keeps a saved key across a later save that does not mention it", async () => {
    const { io } = memoryIo();
    await saveCodexSettings(io, { ...READY, apiKey: "secret" });
    const next = await saveCodexSettings(io, { model: "m2" });
    expect(next.apiKey).toBe("secret");
  });

  test("settings stored under the pre-rename name are still read", async () => {
    const first = memoryIo();
    const saved = await saveCodexSettings(first.io, { ...READY, apiKey: "secret" });
    // What an install that predates the rename has on disk: the old file only.
    const stored = first.files.get(CODEX_SETTINGS_LEGACY_PATH) ?? "";
    const { io, files } = memoryIo({ [CODEX_SETTINGS_LEGACY_PATH]: stored });
    expect((await loadCodexSettings(io)).apiKey).toBe("secret");
    expect(await reapplyCodexSettings(io)).toBe(true);
    // ...and the reapply promotes it, so the old file is no longer load-bearing.
    expect(JSON.parse(files.get(CODEX_SETTINGS_PATH) ?? "{}").model).toBe(saved.model);
  });

  test("an invalid update writes nothing", async () => {
    const { io, writes } = memoryIo();
    await expect(saveCodexSettings(io, { enabled: true })).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  test("reapply does nothing until settings were saved once", async () => {
    const { io, writes } = memoryIo();
    expect(await reapplyCodexSettings(io)).toBe(false);
    expect(writes).toEqual([]);
    await saveCodexSettings(io, READY);
    expect(await reapplyCodexSettings(io)).toBe(true);
  });

  test("with the profile token dropped, reapply forces the switch off but keeps the endpoint", async () => {
    const { io, files } = memoryIo();
    await saveCodexSettings(io, { ...READY, apiKey: "secret" });
    expect(await reapplyCodexSettings(io, { profileEnabled: false })).toBe(true);
    const stored = JSON.parse(files.get(CODEX_SETTINGS_PATH) ?? "{}") as Record<string, unknown>;
    expect(stored.enabled).toBe(false);
    // The rest survives: re-adding the token needs one flip of the switch.
    expect(stored.baseUrl).toBe("http://h/v1");
    expect(stored.apiKey).toBe("secret");
  });
});

const T1 = "01a0e3cf-b69f-7eb0-8b79-4cc6ad0c0e9a"; // 2026-09-27
const T2 = "01a0e3d0-0000-7000-8000-000000000000"; // a little later, same day
const DAY = "/root/.letta/codex/sessions/2026/09/27";

function rollout(threadId: string, prompt: string, cwd = "/work/a") {
  return [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd } }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
    }),
  ].join("\n");
}

describe("runs", () => {
  test("a run is found by thread id alone", async () => {
    const { io } = memoryIo({
      [`${DAY}/rollout-2026-09-27T17-00-35-${T1}.jsonl`]: rollout(T1, "first"),
    });
    expect((await getCodexRun(io, T1))?.prompt).toBe("first");
    expect(await getCodexRun(io, T2)).toBeNull();
  });

  test("recent runs are newest first and capped", async () => {
    const { io } = memoryIo({
      [`${DAY}/rollout-2026-09-27T17-00-35-${T1}.jsonl`]: rollout(T1, "first"),
      [`${DAY}/rollout-2026-09-27T18-00-00-${T2}.jsonl`]: rollout(T2, "second"),
      [`${DAY}/notes.txt`]: "ignored",
    });
    const now = Date.UTC(2026, 8, 27, 20);
    expect((await listCodexRuns(io, 10, now)).runs.map((r) => r.prompt)).toEqual([
      "second",
      "first",
    ]);
    expect((await listCodexRuns(io, 1, now)).runs).toHaveLength(1);
  });

  test("a run carries the agent whose workspace it happened in", async () => {
    const { io } = memoryIo({
      [`${DAY}/rollout-2026-09-27T17-00-35-${T1}.jsonl`]: rollout(T1, "mine", "/work/agent-1/sub"),
      [`${DAY}/rollout-2026-09-27T18-00-00-${T2}.jsonl`]: rollout(T2, "theirs", "/work/agent-2"),
    });
    const { runs } = await listCodexRuns(io, 10, Date.UTC(2026, 8, 27, 20));
    expect(runs.map((r) => [r.prompt, r.agentId])).toEqual([
      ["theirs", "agent-2"],
      ["mine", "agent-1"],
    ]);
  });

  test("filtered to one agent: its runs come back and the rest are counted", async () => {
    const { io } = memoryIo({
      [`${DAY}/rollout-2026-09-27T17-00-35-${T1}.jsonl`]: rollout(T1, "mine"),
      [`${DAY}/rollout-2026-09-27T18-00-00-${T2}.jsonl`]: rollout(T2, "theirs", "/work/b"),
    });
    const now = Date.UTC(2026, 8, 27, 20);
    const scoped = await listCodexRuns(io, 10, now, "a");
    expect(scoped.runs.map((r) => r.prompt)).toEqual(["mine"]);
    expect(scoped.other).toBe(1);
    // Unfiltered, nothing is hidden by a filter that was never on.
    expect(await listCodexRuns(io, 10, now)).toEqual({
      runs: expect.arrayContaining([expect.objectContaining({ prompt: "theirs" })]),
      other: 0,
    });
  });

  test("a cron run in /work itself belongs to no one", async () => {
    const { io } = memoryIo({
      [`${DAY}/rollout-2026-09-27T17-00-35-${T1}.jsonl`]: rollout(T1, "nightly", "/work"),
    });
    const { runs } = await listCodexRuns(io, 10, Date.UTC(2026, 8, 27, 20));
    expect(runs[0]?.agentId).toBeNull();
  });
});
