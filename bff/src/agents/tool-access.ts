import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAgentId } from "./id-list.ts";

/**
 * Which of the shared tool families each agent may use — Codex workers,
 * Claude Code workers and Google. Settings → Codex workers, → Claude Code
 * workers and → Google decide what exists for everyone; this narrows it per
 * agent (Agent → Tools).
 *
 * Enforced inside letta-code through the mods the BFF renders, with no
 * upstream change: Google tools carry an `isEnabled(ctx)` that hides them from
 * a blocked agent's turn, and a mod permission denies a blocked agent's
 * `subagent_type: "codex"` / `"claude-code"` launch and `codex_…` / `claude_…`
 * follow-ups (a mod `deny` wins over every permission mode, Unrestricted
 * included). The BFF re-checks at call time from the agent id the mods send.
 *
 * Availability, not isolation: agent shells are unconfined in the container,
 * so a blocked agent could still reach google-mcp, `codex` or `claude` from
 * Bash. Real isolation needs one app-server container per agent.
 */

export type GoogleAccess = "full" | "read" | "off";

export interface AgentToolAccess {
  codex: boolean;
  claude: boolean;
  google: GoogleAccess;
  /** Whether the agent may dispatch to the remote pi worker (its mod hides
   * the pi tools from a blocked agent's turn, like Google's isEnabled). */
  pi: boolean;
}

export const DEFAULT_TOOL_ACCESS: Readonly<AgentToolAccess> = Object.freeze({
  codex: true,
  claude: true,
  google: "full",
  pi: true,
});

const GOOGLE_ACCESS: readonly GoogleAccess[] = ["full", "read", "off"];

export function parseToolAccess(value: unknown): AgentToolAccess | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.codex !== "boolean") return null;
  // `claude` arrived later than the other two: a stored entry (or an old
  // browser) without it means the default, not a broken entry — dropping it
  // would silently lift that agent's other blocks.
  if ("claude" in record && typeof record.claude !== "boolean") return null;
  if ("pi" in record && typeof record.pi !== "boolean") return null;
  if (!GOOGLE_ACCESS.includes(record.google as GoogleAccess)) return null;
  return {
    codex: record.codex,
    claude: record.claude !== false,
    google: record.google as GoogleAccess,
    // `pi` arrived last: an old entry without it means the default (on).
    pi: record.pi !== false,
  };
}

function isDefault(access: AgentToolAccess): boolean {
  return (
    access.codex === DEFAULT_TOOL_ACCESS.codex &&
    access.claude === DEFAULT_TOOL_ACCESS.claude &&
    access.google === DEFAULT_TOOL_ACCESS.google &&
    access.pi === DEFAULT_TOOL_ACCESS.pi
  );
}

/** Only agents that differ from the default are stored; an unknown agent gets the default. */
export class AgentToolAccessStore {
  private entries = new Map<string, AgentToolAccess>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly onWriteError: (error: unknown) => void,
  ) {
    if (!existsSync(filePath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [agentId, raw] of Object.entries(parsed)) {
        const access = parseToolAccess(raw);
        if (isAgentId(agentId) && access && !isDefault(access)) this.entries.set(agentId, access);
      }
    } catch {
      // Unreadable: every agent gets the default rather than the BFF failing to boot.
    }
  }

  get(agentId: string): AgentToolAccess {
    return this.entries.get(agentId) ?? { ...DEFAULT_TOOL_ACCESS };
  }

  /** Every agent with a non-default entry. */
  all(): Record<string, AgentToolAccess> {
    return Object.fromEntries(this.entries);
  }

  /** Returns whether anything changed. */
  set(agentId: string, access: AgentToolAccess): boolean {
    if (!isAgentId(agentId)) throw new Error("Not an agent id");
    const current = this.get(agentId);
    // Every field counts in the comparison. `pi` was left out when it landed,
    // which made the Agent → Tools pi row a no-op: a pi-only flip never
    // persisted, and an entry holding `pi: false` (written whenever it arrived
    // beside a codex/claude/google change) could never be cleared — the mod
    // kept hiding the pi tools while the UI said the agent had them.
    if (
      current.codex === access.codex &&
      current.claude === access.claude &&
      current.google === access.google &&
      current.pi === access.pi
    )
      return false;
    if (isDefault(access)) this.entries.delete(agentId);
    else this.entries.set(agentId, { ...access });
    this.persist();
    return true;
  }

  /** Resolves once every queued write has settled; never rejects. */
  drain(): Promise<void> {
    return this.writeQueue;
  }

  private persist(): void {
    const snapshot = JSON.stringify(this.all(), null, 2);
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => {
        try {
          const temp = `${this.filePath}.tmp`;
          writeFileSync(temp, snapshot);
          renameSync(temp, this.filePath);
        } catch (error) {
          this.onWriteError(error);
        }
      });
  }
}

/** Agent ids whose entry matches `pick`, sorted so a rendered mod is stable. */
export function agentsWhere(
  all: Record<string, AgentToolAccess>,
  pick: (access: AgentToolAccess) => boolean,
): string[] {
  return Object.entries(all)
    .filter(([, access]) => pick(access))
    .map(([agentId]) => agentId)
    .sort();
}
