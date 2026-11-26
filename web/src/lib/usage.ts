/**
 * Token usage for one agent turn, as the BFF serves it at `GET /api/turn-usage`
 * (`bff/src/session/turn-usage.ts` builds this exact shape; the two packages
 * cannot import from each other).
 *
 * The BFF keeps it because upstream reports usage only live — one
 * `usage_statistics` delta per model step — and stores none of it with the
 * history. When each browser folded the deltas it happened to see, a phone
 * that slept through the latest turns showed an old one, and two devices
 * disagreed about the same conversation.
 *
 * The prompt is split as the model server reports it: `promptTokens` is what
 * was evaluated, `cachedTokens` what the prompt cache (llama.cpp's slot cache)
 * supplied. A big context with a tiny evaluated prompt is a cache hit, not a
 * contradiction.
 */
export interface TurnUsage {
  /** Prompt tokens the model actually evaluated, summed over every step. */
  promptTokens: number;
  /** Prompt tokens served from the prompt cache, summed over every step. */
  cachedTokens: number;
  /** The latest step's whole prompt — evaluated plus cached. */
  lastPromptTokens: number;
  /** Of `lastPromptTokens`, the part served from the cache. */
  lastCachedTokens: number;
  /** Whether the backend reported cache use at all (absent is not zero). */
  cacheReported: boolean;
  completionTokens: number;
  /** Of `completionTokens`, the thinking part, when the model reports it. */
  reasoningTokens: number;
  /** Model calls in the turn; each tool round-trip is another step. */
  steps: number;
  /** Context window occupancy after the latest step, when the backend reports it. */
  contextTokens?: number;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** One usage object from the BFF, or null when it is not one. */
export function readTurnUsage(raw: unknown): TurnUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  if (typeof u.promptTokens !== "number" || typeof u.completionTokens !== "number") return null;
  return {
    promptTokens: count(u.promptTokens),
    cachedTokens: count(u.cachedTokens),
    lastPromptTokens: count(u.lastPromptTokens),
    lastCachedTokens: count(u.lastCachedTokens),
    cacheReported: u.cacheReported === true,
    completionTokens: count(u.completionTokens),
    reasoningTokens: count(u.reasoningTokens),
    steps: typeof u.steps === "number" ? count(u.steps) : 1,
    ...(typeof u.contextTokens === "number" ? { contextTokens: u.contextTokens } : {}),
  };
}

/**
 * The usage to show from `GET /api/turn-usage`: the turn in flight when there
 * is one (`current`), else the last finished one. Null when the BFF has none.
 */
export function pickTurnUsage(body: unknown): TurnUsage | null {
  const b = (body && typeof body === "object" ? body : {}) as { last?: unknown; current?: unknown };
  return readTurnUsage(b.current) ?? readTurnUsage(b.last);
}

/** Share of `part` in `whole` as a whole percent, 0 when there is no whole. */
export function percentOf(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** 950 → "950", 12_345 → "12.3k", 1_234_567 → "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Above this share of the limit the gauge turns amber: compaction is near. */
export const CONTEXT_WARN_RATIO = 0.8;

export interface ContextGauge {
  /** "25k / 128k", or "235k / 225k over" once past the point. */
  label: string;
  /**
   * The true share, allowed above 100: a conversation past its compaction point
   * is at 104 % of it, and rounding that down to 100 hides the only number that
   * says the point has been passed. Bars clamp it; text does not.
   */
  percent: number;
  warn: boolean;
  /**
   * Past the compaction point: the bar is full and the conversation is over it.
   * A distinct state, not a hotter shade of amber, because nothing automatic is
   * coming to help — the next request is the one that fails.
   */
  over: boolean;
  /** How far past, in tokens (0 unless `over`). */
  overBy: number;
}

/** The bar's width: the true share, clamped to the bar. */
export function gaugeWidth(gauge: ContextGauge): number {
  return Math.max(0, Math.min(100, gauge.percent));
}

/** How full the context is, for the header gauge and the details panel. */
export function contextGauge(used: number, limit: number): ContextGauge {
  const ratio = limit > 0 ? used / limit : 0;
  const over = limit > 0 && used > limit;
  return {
    label: `${formatTokens(used)} / ${formatTokens(limit)}${over ? " over" : ""}`,
    percent: Math.round(ratio * 100),
    warn: !over && ratio >= CONTEXT_WARN_RATIO,
    over,
    overBy: over ? Math.round(used - limit) : 0,
  };
}
