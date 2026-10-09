import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";

/** Sequence number the BFF attaches to every unsolicited frame. */
export const SEQ_FIELD = "__seq";

export type SequencedFrame = WsProtocolMessage & { [SEQ_FIELD]?: number };

export interface RuntimeScope {
  agent_id: string;
  conversation_id: string;
}

export interface BffHello {
  type: "__bff_hello";
  session_id: string;
  user: { email: string };
  upstream: ConnectionState;
  app_server_info: unknown;
  latest_seq: number;
  /** Conversations with a response in progress when this session opened. */
  active?: RuntimeScope[];
}

export interface BffResumeResult {
  type: "__bff_resume_result";
  from_seq: number | null;
  latest_seq: number;
  replayed: number;
  resync_required: boolean;
}

export interface BffUpstreamState {
  type: "__bff_upstream_state";
  state: ConnectionState;
  app_server_info: unknown;
}

/** Full snapshot of every conversation with a response in progress, app-server wide. */
export interface BffActivity {
  type: "__bff_activity";
  active: RuntimeScope[];
}

export interface BffError {
  type: "__bff_error";
  message: string;
  request_id?: string;
}

export type ConnectionState = "connecting" | "connected" | "disconnected";

export type BffControlFrame =
  | BffHello
  | BffResumeResult
  | BffUpstreamState
  | BffActivity
  | BffError;

export function isBffControlFrame(frame: unknown): frame is BffControlFrame {
  if (!frame || typeof frame !== "object") return false;
  const type = (frame as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith("__bff_");
}

export function frameSeq(frame: SequencedFrame): number | null {
  const seq = frame[SEQ_FIELD];
  return typeof seq === "number" ? seq : null;
}

export function scopeKey(scope: RuntimeScope): string {
  return `${scope.agent_id}::${scope.conversation_id}`;
}

/** Inverse of `scopeKey`, mirroring the BFF's `parseScopeKey` in `session/buffer.ts`. */
export function parseScopeKey(key: string): [agentId: string, conversationId: string] {
  return key.split("::") as [string, string];
}

/** Capability-discovery handshake, narrowed from the `unknown` wire payload. */
/**
 * One row of Settings → About's component list, as `/api/status` builds it
 * (`bff/src/deployment.ts`). The BFF decides which rows exist; the UI renders them.
 */
export interface Component {
  name: string;
  version: string;
}

export interface AppServerInfo {
  backend: "local" | "api";
  letta_code_version: string;
  protocol_version: number;
  capabilities: {
    agent_management: boolean;
    conversation_management: boolean;
    memory_management: boolean;
    runtime_start: boolean;
    /** letta-code >= 0.32.19. Gates the Tasks tab subagent launcher. */
    launch_subagent: boolean;
    runtime_workspace_sandbox: boolean;
    runtime_external_tools_update: boolean;
    /** Gates the composer's per-turn JSON-schema control. */
    structured_outputs: boolean;
    split_channels: boolean;
  };
}

export function readAppServerInfo(raw: unknown): AppServerInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const info = raw as Record<string, unknown>;
  if (info.backend !== "local" && info.backend !== "api") return null;
  if (typeof info.letta_code_version !== "string") return null;
  if (typeof info.protocol_version !== "number") return null;
  const caps = info.capabilities;
  if (!caps || typeof caps !== "object") return null;
  const c = caps as Record<string, unknown>;
  return {
    backend: info.backend,
    letta_code_version: info.letta_code_version,
    protocol_version: info.protocol_version,
    capabilities: {
      agent_management: c.agent_management === true,
      conversation_management: c.conversation_management === true,
      memory_management: c.memory_management === true,
      runtime_start: c.runtime_start === true,
      launch_subagent: c.launch_subagent === true,
      runtime_workspace_sandbox: c.runtime_workspace_sandbox === true,
      runtime_external_tools_update: c.runtime_external_tools_update === true,
      structured_outputs: c.structured_outputs === true,
      split_channels: c.split_channels === true,
    },
  };
}
