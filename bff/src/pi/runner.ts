/**
 * The ssh runner: what a remote-pi run actually is.
 *
 * One run = one non-interactive `ssh` invocation running `pi --mode json` in
 * the configured workdir (docs/remote-pi-plan.md § 3.2/3.3 spike-proven). The
 * run's stdout jsonl is captured as the durable record the tools poll and the
 * viewer reads; the remote pi keeps its own session file, which the next run
 * resumes with `--session <uuid>`.
 *
 * Cancellation is detach-only (§ 4.5): killing the local ssh stops the
 * capture, the remote keeps working; `stop()` records that honestly as
 * `detached`, never pretending the remote stopped.
 */

import { randomUUID } from "node:crypto";
import { type PiSettings, piTarget } from "./settings.ts";

/** pi session ids are plain UUIDs (docs/session-format.md). */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPiSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/** `pi_<session uuid>` — the parity id the tools and viewer link runs by. */
export function piAgentId(sessionId: string): string {
  return `pi_${sessionId}`;
}

export type PiRunState = "running" | "completed" | "detached" | "failed";

export interface PiRunMeta {
  runId: string;
  kind: "run" | "send";
  /** Filled from the json session header shortly after start. */
  session: string | null;
  prompt: string;
  model: string | null;
  target: string;
  startedAt: string;
  endedAt: string | null;
  state: PiRunState;
  exitCode: number | null;
  /** Whether the stream carried `agent_settled` (the run finished on its own). */
  settled: boolean;
  eventCount: number;
  lastEventAt: string | null;
  /** stderr tail, when the run failed outright (never an ssh secret). */
  error: string | null;
}

/** The injected process abstraction so tests never exec a real ssh. */
export interface PiProcess {
  readonly exited: Promise<{ code: number | null }>;
  kill(): void;
}
export type PiSpawner = (
  args: readonly string[],
  onStdout: (chunk: string) => void,
  onStderr: (chunk: string) => void,
) => PiProcess;

/** Where ssh finds the key and the pinned hosts, as files (0600). */
export interface PiKeyFiles {
  keyFile: string;
  knownHostsFile: string;
}

/** Shell single-quote a value for the REMOTE shell (ssh joins argv into one remote command). */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The remote command: cd into the workdir, give a non-interactive PATH what it
 * misses (spike finding § 3.1), and run pi in json mode. Empty `pathPrepend`
 * must NOT emit `env PATH=:$PATH` — an empty PATH entry means the cwd.
 */
export function buildPiRemoteCommand(
  settings: PiSettings,
  options: { prompt: string; session?: string; model?: string | null },
): string {
  const parts = ["cd", shq(settings.workdir), "&&"];
  const prepend = settings.pathPrepend.trim();
  if (prepend) parts.push("env", `PATH=${shq(`${prepend}:$PATH`)}`);
  parts.push("pi", "--mode", "json");
  if (options.session) {
    if (!isPiSessionId(options.session)) throw new Error("not a pi session id");
    parts.push("--session", shq(options.session));
  }
  const model = options.model ?? settings.model;
  if (model) parts.push("--model", shq(model));
  parts.push(shq(options.prompt));
  return parts.join(" ");
}

/** The full ssh argv (the executable is `ssh`; this is everything after it). */
export function buildSshArgs(
  settings: PiSettings,
  files: PiKeyFiles,
  remoteCommand: string,
): string[] {
  return [
    "-o",
    `IdentityFile=${files.keyFile}`,
    // The key file is the one identity: an agent on the path must not quietly
    // substitute another one.
    "-o",
    "IdentitiesOnly=yes",
    "-p",
    String(settings.port),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${files.knownHostsFile}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    piTarget(settings),
    remoteCommand,
  ];
}

/** The per-run files: `<dir>/<runId>.json` (meta) and `<dir>/<runId>.jsonl` (captured stream). */
export interface PiRunStore {
  create(meta: PiRunMeta): Promise<void>;
  update(meta: PiRunMeta): Promise<void>;
  appendEvent(meta: PiRunMeta, line: string): Promise<void>;
  read(runId: string): Promise<PiRunMeta | null>;
  list(limit: number): Promise<PiRunMeta[]>;
  readEventsTail(runId: string, maxChars: number): Promise<string | null>;
}

const RUN_ID_RE = /^[0-9a-f-]{36}$/i;

export class DirPiRunStore implements PiRunStore {
  constructor(private readonly dir: string) {}

  private metaPath(runId: string): string {
    if (!RUN_ID_RE.test(runId)) throw new Error("not a run id");
    return `${this.dir}/${runId}.json`;
  }
  private eventsPath(runId: string): string {
    if (!RUN_ID_RE.test(runId)) throw new Error("not a run id");
    return `${this.dir}/${runId}.jsonl`;
  }

  async create(meta: PiRunMeta): Promise<void> {
    const fs = await import("node:fs/promises");
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.metaPath(meta.runId), `${JSON.stringify(meta, null, 2)}\n`);
    await fs.writeFile(this.eventsPath(meta.runId), "");
  }
  async update(meta: PiRunMeta): Promise<void> {
    const fs = await import("node:fs/promises");
    await fs.writeFile(this.metaPath(meta.runId), `${JSON.stringify(meta, null, 2)}\n`);
  }
  async appendEvent(meta: PiRunMeta, line: string): Promise<void> {
    const fs = await import("node:fs/promises");
    await fs.appendFile(this.eventsPath(meta.runId), `${line}\n`);
  }
  async read(runId: string): Promise<PiRunMeta | null> {
    const fs = await import("node:fs/promises");
    try {
      return JSON.parse(await fs.readFile(this.metaPath(runId), "utf8")) as PiRunMeta;
    } catch {
      return null;
    }
  }
  async list(limit: number): Promise<PiRunMeta[]> {
    const fs = await import("node:fs/promises");
    let names: string[];
    try {
      names = (await fs.readdir(this.dir)).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    // Names are random UUIDs, so recency comes from the meta itself.
    const metas: PiRunMeta[] = [];
    for (const name of names) {
      try {
        metas.push(JSON.parse(await fs.readFile(`${this.dir}/${name}`, "utf8")) as PiRunMeta);
      } catch {
        // A half-written meta is skipped, never fatal to the listing.
      }
    }
    return metas.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, Math.max(0, limit));
  }
  async readEventsTail(runId: string, maxChars: number): Promise<string | null> {
    const fs = await import("node:fs/promises");
    try {
      const text = await fs.readFile(this.eventsPath(runId), "utf8");
      return text.length > maxChars ? text.slice(-maxChars) : text;
    } catch {
      return null;
    }
  }
}

export class PiRunner {
  private readonly children = new Map<string, PiProcess>();

  constructor(
    private readonly store: PiRunStore,
    private readonly spawner: PiSpawner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Anything still marked running at boot is an orphan from a previous BFF: capture ended, remote unknown. */
  async reconcileOnBoot(): Promise<number> {
    let orphaned = 0;
    for (const meta of await this.store.list(1000)) {
      if (meta.state !== "running") continue;
      await this.store.update({
        ...meta,
        state: "detached",
        endedAt: meta.endedAt ?? this.now().toISOString(),
        error: "capture ended when the BFF restarted; the remote run may have continued",
      });
      orphaned += 1;
    }
    return orphaned;
  }

  async start(
    settings: PiSettings,
    files: PiKeyFiles,
    options: { kind: "run" | "send"; prompt: string; session?: string; model?: string | null },
  ): Promise<PiRunMeta> {
    const remote = buildPiRemoteCommand(settings, options);
    const args = buildSshArgs(settings, files, remote);
    const meta: PiRunMeta = {
      runId: randomUUID(),
      kind: options.kind,
      session: options.session ?? null,
      prompt: options.prompt,
      model: options.model ?? settings.model,
      target: piTarget(settings),
      startedAt: this.now().toISOString(),
      endedAt: null,
      state: "running",
      exitCode: null,
      settled: false,
      eventCount: 0,
      lastEventAt: null,
      error: null,
    };
    await this.store.create(meta);

    let buffer = "";
    let stderrTail = "";
    let lineChain: Promise<void> = Promise.resolve();
    const handleLine = async (line: string) => {
      if (!line.trim()) return;
      await this.store.appendEvent(meta, line);
      meta.eventCount += 1;
      meta.lastEventAt = this.now().toISOString();
      try {
        const record = JSON.parse(line) as { type?: string; id?: string };
        if (record.type === "session" && typeof record.id === "string" && !meta.session) {
          meta.session = record.id;
          await this.store.update(meta);
        } else if (record.type === "agent_settled" && !meta.settled) {
          meta.settled = true;
          await this.store.update(meta);
        }
      } catch {
        // Lenient: a line that is not JSON is still part of the captured stream.
      }
    };

    const child = this.spawner(
      args,
      (chunk) => {
        buffer += chunk;
        let cut = buffer.indexOf("\n");
        while (cut >= 0) {
          const line = buffer.slice(0, cut).replace(/\r$/, "");
          buffer = buffer.slice(cut + 1);
          lineChain = lineChain.then(() => handleLine(line));
          cut = buffer.indexOf("\n");
        }
      },
      (chunk) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-2_000);
      },
    );
    this.children.set(meta.runId, child);

    void child.exited.then(async ({ code }) => {
      this.children.delete(meta.runId);
      await lineChain;
      if (buffer.trim()) await handleLine(buffer);
      meta.exitCode = code;
      meta.endedAt = this.now().toISOString();
      if (meta.settled) meta.state = "completed";
      else if (meta.eventCount === 0) {
        meta.state = "failed";
        meta.error = stderrTail.trim() || `ssh exited ${code}`;
      } else meta.state = "detached";
      await this.store.update(meta);
    });
    return meta;
  }

  /** True when this BFF still has the ssh child alive. */
  isRunning(runId: string): boolean {
    return this.children.has(runId);
  }

  /** Detach: kill the local capture only. The remote pi is not stopped (§ 4.5). */
  stop(runId: string): boolean {
    const child = this.children.get(runId);
    if (!child) return false;
    child.kill();
    return true;
  }
}
