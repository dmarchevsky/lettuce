import { describe, expect, test } from "bun:test";
import { parseToolArgs, shortenPath, summarizeToolCall } from "./tool-summary.ts";

const CWD = "/work/agent-local-5025acf5-930c-4dc9-801c-a2b3cfe96a81";

function summarize(name: string, args: string, cwd: string | null = CWD) {
  return summarizeToolCall(name, parseToolArgs(args), cwd);
}

describe("parseToolArgs", () => {
  test("returns null for the truncated JSON a mid-stream call carries", () => {
    expect(parseToolArgs('{"command":"git sta')).toBeNull();
  });

  test("returns null rather than a bare value for non-object JSON", () => {
    expect(parseToolArgs('"just a string"')).toBeNull();
    expect(parseToolArgs("[1,2]")).toBeNull();
  });

  test("parses a complete argument object", () => {
    expect(parseToolArgs('{"command":"ls"}')).toEqual({ command: "ls" });
  });
});

describe("shortenPath", () => {
  test("drops the agent workspace prefix", () => {
    expect(shortenPath(`${CWD}/notes/todo.md`, CWD)).toBe("notes/todo.md");
  });

  test("names the memfs memory root, which lives outside every workspace", () => {
    expect(
      shortenPath("/data/local-backend/memfs/agent-local-abc/memory/system/persona.md", CWD),
    ).toBe("memory/system/persona.md");
  });

  test("leaves an unrelated absolute path intact", () => {
    expect(shortenPath("/root/.letta/settings.json", CWD)).toBe("/root/.letta/settings.json");
  });

  test("survives a null cwd", () => {
    expect(shortenPath("/work/other/file.md", null)).toBe("/work/other/file.md");
  });
});

describe("summarizeToolCall", () => {
  test("a Bash call reads as the command, with its description beneath", () => {
    expect(
      summarize("Bash", '{"command":"git --version","description":"Check git version"}'),
    ).toEqual({ headline: "$ git --version", mono: true, subtitle: "Check git version" });
  });

  test("a Bash call with no description carries no subtitle", () => {
    expect(summarize("Bash", '{"command":"echo hi"}')).toEqual({
      headline: "$ echo hi",
      mono: true,
    });
  });

  test("file tools read as the path, shortened against the workspace", () => {
    expect(summarize("Read", `{"file_path":"${CWD}/src/index.ts"}`)?.headline).toBe("src/index.ts");
    expect(summarize("Write", `{"file_path":"${CWD}/out.md"}`)?.headline).toBe("out.md");
    expect(summarize("Edit", `{"file_path":"${CWD}/a/b.ts"}`)?.headline).toBe("a/b.ts");
  });

  test("MultiEdit counts its edits", () => {
    expect(summarize("MultiEdit", `{"file_path":"${CWD}/a.ts","edits":[1,2,3]}`)).toEqual({
      headline: "a.ts",
      mono: true,
      subtitle: "3 edits",
    });
  });

  test("TodoWrite pluralises correctly", () => {
    expect(summarize("TodoWrite", '{"todos":[1]}')?.headline).toBe("1 todo");
    expect(summarize("TodoWrite", '{"todos":[1,2]}')?.headline).toBe("2 todos");
  });

  test("Grep names the pattern and where it looked", () => {
    expect(summarize("Grep", `{"pattern":"TODO","path":"${CWD}/src"}`)?.headline).toBe(
      "TODO  in src",
    );
  });

  test("the memory tool reads as its command and target", () => {
    expect(
      summarize(
        "memory",
        '{"command":"str_replace","file_path":"system/human.md","reason":"note"}',
      ),
    ).toEqual({ headline: "str_replace  system/human.md", mono: true, subtitle: "note" });
  });

  test("the Memory tool reads as the path it looked at", () => {
    expect(summarize("Memory", `{"path":"projects/code"}`)).toEqual({
      headline: "projects/code",
      mono: true,
    });
    expect(summarize("Memory", `{}`)).toBeNull();
  });

  test("snake_case aliases from the other toolsets are recognised", () => {
    expect(summarize("read_file", `{"path":"${CWD}/x.ts"}`)?.headline).toBe("x.ts");
  });

  test("a Wake create names the wake and when it fires", () => {
    expect(
      summarize("Wake", '{"action":"create","name":"check build","after_seconds":300}'),
    ).toEqual({
      headline: "create  check build",
      subtitle: "in 300 s",
    });
    expect(
      summarize("Wake", '{"action":"create","name":"digest","cron":"0 8 * * *"}')?.subtitle,
    ).toBe("cron 0 8 * * * (UTC)");
  });

  test("a Wake cancel names the id and a list stands alone", () => {
    expect(summarize("Wake", '{"action":"cancel","id":"wake_1"}')).toEqual({
      headline: "cancel  wake_1",
    });
    expect(summarize("Wake", '{"action":"list"}')).toEqual({ headline: "list" });
  });

  test("a WatchPR call shows the pull request it watches", () => {
    expect(summarize("WatchPR", '{"url":"https://github.com/o/r/pull/7"}')).toEqual({
      headline: "https://github.com/o/r/pull/7",
      mono: true,
    });
  });

  test("an unknown tool falls through so the raw JSON still speaks for it", () => {
    expect(summarize("SomeFutureTool", '{"whatever":1}')).toBeNull();
  });

  test("a known tool missing its key argument falls through rather than showing an empty line", () => {
    expect(summarize("Bash", '{"description":"no command here"}')).toBeNull();
  });

  test("a call still streaming its arguments has no summary yet", () => {
    expect(summarize("Bash", '{"command":"git sta')).toBeNull();
  });

  test("no tool name means no summary", () => {
    expect(summarizeToolCall(undefined, { command: "ls" }, CWD)).toBeNull();
  });
});

describe("native web tools", () => {
  test("web_search shows its query, fetch_webpage its URL", () => {
    expect(summarizeToolCall("web_search", { query: "weather redmond" }, null)).toEqual({
      headline: "weather redmond",
    });
    expect(summarizeToolCall("fetch_webpage", { url: "https://a.example/p" }, null)).toEqual({
      headline: "https://a.example/p",
      mono: true,
    });
  });
});
