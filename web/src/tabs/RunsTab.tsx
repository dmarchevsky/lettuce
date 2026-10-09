import { ClaudeRunsList } from "../components/ClaudeRunsList.tsx";
import { CodexRunsList } from "../components/CodexRunsList.tsx";
import { PiRunsList } from "../components/PiRunsList.tsx";
import { type FeatureFlags, featureEnabled } from "../lib/features.ts";
import type { BackgroundProcessSummary } from "../state/use-conversation.ts";

interface Props {
  backgroundProcesses: BackgroundProcessSummary[];
  /** Profile-gated features: a list hides when its worker token is off. */
  features?: FeatureFlags;
  /** `?run=` deep link: open this pi run's viewer when the tab mounts. */
  initialRunId?: string | null;
}

/**
 * Worker runs live here: Codex threads, Claude Code sessions, remote-pi runs
 * — each list opening its own viewer. They used to sit at the bottom of Tasks,
 * which had long since become scheduling-only; now the two tab names mean
 * what they say. A background `agent_task` finishing is what a worker run
 * settling looks like from the protocol, so it is what refreshes the lists.
 */
export function RunsTab({ backgroundProcesses, features, initialRunId }: Props) {
  const refreshKey = backgroundProcesses
    .filter((process) => process.kind === "agent_task")
    .map((process) => process.processId)
    .join(",");
  return (
    <div className="pane">
      {featureEnabled(features, "codex") ? <CodexRunsList refreshKey={refreshKey} /> : null}
      {featureEnabled(features, "claude") ? <ClaudeRunsList refreshKey={refreshKey} /> : null}
      {/* Remote-pi runs are captured by the BFF itself, so this list does not
          need the worker tokens the coding lists ride on — only `pi` itself. */}
      {featureEnabled(features, "pi") ? (
        <PiRunsList refreshKey={refreshKey} initialRunId={initialRunId} />
      ) : null}
    </div>
  );
}
