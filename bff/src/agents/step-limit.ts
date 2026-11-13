import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAgentId } from "./id-list.ts";

/**
 * Per-agent step limits: the most model calls one turn may make (Agent →
 * General). Enforced by the BFF's `StepLimitWatchdog`, not by letta-code's own
 * `execution_settings.max_turns` — see `session/step-limit-watchdog.ts` for why.
 *
 * Only agents with a limit are stored; an agent without an entry has no limit.
 */

/** A limit is a positive safe integer, the same rule upstream applies to `max_turns`. */
export function parseStepLimit(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  return undefined;
}

export class AgentStepLimitStore {
  private entries = new Map<string, number>();
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
        const limit = parseStepLimit(raw);
        if (isAgentId(agentId) && typeof limit === "number") this.entries.set(agentId, limit);
      }
    } catch {
      // Unreadable: no agent has a limit rather than the BFF failing to boot.
    }
  }

  /** The agent's limit, or null for none. */
  get(agentId: string): number | null {
    return this.entries.get(agentId) ?? null;
  }

  /** Returns whether anything changed. Null clears the agent's limit. */
  set(agentId: string, limit: number | null): boolean {
    if (!isAgentId(agentId)) throw new Error("Not an agent id");
    if (limit !== null && parseStepLimit(limit) === undefined) {
      throw new Error("A step limit must be a positive integer");
    }
    if (this.get(agentId) === limit) return false;
    if (limit === null) this.entries.delete(agentId);
    else this.entries.set(agentId, limit);
    this.persist();
    return true;
  }

  /** Resolves once every queued write has settled; never rejects. */
  drain(): Promise<void> {
    return this.writeQueue;
  }

  private persist(): void {
    const snapshot = JSON.stringify(Object.fromEntries(this.entries), null, 2);
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
