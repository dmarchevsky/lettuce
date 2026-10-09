/**
 * The mod that keeps Codex and Claude Code workers away from agents blocked in
 * Agent → Tools (`agents/tool-access.ts`).
 *
 * A Codex worker is not a tool of its own: it is `Task` / `Agent` with
 * `subagent_type: "codex"`, and a follow-up is `SendAgentMessage` to a
 * `codex_<thread id>` agent; a Claude Code worker is the same with
 * `subagent_type: "claude-code"` and `claude_<session id>` (letta-code
 * `EXTERNAL_AGENT_ID_PREFIXES`). So this is a mod permission, not a hidden
 * tool — `letta.permissions.register` sees the calling agent and the
 * arguments, and its `deny` replaces the built-in decision in every permission
 * mode, Unrestricted included (letta-code `permissions/checker.ts`
 * `checkPermissionWithHooks`). It matches on the arguments, not the tool name,
 * so a renamed launcher is still covered.
 *
 * The blocked lists are baked in; a change re-renders the file and reloads mods.
 * A list can only name the agents that existed when it was rendered, and a
 * subagent reports its own id — so the mod also asks the BFF about any id the
 * list has never seen, which is how a block reaches an agent spawned after the
 * BFF connected (`agents/ancestry.ts`, `/internal/agent-access/`). Since
 * letta-code 0.34.4 a subagent can nest one more layer and start a worker of its
 * own, so without that question the block stops at the first generation.
 */

import { MODS_DIR } from "../internal-tools/mod.ts";

export const AGENT_POLICY_MOD_PATH = `${MODS_DIR}/lettuce-agent-policy.mjs`;

export const CODEX_BLOCKED_REASON =
  "Codex workers are turned off for this agent (Agent → Tools in the UI). Tell the user; do not try to run Codex another way.";

export const CLAUDE_BLOCKED_REASON =
  "Claude Code workers are turned off for this agent (Agent → Tools in the UI). Tell the user; do not try to run Claude Code another way.";

export function renderAgentPolicyMod(options: {
  codexBlocked: readonly string[];
  claudeBlocked?: readonly string[];
  /**
   * Where to ask about an agent this list has never seen (a subagent of a blocked
   * agent): the BFF's loopback origin, e.g. `http://127.0.0.1:8787`. Omit it and
   * only the agents named below are denied — the pre-0.34 behaviour.
   */
  accessBase?: string;
}): string {
  const header = `// lettuce agent-policy v3 — rendered by the lettuce BFF (bff/src/codex/policy-mod.ts).
// Edits here are overwritten on the BFF's next connect.`;
  const codex = [...options.codexBlocked].sort();
  const claude = [...(options.claudeBlocked ?? [])].sort();
  if (codex.length === 0 && claude.length === 0) {
    // The protocol cannot delete a file, so "nothing blocked" registers nothing.
    return `${header}
// No agent is blocked from anything: registers nothing.
export default function activate() {}
`;
  }
  return `${header}
const CODEX_BLOCKED = new Set(${JSON.stringify(codex)});
const CLAUDE_BLOCKED = new Set(${JSON.stringify(claude)});
const CODEX_REASON = ${JSON.stringify(CODEX_BLOCKED_REASON)};
const CLAUDE_REASON = ${JSON.stringify(CLAUDE_BLOCKED_REASON)};
const ACCESS = ${JSON.stringify(options.accessBase ?? "")};
// An agent's own block never changes while it lives, so one short answer per id
// covers every parallel call it makes.
const ASKED = new Map();
const ASK_TTL_MS = 30000;

function startsCodex(args) {
  if (args.subagent_type === "codex") return true;
  return typeof args.agent_id === "string" && args.agent_id.startsWith("codex_");
}

function startsClaude(args) {
  if (args.subagent_type === "claude-code") return true;
  return typeof args.agent_id === "string" && args.agent_id.startsWith("claude_");
}

/**
 * May this agent start an external worker? A subagent reports its own id, which
 * no baked list can name, so the BFF is asked — it walks the parent tags.
 * null: no answer, and an unanswered question denies nothing (an agent shell
 * could reach the CLI from Bash anyway; this is availability, not isolation).
 */
async function inherited(agentId, want) {
  if (!ACCESS) return null;
  const hit = ASKED.get(agentId);
  if (hit && Date.now() - hit.at < ASK_TTL_MS) return hit[want];
  let verdict = null;
  try {
    const response = await fetch(ACCESS + "/internal/agent-access/" + encodeURIComponent(agentId));
    const body = await response.json();
    if (body && typeof body.codex === "boolean") {
      verdict = { codex: body.codex === true, claude: body.claude === true, at: Date.now() };
      ASKED.set(agentId, verdict);
    }
  } catch (error) {
    // No answer from the BFF: fall back to what the baked lists already said.
  }
  return verdict ? verdict[want] : null;
}

export default function activate(letta) {
  if (!letta.capabilities?.permissions) return;
  return letta.permissions.register({
    id: "lettuce-external-workers-per-agent",
    description:
      "Codex and Claude Code workers blocked per agent, inherited by subagents (Agent -> Tools)",
    async check(event) {
      const args = event.args ?? {};
      const agentId = event.agentId;
      if (!agentId) return undefined;
      const wantCodex = startsCodex(args);
      const wantClaude = !wantCodex && startsClaude(args);
      if (!wantCodex && !wantClaude) return undefined;
      const want = wantCodex ? "codex" : "claude";
      const reason = wantCodex ? CODEX_REASON : CLAUDE_REASON;
      if ((wantCodex ? CODEX_BLOCKED : CLAUDE_BLOCKED).has(agentId)) {
        return { decision: "deny", reason };
      }
      if ((await inherited(agentId, want)) === false) return { decision: "deny", reason };
      return undefined;
    },
  });
}
`;
}
