/**
 * Codex run viewer: turns a Codex rollout file into readable steps.
 *
 * letta-code keeps only a Codex worker's final message (`codex-app-server.ts`
 * resolves the task with `turnReport` / `latestAgentMessage`); every command
 * and its output is dropped. Codex itself writes the whole run to
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`,
 * appending as it goes — so the file is both the history and the live view.
 */

import { agentIdFromCwd } from "../runs/attribution.ts";

/** Codex thread ids are UUIDv7: the first 48 bits are the creation time in ms. */
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCodexThreadId(value: string): boolean {
  return THREAD_ID_RE.test(value);
}

/** `codex_<thread id>`, the synthetic agent id letta-code reports for a worker. */
export function threadIdFromAgentId(agentId: string): string | null {
  const id = agentId.startsWith("codex_") ? agentId.slice("codex_".length) : "";
  return isCodexThreadId(id) ? id : null;
}

export function threadCreatedAtMs(threadId: string): number {
  return Number.parseInt(threadId.replace(/-/g, "").slice(0, 12), 16);
}

function dayDir(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where to look for a thread's rollout, most likely first. Codex names the
 * directory by local time, and the app-server container runs in UTC — the
 * neighbouring days cover a host that does not.
 */
export function candidateDayDirs(threadId: string): string[] {
  const at = threadCreatedAtMs(threadId);
  return [...new Set([dayDir(at), dayDir(at - DAY_MS), dayDir(at + DAY_MS)])];
}

/** Day directories to scan for the most recent runs, newest first. */
export function recentDayDirs(nowMs: number, days: number): string[] {
  return Array.from({ length: days }, (_, i) => dayDir(nowMs - i * DAY_MS));
}

/** The thread id at the end of a rollout file name, or null for anything else. */
export function threadIdOfRollout(fileName: string): string | null {
  const match = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/i.exec(fileName);
  return match?.[1] && isCodexThreadId(match[1]) ? match[1] : null;
}

export interface CodexCommandStep {
  kind: "command";
  callId: string;
  tool: string;
  command: string;
  output: string | null;
  exitCode: number | null;
  truncated: boolean;
  at: string | null;
}

export type CodexRunStep =
  | { kind: "prompt" | "message" | "reasoning"; text: string; at: string | null }
  | CodexCommandStep;

export type CodexRunStatus = "running" | "completed" | "aborted" | "unknown";

export interface CodexRunSummary {
  threadId: string;
  cwd: string | null;
  /**
   * The agent whose workspace the run happened in (`bff/src/runs/attribution.ts`),
   * or null for a run with no workspace owner — cron- and channel-fired workers
   * run in `/work` itself. This is what the Runs pane filters on.
   */
  agentId: string | null;
  status: CodexRunStatus;
  startedAt: string | null;
  lastActivityAt: string | null;
  prompt: string | null;
}

/** A parsed rollout: everything a summary has, less the owner, which
 * `summarizeRun` derives from the cwd the file recorded. */
export interface CodexRun extends Omit<CodexRunSummary, "agentId"> {
  durationMs: number | null;
  steps: CodexRunStep[];
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null;
}

/** A command's output can be a whole build log; the viewer needs the gist (its tail). */
export const MAX_OUTPUT_CHARS = 16_000;

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return str(content) ?? "";
  return content
    .map((part) => str(asObject(part)?.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

/** Codex injects its own context as user messages wrapped in a tag. */
function isInjected(text: string): boolean {
  return /^\s*<[a-z_][a-z_ -]*>/i.test(text);
}

function describeCall(tool: string, rawArgs: unknown): string {
  const text = str(rawArgs) ?? JSON.stringify(rawArgs ?? "");
  let args: Json | null = null;
  try {
    args = asObject(JSON.parse(text));
  } catch {
    // Freeform tools (apply_patch) send raw text, not JSON.
  }
  const cmd = args?.cmd ?? args?.command;
  if (typeof cmd === "string") return cmd;
  if (Array.isArray(cmd)) return cmd.map(String).join(" ");
  if (tool === "write_stdin" && args) {
    return `stdin → session ${String(args.session_id ?? "?")}: ${String(args.chars ?? "")}`;
  }
  return text;
}

/** Codex wraps shell output in a header ("Process exited with code N … Output:"). */
function splitOutput(raw: string): { output: string; exitCode: number | null } {
  const code = /Process exited with code (-?\d+)/.exec(raw);
  const marker = raw.indexOf("\nOutput:\n");
  return {
    exitCode: code?.[1] ? Number(code[1]) : null,
    output: marker >= 0 ? raw.slice(marker + "\nOutput:\n".length) : raw,
  };
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  const content = asObject(value)?.content;
  if (typeof content === "string") return content;
  return value === undefined || value === null ? "" : JSON.stringify(value);
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

function applyEvent(run: CodexRun, payload: Json): void {
  switch (payload.type) {
    case "task_started":
      run.status = "running";
      return;
    case "task_complete":
      run.status = "completed";
      if (typeof payload.duration_ms === "number") run.durationMs = payload.duration_ms;
      return;
    case "turn_aborted":
      run.status = "aborted";
      return;
    case "token_count": {
      const total = asObject(asObject(payload.info)?.total_token_usage);
      if (total) {
        run.usage = {
          inputTokens: Number(total.input_tokens) || 0,
          cachedInputTokens: Number(total.cached_input_tokens) || 0,
          outputTokens: Number(total.output_tokens) || 0,
        };
      }
      return;
    }
  }
}

export function parseRollout(threadId: string, text: string): CodexRun {
  const run: CodexRun = {
    threadId,
    cwd: null,
    status: "unknown",
    startedAt: null,
    lastActivityAt: null,
    prompt: null,
    durationMs: null,
    steps: [],
    usage: null,
  };
  const calls = new Map<string, CodexCommandStep>();
  const seenMessages = new Set<string>();

  for (const record of parseLines(text)) {
    const at = str(record.timestamp);
    if (at) run.lastActivityAt = at;
    const payload = asObject(record.payload) ?? {};
    const type = str(payload.type) ?? "";

    if (record.type === "session_meta") {
      run.cwd = str(payload.cwd);
      run.startedAt = str(payload.timestamp) ?? at;
    } else if (record.type === "event_msg") {
      applyEvent(run, payload);
    } else if (record.type !== "response_item") {
      // world_state, turn_context, token_usage_record: nothing to show.
    } else if (type === "message") {
      const role = str(payload.role);
      const body = contentText(payload.content).trim();
      if (!body || (role !== "user" && role !== "assistant")) continue;
      if (role === "user") {
        if (isInjected(body)) continue;
        run.prompt ??= body;
        run.steps.push({ kind: "prompt", text: body, at });
        continue;
      }
      // Codex records one assistant message more than once; keep the first.
      const key = str(payload.id) ?? body;
      if (seenMessages.has(key)) continue;
      seenMessages.add(key);
      run.steps.push({ kind: "message", text: body, at });
    } else if (type === "reasoning") {
      const summary = Array.isArray(payload.summary)
        ? payload.summary
            .map((part) => str(asObject(part)?.text) ?? "")
            .join("\n")
            .trim()
        : "";
      if (summary) run.steps.push({ kind: "reasoning", text: summary, at });
    } else if (type === "function_call" || type === "custom_tool_call") {
      const callId = str(payload.call_id) ?? str(payload.id) ?? `call-${run.steps.length}`;
      const tool = str(payload.name) ?? "tool";
      const step: CodexCommandStep = {
        kind: "command",
        callId,
        tool,
        command: describeCall(tool, payload.arguments ?? payload.input),
        output: null,
        exitCode: null,
        truncated: false,
        at,
      };
      calls.set(callId, step);
      run.steps.push(step);
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      const step = calls.get(str(payload.call_id) ?? "");
      if (!step) continue;
      const { output, exitCode } = splitOutput(outputText(payload.output));
      step.exitCode = exitCode;
      step.truncated = output.length > MAX_OUTPUT_CHARS;
      step.output = step.truncated ? output.slice(-MAX_OUTPUT_CHARS) : output;
    }
  }
  return run;
}

export function summarizeRun(run: CodexRun): CodexRunSummary {
  const { threadId, cwd, status, startedAt, lastActivityAt, prompt } = run;
  return { threadId, cwd, agentId: agentIdFromCwd(cwd), status, startedAt, lastActivityAt, prompt };
}
