import { isAgentId } from "./agents/id-list.ts";

/**
 * Unix cron jobs agents keep for commands that need no agent (the installing-tools
 * skill, rule 8), listed read-only for the Tasks tab.
 *
 * The skill has an agent write one file per job into `SYSTEM_CRON_DIR`, which
 * survives a recreate, and install it into `LIVE_CRON_DIR` to start it now; the
 * image entrypoint copies the first folder into the second at every start and never
 * deletes. So the saved file is the job, and the live copy only says whether cron is
 * running that version yet.
 *
 * Owners come from the `# agent:` line the skill writes. It is self-reported, which
 * is no weaker than anything else here: there is no agent-to-agent isolation.
 */

export const SYSTEM_CRON_DIR = "/root/.letta/system-cron";
export const LIVE_CRON_DIR = "/etc/cron.d";

/** The two file commands this needs; `codexIo` in `index.ts` provides both. */
export interface SystemCronIo {
  /** File contents, or null when the file does not exist. */
  read(path: string): Promise<string | null>;
  /** File names directly inside `dir`, or null when it does not exist. */
  listFiles(dir: string): Promise<string[] | null>;
}

export interface CronEntry {
  /** Five fields, or an `@daily`-style keyword, as written. */
  schedule: string;
  /** Everything after the user field. */
  command: string;
}

export interface CronFile {
  /** The `# agent:` line; null when absent or not an agent id. */
  agentId: string | null;
  description: string | null;
  entries: CronEntry[];
}

export interface SystemCronJob extends CronFile {
  name: string;
  /** Cron is running exactly this file now; false until the next restart otherwise. */
  live: boolean;
}

/** Cron skips any other file name in /etc/cron.d, and this keeps the paths fixed. */
const JOB_NAME = /^[A-Za-z0-9_-]+$/;
const HEADER = /^#\s*(agent|description):\s*(.*?)\s*$/i;
const ENV_LINE = /^[A-Za-z_][A-Za-z0-9_]*\s*=/;
/** /etc/cron.d format: schedule, then the user, then the command. */
const JOB_LINE = /^(@\S+|(?:\S+\s+){4}\S+)\s+\S+\s+(\S.*)$/;

export function parseCronFile(text: string): CronFile {
  let agentId: string | null = null;
  let description: string | null = null;
  const entries: CronEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || ENV_LINE.test(line)) continue;
    if (line.startsWith("#")) {
      const header = HEADER.exec(line);
      const value = header?.[2] ?? "";
      if (header?.[1]?.toLowerCase() === "agent") {
        // An unexpanded `$LETTA_AGENT_ID` is no owner, so the job shows under every agent.
        agentId ??= isAgentId(value) && !value.startsWith("$") ? value : null;
      } else if (header && value) {
        description ??= value;
      }
      continue;
    }
    const job = JOB_LINE.exec(line);
    if (job?.[1] && job[2]) entries.push({ schedule: job[1], command: job[2] });
  }
  return { agentId, description, entries };
}

/**
 * Every job, by name, with its owner. Which agent sees which is the Tasks tab's
 * call: only it knows which agents still exist, and a job whose agent is gone must
 * still show somewhere. A saved file that cannot be read or holds no job line is
 * left out rather than failing the whole list; a live copy that cannot be read
 * makes the job not live.
 */
export async function listSystemCron(io: SystemCronIo): Promise<SystemCronJob[]> {
  const names = ((await io.listFiles(SYSTEM_CRON_DIR)) ?? [])
    .filter((name) => JOB_NAME.test(name))
    .sort();
  const jobs = await Promise.all(
    names.map(async (name): Promise<SystemCronJob | null> => {
      const [saved, live] = await Promise.all([
        io.read(`${SYSTEM_CRON_DIR}/${name}`).catch(() => null),
        io.read(`${LIVE_CRON_DIR}/${name}`).catch(() => null),
      ]);
      if (saved === null) return null;
      const file = parseCronFile(saved);
      if (file.entries.length === 0) return null;
      return { name, ...file, live: live === saved };
    }),
  );
  return jobs.filter((job): job is SystemCronJob => job !== null);
}

/**
 * Each owner replaced by the top of its `parent:` chain (`AgentAncestry.chain`).
 * A subagent writes its own `$LETTA_AGENT_ID`, and letta-code hides subagents from
 * `agent_list`, so the Tasks tab would call that owner gone. A chain that cannot
 * be read leaves the owner as written: a deleted agent stays gone.
 */
export async function withTopLevelOwners(
  jobs: readonly SystemCronJob[],
  chain: (agentId: string) => Promise<readonly string[]>,
): Promise<SystemCronJob[]> {
  return Promise.all(
    jobs.map(async (job) => {
      if (job.agentId === null) return job;
      const ids = await chain(job.agentId).catch(() => []);
      return { ...job, agentId: ids.at(-1) ?? job.agentId };
    }),
  );
}
