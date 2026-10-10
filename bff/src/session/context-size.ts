import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  AgentListResponseMessage,
  ExecuteCommandResponseMessage,
  WsProtocolMessage,
} from "@letta-ai/letta-code/app-server-protocol";
import { effectiveContextLimit, LETTA_DEFAULT_CONTEXT_LIMIT } from "./context-watchdog.ts";

/**
 * Keeps the window letta-code compacts against behind the point where the model
 * server actually refuses.
 *
 * Two numbers decide when a local conversation survives its own length:
 *
 *  - the **context size** `C` — what the server gives one request (llama.cpp's
 *    `n_ctx` per slot). Settings → Models declares it per model; the Context
 *    sheet can be told a different one.
 *  - the **max output** `M` — what every request promises to be allowed to
 *    generate. A request fits while `prompt + M ≤ C`, so `C − M` is the last
 *    prompt that fits at all.
 *
 * Compacting must happen before that, and for a little more reason than one:
 * the summariser is itself a request carrying the whole transcript, with the
 * model's own `max_tokens` (`letta-code src/backend/local/compaction.ts:398`),
 * so it needs room for its output too plus its instruction. Hence the budget
 * `max(M + 4 096, reserve)`, and the compact point `T = C − budget`.
 *
 * Upstream cannot be given a threshold — it computes
 * `window − min(16 384, 20 % of window)` from the window alone
 * (`provider-turn-executor.ts:contextCompactionThreshold`) — so what this does
 * is hand it a window whose own threshold lands exactly on `T`. That is the
 * whole trick: no second timer, no parallel compactor, upstream's own code does
 * the work, a few thousand tokens earlier than it would have.
 *
 * Writes go through letta-code's `/context-limit`, the same command the Context
 * sheet uses, so there is exactly one writer of that field's semantics and the
 * app-server keeps ownership of the value.
 */

/** Upstream's own reserve: `LOCAL_CONTEXT_COMPACTION_RESERVE_TOKENS`. */
export const COMPACTION_RESERVE_TOKENS = 16_384;

/** What the summariser's instruction and any schema overhead get on top of `M`. */
export const SUMMARY_SLACK_TOKENS = 4_096;

/** Never smaller than upstream's reserve, whatever the model promises. */
export function contextBudget(maxOutput?: number | null): number {
  return Math.max((maxOutput ?? 0) + SUMMARY_SLACK_TOKENS, COMPACTION_RESERVE_TOKENS);
}

/** Where the conversation compacts: the last prompt that still leaves the engine room. */
export function compactAt(context: number, maxOutput?: number | null): number {
  return Math.max(0, context - contextBudget(maxOutput));
}

/**
 * The window that makes letta-code's own threshold land on `compactAt`.
 *
 * Its threshold is `W − min(16 384, 20 % W)`, so inverting it has two branches:
 * above 81 920 tokens the reserve is the flat 16 384, below it the reserve is a
 * fifth of the window.
 */
export function harnessWindow(context: number, maxOutput?: number | null): number {
  const target = compactAt(context, maxOutput);
  // The size cannot hold the model's own output, so there is nothing compactible
  // left to aim at: the size itself is the least-wrong window. A PUT refuses such
  // a size; this covers one declared in Settings → Models.
  if (target <= 0) return context;
  const window =
    target >= 4 * COMPACTION_RESERVE_TOKENS
      ? target + COMPACTION_RESERVE_TOKENS
      : Math.ceil(target / 0.8);
  return Math.min(context, window);
}

/** letta-code's own threshold for a window it was given: `provider-turn-executor.ts`. */
export function upstreamThreshold(window: number): number {
  return Math.max(
    0,
    window - Math.min(COMPACTION_RESERVE_TOKENS, Math.max(1, Math.floor(window * 0.2))),
  );
}

/** Where a context size comes from, as the Context sheet words it. */
export type ContextSource = "typed" | "declared" | "default";

export interface ContextAccounting {
  /** C — what one request gets. */
  context: number;
  source: ContextSource;
  /** M, the output every request promises, when the model declares it. */
  maxOutput: number | null;
  /** T — where the conversation compacts. The gauge measures against this. */
  compactAt: number;
  /** The window that makes upstream's own threshold land on `compactAt`. */
  window: number;
  /** What the operator typed, per scope — what "Use automatic" would clear. */
  typed: { agent: number | null; conversation: number | null };
  /** What the declaration would have produced, when an override is in force. */
  automatic: { context: number; compactAt: number } | null;
}

/**
 * Every number the Context sheet shows, from what is in force and what is
 * declared. Kept here rather than in the browser so the value the sheet shows
 * and the value `ContextSizer` writes are computed by one function.
 */
export function accounting(input: {
  /** The window currently in force for this scope, as letta-code reads it. */
  limit: number;
  typedAgent: number | null;
  typedConversation: number | null;
  declared: ModelWindowCaps | null;
}): ContextAccounting {
  const typed = input.typedConversation ?? input.typedAgent;
  const source: ContextSource = typed !== null ? "typed" : input.declared ? "declared" : "default";
  const context = typed ?? input.declared?.contextWindow ?? input.limit;
  const maxOutput = input.declared?.maxTokens ?? null;
  // Nothing declared and nothing typed: the window in force is the only claim
  // about the server, so its own threshold is the honest compact point.
  const compactPoint =
    source === "default" ? upstreamThreshold(input.limit) : compactAt(context, maxOutput);
  // What the declaration would produce is shown whenever there is one, so the
  // editor can offer "back to automatic" as a preset even before anything was
  // typed — and the hint line only offers it for real once something was.
  const automatic = input.declared
    ? {
        context: input.declared.contextWindow,
        compactAt: compactAt(input.declared.contextWindow, input.declared.maxTokens),
      }
    : null;
  return {
    context,
    source,
    maxOutput,
    compactAt: compactPoint,
    window: source === "default" ? input.limit : harnessWindow(context, maxOutput),
    typed: { agent: input.typedAgent, conversation: input.typedConversation },
    automatic,
  };
}

/** What Settings → Models declares for one model handle — the two numbers that matter. */
export interface ModelWindowCaps {
  contextWindow: number;
  maxTokens: number;
}

export interface SizerUpstream {
  request<T extends WsProtocolMessage>(
    command: Record<string, unknown> & { type: string; request_id: string },
    timeoutMs: number,
  ): Promise<T>;
  isReady(): boolean;
}

export interface ContextSizeDeps {
  upstream: SizerUpstream;
  /** The declared caps per model handle, live from the store. */
  caps: () => Record<string, ModelWindowCaps>;
  log: (message: string) => void;
}

/** `agent.model`, falling back to reassembling it from the LLM config. */
export function agentModelHandle(agent: unknown): string | null {
  const a = (agent ?? {}) as Record<string, unknown>;
  if (typeof a.model === "string" && a.model) return a.model;
  const llm = (a.llm_config ?? {}) as { provider?: unknown; model?: unknown };
  if (typeof llm.provider === "string" && typeof llm.model === "string" && llm.model) {
    return `${llm.provider}/${llm.model}`;
  }
  const settings = (a.model_settings ?? {}) as { model?: unknown };
  return typeof settings.model === "string" && settings.model ? settings.model : null;
}

/**
 * Is the window in force one the operator chose by hand? Then it came from the old
 * Context sheet or `/context-limit` in the CLI — before this feature kept its own
 * record of such sizes — and it is adopted as a typed size instead of retuned. A
 * size set because the server really gives less has to survive a restart;
 * overwriting it with the declaration is how a working agent starts having every
 * request refused.
 *
 * shortcut: a hand-set window cannot be told from one we wrote under an older
 * declaration, so a window that matches nothing current is adopted; the sheet
 * shows it as "set by you" and Use automatic clears it.
 */
export function handSetWindow(inForce: number, declared: ModelWindowCaps | null): boolean {
  if (!declared || inForce === LETTA_DEFAULT_CONTEXT_LIMIT) return false;
  return (
    inForce !== declared.contextWindow &&
    inForce !== harnessWindow(declared.contextWindow, declared.maxTokens)
  );
}

/**
 * Context sizes the operator typed, keyed `"agent:<id>"` or `"conv:<id>"`, and
 * absent where the number comes from the model's declaration. Ours, not
 * upstream's: the field upstream stores is the window, which is derived, and
 * the raw size it was computed from would be lost on the next caps change.
 */
export class ContextSizeStore {
  private sizes = new Map<string, number>();

  constructor(
    private readonly filePath: string,
    private readonly onWriteError: (error: unknown) => void = () => {},
  ) {
    if (!existsSync(filePath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === "number" && value > 0) this.sizes.set(key, value);
        }
      }
    } catch {
      // Unreadable: fall back to the declarations rather than refuse to boot.
    }
  }

  get(key: string): number | null {
    return this.sizes.get(key) ?? null;
  }

  /** Both halves at once, for the Context sheet's first render. */
  all(): Record<string, number> {
    return Object.fromEntries(this.sizes);
  }

  set(key: string, tokens: number | null): void {
    if (tokens === null) this.sizes.delete(key);
    else this.sizes.set(key, tokens);
    this.persist();
  }

  private persist(): void {
    const snapshot = JSON.stringify(Object.fromEntries(this.sizes), null, 2);
    try {
      const temp = `${this.filePath}.tmp`;
      writeFileSync(temp, snapshot);
      renameSync(temp, this.filePath);
    } catch (error) {
      this.onWriteError(error);
    }
  }
}

export type SizeScope =
  | { kind: "agent"; agentId: string }
  | { kind: "conversation"; agentId: string; conversationId: string };

/** The store key: conversation scope is keyed by conversation, agent scope by agent. */
function scopeKey(scope: SizeScope): string {
  return scope.kind === "agent" ? `agent:${scope.agentId}` : `conv:${scope.conversationId}`;
}

export class ContextSizer {
  /** One sizing pass at a time: they all read and write the same few fields. */
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: ContextSizeDeps,
    private readonly sizes: ContextSizeStore,
  ) {}

  /**
   * The size in force for a scope: what the operator typed, else what the
   * model declares, else null when nothing declares anything.
   */
  sizeFor(
    scope: SizeScope,
    handle: string | null,
  ): { context: number; source: "typed" | "declared" } | null {
    const typed = this.sizes.get(scopeKey(scope));
    if (typed !== null) return { context: typed, source: "typed" };
    const caps = handle ? this.deps.caps()[handle] : undefined;
    if (caps) return { context: caps.contextWindow, source: "declared" };
    return null;
  }

  capsFor(handle: string | null): ModelWindowCaps | null {
    return (handle && this.deps.caps()[handle]) || null;
  }

  /** The agents upstream will list; null when the list itself failed. */
  private async listAgents(tag: string): Promise<AgentListResponseMessage["agents"] | null> {
    const response = await this.deps.upstream.request<AgentListResponseMessage>(
      {
        type: "agent_list",
        request_id: `bff-sizer-${tag}-${randomUUID()}`,
        query: { limit: 100 },
      },
      15_000,
    );
    return response.success ? response.agents : null;
  }

  /**
   * One agent: keep a window the operator set by hand, else write the window its
   * size implies. `adopt` is false where the window in force can only be ours — a
   * caps edit runs the moment the declaration changes, and adopting there would
   * freeze the very value it just invalidated and call it the operator's.
   * Returns whether a window was written.
   */
  private async sizeAgent(agent: { id: string }, adopt = true): Promise<boolean> {
    const scope: SizeScope = { kind: "agent", agentId: agent.id };
    const key = scopeKey(scope);
    const handle = agentModelHandle(agent);
    const caps = this.capsFor(handle);
    const inForce = effectiveContextLimit(agent, null);
    if (adopt && this.sizes.get(key) === null && handSetWindow(inForce, caps)) {
      this.sizes.set(key, inForce);
      this.deps.log(
        `context sizing: ${key} keeps its ${inForce.toLocaleString()}-token window as the size you set`,
      );
    }
    const size = this.sizeFor(scope, handle);
    if (!size) return false;
    const want = harnessWindow(size.context, caps?.maxTokens);
    if (inForce === want) return false;
    return (await this.write(scope, want)) !== null;
  }

  /** Every agent whose model declares caps, sized to what those caps imply. */
  async applyAll(): Promise<string> {
    return this.serialize(async () => {
      const agents = await this.listAgents("agents");
      if (!agents) return "context sizing: agent_list failed";
      let changed = 0;
      for (const agent of agents) if (await this.sizeAgent(agent)) changed += 1;
      return `context sizing: ${changed} agent(s) retuned to their model's window`;
    });
  }

  /** One agent — what the Context sheet's read asks for, so a new agent is sized on sight. */
  async ensure(agentId: string): Promise<void> {
    await this.serialize(async () => {
      const agent = (await this.listAgents("agent"))?.find((a) => a.id === agentId);
      if (agent) await this.sizeAgent(agent);
    });
  }

  /** Every agent running one model — after its caps were edited. */
  async applyHandle(handle: string): Promise<void> {
    await this.serialize(async () => {
      const agents = await this.listAgents("handle");
      if (!agents) return;
      for (const agent of agents) {
        // `false`: whatever window is in force was written under the old caps.
        if (agentModelHandle(agent) === handle) await this.sizeAgent(agent, false);
      }
    });
  }

  /**
   * Store (or clear) the size the operator typed and write the window it
   * implies. Returns letta-code's own confirmation line.
   */
  async setSize(scope: SizeScope, tokens: number | null, handle: string | null): Promise<string> {
    this.sizes.set(scopeKey(scope), tokens);
    const size = this.sizeFor(scope, handle);
    if (!size) throw new Error("Nothing declares this model's context size");
    const caps = this.capsFor(handle);
    const written = await this.serialize(() =>
      this.write(scope, harnessWindow(size.context, caps?.maxTokens)),
    );
    return written ?? "Context size stored, but the window could not be written.";
  }

  /** `/context-limit` on the scope: `default` is how an agent-wide setting is applied. */
  private async write(scope: SizeScope, tokens: number): Promise<string | null> {
    if (!this.deps.upstream.isReady()) return null;
    try {
      const response = await this.deps.upstream.request<ExecuteCommandResponseMessage>(
        {
          type: "execute_command",
          request_id: `bff-sizer-${randomUUID()}`,
          command_id: "context-limit",
          runtime: {
            agent_id: scope.agentId,
            conversation_id: scope.kind === "agent" ? "default" : scope.conversationId,
          },
          args: `${tokens} --override`,
        },
        60_000,
      );
      if (response.success === false) {
        this.deps.log(
          `context sizing: /context-limit refused for ${scopeKey(scope)}: ${
            response.output || "no reason given"
          }`,
        );
        return null;
      }
      this.deps.log(
        `context sizing: ${scopeKey(scope)} → window ${tokens.toLocaleString()} tokens`,
      );
      return response.output || `Context window set to ${tokens.toLocaleString()} tokens.`;
    } catch (error) {
      this.deps.log(
        `context sizing: could not write the window for ${scopeKey(scope)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** The command's own confirmation text, when it gave any. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.running.catch(() => undefined).then(work);
    this.running = next;
    return next;
  }
}
