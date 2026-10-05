/**
 * Run viewer source: the BFF-captured pi json event stream of one run, turned
 * into readable steps — the remote-pi counterpart of `claude/transcript.ts`
 * and `codex/rollout.ts`, except the file is ours (captured ssh stdout), so
 * the contract is pi's published json.md event shapes, not an internal CLI
 * format. Still parsed leniently: unknown event types and unknown content
 * parts are skipped, never fatal.
 */

import type { PiRunMeta } from "./runner.ts";

export interface PiCommandStep {
  kind: "command";
  callId: string;
  tool: string;
  input: string;
  output: string | null;
  isError: boolean;
  at: string | null;
}

export type PiRunStep =
  | { kind: "prompt" | "message" | "reasoning"; text: string; at: string | null }
  | PiCommandStep;

export interface PiRunSummary {
  runId: string;
  session: string | null;
  target: string;
  kind: "run" | "send";
  status: PiRunMeta["state"];
  startedAt: string;
  endedAt: string | null;
  prompt: string;
  model: string | null;
}

export interface PiRun extends PiRunSummary {
  steps: PiRunStep[];
  usage: { inputTokens: number; outputTokens: number } | null;
}

export function summarizePiRun(meta: PiRunMeta): PiRunSummary {
  return {
    runId: meta.runId,
    session: meta.session,
    target: meta.target,
    kind: meta.kind,
    status: meta.state,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    prompt: meta.prompt,
    model: meta.model,
  };
}

interface ContentPart {
  type?: string;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  input?: unknown;
  id?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentPart[])
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

/**
 * Parse the captured stream. Message events are authoritative on
 * `message_end` (pi/json.md), tool lifecycle is correlated by `toolCallId`,
 * usage is the cumulative `usage` of the newest `message_update`.
 */
export function parsePiRun(meta: PiRunMeta, eventsText: string): PiRun {
  const steps: PiRunStep[] = [{ kind: "prompt", text: meta.prompt, at: meta.startedAt }];
  const commands = new Map<string, PiCommandStep>();
  let usage: { inputTokens: number; outputTokens: number } | null = null;

  for (const line of eventsText.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = record.type;
    if (type === "message_end") {
      const message = record.message as
        | { role?: string; content?: unknown; timestamp?: number }
        | undefined;
      const role = message?.role;
      if (role === "assistant") {
        const at =
          typeof message?.timestamp === "number" ? new Date(message.timestamp).toISOString() : null;
        const content = Array.isArray(message?.content) ? (message.content as ContentPart[]) : [];
        for (const part of content) {
          if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
            steps.push({ kind: "message", text: part.text, at });
          } else if (
            part?.type === "thinking" &&
            typeof part.thinking === "string" &&
            part.thinking.trim()
          ) {
            steps.push({ kind: "reasoning", text: part.thinking, at });
          }
        }
      }
    } else if (type === "message_update") {
      // pi/json.md: message_update carries `usage` (cumulative) and the delta
      // event, not a message snapshot — usage is all the viewer needs.
      const u = record.usage as
        | { input?: number; output?: number; inputTokens?: number; outputTokens?: number }
        | undefined;
      if (u) {
        usage = {
          inputTokens: Number(u.input ?? u.inputTokens ?? 0),
          outputTokens: Number(u.output ?? u.outputTokens ?? 0),
        };
      }
    } else if (type === "tool_execution_start") {
      const callId = String(record.toolCallId ?? "");
      const step: PiCommandStep = {
        kind: "command",
        callId,
        tool: String(record.toolName ?? "tool"),
        input: safeCompact(record.args),
        output: null,
        isError: false,
        at: null,
      };
      commands.set(callId, step);
      steps.push(step);
    } else if (type === "tool_execution_end") {
      const step = commands.get(String(record.toolCallId ?? ""));
      if (step) {
        step.isError = record.isError === true;
        step.output = toolResultText(record.result);
      }
    }
  }

  return { ...summarizePiRun(meta), steps, usage };
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    const text = textOf(content);
    return text || safeCompact(result);
  }
  return "";
}

function safeCompact(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  } catch {
    return String(value);
  }
}
