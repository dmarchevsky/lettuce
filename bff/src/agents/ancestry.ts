/**
 * Which agents a turn's tool access actually covers once subagents are in play.
 *
 * A letta-code subagent is a real agent with an id of its own, tagged
 * `parent:<parent agent id>` (`agent/subagents/manager.ts`). Per-agent tool
 * access is keyed by the id the calling turn reports, so a block set on agent A
 * says nothing about what A spawns — and since letta-code 0.34.4 a subagent can
 * nest one layer further and start an external coding worker of its own. Walking
 * the `parent:` tags and intersecting is what makes "off for this agent" also
 * mean off for everything it spawned.
 *
 * Still availability, not isolation: an agent shell is unconfined in the
 * container, so nothing here stops a determined agent — it stops the accident.
 */

/** How long a resolved chain is trusted. An agent's own tags never change and a
 * subagent id is never reused, so this only bounds how long a policy edit takes
 * to reach a long-lived subagent. */
export const ANCESTRY_TTL_MS = 10 * 60_000;

/** Cycle guard for a malformed tag, not a policy limit. */
const MAX_DEPTH = 16;

/** The `parent:<id>` tag letta-code stamps on a spawned subagent, if present. */
export function parentOf(tags: readonly string[]): string | null {
  for (const tag of tags) {
    if (typeof tag !== "string" || !tag.startsWith("parent:")) continue;
    const id = tag.slice("parent:".length);
    if (id) return id;
  }
  return null;
}

/**
 * Agent ids resolved through the `parent:` tags, self first. A tag whose agent
 * cannot be retrieved just ends the chain — an unknown ancestor blocks nothing,
 * which is the same default an untagged agent already has.
 */
export class AgentAncestry {
  private readonly cache = new Map<string, { chain: string[]; at: number }>();

  constructor(
    private readonly tagsOf: (agentId: string) => Promise<readonly string[]>,
    private readonly now: () => number = Date.now,
  ) {}

  async chain(agentId: string): Promise<string[]> {
    const cached = this.cache.get(agentId);
    if (cached && this.now() - cached.at < ANCESTRY_TTL_MS) return cached.chain;

    const chain: string[] = [];
    let current: string | null = agentId;
    while (current && chain.length < MAX_DEPTH && !chain.includes(current)) {
      chain.push(current);
      let tags: readonly string[] = [];
      try {
        tags = await this.tagsOf(current);
      } catch {
        tags = [];
      }
      current = parentOf(tags);
    }
    this.cache.set(agentId, { chain, at: this.now() });
    return chain;
  }
}
