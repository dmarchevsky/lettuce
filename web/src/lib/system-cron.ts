/**
 * Unix cron jobs an agent set up for commands that need no agent, listed
 * read-only in the Tasks tab. The BFF reads every agent's
 * (`bff/src/system-cron.ts`); `jobsForAgent` picks the ones a tab shows.
 */

export interface SystemCronJob {
  name: string;
  /** From the `# agent:` line; null when there is none. */
  agentId: string | null;
  description: string | null;
  entries: { schedule: string; command: string }[];
  /** false: saved, but cron runs it (or this version of it) only after a restart. */
  live: boolean;
}

export interface SystemCronList {
  /** The container's timezone, which cron schedules run in. */
  timezone: string;
  jobs: SystemCronJob[];
}

export async function fetchSystemCron(): Promise<SystemCronList> {
  const response = await fetch("/api/system-cron");
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return (await response.json()) as SystemCronList;
}

/** Whose job it is, from the viewing agent's side. */
export type CronJobOwner = "self" | "none" | "gone";

/**
 * The jobs one agent's Tasks tab shows: its own, those with no owner, and those
 * whose agent no longer exists. Hidden everywhere, that last kind would keep running
 * with nothing in the UI saying so. Until the agent list has loaded, no owner is
 * taken for gone.
 */
export function jobsForAgent(
  jobs: readonly SystemCronJob[],
  agentId: string,
  agentIds: readonly string[],
): { job: SystemCronJob; owner: CronJobOwner }[] {
  const known = new Set(agentIds);
  const ownerOf = (job: SystemCronJob): CronJobOwner | null => {
    if (job.agentId === agentId) return "self";
    if (job.agentId === null) return "none";
    return known.size > 0 && !known.has(job.agentId) ? "gone" : null;
  };
  return jobs.flatMap((job) => {
    const owner = ownerOf(job);
    return owner ? [{ job, owner }] : [];
  });
}

/**
 * The start of a message asking the agent to change a job: only an agent can, and
 * "cron job" is the phrase that has it load the skill saying how.
 */
export function askToChangeText(job: Pick<SystemCronJob, "name">): string {
  return `Change the cron job "${job.name}": `;
}
