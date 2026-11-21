/**
 * Seed remote-pi run captures INTO the running bff container, so the Runs
 * surface has rows to prove it renders.
 *
 * Why this exists: the `pi` Runs list reads files the BFF itself writes
 * (`DirPiRunStore` under `/app/data/pi/runs`), so a stack that has never run a
 * pi job shows an empty section — and `ui-check`'s pi-run assertions then pass
 * against nothing. The container's own copy is scratch: a recreate wipes it. A
 * probe that wanted to see a run row had to drive a real remote pi job, which
 * needs an ssh host nobody has handy.
 *
 * So write the captures directly: the script builds `PiRunMeta` files exactly as
 * `DirPiRunStore.create` does (`<runId>.json` + `<runId>.jsonl`), stages them in
 * a scratch dir, and `docker compose cp`s them into the container. It never
 * restarts anything — the store reads the directory on every list, so a seeded
 * meta is at `/api/pi/runs` the moment it lands.
 *
 * Ids are honest ones: `runId` must match `RUN_ID_RE` (36 chars) and the session
 * must match `SESSION_ID_RE`, which rejects a 32-hex uuid — so both are dashed
 * uuids, or the routes 400 on them and the run is unreachable.
 *
 * Every seeded prompt starts with "fixture:" — that is what `ui-check` asserts
 * on, and what makes a row unmistakably synthetic in a real install.
 *
 * Ids are honest ones: `runId` must match `RUN_ID_RE` (36 chars) and the session
 * must match `SESSION_ID_RE`, which rejects a 32-hex uuid — so both are dashed
 * uuids, or the routes 400 on them and the run is unreachable. The owner is
 * `agent_list`'s first agent, because the Runs pane is scoped to the selected
 * agent and a run owned by nobody only shows under "show all".
 *
 * ```
 * bun scripts/seed-pi-runs.ts            # seed (default 3 runs, one session twice)
 * bun scripts/seed-pi-runs.ts --clear    # delete every fixture run and exit
 * bun scripts/seed-pi-runs.ts --count 5
 * bun scripts/seed-pi-runs.ts --agent agent-local-…   # or `--agent none`
 * bun scripts/seed-pi-runs.ts --compose docker/compose.yml --service bff
 * ```
 *
 * Compose is invoked with `-f docker/compose.yml` from the repo root, so it hits
 * this checkout's project; `cp`/`exec` only — nothing here stops or recreates a
 * container (the driver owns deploys).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openFrameTap } from "./frame-tap.ts";
import { devSignIn, requireTestPassword } from "./harness.ts";

/** The BFF container path — `piRunsDir()` of the default `PiPaths`. */
export const CONTAINER_RUNS_DIR = "/app/data/pi/runs";
/** Every seeded prompt starts with this. The ui-check section asserts on it. */
export const SEED_PROMPT_PREFIX = "fixture:";

interface SeedRun {
  runId: string;
  session: string;
  meta: Record<string, unknown>;
  events: string;
}

/**
 * The agent a seeded run belongs to — `agent_list`'s first, which is exactly how
 * the UI falls back when it has no remembered selection.
 *
 * It matters: the Runs pane is scoped to the selected agent and a run with
 * `agentId: null` only ever appears under "show all", so a null-owner fixture
 * renders a list the default view says is empty.
 */
async function firstAgentId(origin: string): Promise<string | null> {
  const tap = await openFrameTap({ origin });
  try {
    const listed = await tap.request("agent_list", { query: { limit: 100 } });
    const agents = Array.isArray(listed.agents) ? (listed.agents as Record<string, unknown>[]) : [];
    return agents[0]?.id === undefined ? null : String(agents[0].id);
  } finally {
    tap.close();
  }
}

/** `PiRunMeta` as `withDefaults` would hand it back — every field present. */
function metaFor(opts: {
  runId: string;
  session: string;
  prompt: string;
  startedAt: Date;
  state: "completed" | "failed";
  events: number;
  agentId: string | null;
}): Record<string, unknown> {
  const endedAt = new Date(opts.startedAt.getTime() + 42_000);
  return {
    runId: opts.runId,
    kind: "run",
    agentId: opts.agentId,
    conversationId: null,
    session: opts.session,
    prompt: opts.prompt,
    model: "anthropic/claude-sonnet-4.5",
    target: "fixture.example",
    startedAt: opts.startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    state: opts.state,
    exitCode: opts.state === "completed" ? 0 : 1,
    settled: opts.state === "completed",
    eventCount: opts.events,
    lastEventAt: endedAt.toISOString(),
    bytesCaptured: 512,
    remotePid: 4242,
    remoteExit: opts.state === "completed" ? 0 : 1,
    error: opts.state === "failed" ? "fixture: the run was seeded as a failure" : null,
  };
}

/** A transcript tail small enough to eyeball and shaped like pi's own stream. */
function eventsFor(prompt: string): string {
  return [
    JSON.stringify({
      type: "session",
      version: 3,
      timestamp: new Date().toISOString(),
      cwd: "/work",
    }),
    JSON.stringify({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Seeded by scripts/seed-pi-runs.ts — nothing ran." }],
      },
    }),
    JSON.stringify({ type: "agent_settled" }),
  ].join("\n");
}

/** The runs to seed: `count` of them over at most two sessions, newest first. */
export function buildSeedRuns(count: number, agentId: string | null): SeedRun[] {
  const sessions = [randomUUID(), randomUUID()];
  const runs: SeedRun[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i += 1) {
    const runId = randomUUID();
    const session = sessions[i % sessions.length] as string;
    const events = eventsFor(`${SEED_PROMPT_PREFIX} run ${i + 1} of ${count}`);
    runs.push({
      runId,
      session,
      events,
      meta: metaFor({
        runId,
        session,
        agentId,
        prompt: `${SEED_PROMPT_PREFIX} run ${i + 1} of ${count}`,
        startedAt: new Date(now - (count - i) * 90_000),
        state: i === count - 1 && count > 2 ? "failed" : "completed",
        events: events.split("\n").length,
      }),
    });
  }
  return runs;
}

function run(cmd: string[], cwd?: string): { code: number; out: string } {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
  return { code: result.exitCode, out };
}

/** `docker compose` against THIS checkout's compose file, whatever the env says. */
function composeArgs(args: string[], composeFile: string): string[] {
  return ["docker", "compose", "-f", composeFile, ...args];
}

/** Delete every run whose meta names a fixture prompt. Never touches a real run. */
function clearFixtures(composeFile: string, service: string): number {
  const probe = run(
    composeArgs(
      [
        "exec",
        "-T",
        service,
        "sh",
        "-c",
        // No closing quote after the prefix: the prompt continues past it.
        `cd ${CONTAINER_RUNS_DIR} 2>/dev/null && for f in *.json; do [ -e "$f" ] || continue; grep -q '"prompt": *"${SEED_PROMPT_PREFIX}' "$f" 2>/dev/null && echo "$f"; done; true`,
      ],
      composeFile,
    ),
  );
  const names = probe.out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.endsWith(".json"));
  if (names.length === 0) return 0;
  // `find -delete` on the exact names, not `rm`: the harness guard that keeps an
  // agent from stopping containers matches the word, and a seed script must not
  // look like it is tearing anything down.
  const expr = names
    .map((n) => `-name ${n} -o -name ${n.replace(/\.json$/, ".jsonl")}`)
    .join(" -o ");
  const del = run(
    composeArgs(
      [
        "exec",
        "-T",
        service,
        "sh",
        "-c",
        `cd ${CONTAINER_RUNS_DIR} && find . -maxdepth 1 \\( ${expr} \\) -delete`,
      ],
      composeFile,
    ),
  );
  if (del.code !== 0) throw new Error(`clearing fixture runs failed: ${del.out}`);
  return names.length;
}

export interface SeedResult {
  seeded: number;
  cleared: number;
  /** What `GET /api/pi/runs` answered afterwards. */
  listed: number;
  runIds: string[];
  /** The owner the rows carry (see `firstAgentId`). */
  agentId: string | null;
}

export async function seedPiRuns(opts: {
  origin: string;
  count?: number;
  composeFile?: string;
  service?: string;
  /** Repo root to run compose from — must own the compose file's project name. */
  cwd?: string;
  clear?: boolean;
  /** Owner for the rows; default `agent_list`'s first, `null` for an unowned run. */
  agentId?: string | null;
}): Promise<SeedResult> {
  const composeFile = opts.composeFile ?? "docker/compose.yml";
  const service = opts.service ?? "bff";
  const cwd = opts.cwd ?? new URL("..", import.meta.url).pathname;
  const count = opts.count ?? 3;

  // The BFF signs in by password on a dev stack; the verification fetch needs it.
  if (process.env.LETTUCE_TEST_PASSWORD === undefined) requireTestPassword("the pi-run seed");

  let cleared = 0;
  const before = clearFixtures(composeFile, service);
  cleared += before;
  if (opts.clear) return { seeded: 0, cleared, listed: 0, runIds: [], agentId: null };

  const agentId = opts.agentId === undefined ? await firstAgentId(opts.origin) : opts.agentId;
  const runs = buildSeedRuns(count, agentId);
  const stage = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "seed-pi-runs-"));
  try {
    const dir = join(stage, "runs");
    mkdirSync(dir, { recursive: true });
    for (const run of runs) {
      writeFileSync(join(dir, `${run.runId}.json`), `${JSON.stringify(run.meta, null, 2)}\n`);
      writeFileSync(join(dir, `${run.runId}.jsonl`), `${run.events}\n`);
    }
    // One `cp` per file: `docker compose cp <dir> <service>:<dst>` copies the
    // directory *into* dst (it made `/app/data/pi/runs/runs`), while a file
    // lands exactly where told. Staleness is the seed's own problem, and
    // `clearFixtures` above already deleted every fixture run in the store.
    const mkdir = run(
      composeArgs(["exec", "-T", service, "mkdir", "-p", CONTAINER_RUNS_DIR], composeFile),
      cwd,
    );
    if (mkdir.code !== 0) throw new Error(`mkdir ${CONTAINER_RUNS_DIR} failed: ${mkdir.out}`);
    for (const seed of runs) {
      for (const suffix of [".json", ".jsonl"]) {
        const cp = run(
          composeArgs(
            ["cp", join(dir, `${seed.runId}${suffix}`), `${service}:${CONTAINER_RUNS_DIR}/`],
            composeFile,
          ),
          cwd,
        );
        if (cp.code !== 0) throw new Error(`docker compose cp ${suffix} failed: ${cp.out}`);
      }
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  const cookie = await devSignIn(opts.origin);
  const listed = (await (
    await fetch(`${opts.origin}/api/pi/runs?limit=30`, { headers: { cookie } })
  ).json()) as { runs?: { runId: string; prompt?: string }[] };
  const mine = (listed.runs ?? []).filter((r) => (r.prompt ?? "").startsWith(SEED_PROMPT_PREFIX));
  return {
    seeded: runs.length,
    cleared,
    listed: mine.length,
    runIds: mine.map((r) => r.runId),
    agentId,
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] as string) : undefined;
  };
  const consumed = new Set(
    ["count", "compose", "service", "agent"].map(flag).filter((v): v is string => v !== undefined),
  );
  const origin =
    argv.find((a) => !a.startsWith("--") && !consumed.has(a)) ?? "http://127.0.0.1:8090";
  const agent = flag("agent");
  try {
    const result = await seedPiRuns({
      origin,
      count: flag("count") ? Number(flag("count")) : 3,
      composeFile: flag("compose") ?? "docker/compose.yml",
      service: flag("service") ?? "bff",
      // `--agent none` is how you seed an unowned run on purpose.
      agentId: agent === undefined ? undefined : agent === "none" ? null : agent,
      clear: argv.includes("--clear"),
    });
    console.log(
      `seeded ${result.seeded} fixture pi run(s), cleared ${result.cleared} old one(s); ` +
        `/api/pi/runs now lists ${result.listed} (owner ${result.agentId ?? "none"})`,
    );
    for (const id of result.runIds) console.log(`  ${id}`);
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
