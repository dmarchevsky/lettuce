/**
 * Claude Code run viewer: turns a Claude transcript file into readable steps.
 *
 * letta-code keeps only a Claude worker's final message; every command and its
 * output is dropped. Claude Code itself writes the whole run to
 * `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<session-id>.jsonl` (slug = the
 * absolute cwd with non-alphanumerics replaced by `-`), appending as it goes —
 * so the file is both the history and the live view.
 *
 * The format is internal to Claude Code and can change between versions, so
 * everything here is lenient: unknown entry types and unknown content parts are
 * skipped, never fatal. Verified against 2.1.285 and 2.1.289.
 */

/** Claude session ids are plain UUIDv4 — unlike Codex's UUIDv7, no time bits. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isClaudeSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/** `claude_<session id>`, the synthetic agent id letta-code reports for a worker. */
export function sessionIdFromAgentId(agentId: string): string | null {
  const id = agentId.startsWith("claude_") ? agentId.slice("claude_".length) : "";
  return isClaudeSessionId(id) ? id : null;
}

export interface ClaudeCommandStep {
  kind: "command";
  callId: string;
  tool: string;
  /** The tool's JSON input, rendered compactly. */
  input: string;
  output: string | null;
  truncated: boolean;
  at: string | null;
}

export type ClaudeRunStep =
  | { kind: "prompt" | "message" | "reasoning"; text: string; at: string | null }
  | ClaudeCommandStep;

export type ClaudeRunStatus = "running" | "completed" | "unknown";

export interface ClaudeRunSummary {
  sessionId: string;
  cwd: string | null;
  model: string | null;
  status: ClaudeRunStatus;
  startedAt: string | null;
  lastActivityAt: string | null;
  prompt: string | null;
}

export interface ClaudeRun extends ClaudeRunSummary {
  durationMs: number | null;
  steps: ClaudeRunStep[];
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null;
}

/** A tool's output can be a whole build log; the viewer needs the gist (its tail). */
export const MAX_OUTPUT_CHARS = 16_000;

/**
 * How long the transcript may sit silent before a run is called finished.
 * Claude writes an entry per message and per tool result, so a live run
 * touches the file often; but a single long command (a build, a test suite)
 * leaves it silent for as long as that command runs, so a finished-looking
 * recent file is still treated as running and the viewer keeps polling.
 */
export const RUNNING_WINDOW_MS = 5 * 60 * 1000;

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Anthropic content: a plain string or an array of parts with `text`. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => str(asObject(part)?.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

function parseLines(text: string): Json[] {
  const records: Json[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = asObject(JSON.parse(line));
      if (record) records.push(record);
    } catch {
      // The last line of a file still being written can be partial.
    }
  }
  return records;
}

/** `cost-state` carries the running totals Claude keeps for its own /cost. */
function applyCostState(run: ClaudeRun, record: Json): void {
  const usage = asObject(record.modelUsage);
  if (!usage) return;
  const totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  for (const model of Object.values(usage)) {
    const m = asObject(model);
    if (!m) continue;
    totals.inputTokens += Number(m.inputTokens) || 0;
    totals.cachedInputTokens += Number(m.cacheReadInputTokens) || 0;
    totals.outputTokens += Number(m.outputTokens) || 0;
  }
  run.usage = totals;
  if (typeof record.totalDuration === "number") run.durationMs = record.totalDuration;
}

export function parseTranscript(sessionId: string, text: string, nowMs = Date.now()): ClaudeRun {
  const run: ClaudeRun = {
    sessionId,
    cwd: null,
    model: null,
    status: "unknown",
    startedAt: null,
    lastActivityAt: null,
    prompt: null,
    durationMs: null,
    steps: [],
    usage: null,
  };
  const calls = new Map<string, ClaudeCommandStep>();

  for (const record of parseLines(text)) {
    // Sidechain entries belong to Claude's own internal subagents, not to the
    // run the parent agent launched; showing them would double-count the work.
    if (record.isSidechain === true) continue;
    const at = str(record.timestamp);
    if (at) {
      run.lastActivityAt = at;
      run.startedAt ??= at;
    }
    if (!run.cwd) run.cwd = str(record.cwd);
    const message = asObject(record.message);

    if (record.type === "user") {
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          const p = asObject(part);
          if (p?.type !== "tool_result") continue;
          const step = calls.get(str(p.tool_use_id) ?? "");
          if (!step) continue;
          const raw = contentText(p.content);
          step.truncated = raw.length > MAX_OUTPUT_CHARS;
          step.output = step.truncated ? raw.slice(-MAX_OUTPUT_CHARS) : raw;
        }
      }
      const body = contentText(content).trim();
      if (body) {
        run.prompt ??= body;
        run.steps.push({ kind: "prompt", text: body, at });
      }
    } else if (record.type === "assistant" && message) {
      if (!run.model) run.model = str(message.model);
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const p = asObject(part);
        if (!p) continue;
        if (p.type === "text") {
          const body = str(p.text)?.trim();
          if (body) run.steps.push({ kind: "message", text: body, at });
        } else if (p.type === "thinking") {
          const body = str(p.thinking)?.trim();
          if (body) run.steps.push({ kind: "reasoning", text: body, at });
        } else if (p.type === "tool_use") {
          const step: ClaudeCommandStep = {
            kind: "command",
            callId: str(p.id) ?? `call-${run.steps.length}`,
            tool: str(p.name) ?? "tool",
            input: JSON.stringify(p.input ?? {}),
            output: null,
            truncated: false,
            at,
          };
          calls.set(step.callId, step);
          run.steps.push(step);
        }
      }
    } else if (record.type === "cost-state") {
      applyCostState(run, record);
    }
    // attachment, queue-operation, last-prompt, atis-latch, …: nothing to show.
  }

  if (run.lastActivityAt) {
    const last = Date.parse(run.lastActivityAt);
    run.status =
      Number.isFinite(last) && nowMs - last <= RUNNING_WINDOW_MS ? "running" : "completed";
  }
  return run;
}

export function summarizeRun(run: ClaudeRun): ClaudeRunSummary {
  const { sessionId, cwd, model, status, startedAt, lastActivityAt, prompt } = run;
  return { sessionId, cwd, model, status, startedAt, lastActivityAt, prompt };
}
