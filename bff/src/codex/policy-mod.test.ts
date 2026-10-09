import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_BLOCKED_REASON, CODEX_BLOCKED_REASON, renderAgentPolicyMod } from "./policy-mod.ts";

interface Registered {
  id: string;
  check: (event: Record<string, unknown>) => unknown;
}

/** Loads the rendered mod and runs its `activate` against a fake `letta`. */
async function activate(source: string): Promise<Registered[]> {
  const file = join(mkdtempSync(join(tmpdir(), "policy-mod-")), "mod.mjs");
  writeFileSync(file, source);
  const mod = (await import(file)) as { default: (letta: unknown) => unknown };
  const registered: Registered[] = [];
  mod.default({
    capabilities: { permissions: true },
    permissions: {
      register(permission: Registered) {
        registered.push(permission);
        return () => {};
      },
    },
  });
  return registered;
}

/** Stands in for the BFF's `/internal/agent-access/<id>` while the mod asks. */
function answerWith(body: string): { base: string; stop: () => void } {
  const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop() };
}

describe("the agent-policy mod", () => {
  test("nothing blocked registers nothing", async () => {
    expect(await activate(renderAgentPolicyMod({ codexBlocked: [], claudeBlocked: [] }))).toEqual(
      [],
    );
  });

  test("a blocked agent cannot start or message a Codex worker", async () => {
    const [permission] = await activate(renderAgentPolicyMod({ codexBlocked: ["agent-b"] }));
    const check = async (agentId: string | null, toolName: string, args: Record<string, unknown>) =>
      await permission?.check({ agentId, toolName, args });
    const deny = { decision: "deny", reason: CODEX_BLOCKED_REASON };

    expect(await check("agent-b", "Task", { subagent_type: "codex", prompt: "x" })).toEqual(deny);
    expect(await check("agent-b", "Agent", { subagent_type: "codex" })).toEqual(deny);
    expect(
      await check("agent-b", "SendAgentMessage", {
        agent_id: "codex_0199aa00-0000-7000-8000-000000000000",
      }),
    ).toEqual(deny);
    // Everything else, and every other agent, is left to the normal rules.
    expect(await check("agent-b", "Task", { subagent_type: "general-purpose" })).toBeUndefined();
    expect(await check("agent-b", "SendAgentMessage", { agent_id: "agent-c" })).toBeUndefined();
    expect(await check("agent-b", "Bash", { command: "ls" })).toBeUndefined();
    expect(await check("agent-a", "Task", { subagent_type: "codex" })).toBeUndefined();
    expect(await check(null, "Task", { subagent_type: "codex" })).toBeUndefined();
    // A Codex block is not a Claude block.
    expect(await check("agent-b", "Task", { subagent_type: "claude-code" })).toBeUndefined();
  });

  test("a blocked agent cannot start or message a Claude Code worker", async () => {
    const [permission] = await activate(
      renderAgentPolicyMod({ codexBlocked: [], claudeBlocked: ["agent-c"] }),
    );
    const check = async (agentId: string | null, toolName: string, args: Record<string, unknown>) =>
      await permission?.check({ agentId, toolName, args });
    const deny = { decision: "deny", reason: CLAUDE_BLOCKED_REASON };

    expect(await check("agent-c", "Task", { subagent_type: "claude-code", prompt: "x" })).toEqual(
      deny,
    );
    expect(
      await check("agent-c", "SendAgentMessage", {
        agent_id: "claude_3218941e-1e45-471c-af5f-37f91e709f7a",
      }),
    ).toEqual(deny);
    expect(await check("agent-c", "Task", { subagent_type: "codex" })).toBeUndefined();
    expect(await check("agent-c", "Bash", { command: "ls" })).toBeUndefined();
    expect(await check("agent-a", "Task", { subagent_type: "claude-code" })).toBeUndefined();
  });

  test("an agent the list has never seen is denied what the BFF says it may not start", async () => {
    // This is the subagent of a blocked agent: its own id is in no baked list, and
    // the BFF answers for the whole `parent:` chain.
    const bff = answerWith(`{"codex":false,"claude":true}`);
    const [permission] = await activate(
      renderAgentPolicyMod({ codexBlocked: ["agent-b"], accessBase: bff.base }),
    );
    const check = async (agentId: string, args: Record<string, unknown>) =>
      await permission?.check({ agentId, toolName: "Task", args });

    expect(await check("agent-sub-9", { subagent_type: "codex" })).toEqual({
      decision: "deny",
      reason: CODEX_BLOCKED_REASON,
    });
    expect(await check("agent-sub-9", { subagent_type: "claude-code" })).toBeUndefined();
    expect(await check("agent-sub-9", { subagent_type: "general-purpose" })).toBeUndefined();
    bff.stop();
  });

  test("no answer from the BFF denies nothing", async () => {
    const bff = answerWith("not json");
    const [permission] = await activate(
      renderAgentPolicyMod({ codexBlocked: ["agent-b"], accessBase: bff.base }),
    );
    expect(
      await permission?.check({
        agentId: "agent-sub-9",
        toolName: "Task",
        args: { subagent_type: "codex" },
      }),
    ).toBeUndefined();
    bff.stop();
    // And a base that is not listening behaves the same way.
    const gone = answerWith("{}");
    const port = gone.base;
    gone.stop();
    const [second] = await activate(
      renderAgentPolicyMod({ codexBlocked: ["agent-b"], accessBase: port }),
    );
    expect(
      await second?.check({
        agentId: "agent-sub-9",
        toolName: "Task",
        args: { subagent_type: "codex" },
      }),
    ).toBeUndefined();
  });

  test("without a BFF to ask, only the baked lists deny", async () => {
    const [permission] = await activate(renderAgentPolicyMod({ codexBlocked: ["agent-b"] }));
    expect(
      await permission?.check({
        agentId: "agent-sub-9",
        toolName: "Task",
        args: { subagent_type: "codex" },
      }),
    ).toBeUndefined();
    // The baked list still works with no network at all.
    expect(
      await permission?.check({
        agentId: "agent-b",
        toolName: "Task",
        args: { subagent_type: "codex" },
      }),
    ).toEqual({ decision: "deny", reason: CODEX_BLOCKED_REASON });
  });
});
