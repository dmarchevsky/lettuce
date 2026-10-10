import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { frameScopeKey } from "./buffer.ts";

/**
 * Token usage for one agent turn, as served to the web client
 * (`web/src/lib/usage.ts` reads this exact shape; the packages cannot share
 * code).
 *
 * The prompt is split the way the model server reports it. letta-code's local
 * executor (pi-ai `parseChunkUsage`) sends `prompt_tokens` **net of the cache**
 * and the reused part as `cached_input_tokens` — on llama.cpp that is the slot's
 * prompt cache. So a 85k-token call that reused 84k of its prefix arrives as
 * `prompt_tokens: 790`. Cache writes are counted as evaluated, because they
 * were.
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
  /** Context window occupancy after the latest step, when reported. */
  contextTokens?: number;
}

export interface TurnUsageRecord extends TurnUsage {
  turn_id: string | null;
  /** When the BFF saw the turn end. */
  at: string;
}

/** Conversations remembered at once; the least recently active is dropped first. */
export const TURN_USAGE_SCOPES = 200;

/**
 * Where the last finished turn per scope is remembered between BFF restarts.
 * The disk is an optional sink so the log stays testable without a filesystem.
 */
export interface UsageDisk {
  load(): Record<string, TurnUsageRecord>;
  save(records: Record<string, TurnUsageRecord>): void;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * One `usage_statistics` delta (or the listener's `UsageStatistics` shape) as
 * a `TurnUsage`, or null for anything else.
 */
export function readUsageStatistics(raw: unknown): TurnUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const cacheReported =
    typeof u.cached_input_tokens === "number" || typeof u.cache_write_tokens === "number";
  const evaluated = count(u.prompt_tokens) + count(u.cache_write_tokens);
  const cached = count(u.cached_input_tokens);
  const usage: TurnUsage = {
    promptTokens: evaluated,
    cachedTokens: cached,
    lastPromptTokens: evaluated + cached,
    lastCachedTokens: cached,
    cacheReported,
    completionTokens: count(u.completion_tokens),
    reasoningTokens: count(u.reasoning_tokens),
    // One chunk is one step unless it says otherwise.
    steps: typeof u.step_count === "number" ? count(u.step_count) : 1,
  };
  if (typeof u.context_tokens === "number") usage.contextTokens = u.context_tokens;
  return usage;
}

/** Fold one step into a running turn total. Context is a level, not a sum: the latest wins. */
export function addUsage(total: TurnUsage | null, step: TurnUsage): TurnUsage {
  if (!total) return { ...step };
  const next: TurnUsage = {
    promptTokens: total.promptTokens + step.promptTokens,
    cachedTokens: total.cachedTokens + step.cachedTokens,
    lastPromptTokens: step.lastPromptTokens,
    lastCachedTokens: step.lastCachedTokens,
    cacheReported: total.cacheReported || step.cacheReported,
    completionTokens: total.completionTokens + step.completionTokens,
    reasoningTokens: total.reasoningTokens + step.reasoningTokens,
    steps: total.steps + step.steps,
  };
  const context = step.contextTokens ?? total.contextTokens;
  if (context !== undefined) next.contextTokens = context;
  return next;
}

/**
 * The last finished turn's usage, and the turn in flight so far, per
 * conversation — so every device shows the same numbers.
 *
 * Upstream reports usage only live: one `usage_statistics` stream delta per
 * model step, and `turn_finished.usage` only when the conversation carries CLI
 * `execution_settings` (which we never set). Nothing is stored with the
 * history. When browsers kept it, each showed the last turn *it* happened to
 * watch — a phone that slept through three turns showed the context of the
 * fourth-last one. The BFF sees every scope's frames on its permanent
 * connection, so it keeps them here.
 *
 * Subagent deltas share the parent's scope (with `subagent_id`); they are not
 * the parent's model calls and are skipped. The last finished turn is mirrored
 * to `disk` when one is given, so a BFF restart does not blank every gauge;
 * the turn in flight is memory only.
 *
 * A compaction empties the remembered occupancy rather than updating it: the
 * `context_tokens_after` in the compaction stats counts the message history
 * alone — no system prompt, no tool schemas — so adopting it would draw a gauge
 * far emptier than the next request. "Unknown" is the honest reading, and the
 * next step's usage replaces it within seconds of the next turn.
 */
export class TurnUsageLog {
  private readonly scopes = new Map<
    string,
    { last: TurnUsageRecord | null; current: TurnUsage | null }
  >();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly disk?: UsageDisk,
  ) {
    if (!disk) return;
    for (const [key, record] of Object.entries(disk.load())) {
      if (readTurnUsageRecord(record)) this.scopes.set(key, { last: record, current: null });
    }
  }

  observe(frame: WsProtocolMessage): void {
    if (frame.type === "stream_delta") {
      if ((frame as { subagent_id?: unknown }).subagent_id) return;
      const delta = (frame as { delta?: unknown }).delta as
        | { message_type?: unknown; event_type?: unknown; command_id?: unknown }
        | undefined;
      if (isCompactionDelta(delta)) {
        this.forgetOccupancy(frameScopeKey(frame));
        return;
      }
      if (delta?.message_type !== "usage_statistics") return;
      const step = readUsageStatistics(delta);
      const key = frameScopeKey(frame);
      if (!step || !key) return;
      const entry = this.touch(key);
      entry.current = addUsage(entry.current, step);
      return;
    }
    if (frame.type !== "turn_finished") return;
    const key = frameScopeKey(frame);
    if (!key) return;
    const entry = this.touch(key);
    const folded = entry.current;
    entry.current = null;
    const reported = readUsageStatistics((frame as { usage?: unknown }).usage);
    const usage = reported ? mergeReported(folded, reported) : folded;
    if (!usage) return;
    entry.last = {
      ...usage,
      turn_id: typeof frame.turn_id === "string" ? frame.turn_id : null,
      at: this.now().toISOString(),
    };
    this.persist();
  }

  /**
   * A conversation just got shorter: drop the occupancy so the gauge reads
   * "— / 128k" instead of the pre-compaction number it can no longer mean.
   */
  private forgetOccupancy(key: string | null): void {
    const entry = key ? this.scopes.get(key) : undefined;
    if (!entry) return;
    entry.current = null;
    if (!entry.last) return;
    const { contextTokens: _dropped, ...rest } = entry.last;
    entry.last = rest as TurnUsageRecord;
    this.persist();
  }

  get(scopeKey: string): { last: TurnUsageRecord | null; current: TurnUsage | null } {
    const entry = this.scopes.get(scopeKey);
    return { last: entry?.last ?? null, current: entry?.current ?? null };
  }

  private persist(): void {
    if (!this.disk) return;
    const records: Record<string, TurnUsageRecord> = {};
    for (const [key, entry] of this.scopes) if (entry.last) records[key] = entry.last;
    try {
      this.disk.save(records);
    } catch {
      // The gauge survives in memory; a failing disk is never a turn failure.
    }
  }

  private touch(key: string): { last: TurnUsageRecord | null; current: TurnUsage | null } {
    const entry = this.scopes.get(key) ?? { last: null, current: null };
    // Re-insert so Map order tracks recency; the oldest scope is evicted first.
    this.scopes.delete(key);
    this.scopes.set(key, entry);
    if (this.scopes.size > TURN_USAGE_SCOPES) {
      const oldest = this.scopes.keys().next().value;
      if (oldest !== undefined) this.scopes.delete(oldest);
    }
    return entry;
  }
}

/**
 * Whether this stream delta says the conversation was just compacted.
 *
 * Auto-compaction streams an `event_message{event_type:"compaction"}` and then a
 * `summary_message` carrying `compaction_stats`; a manual `/compact` streams
 * neither — its only wire trace is the `slash_command_end` for `compact`. All
 * three mean the same thing to the gauge: the history just got shorter.
 */
function isCompactionDelta(
  delta: { message_type?: unknown; event_type?: unknown; command_id?: unknown } | undefined,
): boolean {
  if (!delta) return false;
  if (delta.message_type === "summary_message") return true;
  if (delta.message_type === "event_message") return delta.event_type === "compaction";
  return delta.message_type === "slash_command_end" && delta.command_id === "compact";
}

/** Shape check for a record read back from disk. */
function readTurnUsageRecord(record: unknown): TurnUsageRecord | null {
  if (!record || typeof record !== "object") return null;
  const r = record as TurnUsageRecord;
  return typeof r.promptTokens === "number" && typeof r.completionTokens === "number" ? r : null;
}

/**
 * `turn_finished.usage` is the authoritative total, but it has no per-step
 * view, so the latest step's prompt comes from the fold when there is one.
 */
function mergeReported(folded: TurnUsage | null, reported: TurnUsage): TurnUsage {
  if (!folded) return reported;
  const merged: TurnUsage = {
    ...reported,
    lastPromptTokens: folded.lastPromptTokens,
    lastCachedTokens: folded.lastCachedTokens,
    cacheReported: reported.cacheReported || folded.cacheReported,
  };
  const context = reported.contextTokens ?? folded.contextTokens;
  if (context !== undefined) merged.contextTokens = context;
  return merged;
}

/**
 * `UsageDisk` over one JSON file: `{ "<agent>\u0000<conversation>": TurnUsageRecord }`.
 * Written temp-then-rename like the other BFF preference files, because a
 * half-written gauge file would mean no gauge after a restart, not a wrong one.
 */
export class JsonUsageDisk implements UsageDisk {
  constructor(
    private readonly filePath: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  load(): Record<string, TurnUsageRecord> {
    if (!existsSync(this.filePath)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed as Record<string, TurnUsageRecord>;
    } catch (error) {
      this.onError(error);
      return {};
    }
  }

  save(records: Record<string, TurnUsageRecord>): void {
    try {
      const temp = `${this.filePath}.tmp`;
      writeFileSync(temp, JSON.stringify(records, null, 2));
      renameSync(temp, this.filePath);
    } catch (error) {
      this.onError(error);
    }
  }
}
