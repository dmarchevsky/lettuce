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
import { normalizePathPrepend, type PiSettings, piTarget } from "./settings.ts";

/** pi session ids are plain UUIDs (docs/session-format.md). */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPiSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/** `pi_<session uuid>` — the parity id the tools and viewer link runs by. */
export function piAgentId(sessionId: string): string {
  return `pi_${sessionId}`;
}

export type PiRunState = "running" | "completed" | "detached" | "failed" | "cancelled";

/** How late progress metadata may read from `pi_status` while a run streams (A1). */
export const PI_META_FLUSH_INTERVAL_MS = 2_000;
/** … or how many captured lines force a flush regardless of time. */
export const PI_META_FLUSH_LINES = 64;

export interface PiRunMeta {
  runId: string;
  kind: "run" | "send";
  /**
   * Which agent started it, when the call came from one. Per-agent hosts make
   * this load-bearing rather than cosmetic: a follow-up has to go to the host
   * that made the session, and runs are listed for every agent. Old run files
   * simply read as null.
   */
  agentId: string | null;
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
  /** Bytes captured so far — the honest counter a frozen `events 0` could not be. */
  bytesCaptured: number;
  /** The pi process on the remote host, captured from stderr; force-stop kills it. */
  remotePid: number | null;
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
 *
 * The PATH assignment is `PATH='<prepend>':"$PATH"` and not `'<prepend>:$PATH'`:
 * the `$PATH` has to survive to the *remote* shell, and a value that quotes it
 * keeps the five characters literally. env then looks up the program with that
 * broken PATH in hand, and the whole run dies with `env: 'sh': No such file or
 * directory` — an operator-visible failure from a field that looks correct.
 * Two adjacent quoted segments concatenate, so the prepend stays quoted and
 * `$PATH` still expands, spaces in the inherited PATH included.
 *
 * The `{ pi … & rp=$!; echo pid >&2; wait $rp; }` wrapper exists for one
 * reason: force-stop needs pi's REMOTE pid. Backgrounding pi makes its own pid
 * `$!` (backgrounding the whole compound would name a subshell whose kill
 * orphans pi), and `wait $rp` — not a bare `wait`, which always returns 0 —
 * keeps the ssh exit code equal to pi's. The marker goes to stderr because
 * stdout is the json stream.
 */
export function buildPiRemoteCommand(
  settings: PiSettings,
  options: { prompt: string; session?: string; model?: string | null },
): string {
  const pi: string[] = [];
  const prepend = normalizePathPrepend(settings.pathPrepend);
  if (prepend) pi.push("env", `PATH=${shq(prepend)}:"$PATH"`);
  pi.push("pi", "--mode", "json");
  if (options.session) {
    if (!isPiSessionId(options.session)) throw new Error("not a pi session id");
    pi.push("--session", shq(options.session));
  }
  const model = options.model ?? settings.model;
  if (model) pi.push("--model", shq(model));
  pi.push(shq(options.prompt));
  return [
    "cd",
    shq(settings.workdir),
    "&&",
    "{",
    ...pi,
    "&",
    "rp=$!;",
    'echo "lettuce-remote-pid $rp" >&2;',
    "wait $rp;",
    "}",
  ].join(" ");
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
  /** mtime of the capture file — the liveness signal `quiet` verdicts come from. */
  eventsMtimeMs(runId: string): Promise<number | null>;
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
      return withDefaults(JSON.parse(await fs.readFile(this.metaPath(runId), "utf8")) as PiRunMeta);
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
        metas.push(
          withDefaults(JSON.parse(await fs.readFile(`${this.dir}/${name}`, "utf8")) as PiRunMeta),
        );
      } catch {
        // A half-written meta is skipped, never fatal to the listing.
      }
    }
    return metas.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, Math.max(0, limit));
  }
  /**
   * The run that created a pi session, newest first. A follow-up must reach the
   * host that made the session — a pi session id means nothing on another
   * machine — so the send path looks the origin up instead of trusting the
   * agent that happens to be asking.
   */
  async findBySession(session: string): Promise<PiRunMeta | null> {
    for (const meta of await this.list(500)) {
      if (meta.session === session) return meta;
    }
    return null;
  }
  async readEventsTail(runId: string, maxChars: number): Promise<string | null> {
    const fs = await import("node:fs/promises");
    try {
      const fh = await fs.open(this.eventsPath(runId), "r");
      try {
        const { size } = await fh.stat();
        if (size <= maxChars) return (await fh.readFile()).toString("utf8");
        // A seeked tail can cut a multi-byte character at its start; TextDecoder
        // leniency turns that into one replacement glyph, and every reader of a
        // tail parses line-by-line leniently anyway.
        const buf = Buffer.allocUnsafe(maxChars);
        await fh.read(buf, 0, maxChars, size - maxChars);
        return buf.toString("utf8");
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  }
  async eventsMtimeMs(runId: string): Promise<number | null> {
    const fs = await import("node:fs/promises");
    try {
      return (await fs.stat(this.eventsPath(runId))).mtimeMs;
    } catch {
      return null;
    }
  }
}

/** Pre-A1 run files lack the new fields; readers should never see `undefined` for them. */
function withDefaults(meta: PiRunMeta): PiRunMeta {
  meta.bytesCaptured ??= 0;
  meta.remotePid ??= null;
  return meta;
}

export class PiRunner {
  private readonly children = new Map<string, PiProcess>();
  /** Live runs by id — the in-process truth behind the on-disk meta. */
  private readonly metas = new Map<string, PiRunMeta>();
  /** Resolve-callbacks waiting on a run reaching a terminal state (`pi_wait`). */
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly store: PiRunStore,
    private readonly spawner: PiSpawner,
    private readonly now: () => Date = () => new Date(),
    /** Fires once per run as it reaches a terminal state (push-on-settle). */
    private readonly onSettle?: (meta: PiRunMeta) => void,
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
    options: {
      kind: "run" | "send";
      prompt: string;
      session?: string;
      model?: string | null;
      agentId?: string | null;
    },
  ): Promise<PiRunMeta> {
    const remote = buildPiRemoteCommand(settings, options);
    const args = buildSshArgs(settings, files, remote);
    const meta: PiRunMeta = {
      runId: randomUUID(),
      kind: options.kind,
      agentId: options.agentId ?? null,
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
      bytesCaptured: 0,
      remotePid: null,
      error: null,
    };
    await this.store.create(meta);
    this.metas.set(meta.runId, meta);

    let buffer = "";
    let stderrTail = "";
    let lineChain: Promise<void> = Promise.resolve();
    // Progress truth (A1): eventCount/lastEventAt living only in memory is how
    // an 18 MB run read as `events 0` for 26 minutes in prod. Flush dirty
    // progress at most every interval — never per line, an 18 MB stream is
    // thousands of lines.
    let lastFlushMs = this.now().getTime();
    let linesSinceFlush = 0;
    const handleLine = async (line: string) => {
      if (!line.trim()) return;
      await this.store.appendEvent(meta, line);
      meta.eventCount += 1;
      meta.bytesCaptured += line.length + 1;
      meta.lastEventAt = this.now().toISOString();
      linesSinceFlush += 1;
      const ms = this.now().getTime();
      let flushedNow = false;
      if (linesSinceFlush >= PI_META_FLUSH_LINES || ms - lastFlushMs >= PI_META_FLUSH_INTERVAL_MS) {
        linesSinceFlush = 0;
        lastFlushMs = ms;
        flushedNow = true;
      }
      try {
        const record = JSON.parse(line) as { type?: string; id?: string };
        if (record.type === "session" && typeof record.id === "string" && !meta.session) {
          meta.session = record.id;
          flushedNow = true;
        } else if (record.type === "agent_settled" && !meta.settled) {
          meta.settled = true;
          flushedNow = true;
        }
      } catch {
        // Lenient: a line that is not JSON is still part of the captured stream.
      }
      if (flushedNow) await this.store.update(meta);
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
        // The wrapper's first stderr line is pi's remote pid; force-stop kills
        // it through a second ssh, so it must reach the durable record.
        if (meta.remotePid === null) {
          const m = /lettuce-remote-pid (\d+)/.exec(stderrTail);
          if (m) {
            meta.remotePid = Number(m[1]);
            lineChain = lineChain.then(() => this.store.update(meta));
          }
        }
      },
    );
    this.children.set(meta.runId, child);

    void child.exited.then(async ({ code }) => {
      this.children.delete(meta.runId);
      await lineChain;
      if (buffer.trim()) await handleLine(buffer);
      // A force-stop already recorded `cancelled`; a detached-or-completed write
      // here would overwrite the honest verdict with a guess.
      if (meta.state !== "running") {
        this.settle(meta);
        return;
      }
      meta.exitCode = code;
      meta.endedAt = this.now().toISOString();
      if (meta.settled) meta.state = "completed";
      else if (meta.eventCount === 0) {
        meta.state = "failed";
        meta.error = stderrTail.trim() || `ssh exited ${code}`;
      } else meta.state = "detached";
      await this.store.update(meta);
      this.settle(meta);
    });
    return meta;
  }

  /** Once-per-run settle bookkeeping: waiters wake, `onSettle` fires, meta is retired. */
  private settle(meta: PiRunMeta): void {
    if (!this.metas.delete(meta.runId)) return;
    const waiting = this.waiters.get(meta.runId);
    if (waiting) {
      this.waiters.delete(meta.runId);
      for (const wake of [...waiting]) wake();
    }
    try {
      this.onSettle?.(meta);
    } catch {
      // A broken notification must never corrupt a recorded run.
    }
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

  /**
   * Record a force-stop after the remote kill succeeded: the run is `cancelled`
   * (not `detached` — the remote really was stopped), and the local capture goes
   * with it. The ssh exit hook sees the terminal state and does not overwrite it.
   */
  async cancel(runId: string): Promise<boolean> {
    const meta = this.metas.get(runId);
    if (!meta) return false;
    meta.state = "cancelled";
    meta.endedAt = meta.endedAt ?? this.now().toISOString();
    meta.error = `force-stopped: remote pi ${meta.remotePid ?? "?"} terminated`;
    await this.store.update(meta);
    this.children.get(runId)?.kill();
    this.settle(meta);
    return true;
  }

  /**
   * Resolve when `runId` reaches a terminal state, or after `timeoutMs`. A run
   * this runner never started (or already finished) resolves immediately — the
   * caller reads the store and gets the truth either way.
   */
  wait(runId: string, timeoutMs: number): Promise<void> {
    if (!this.metas.has(runId)) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const wake = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.get(runId)?.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      timer.unref?.();
      let waiting = this.waiters.get(runId);
      if (!waiting) {
        waiting = new Set();
        this.waiters.set(runId, waiting);
      }
      waiting.add(wake);
    });
  }
}
