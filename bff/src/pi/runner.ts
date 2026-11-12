/**
 * The ssh runner: what a remote-pi run actually is.
 *
 * One run = one non-interactive `ssh` invocation running `pi --mode json` in
 * the configured workdir. pi's JSON mode prints its session header first, so a
 * run learns its own resumable session id from its own output. The
 * run's stdout jsonl is captured as the durable record the tools poll and the
 * viewer reads; the remote pi keeps its own session file, which the next run
 * resumes with `--session <uuid>`.
 *
 * Cancellation: killing the local ssh stops the capture, and that is all it can
 * do. Measured on pi 1.5.0: with no PTY, no `setsid` and no remote log file, the
 * remote pi dies writing to the closed pipe within seconds of the connection
 * going away. So stopping a run asks for the REMOTE pi to be killed (see
 * `stopRun` in `service.ts`), and `detached` is reserved for what it always has
 * meant — "we stopped watching", either because that was asked for or because
 * the connection died first. Completion is a clean ssh exit, with or without
 * the upstream `agent_settled` line.
 */

import { randomUUID } from "node:crypto";
import { normalizePathPrepend, type PiSettings, piCommandWords, piTarget } from "./settings.ts";

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
/** How many runs of one session the listing keeps, newest first. The session
 * viewer says so out loud when a session is longer than this. */
export const PI_SESSION_RUN_CAP = 60;

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
  /** The conversation that dispatched it; the settle report goes back there. */
  conversationId: string | null;
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
  /** The pi process on the remote host, captured from stderr; stop kills it. */
  remotePid: number | null;
  /**
   * pi's own exit code, printed by the wrapper just before ssh exits. Null for a
   * run that ended before the wrapper could report — the difference between
   * "the remote told us how it ended" and "the pipe went away", and the reason
   * a crash is no longer filed as a detach.
   */
  remoteExit: number | null;
  /** stderr tail, when the run failed outright (never an ssh secret). */
  error: string | null;
}

/** The injected process abstraction so tests never exec a real ssh. */
export interface PiProcess {
  readonly exited: Promise<{ code: number | null }>;
  kill(): void;
  /** Write text to the child's stdin and close it (C2: the prompt never enters argv). */
  sendStdin?(text: string): void;
  /** Close stdin when nothing will be sent (one-shot ssh calls; nothing reads it). */
  closeStdin?(): void;
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
 * Quote a command word for the remote shell only when it needs it. Words made of
 * portable filename characters (`pi`, `pi-bolt`, `--thinking`, `/opt/pi/bin/pi`)
 * go through bare so the generated command stays readable — and so the fixtures
 * that read it, including the ones that substitute a program to run the shape
 * locally, keep matching.
 */
export function shqWord(value: string): string {
  // A negated class rather than `^[…]+$`, whose `$` would also match before a
  // trailing newline and let a word ending in one through unquoted.
  return value !== "" && !/[^\w@%+=:,./-]/.test(value) ? value : shq(value);
}

/**
 * Quote a value for a double-quoted REMOTE context. The wrapper embeds the inner
 * script in `"…"` inside the single-quoted ssh argument, so the four characters
 * an outer shell would otherwise eat have to be escaped: the inner script's `$$`
 * pid marker must survive to the inner shell, and backticks, `"` and `\` cannot
 * be reinterpreted on the way. pi's own arguments arrive already single-quoted
 * by `shq`, which a double-quoted context passes through literally.
 */
export function shdq(value: string): string {
  return `"${value.replace(/[\\$"`]/g, (c) => `\\${c}`)}"`;
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
 * The command is two shells deep, each for one reason.
 *
 * The INNER shell is the pid marker's whole trick: the stop path needs pi's REMOTE
 * pid, so the inner shell prints its own `$$` and then `exec`s pi, which makes
 * that pid pi's. (`&`-backgrounding pi instead would give it /dev/null stdin —
 * the bug the `exec` form exists to fix — and backgrounding a subshell would
 * name a process whose kill orphans pi.)
 *
 * The OUTER wrapper is why a run can tell a crash from a lost connection. pi's
 * exit code alone cannot: a pi killed by a signal reaches ssh as `128+n` (dash
 * reports the signal), and a pi whose ssh connection dropped dies writing to the
 * closed stdout, which reaches ssh the same way. So once the inner shell is
 * really gone the wrapper prints `lettuce-remote-exit <code>` to stderr and
 * re-raises that code. A run whose stream carries the marker knows pi's own
 * exit code; one whose ssh died without it knows only that the pipe went away,
 * and says so instead of guessing. Both markers go to stderr because stdout is
 * the json stream.
 */
export function buildPiRemoteCommand(
  settings: PiSettings,
  options: { session?: string; model?: string | null },
): string {
  // C2: no prompt in argv. An argv prompt is world-readable in the remote's
  // `ps`, bounded by ARG_MAX, and quoted through two shells; pi reads the
  // message from stdin instead (proved against pi 1.1.0 before this shipped),
  // and the runner writes it into the ssh stdin and closes it.
  //
  // The pid marker needs a trick: a `&`-backgrounded job gets its stdin
  // redirected to /dev/null by POSIX shells when job control is off (caught
  // live: the first stdin design ran `pi &` and pi saw an immediate EOF).
  // So pi is `exec`'d inside an inner sh instead — stdin survives, the inner
  // shell's $$ is pi's own pid after the exec replaces it, and the exec also
  // passes pi's exit code through untouched.
  const inner: string[] = [
    'echo "lettuce-remote-pid $$" >&2;',
    "exec",
    // The program and its fixed arguments, from the `command` setting: one line
    // typed by the operator, split into words and quoted here (see settings.ts).
    // Our flags come AFTER them on purpose: `--mode json` and `--approve` are the
    // contract this runner parses and the reason a run never blocks on a prompt.
    // They stay the last words because `parsePiCommand` refuses the ones it
    // could clash with (`--`, `--mode`, `--approve`, `--session`, `--model`).
    ...piCommandWords(settings.command).map(shqWord),
    "--mode",
    "json",
    // Trust project-local files: a session resumed onto another project's dir
    // would otherwise block on an interactive [y/N] that nobody can answer in
    // json mode (the cross-project fork trap).
    "--approve",
  ];
  if (options.session) {
    if (!isPiSessionId(options.session)) throw new Error("not a pi session id");
    inner.push("--session", shq(options.session));
  }
  const model = options.model ?? settings.model;
  if (model) inner.push("--model", shq(model));
  const outer: string[] = ["cd", shq(settings.workdir), "&&"];
  const prepend = normalizePathPrepend(settings.pathPrepend);
  if (prepend) outer.push("env", `PATH=${shq(prepend)}:"$PATH"`);
  const wrapper = `/bin/sh -c ${shdq(inner.join(" "))}; rc=$?; echo "lettuce-remote-exit $rc" >&2; exit $rc`;
  outer.push("/bin/sh", "-c", shq(wrapper));
  return outer.join(" ");
}

/**
 * pi_exec: one raw command in the configured workdir over the same ssh
 * channel and PATH prefix a pi run gets — deterministic, no agent in the
 * loop. The caller already proved it can reach this host (the pi tools do).
 */
export function buildPiExecRemoteCommand(settings: PiSettings, command: string): string {
  const outer: string[] = ["cd", shq(settings.workdir), "&&"];
  const prepend = normalizePathPrepend(settings.pathPrepend);
  if (prepend) outer.push("env", `PATH=${shq(prepend)}:"$PATH"`);
  outer.push("/bin/sh", "-c", shq(command));
  return outer.join(" ");
}

/**
 * The settle manifest: files the run created or modified under the workdir —
 * everything modified after the run started, minus git and dependency noise,
 * minus anything past the fetch cap. `find -printf` is GNU; see the C1 note.
 */
export function buildPiFindRemoteCommand(settings: PiSettings, sinceMs: number): string {
  const outer: string[] = ["cd", shq(settings.workdir), "&&"];
  outer.push(
    "find",
    ".",
    "-xdev",
    "-type",
    "f",
    "-newermt",
    shq(`@${Math.floor(sinceMs / 1000)}`),
    "-not",
    "-path",
    '"*/.git/*"',
    "-not",
    "-path",
    '"*/node_modules/*"',
    "-size",
    "-25M",
    "-printf",
    '"%P %s\\n"',
    "| head -80",
  );
  return outer.join(" ");
}

/**
 * pi_fetch (C1): one file from the remote, base64'd so the text-only ssh
 * capture carries bytes. The path is confined to the configured workdir by
 * resolving both ends remotely (`realpath -e`) and prefix-matching, so `..`,
 * symlinks and absolute paths cannot escape it; size is capped at 25 MB.
 * Markers on stdout name every refusal: `lettuce-fetch: missing|outside|too_big`.
 * shortcut: `realpath -e`/`base64` assume GNU userlands (every worker so far);
 * upgrade with a BSD fallback if a macOS worker appears.
 */
export function buildPiFetchRemoteCommand(settings: PiSettings, path: string): string {
  return [
    "cd",
    shq(settings.workdir),
    "&&",
    "wd=$(realpath -e .) && rp=$(realpath -e --",
    shq(path),
    ") || { echo 'lettuce-fetch: missing'; exit 0; };",
    'case "$rp" in "$wd/"*) ;; *) echo \'lettuce-fetch: outside\'; exit 0;; esac;',
    'sz=$(wc -c <"$rp");',
    "if [ \"$sz\" -gt 26214400 ]; then echo 'lettuce-fetch: too_big'; exit 0; fi;",
    'echo "lettuce-fetch: size $sz";',
    'base64 "$rp"',
  ].join(" ");
}

/** pi_ls (C1): a listing inside the workdir, the same confinement as a fetch. */
export function buildPiLsRemoteCommand(settings: PiSettings, path: string): string {
  return [
    "cd",
    shq(settings.workdir),
    "&&",
    "wd=$(realpath -e .) && rp=$(realpath -e --",
    shq(path),
    ") || { echo 'lettuce-ls: missing'; exit 0; };",
    'case "$rp" in "$wd"|"$wd/"*) ;; *) echo \'lettuce-ls: outside\'; exit 0;; esac;',
    'ls -la "$rp" 2>&1 | head -c 8192',
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
  private readonly dir: string;
  /**
   * Session id → the run that made it, for every run this process has written.
   *
   * A follow-up has to go to the host that made the session, and `pi_send` asks
   * that question on every dispatch. Answering it from disk meant reading and
   * parsing every meta file — retention keeps a few hundred — to find one line
   * this process was told about when it wrote the run. The scan below stays as
   * the fallback for runs recorded before this process started.
   */
  private readonly sessionRuns = new Map<string, string>();

  constructor(dir: string) {
    this.dir = dir;
  }

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
    if (meta.session) this.sessionRuns.set(meta.session, meta.runId);
  }
  async update(meta: PiRunMeta): Promise<void> {
    const fs = await import("node:fs/promises");
    await fs.writeFile(this.metaPath(meta.runId), `${JSON.stringify(meta, null, 2)}\n`);
    // The session is learned from the stream a moment after the run starts, so
    // this is where the index gets it.
    if (meta.session) this.sessionRuns.set(meta.session, meta.runId);
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
    const known = this.sessionRuns.get(session);
    if (known) {
      const meta = await this.read(known);
      // A swept-away run leaves a stale entry behind; the scan settles it.
      if (meta?.session === session) return meta;
    }
    for (const meta of await this.list(500)) {
      if (meta.session === session) return meta;
    }
    return null;
  }
  /**
   * Every run on one pi session, oldest first — the session viewer's spine.
   * A pi session is a file on one host, so the runs sharing it are the whole
   * history of what lettuce asked of that conversation. The in-process index
   * names only each session's origin run, so this scans the way
   * `findBySession`'s fallback does (retention keeps a few hundred metas), and
   * `cap` keeps the newest few when a session has outlived its usefulness.
   */
  async listBySession(session: string, cap = PI_SESSION_RUN_CAP): Promise<PiRunMeta[]> {
    const mine = (await this.list(Number.MAX_SAFE_INTEGER)).filter(
      (meta) => meta.session === session,
    );
    return mine.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)).slice(-cap);
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

  private filesDir(runId: string): string {
    if (!RUN_ID_RE.test(runId)) throw new Error("not a run id");
    return `${this.dir}/${runId}`;
  }

  /** A fetched artifact name: nothing path-shaped survives the sanitize. */
  static safeFileName(name: string): string {
    const base = name.split("/").pop() ?? "file";
    return (
      base
        .replace(/[^A-Za-z0-9._-]/g, "_")
        .replace(/^\.+/, "_")
        .slice(0, 100) || "file"
    );
  }

  /** pi_fetch lands here (C1): `runs/<runId>/<name>`, next to the capture. */
  async saveFile(runId: string, name: string, bytes: Uint8Array): Promise<string> {
    const fs = await import("node:fs/promises");
    const safe = DirPiRunStore.safeFileName(name);
    await fs.mkdir(this.filesDir(runId), { recursive: true });
    await fs.writeFile(`${this.filesDir(runId)}/${safe}`, bytes);
    return safe;
  }

  async listFiles(runId: string): Promise<{ name: string; size: number }[]> {
    const fs = await import("node:fs/promises");
    try {
      const entries = await fs.readdir(this.filesDir(runId), { withFileTypes: true });
      const out: { name: string; size: number }[] = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const st = await fs.stat(`${this.filesDir(runId)}/${entry.name}`);
        out.push({ name: entry.name, size: st.size });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  /** Exact-match read: a name that sanitizes to something else never resolves. */
  async readFile(runId: string, name: string): Promise<Buffer | null> {
    if (name !== DirPiRunStore.safeFileName(name)) return null;
    const fs = await import("node:fs/promises");
    try {
      return await fs.readFile(`${this.filesDir(runId)}/${name}`);
    } catch {
      return null;
    }
  }

  /**
   * Retention: delete every run past the newest `keep`, plus any run older
   * than `maxAgeMs` (meta mtime by `startedAt`; an unparseable date counts as
   * old). Meta and capture always go together — a lone jsonl is nobody's
   * record. Returns the number of runs removed.
   */
  async sweep(keep: number, maxAgeMs: number, nowMs: number): Promise<number> {
    const fs = await import("node:fs/promises");
    const cutoff = nowMs - maxAgeMs;
    let removed = 0;
    for (const [index, meta] of (await this.list(Number.MAX_SAFE_INTEGER)).entries()) {
      const started = Date.parse(meta.startedAt);
      if (index < keep && !Number.isNaN(started) && started >= cutoff) continue;
      await fs.rm(this.metaPath(meta.runId), { force: true });
      await fs.rm(this.eventsPath(meta.runId), { force: true });
      if (meta.session) this.sessionRuns.delete(meta.session);
      // Fetched artifacts (C1) ride the run they were fetched for.
      if (RUN_ID_RE.test(meta.runId))
        await fs.rm(`${this.dir}/${meta.runId}`, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }
}

/** Pre-A1 run files lack the new fields; readers should never see `undefined` for them. */
function withDefaults(meta: PiRunMeta): PiRunMeta {
  meta.bytesCaptured ??= 0;
  meta.remotePid ??= null;
  meta.remoteExit ??= null;
  return meta;
}

/**
 * One short clause out of an ssh stderr tail, for a `meta.error` that a model
 * reads in a conversation and a person reads on a card. The tail is kept whole
 * in memory precisely so the last lines — the ones that name the reason — can be
 * quoted here; a 2 KB dump of `ssh` chatter in a transcript helps nobody.
 */
function brief(text: string): string {
  // The wrapper's own protocol lines travel in the same stderr and are noise to
  // whoever reads the error — the reason is what the tail is for.
  const flat = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("lettuce-remote-"))
    .join(" ")
    .trim()
    .replace(/\s+/g, " ");
  if (!flat) return "";
  return flat.length > 200 ? `: …${flat.slice(-197)}` : `: ${flat}`;
}

export class PiRunner {
  private readonly children = new Map<string, PiProcess>();
  /** Live runs by id — the in-process truth behind the on-disk meta. */
  private readonly metas = new Map<string, PiRunMeta>();
  /** Runs whose capture we were asked to stop, so their exit is a detach we chose. */
  private readonly stopRequested = new Set<string>();

  constructor(
    private readonly store: PiRunStore,
    private readonly spawner: PiSpawner,
    private readonly now: () => Date = () => new Date(),
    /** Fires once per run as it reaches a terminal state (push-on-settle). */
    private readonly onSettle?: (meta: PiRunMeta) => void,
    /** Fires on every meta flush while running, and once more at the terminal
     * state — the push-over-poll feed for the browser (throttled with the meta). */
    private readonly onProgress?: (meta: PiRunMeta) => void,
  ) {}

  /** Anything still marked running at boot is an orphan from a previous BFF: capture ended, remote unknown. */
  async reconcileOnBoot(): Promise<number> {
    let orphaned = 0;
    for (const meta of await this.store.list(1000)) {
      if (meta.state !== "running") continue;
      // A run this process is watching is not an orphan however stale its stored
      // meta reads; detaching it here would report it twice — once from here, once
      // from its own exit hook.
      if (this.children.has(meta.runId)) continue;
      const orphan: PiRunMeta = {
        ...meta,
        state: "detached",
        endedAt: meta.endedAt ?? this.now().toISOString(),
        error:
          "the BFF restarted, so its capture of this run ended; the remote pi almost certainly " +
          "died on its next write to a stream nobody was reading",
      };
      await this.store.update(orphan);
      // A run that ends in front of us gets its verdict from the exit hook; an
      // orphan has no ssh left to report anything, which is what the line says.
      // Report it the way a run that ended in front of us reports itself. These
      // are the runs whose dispatching conversation is still waiting for a line
      // that will now never arrive on its own, and `settle()` only serves runs
      // this process was watching, so the hooks fire directly. The upstream send
      // retries until the app-server connection is up — reconcile runs at boot.
      this.report(orphan);
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
      conversationId?: string | null;
      /** Run budget guards (0/absent = off): the run cancels itself, remotely. */
      maxEvents?: number;
      maxRuntimeMinutes?: number;
    },
  ): Promise<PiRunMeta> {
    const remote = buildPiRemoteCommand(settings, options);
    const args = buildSshArgs(settings, files, remote);
    const meta: PiRunMeta = {
      runId: randomUUID(),
      kind: options.kind,
      agentId: options.agentId ?? null,
      conversationId: options.conversationId ?? null,
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
      remoteExit: null,
      error: null,
    };
    await this.store.create(meta);
    this.metas.set(meta.runId, meta);

    let buffer = "";
    let stderrTail = "";
    let lineChain: Promise<void> = Promise.resolve();
    // Budget guards: a runaway is more expensive to babysit than to let die.
    // The kill mirrors pi_stop force (second ssh `kill <remotePid>`), so the
    // remote pi stops instead of running on after a detached capture.
    const maxEvents = Number(options.maxEvents) > 0 ? Number(options.maxEvents) : 0;
    const maxRuntimeMs =
      Number(options.maxRuntimeMinutes) > 0 ? Number(options.maxRuntimeMinutes) * 60_000 : 0;
    const deadlineMs = maxRuntimeMs ? new Date(meta.startedAt).getTime() + maxRuntimeMs : 0;
    let budgetStopActive = false;
    const budgetStop = async (why: string) => {
      if (budgetStopActive || meta.state !== "running") return;
      budgetStopActive = true;
      if (meta.remotePid) {
        try {
          const killer = this.spawner(
            buildSshArgs(settings, files, `kill ${meta.remotePid}`),
            () => {},
            () => {},
          );
          killer.closeStdin?.();
        } catch {
          // best-effort; the local cancel records the verdict either way
        }
      }
      await this.cancel(meta.runId, `budget exceeded (${why})`);
    };
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    if (deadlineMs)
      budgetTimer = setTimeout(
        () => void budgetStop(`${Math.round(maxRuntimeMs / 60_000)} min runtime`),
        Math.max(1, deadlineMs - Date.now()),
      );
    // Progress truth (A1): eventCount/lastEventAt living only in memory is how
    // an 18 MB run read as `events 0` for 26 minutes in prod. Flush dirty
    // progress at most every interval — never per line, an 18 MB stream is
    // thousands of lines.
    let lastFlushMs = this.now().getTime();
    let linesSinceFlush = 0;
    /** One durable flush; each *running* flush doubles as the progress frame. */
    const flushMeta = async () => {
      await this.store.update(meta);
      if (meta.state === "running") this.onProgress?.(meta);
    };
    const handleLine = async (line: string) => {
      if (!line.trim()) return;
      await this.store.appendEvent(meta, line);
      meta.eventCount += 1;
      meta.bytesCaptured += Buffer.byteLength(line) + 1;
      meta.lastEventAt = this.now().toISOString();
      linesSinceFlush += 1;
      const ms = this.now().getTime();
      if (meta.state === "running" && maxEvents && meta.eventCount >= maxEvents)
        void budgetStop(`${maxEvents} events`);
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
      if (flushedNow) await flushMeta();
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
        // The wrapper's first stderr line is pi remote pid; the stop path kills
        // it through a second ssh, so it must reach the durable record.
        if (meta.remotePid === null) {
          const m = /lettuce-remote-pid (\d+)/.exec(stderrTail);
          if (m) {
            meta.remotePid = Number(m[1]);
            lineChain = lineChain.then(flushMeta);
          }
        }
        // The last marker wins: a worker that somehow produced two (a retried
        // login shell, say) reported the second one as its own verdict.
        for (const m of stderrTail.matchAll(/lettuce-remote-exit (\d+)/g)) {
          meta.remoteExit = Number(m[1]);
        }
      },
    );
    this.children.set(meta.runId, child);
    // C2: the prompt travels through the ssh stdin and closes it, so pi sees
    // piped input (non-interactive) and the remote `ps` never names it.
    child.sendStdin?.(options.prompt);

    void child.exited.then(async ({ code }) => {
      if (budgetTimer) clearTimeout(budgetTimer);
      this.children.delete(meta.runId);
      await lineChain;
      if (buffer.trim()) await handleLine(buffer);
      // A stop-by-kill already recorded `cancelled`; a detached-or-completed write
      // here would overwrite the honest verdict with a guess.
      if (meta.state !== "running") {
        this.settle(meta);
        return;
      }
      meta.exitCode = code;
      meta.endedAt = this.now().toISOString();
      const askedToStop = this.stopRequested.delete(meta.runId);
      // The stderr tail is capped because it lands in a conversation and on a
      // card, not in a log file: the reason, not the dump.
      const stderrNote = brief(stderrTail);
      // A clean ssh exit IS the finish line: pi exits when its prompts are done,
      // so a zero with a captured stream is a finished run whether or not the
      // stream carried `agent_settled`. Making that one upstream event the only
      // completion signal meant a pi version skew or a truncated tail read as
      // "never finished" — and a run nobody reports is exactly what taught agents
      // to poll. `settled` stays on the meta as the separate fact it is.
      if (code === 0 && meta.eventCount > 0) meta.state = "completed";
      // `settled` outranks a late non-zero exit on purpose: pi said it was done,
      // and what happens to a process after it finishes its turn is not the
      // run's failure. The code still lands in `exitCode`/`remoteExit`.
      else if (meta.settled) meta.state = "completed";
      else if (askedToStop) {
        // This server chose to close the capture, so that is the story — even when
        // the worker got an exit code out alongside it. Asked for before anything
        // was captured still counts as our choice, not the remote's failure.
        meta.state = "detached";
        meta.error =
          "capture stopped on request; the remote pi dies writing to the closed stream" +
          (meta.remoteExit === null || meta.remoteExit === 0
            ? ""
            : ` (the worker reported pi exited ${meta.remoteExit})`);
      } else if (meta.remoteExit !== null && meta.remoteExit !== 0) {
        // The wrapper saw pi leave, so this is the remote's own verdict and not
        // our guess. Until now stderr was only recorded for a run that streamed
        // nothing, so a pi that crashed after working for a while was filed as
        // `detached` with `error: null` and the agent reading it blamed the
        // network. `137` plus the shell's `Killed` is not the network.
        meta.state = "failed";
        meta.error = `pi exited ${meta.remoteExit}${stderrNote}`;
      } else if (meta.eventCount === 0) {
        meta.state = "failed";
        meta.error = brief(stderrTail).slice(2) || `ssh exited ${code}`;
      } else {
        // No marker: pi never got to report how it ended, so the only honest
        // statement is that the pipe went away — the connection or ssh died.
        meta.state = "detached";
        meta.error = `the remote pi never reported its exit; ssh exited ${code ?? "on a signal"}${stderrNote}`;
      }
      await this.store.update(meta);
      this.settle(meta);
    });
    return meta;
  }

  /** Once-per-run settle bookkeeping: the terminal progress and `onSettle` fire
   * and the meta is retired. Nothing waits for a run any more — a settled run
   * reports itself into its conversation — so there are no waiters to wake. */
  private settle(meta: PiRunMeta): void {
    this.stopRequested.delete(meta.runId);
    if (!this.metas.delete(meta.runId)) return;
    this.report(meta);
  }

  /** The once-per-run notifications, guarded so a broken subscriber can never
   * corrupt a recorded run. */
  private report(meta: PiRunMeta): void {
    try {
      this.onProgress?.(meta);
    } catch {
      // A broken notification must never corrupt a recorded run.
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

  /**
   * Detach: kill the local capture only. The remote pi is not sent any signal —
   * and it will not long survive the closed stream, which is why stopping a run
   * goes through `cancel` (a remote kill) and only a requested detach lands here.
   */
  stop(runId: string): boolean {
    const child = this.children.get(runId);
    if (!child) return false;
    this.stopRequested.add(runId);
    child.kill();
    return true;
  }

  /**
   * Record a stop after the remote kill succeeded: the run is `cancelled`
   * (not `detached` — the remote really was stopped), and the local capture goes
   * with it. The ssh exit hook sees the terminal state and does not overwrite it.
   */
  async cancel(runId: string, reason?: string): Promise<boolean> {
    const meta = this.metas.get(runId);
    if (!meta) return false;
    meta.state = "cancelled";
    meta.endedAt = meta.endedAt ?? this.now().toISOString();
    meta.error = reason ?? `stopped: remote pi ${meta.remotePid ?? "?"} terminated`;
    await this.store.update(meta);
    this.children.get(runId)?.kill();
    this.settle(meta);
    return true;
  }
}
