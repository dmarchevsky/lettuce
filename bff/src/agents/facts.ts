/**
 * One `agent_retrieve` per agent, shared by the two things that ask about an
 * agent over the permanent connection: the display name in a push title
 * (`push/agent-names.ts`) and the `parent:` tags that decide what a subagent may
 * start (`agents/ancestry.ts`).
 *
 * Each of those keeps its own longer cache for its own reasons — a name is
 * trusted for ten minutes and a stale one still beats none — so without this a
 * subagent that both triggered a push and reached for a coding worker was
 * retrieved twice. The window here is short on purpose: it exists to collapse
 * lookups made close together, not to hold agent state.
 */

/** How long one agent's facts are reused. */
export const AGENT_FACTS_TTL_MS = 60_000;

/** Ceiling, like the ancestry cache: every subagent mints a new id, so without
 * one this grows for the life of a BFF meant to run for weeks. */
export const AGENT_FACTS_MAX = 500;

export interface AgentFactsValue {
  name: string | null;
  tags: readonly string[];
}

export class AgentFacts {
  private readonly cache = new Map<string, { facts: AgentFactsValue; at: number }>();

  constructor(
    private readonly retrieve: (agentId: string) => Promise<AgentFactsValue>,
    private readonly now: () => number = Date.now,
  ) {}

  async get(agentId: string): Promise<AgentFactsValue> {
    const cached = this.cache.get(agentId);
    if (cached && this.now() - cached.at < AGENT_FACTS_TTL_MS) return cached.facts;

    const facts = await this.retrieve(agentId);
    // Delete-then-set keeps insertion order equal to recency, so the eviction
    // below drops whatever was asked about least recently.
    this.cache.delete(agentId);
    this.cache.set(agentId, { facts, at: this.now() });
    while (this.cache.size > AGENT_FACTS_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return facts;
  }
}
