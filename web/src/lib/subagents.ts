/**
 * Live activity of children the app-server spawned in this scope — plain subagents and
 * codex/claude coding workers alike.
 *
 * `update_subagent_state` re-sends the whole snapshot list on every change, so these reads
 * are parse-only and self-healing after a missed frame. The snapshot is also the ONLY live
 * source of a child's tool calls: subagent tool calls never arrive as transcript frames.
 * Remote Pi runs are absent here on purpose — the BFF owns those (bff/src/pi), and the app
 * server has no snapshot for them.
 */

import { parseToolArgs, summarizeToolCall } from "./tool-summary.ts";
import { formatTokens } from "./usage.ts";
import { formatElapsed } from "./working.ts";

export interface LiveSubagentToolCall {
  /** Tool name as the child's runtime spells it (Edit, Bash, mcp__… ). */
  name: string;
  /** Raw JSON argument string, parsed through the transcript's own summariser. */
  args: string;
}

/** One `progress_texts` line: the child's own narration, newest last. */
export interface LiveSubagentProgress {
  id: string;
  /** ISO timestamp as the wire sent it. */
  at: string;
  text: string;
}

/** One live (`pending`/`running`) subagent snapshot, parsed off `update_subagent_state`. */
export interface LiveSubagent {
  status: string;
  subagentType: string;
  description: string;
  /** The parent's Task/Agent call id, when upstream reports it. Exact line join. */
  toolCallId?: string;
  /** The child's own agent id — what `subagent_stop` takes; absent = no Stop. */
  agentId?: string;
  /** The child's own model id, when the wire carries one. */
  model?: string;
  /** The launch prompt, when the wire carries one. */
  prompt?: string;
  /** In order; the last one is what the child is doing right now. */
  toolCalls: LiveSubagentToolCall[];
  /** In order; absent on the wire until the child narrates. The parser always
   * fills it (`[]` when the frame carried none); hand-built snapshots may omit. */
  /** The child's own narration lines, newest last. */
  progress: LiveSubagentProgress[];
  /** The child's launch instant (epoch ms), when the wire carries it. */
  startTime?: number;
  totalTokens: number;
  durationMs: number;
}

/** `subagent_id -> snapshot` for the live entries of an `update_subagent_state` frame. */
export function readLiveSubagents(raw: unknown): Record<string, LiveSubagent> {
  if (!Array.isArray(raw)) return {};
  const live: Record<string, LiveSubagent> = {};
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as {
      subagent_id?: unknown;
      agent_id?: unknown;
      status?: unknown;
      subagent_type?: unknown;
      description?: unknown;
      prompt?: unknown;
      model?: unknown;
      tool_call_id?: unknown;
      tool_calls?: unknown;
      progress_texts?: unknown;
      start_time?: unknown;
      total_tokens?: unknown;
      duration_ms?: unknown;
    };
    if (typeof s.subagent_id !== "string") continue;
    if (s.status !== "pending" && s.status !== "running") continue;
    const toolCalls = Array.isArray(s.tool_calls)
      ? s.tool_calls.flatMap((tc) => {
          if (!tc || typeof tc !== "object") return [];
          const call = tc as { name?: unknown; args?: unknown };
          return typeof call.name === "string"
            ? [{ name: call.name, args: typeof call.args === "string" ? call.args : "" }]
            : [];
        })
      : [];
    const progress = Array.isArray(s.progress_texts)
      ? s.progress_texts.flatMap((pt) => {
          if (!pt || typeof pt !== "object") return [];
          const p = pt as { id?: unknown; at?: unknown; text?: unknown };
          return typeof p.text === "string" && typeof p.id === "string"
            ? [{ id: p.id, at: typeof p.at === "string" ? p.at : "", text: p.text }]
            : [];
        })
      : [];
    live[s.subagent_id] = {
      status: String(s.status),
      subagentType: typeof s.subagent_type === "string" ? s.subagent_type : "",
      description: typeof s.description === "string" ? s.description : "",
      ...(typeof s.tool_call_id === "string" ? { toolCallId: s.tool_call_id } : {}),
      ...(typeof s.agent_id === "string" ? { agentId: s.agent_id } : {}),
      ...(typeof s.model === "string" && s.model ? { model: s.model } : {}),
      ...(typeof s.prompt === "string" && s.prompt ? { prompt: s.prompt } : {}),
      toolCalls,
      progress,
      ...(typeof s.start_time === "number" ? { startTime: s.start_time } : {}),
      totalTokens: typeof s.total_tokens === "number" ? s.total_tokens : 0,
      durationMs: typeof s.duration_ms === "number" ? s.duration_ms : 0,
    };
  }
  return live;
}

/**
 * The running snapshot behind a delegated Task/Agent call: the exact `tool_call_id` match
 * when upstream reports one, else the single running snapshot (a lone delegation is the
 * common case). Several running without ids stays ambiguous → nothing is shown, which is
 * the failure mode that never attributes one child's work to another's line.
 */
export function pickRunningChild(
  live: Readonly<Record<string, LiveSubagent>>,
  toolCallId?: string,
): LiveSubagent | null {
  const values = Object.values(live);
  if (toolCallId) {
    const exact = values.find((s) => s.toolCallId === toolCallId && s.status === "running");
    if (exact) return exact;
  }
  const running = values.filter((s) => s.status === "running");
  return running.length === 1 ? (running[0] ?? null) : null;
}

/** What the child is doing right now, in the working line's verb+object grammar. */
export function childActivityLabel(child: LiveSubagent, cwd: string | null): string {
  const last = child.toolCalls[child.toolCalls.length - 1];
  if (!last) return "thinking";
  const summary = summarizeToolCall(last.name, parseToolArgs(last.args), cwd);
  // Same strip the working line does on the parent's own Bash line.
  return (summary?.headline ?? last.name).replace(/^\$ /, "");
}

/** `running · Run bun test bff · 48k tok · 6:04` for a Tasks row. */
export function subagentStatusLine(
  status: string,
  child: LiveSubagent,
  cwd: string | null,
): string {
  const bits = [status, childActivityLabel(child, cwd)];
  if (child.totalTokens >= 100) bits.push(`${formatTokens(child.totalTokens)} tok`);
  if (child.durationMs > 0) bits.push(formatElapsed(child.durationMs));
  return bits.filter(Boolean).join(" · ");
}

/** One child's progress line: `running · 5/8 agents · 2 running · 140k tok`. */
export interface WorkflowPhaseCounts {
  title: string;
  total: number;
  done: number;
  failed: number;
  running: number;
  tokens: number;
}

export interface WorkflowCounts {
  total: number;
  done: number;
  failed: number;
  running: number;
  tokens: number;
  phases: WorkflowPhaseCounts[];
}

/** Parses the device-status `progress` field of a workflow process summary. */
export function readWorkflowProgress(raw: unknown): WorkflowCounts | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const counts = (src: Record<string, unknown>): Omit<WorkflowCounts, "phases"> => ({
    total: typeof src.agents_total === "number" ? src.agents_total : 0,
    done: typeof src.agents_done === "number" ? src.agents_done : 0,
    failed: typeof src.agents_failed === "number" ? src.agents_failed : 0,
    running: typeof src.agents_running === "number" ? src.agents_running : 0,
    tokens: typeof src.total_tokens === "number" ? src.total_tokens : 0,
  });
  const base = counts(p);
  const phases = Array.isArray(p.phases)
    ? p.phases.flatMap((ph) => {
        if (!ph || typeof ph !== "object") return [];
        const phase = counts(ph as Record<string, unknown>);
        const title = (ph as { title?: unknown }).title;
        return typeof title === "string" ? [{ title, ...phase } satisfies WorkflowPhaseCounts] : [];
      })
    : [];
  // An all-zero payload means the wire sent an empty progress object, not progress.
  if (!base.total && !phases.length) return null;
  return { ...base, phases };
}

/** `running · 5/8 agents · 2 running · 1 failed · 140k tok` for a Tasks row. */
export function workflowStatusLine(status: string, w: WorkflowCounts): string {
  const bits = [status, `${w.done}/${w.total} agents`];
  if (w.running > 0) bits.push(`${w.running} running`);
  if (w.failed > 0) bits.push(`${w.failed} failed`);
  if (w.tokens >= 100) bits.push(`${formatTokens(w.tokens)} tok`);
  return bits.filter(Boolean).join(" · ");
}

/** `plan 8/8 · build 3/4 · test 0/1`; empty when no phases came on the wire. */
export function workflowPhasesLine(w: WorkflowCounts): string {
  return w.phases.map((p) => `${p.title} ${p.done}/${p.total}`).join(" · ");
}
