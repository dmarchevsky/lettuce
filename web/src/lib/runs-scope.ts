/**
 * The Runs pane's one control: whose runs are showing.
 *
 * The pane opens on the open agent's runs, because Files is a conversation's
 * directory and Tasks is its runs — a pane that ignored the open agent was the
 * odd one out. `show all` is a LOOK, not a setting: it is never stored, so the
 * default is the default every time, and switching agents cannot leave you
 * somewhere you did not choose. This module holds the words and the arithmetic so
 * both are testable; the state itself is a `useState` in `RunsTab`.
 */

/** A run listing narrowed to one agent, and what the filter dropped. */
export interface RunsPage<T> {
  runs: T[];
  /** Runs the scan saw and the filter dropped — what `show all` would reveal. */
  other: number;
}

/** `agentId -> display name`, so a run listing can say whose it is. */
export type AgentNames = Readonly<Record<string, string>>;

/** What every run listing takes: the scope, whose name to use, and where to report the count. */
export interface RunsListProps {
  /** Changes when the set of running background tasks does — the list's own refresh trigger. */
  refreshKey: string;
  /** The agent to show, or null to show every agent's runs. */
  agentId: string | null;
  /** Display name of that agent, for the note shown when it has none. */
  agentName: string | null;
  /** How many runs the filter dropped, reported after every load. */
  onOther: (other: number) => void;
}

/** How the agent is named when the app does not know it (deleted, or not loaded yet). */
export function agentLabel(agentName: string | null): string {
  return agentName ?? "this agent";
}

/** The link back from showing everything: `Nova only`. */
export function onlyRunsLabel(agentName: string | null): string {
  return `${agentLabel(agentName)} only`;
}

/** The count beside `show all`, or nothing when the filter has hidden none. */
export function otherRunsLabel(other: number): string | null {
  if (other <= 0) return null;
  return other === 1 ? "1 other run" : `${other} other runs`;
}

/**
 * What a section says when the agent has none of these but the machine has some.
 *
 * A section that renders nothing at all cannot be told from one that is disabled,
 * so a scoped listing keeps its heading and says which it is.
 */
export function scopedEmptyLabel(section: string, agentName: string | null, other: number): string {
  const none = `No ${section} for ${agentLabel(agentName)}`;
  return other > 0 ? `${none} — ${otherRunsLabel(other)} on this machine.` : `${none}.`;
}

/** The pane's total: what all three filters hid between them. */
export function sumOther(hidden: Readonly<Record<string, number>>): number {
  return Object.values(hidden).reduce((total, count) => total + count, 0);
}
