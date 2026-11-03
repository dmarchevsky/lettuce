import { useCallback, useMemo, useState } from "react";
import { ClaudeRunsList } from "../components/ClaudeRunsList.tsx";
import { CodexRunsList } from "../components/CodexRunsList.tsx";
import { PiRunsList } from "../components/PiRunsList.tsx";
import { type FeatureFlags, featureEnabled } from "../lib/features.ts";
import { onlyRunsLabel, otherRunsLabel, sumOther } from "../lib/runs-scope.ts";
import type { BackgroundProcessSummary } from "../state/use-conversation.ts";

interface Props {
  backgroundProcesses: BackgroundProcessSummary[];
  /** Profile-gated features: a list hides when its worker token is off. */
  features?: FeatureFlags;
  /** `?run=` deep link: open this pi run's viewer when the tab mounts. */
  initialRunId?: string | null;
  /** The open agent — whose runs the pane shows until `show all` says otherwise. */
  agentId: string | null;
  /** Its display name, for the one place the pane says it out loud. */
  agentName: string | null;
  /** Every agent, so a run listing can name an owner other than the open one. */
  agents: readonly { id: string; name: string }[];
}

/**
 * Worker runs live here: Codex threads, Claude Code sessions, remote-pi runs —
 * each list opening its own viewer. They used to sit at the bottom of Tasks,
 * which had long since become scheduling-only; now the two tab names mean what
 * they say. A background `agent_task` finishing is what a worker run settling
 * looks like from the protocol, so it is what refreshes the lists.
 *
 * The pane belongs to the open agent, the way Files belongs to a conversation and
 * Tasks to its runs: each run's owner is derived from the workspace it ran in
 * (`bff/src/runs/attribution.ts`), and all three lists filter by it. The one
 * control is a link at the pane's top right — `show all`, which becomes
 * `<agent> only` while everything is showing. It is a look and not a setting:
 * never stored, and remembered only for the agent it was clicked under, so
 * switching agents finds the pane scoped again. The count beside it is what the
 * filters hid between them, so an empty-looking pane cannot be mistaken for an
 * install with no runs.
 */
export function RunsTab({
  backgroundProcesses,
  features,
  initialRunId,
  agentId,
  agentName,
  agents,
}: Props) {
  const refreshKey = backgroundProcesses
    .filter((process) => process.kind === "agent_task")
    .map((process) => process.processId)
    .join(",");

  // The agent `show all` was clicked under — not a preference, and not the
  // current agent's state once they pick someone else.
  const [allFor, setAllFor] = useState<string | null>(null);
  const showAll = agentId !== null && allFor === agentId;
  const scope = showAll ? null : agentId;

  // What each list's filter dropped, keyed by list, so the count is the sum of
  // what the three scans actually read.
  const [hidden, setHidden] = useState<Record<string, number>>({});
  const report = useCallback((list: string, other: number) => {
    setHidden((previous) => (previous[list] === other ? previous : { ...previous, [list]: other }));
  }, []);
  const onCodex = useCallback((other: number) => report("codex", other), [report]);
  const onClaude = useCallback((other: number) => report("claude", other), [report]);
  const onPi = useCallback((other: number) => report("pi", other), [report]);

  const agentNames = useMemo(
    () => Object.fromEntries(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const hiddenTotal = showAll ? 0 : sumOther(hidden);
  const hiddenLabel = showAll ? null : otherRunsLabel(hiddenTotal);

  return (
    <div className="pane">
      {agentId ? (
        <div className="filters">
          <span className="spacer" />
          {hiddenLabel ? <span className="muted small">{hiddenLabel}</span> : null}
          <button
            type="button"
            className="link"
            onClick={() => setAllFor(showAll ? null : agentId)}
            aria-label={
              showAll ? `Show only ${agentName ?? "this agent"}'s runs` : "Show every agent's runs"
            }
          >
            {showAll ? onlyRunsLabel(agentName) : "show all"}
          </button>
        </div>
      ) : null}
      {featureEnabled(features, "codex") ? (
        <CodexRunsList
          refreshKey={refreshKey}
          agentId={scope}
          agentName={agentName}
          onOther={onCodex}
        />
      ) : null}
      {featureEnabled(features, "claude") ? (
        <ClaudeRunsList
          refreshKey={refreshKey}
          agentId={scope}
          agentName={agentName}
          onOther={onClaude}
        />
      ) : null}
      {/* Remote-pi runs are captured by the BFF itself, so this list does not
          need the worker tokens the coding lists ride on — only `pi` itself. */}
      {featureEnabled(features, "pi") ? (
        <PiRunsList
          refreshKey={refreshKey}
          initialRunId={initialRunId}
          agentId={scope}
          agentName={agentName}
          agentNames={agentNames}
          onOther={onPi}
        />
      ) : null}
    </div>
  );
}
