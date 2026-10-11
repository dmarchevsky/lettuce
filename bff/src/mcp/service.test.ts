import { describe, expect, test } from "bun:test";
import {
  ensureMcpServers,
  loadMcpServers,
  type McpIo,
  saveMcpServers,
  updateMcpServers,
} from "./service.ts";
import { MCP_SETTINGS_PATH, type McpServer, renderMcpSettings } from "./settings.ts";
import { MCP_SKILL_DIR, MCP_SKILL_NAME, renderMcpSkill } from "./skill.ts";

const SEED = "http://ddg-mcp:8000/mcp";
const DDG: McpServer = { name: "duckduckgo", transport: "http", url: SEED };

/**
 * The same line-based parse letta-code's `utils/frontmatter.ts` does: each
 * unindented line is `key: value`, split at the first colon, value verbatim.
 * Later keys win, which is exactly how an injected line would take over.
 */
function parseFrontmatterForTest(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  const fields: Record<string, string> = {};
  for (const line of (match?.[1] ?? "").split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0 && line === line.trimStart()) {
      fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  return fields;
}

function memoryIo(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const events: string[] = [];
  const io: McpIo = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => {
      events.push(`write ${path}`);
      files.set(path, content);
    },
    enableSkill: async (path) => {
      events.push(`enable ${path}`);
    },
    disableSkill: async (name) => {
      events.push(`disable ${name}`);
    },
  };
  return { io, files, events };
}

describe("ensureMcpServers", () => {
  // Web search is a native tool now (web-tools/), so nothing is seeded.
  test("a fresh install starts with an empty list and no skill", async () => {
    const { io, files, events } = memoryIo();
    expect(await ensureMcpServers(io)).toEqual([]);
    expect(await loadMcpServers(io)).toEqual([]);
    expect(files.has(MCP_SETTINGS_PATH)).toBe(true);
    expect(events.at(-1)).toBe(`disable ${MCP_SKILL_NAME}`);
  });

  test("a configured server gets the skill, linked after its files exist", async () => {
    const { io, files, events } = memoryIo({ [MCP_SETTINGS_PATH]: renderMcpSettings([DDG]) });
    expect(await ensureMcpServers(io)).toEqual([DDG]);
    expect(files.has(`${MCP_SKILL_DIR}/SKILL.md`)).toBe(true);
    expect(files.has(`${MCP_SKILL_DIR}/scripts/mcp.sh`)).toBe(true);
    // Linked only after its files exist — skill_enable validates SKILL.md.
    expect(events.at(-1)).toBe(`enable ${MCP_SKILL_DIR}`);
  });

  test("an existing list is left as written and its skill re-rendered", async () => {
    const other: McpServer = { name: "notes", command: "notes-mcp" };
    const settings = renderMcpSettings([other]);
    const { io, files } = memoryIo({ [MCP_SETTINGS_PATH]: settings });
    expect(await ensureMcpServers(io)).toEqual([other]);
    expect(files.get(MCP_SETTINGS_PATH)).toBe(settings);
    expect(files.get(`${MCP_SKILL_DIR}/SKILL.md`)).toContain("notes");
  });
});

describe("saveMcpServers", () => {
  test("an empty list unlinks the skill instead of advertising nothing", async () => {
    const { io, events } = memoryIo();
    await saveMcpServers(io, []);
    expect(events).toEqual([`write ${MCP_SETTINGS_PATH}`, `disable ${MCP_SKILL_NAME}`]);
  });
});

describe("renderMcpSkill", () => {
  const [skill, wrapper] = renderMcpSkill([DDG, { name: "notes", command: "x" }]);

  test("frontmatter name matches the directory, and the description names every server", () => {
    expect(skill?.path).toBe(`${MCP_SKILL_NAME}/SKILL.md`);
    const frontmatter = parseFrontmatterForTest(skill?.content ?? "");
    expect(frontmatter.name).toBe(MCP_SKILL_NAME);
    expect(frontmatter.description).toContain("duckduckgo, notes");
  });

  // An agent that never loads the skill still sees its description, so that
  // line alone has to get it past upstream's empty-list "None" reminder.
  test("the description names both traps", () => {
    const description = String(parseFrontmatterForTest(skill?.content ?? "").description);
    expect(description).toContain("MCP servers with available tools: None");
    expect(description).toContain("plain `letta mcp`");
  });

  test("agents with native bridge tools are sent to them", () => {
    const description = String(parseFrontmatterForTest(skill?.content ?? "").description);
    expect(description).toContain("mcp_search / mcp_call");
    expect(skill?.content).toContain("`mcp_call_write`");
  });

  test("web search is sent to the native tools, never an MCP server", () => {
    expect(skill?.content).not.toContain("mcp__duckduckgo__search");
    expect(skill?.content).toContain("`web_search`");
  });

  test("a line break in a server name cannot break the frontmatter", () => {
    const [odd] = renderMcpSkill([{ name: "a\nname: evil", command: "x" }]);
    const frontmatter = parseFrontmatterForTest(odd?.content ?? "");
    expect(frontmatter.name).toBe(MCP_SKILL_NAME);
  });

  test("the wrapper points letta mcp at the shared list", () => {
    expect(wrapper?.path).toBe(`${MCP_SKILL_NAME}/scripts/mcp.sh`);
    expect(wrapper?.content).toContain(
      'HOME=/root/.letta/mcp-home exec letta mcp "$@" --agent agent-local-mcp-global',
    );
  });
});

describe("updateMcpServers", () => {
  const NOTES: McpServer = { name: "notes", transport: "http", url: "http://notes:1/mcp" };
  const OTHER: McpServer = { name: "other", transport: "http", url: "http://other:1/mcp" };

  /** A slow io is what makes the race observable: without a queue both callers
   * read the same list before either writes, and the second write is a whole
   * file that never knew about the first server. */
  function slowIo() {
    const files = new Map<string, string>();
    const wait = () => new Promise((resolve) => setTimeout(resolve, 5));
    const io: McpIo = {
      read: async (path) => {
        await wait();
        return files.get(path) ?? null;
      },
      write: async (path, content) => {
        await wait();
        files.set(path, content);
      },
      enableSkill: async () => {
        await wait();
      },
      disableSkill: async () => {
        await wait();
      },
    };
    return { io, files };
  }

  test("two mutations started together both land", async () => {
    const { io } = slowIo();
    await Promise.all([
      updateMcpServers(io, (servers) => [...servers, NOTES]),
      updateMcpServers(io, (servers) => [...servers, OTHER]),
    ]);
    expect(await loadMcpServers(io)).toEqual([NOTES, OTHER]);
  });

  test("returning the list unchanged writes nothing", async () => {
    const { io, files } = slowIo();
    const wrote = await updateMcpServers(io, (servers) => servers);
    expect(wrote).toBe(false);
    expect(files.size).toBe(0);
  });

  test("a failed mutation does not wedge the ones after it", async () => {
    const { io } = slowIo();
    const failing = updateMcpServers(io, () => {
      throw new Error("disk gone");
    });
    await expect(failing).rejects.toThrow("disk gone");
    await updateMcpServers(io, (servers) => [...servers, NOTES]);
    expect(await loadMcpServers(io)).toEqual([NOTES]);
  });
});
