/**
 * The remote-pi service: local custody of the settings and keys, the real
 * `ssh` spawner, and the three tools the agents get.
 *
 * Everything here is BFF-local (`/app/data/pi` on the `bff-data` volume): the
 * private key never crosses the upstream connection and never returns to a
 * browser. The mod is just the thin POST wrapper (`internal-tools/mod.ts`);
 * all the work — and all the state — is here.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolAnswer, ToolHandler, ToolSpec } from "../internal-tools/types.ts";
import { capText } from "../internal-tools/types.ts";
import { effectivePiSettings, PiAgentSettingsStore } from "./agent-settings.ts";
import {
  ago,
  buildProbeRemoteCommand,
  checkTargetKey,
  classifyCheckOutput,
  type PiCheck,
  type PiCheckRecord,
  type PiCheckTarget,
  parseChecks,
  pinnedHostKey,
  renderChecks,
} from "./check.ts";
import {
  buildSshArgs,
  DirPiRunStore,
  isPiSessionId,
  type PiKeyFiles,
  type PiRunMeta,
  PiRunner,
  type PiSpawner,
  piAgentId,
} from "./runner.ts";
import {
  applyPiSettingsUpdate,
  InvalidPiSettingsError,
  type PiSettings,
  parsePiSettings,
  piConfigured,
  renderPiSettings,
} from "./settings.ts";

export {
  assertEffectiveUsable,
  DEFAULT_PI_AGENT_SETTINGS,
  effectivePiSettings,
  InvalidPiAgentSettingsError,
  isDefaultPiAgentSettings,
  type PiAgentSettings,
  parsePiAgentSettings,
} from "./agent-settings.ts";
export type { PiCheck, PiCheckRecord, PiCheckState, PiCheckTarget } from "./check.ts";
export type { PiRunMeta } from "./runner.ts";
export { DirPiRunStore, isPiSessionId, PiRunner, piAgentId } from "./runner.ts";
export type { PiSettings, PublicPiSettings } from "./settings.ts";
export { piConfigured, piTarget, toPublicPiSettings } from "./settings.ts";
export { InvalidPiSettingsError };

export interface PiPaths {
  /** Directory on the bff-data volume, e.g. `/app/data/pi`. */
  dir: string;
}
export function piSettingsFile(paths: PiPaths): string {
  return `${paths.dir}/settings.json`;
}
export function piKeyFile(paths: PiPaths): string {
  return `${paths.dir}/deploy_key`;
}
export function piKnownHostsFile(paths: PiPaths): string {
  return `${paths.dir}/known_hosts`;
}
export function piRunsDir(paths: PiPaths): string {
  return `${paths.dir}/runs`;
}
/** Per-agent overrides (workdir, host) — see `pi/agent-settings.ts`. */
export function piAgentSettingsFile(paths: PiPaths): string {
  return `${paths.dir}/agents.json`;
}
/** Last check per `user@host:port` — see `pi/check.ts`. */
export function piChecksFile(paths: PiPaths): string {
  return `${paths.dir}/checks.json`;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
}

/** The real spawner: `ssh` with piped stdio, resolved as a detached capture. */
export const sshSpawner: PiSpawner = (args, onStdout, onStderr) => {
  const child = Bun.spawn(["ssh", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const decode = (stream: ReadableStream<Uint8Array>, cb: (chunk: string) => void) => {
    void (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) cb(decoder.decode(value, { stream: true }));
      }
    })().catch(() => {});
  };
  decode(child.stdout, onStdout);
  decode(child.stderr, onStderr);
  return {
    exited: child.exited.then((code) => ({ code })),
    kill: () => {
      child.kill();
    },
  };
};

export interface PiServiceOptions {
  paths: PiPaths;
  /** Whether the `pi` compose profile token is on (effective-enabled gate). */
  featureEnabled: () => boolean;
  spawner?: PiSpawner;
  now?: () => Date;
  log?: (message: string) => void;
}

/** How long a check waits for ssh before calling the host unreachable. */
const PI_CHECK_TIMEOUT_MS = 15_000;

/**
 * What pinning came back as: written, or refused because a different key was
 * already pinned (the caller asks the human, then retries with `force`).
 */
export type PiPinResult =
  | { changed: false; lines: number; target: string; fingerprint: string | null }
  | { changed: true; target: string; oldFingerprint: string | null; newFingerprint: string | null };

export class PiService {
  private cached: { text: string | null; settings: PiSettings } | null = null;

  readonly store: DirPiRunStore;
  readonly runner: PiRunner;
  /** What each agent does differently (its own workdir, its own host). */
  readonly agentSettings: PiAgentSettingsStore;

  constructor(private readonly options: PiServiceOptions) {
    this.store = new DirPiRunStore(piRunsDir(options.paths));
    this.runner = new PiRunner(this.store, options.spawner ?? sshSpawner, options.now);
    this.agentSettings = new PiAgentSettingsStore(piAgentSettingsFile(options.paths), () => {});
  }

  /**
   * The connection one agent will actually use: the global record with its own
   * fields laid over it. `agentId` is what the mod sent in `x-letta-agent-id`;
   * null (a curl from an agent shell, a test) means the global record.
   */
  async settingsFor(agentId: string | null): Promise<PiSettings & { source: "global" | "agent" }> {
    const global = await this.load();
    if (!agentId) return { ...global, source: "global" };
    return effectivePiSettings(global, this.agentSettings.get(agentId));
  }

  get featureEnabled(): boolean {
    return this.options.featureEnabled();
  }

  async load(): Promise<PiSettings> {
    const text = await readOrNull(piSettingsFile(this.options.paths));
    if (this.cached && this.cached.text === text) return this.cached.settings;
    const settings = parsePiSettings(text);
    this.cached = { text, settings };
    return settings;
  }

  /** Effective-enabled: the token must be on for the stored switch to count. */
  async effectiveEnabled(): Promise<boolean> {
    return this.featureEnabled && piConfigured(await this.load());
  }

  /** Off-state message the tools answer with — the same tone as the codex shim. */
  disabledReason(): string {
    return this.featureEnabled
      ? "The remote pi worker is disabled (Settings → Remote pi worker)."
      : "The remote pi worker is off: COMPOSE_PROFILES has no `pi` token.";
  }

  async save(body: unknown): Promise<PiSettings> {
    const settings = applyPiSettingsUpdate(await this.load(), body);
    this.cached = null;
    if (settings.privateKey) {
      await writePrivate(piKeyFile(this.options.paths), settings.privateKey);
      // Keep the served public half honest: always re-derived from the key we
      // just stored, null when it cannot be parsed (a hand-edited PEM is then
      // simply shown as no-public-key rather than lying with a stale one).
      settings.publicKey = await this.derivePublicKey();
    } else {
      settings.publicKey = null;
    }
    await writePrivate(piSettingsFile(this.options.paths), renderPiSettings(settings));
    return settings;
  }

  /** `ssh-keygen -y` on the stored key; lenient (null on anything unusable). */
  private async derivePublicKey(): Promise<string | null> {
    try {
      const res = Bun.spawnSync({
        cmd: ["ssh-keygen", "-y", "-f", piKeyFile(this.options.paths)],
        stdin: "ignore",
      });
      const out = res.stdout.toString().trim();
      return res.exitCode === 0 && out.startsWith("ssh-") ? out : null;
    } catch {
      return null;
    }
  }

  /**
   * Generate (or rotate) the lettuce-held deploy key: the operator never
   * handles a private key — only the PUBLIC half is shown in Settings to paste
   * into the remote's `authorized_keys`. Rotation is always allowed; removing
   * the old line on the remote stays a manual step (the UI says so, and runs
   * keep working with whichever key the remote still trusts).
   */
  async generateKeyPair(): Promise<PiSettings> {
    const keyFile = piKeyFile(this.options.paths);
    const tmp = `${keyFile}.${randomUUID()}.gen`;
    try {
      const res = Bun.spawnSync({
        cmd: ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "lettuce-pi-worker", "-f", tmp],
        stdin: "ignore",
      });
      if (res.exitCode !== 0) {
        throw new Error(`ssh-keygen failed: ${res.stderr.toString().trim() || res.exitCode}`);
      }
      const pem = `${(await readFile(tmp, "utf8")).trimEnd()}\n`;
      const pub = (await readFile(`${tmp}.pub`, "utf8")).trim();
      await writePrivate(keyFile, pem);
      // Generate straight onto the settings record (no applyPiSettingsUpdate:
      // rotating a key must not require the rest of the config to be complete).
      const settings: PiSettings = {
        ...(await this.load()),
        privateKey: pem,
        publicKey: pub,
        keySource: "generated",
      };
      this.cached = null;
      await writePrivate(piSettingsFile(this.options.paths), renderPiSettings(settings));
      return settings;
    } finally {
      // The tmpfs-free sibling case: the private half lands on the volume only
      // via writePrivate (0600); shred the scratch copies best-effort.
      await rm(tmp, { force: true }).catch(() => {});
      await rm(`${tmp}.pub`, { force: true }).catch(() => {});
    }
  }

  private async keyFiles(settings: PiSettings): Promise<PiKeyFiles> {
    const keyFile = piKeyFile(this.options.paths);
    if (settings.privateKey) await writePrivate(keyFile, settings.privateKey);
    // A missing known_hosts fails StrictHostKeyChecking loudly (the tool says
    // so) rather than silently trusting a new host — pin via Settings first.
    const knownHostsFile = piKnownHostsFile(this.options.paths);
    if ((await readOrNull(knownHostsFile)) === null) {
      await writePrivate(knownHostsFile, "");
    }
    return { keyFile, knownHostsFile };
  }

  /**
   * Pin the host's key the way TOFU works here: run `ssh-keyscan` (read-only,
   * asks nothing) and append whatever it answers. The user pressed "Check &
   * pin" in Settings; that human moment is the trust on first use.
   *
   * A *different* key already pinned for that host is never replaced silently:
   * that is the one case TOFU exists to catch, so it comes back as
   * `changed: true` with both fingerprints and the caller asks again.
   */
  async pinHost(
    options: { host?: string; port?: number; force?: boolean; agentId?: string | null } = {},
  ): Promise<PiPinResult> {
    const settings = await this.settingsFor(options.agentId ?? null);
    const host = (options.host ?? settings.host).trim();
    const port = options.port ?? settings.port;
    if (!host) throw new Error("set a host first");
    const result = Bun.spawnSync({
      cmd: ["ssh-keyscan", ...(port === 22 ? [] : ["-p", String(port)]), host],
      timeout: 15_000,
    });
    const scanned = result.stdout
      .toString()
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"));
    if (result.exitCode !== 0 || scanned.length === 0) {
      throw new Error(`ssh-keyscan ${host} found no host key`);
    }
    const file = piKnownHostsFile(this.options.paths);
    const existing = (await readOrNull(file)) ?? "";
    const pinned = pinnedHostKey(existing, host, port);
    const newFingerprint = await this.fingerprint(scanned[0] ?? "");
    if (pinned && !options.force) {
      const oldFingerprint = await this.fingerprint(pinned);
      if (oldFingerprint !== newFingerprint) {
        return { changed: true, target: host, oldFingerprint, newFingerprint };
      }
    }
    // Drop whatever this host had (any port form) and write what was scanned.
    const pattern = port === 22 ? host : `[${host}]:${port}`;
    const kept = existing
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return false;
        const first = trimmed.split(/\s+/)[0] ?? "";
        return !first.split(/[,\s]/).includes(pattern);
      })
      .join("\n");
    await writePrivate(file, `${kept}${kept ? "\n" : ""}${scanned.join("\n")}\n`);
    return {
      changed: false,
      lines: scanned.length,
      target: host,
      fingerprint: newFingerprint,
    };
  }

  /** `ssh-keygen -lf` over one key line, through a 0600 temp file. */
  private async fingerprint(keyLine: string): Promise<string | null> {
    if (!keyLine.trim()) return null;
    const tmp = `${piKnownHostsFile(this.options.paths)}.${randomUUID()}.fp`;
    try {
      await writePrivate(tmp, `${keyLine.trim()}\n`);
      const res = Bun.spawnSync({ cmd: ["ssh-keygen", "-lf", tmp], stdin: "ignore" });
      // "256 SHA256:xxxx comment (ED25519)"
      const match = /SHA256:\S+/.exec(res.stdout.toString());
      return res.exitCode === 0 && match ? match[0] : null;
    } catch {
      return null;
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  // ── checking a host ───────────────────────────────────────────────────────

  /** Everything the checks file holds, keyed by `user@host:port`. */
  async checks(): Promise<PiCheckRecord> {
    return parseChecks(await readOrNull(piChecksFile(this.options.paths)));
  }

  /** The last check for a target, or null when it has never been checked. */
  async lastCheck(target: PiCheckTarget): Promise<PiCheck | null> {
    return (await this.checks())[checkTargetKey(target)] ?? null;
  }

  /**
   * Ask the host the question a run will ask: is it pinned, does it take our
   * key, is `pi` on the PATH a run gets, does the workdir exist. The draft may
   * hold unsaved form values — checking before saving is the point.
   */
  async checkHost(
    draft: Partial<PiSettings> = {},
    agentId: string | null = null,
  ): Promise<PiCheck> {
    const stored = await this.settingsFor(agentId);
    const settings: PiSettings = {
      ...stored,
      host: (draft.host ?? stored.host).trim(),
      user: (draft.user ?? stored.user).trim(),
      port: Number.isFinite(Number(draft.port)) ? Number(draft.port) : stored.port,
      pathPrepend: draft.pathPrepend ?? stored.pathPrepend,
      workdir: draft.workdir ?? stored.workdir,
    };
    const key = checkTargetKey(settings);
    const clock = this.options.now ?? (() => new Date());
    const at = clock().toISOString();
    const finish = async (check: Omit<PiCheck, "target" | "at">): Promise<PiCheck> => {
      const full: PiCheck = { ...check, target: key, at };
      const record = await this.checks();
      record[key] = full;
      await writePrivate(piChecksFile(this.options.paths), renderChecks(record));
      return full;
    };
    if (!settings.host || !settings.user) {
      return finish({
        state: "unreachable",
        ok: false,
        detail: "Set a host and a user first.",
        piVersion: null,
        pinnedFingerprint: null,
      });
    }
    const knownHosts = (await readOrNull(piKnownHostsFile(this.options.paths))) ?? "";
    const pinned = pinnedHostKey(knownHosts, settings.host, settings.port);
    const pinnedFingerprint = pinned ? await this.fingerprint(pinned) : null;
    if (!settings.privateKey) {
      return finish({
        state: "no_key",
        ok: false,
        detail: "No deploy key yet — generate one or paste a private key.",
        piVersion: null,
        pinnedFingerprint,
      });
    }
    if (!pinned) {
      return finish({
        state: "unpinned",
        ok: false,
        detail: `No host key pinned for ${key} — runs would be refused. Check & pin host key.`,
        piVersion: null,
        pinnedFingerprint: null,
      });
    }
    const files = await this.keyFiles(settings);
    const remote = buildProbeRemoteCommand(settings);
    const args = buildSshArgs(settings, files, remote);
    let stdout = "";
    let stderr = "";
    const child = (this.options.spawner ?? sshSpawner)(
      args,
      (chunk) => {
        stdout += chunk;
      },
      (chunk) => {
        stderr += chunk;
      },
    );
    const killer = setTimeout(() => child.kill(), PI_CHECK_TIMEOUT_MS);
    let code: number | null = null;
    try {
      code = (await child.exited).code;
    } catch (error) {
      stderr += String(error);
    } finally {
      clearTimeout(killer);
    }
    const verdict = classifyCheckOutput({ code, stdout, stderr });
    return finish({
      state: verdict.state,
      ok: verdict.state === "ready",
      detail: verdict.detail,
      piVersion: verdict.piVersion,
      pinnedFingerprint,
    });
  }

  /** One line a UI can show for a stored check, with the time made relative. */
  static describeCheck(check: PiCheck | null): string {
    if (!check) return "Never checked.";
    return `${check.detail} · ${check.target} · ${ago(check.at)}`;
  }

  /** Boot reconciliation: runs still marked running are orphans of the old BFF. */
  async reconcile(): Promise<number> {
    const orphaned = await this.runner.reconcileOnBoot();
    if (orphaned > 0)
      (this.options.log ?? (() => {}))(
        `Remote pi: ${orphaned} run(s) orphaned by restart → detached`,
      );
    return orphaned;
  }

  async listRuns(limit: number): Promise<PiRunMeta[]> {
    return this.store.list(limit);
  }
  async getRun(runId: string): Promise<PiRunMeta | null> {
    return this.store.read(runId);
  }

  // ── tools ──────────────────────────────────────────────────────────────────

  private guard(): ToolAnswer | null {
    if (!this.featureEnabled) return { text: this.disabledReason(), isError: true };
    return null;
  }

  private async startRun(
    kind: "run" | "send",
    args: Record<string, unknown>,
    callerAgentId: string | null,
  ): Promise<ToolAnswer> {
    const off = this.guard();
    if (off) return off;
    const settings = await this.settingsFor(callerAgentId);
    if (!piConfigured(settings)) return { text: this.disabledReason(), isError: true };

    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) return { text: "`prompt` is required", isError: true };
    let session: string | undefined;
    // A follow-up goes where the session was made: a pi session id is a file on
    // one host, so asking another agent's host about it cannot work. The origin
    // wins over whoever is asking; an unseen session falls back and says so.
    let sessionNote = "";
    if (kind === "send") {
      const raw = typeof args.session === "string" ? args.session.trim() : "";
      if (!isPiSessionId(raw)) {
        return { text: "`session` must be the pi session id from a previous run", isError: true };
      }
      session = raw;
      const origin = await this.store.findBySession(raw);
      if (origin?.agentId && origin.agentId !== callerAgentId) {
        const from = await this.settingsFor(origin.agentId);
        if (piConfigured(from)) {
          Object.assign(settings, from);
          sessionNote = ` (session started by agent ${origin.agentId})`;
        }
      } else if (!origin) {
        sessionNote = " (session unknown to lettuce — using this agent's host)";
      }
    }
    const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : null;

    try {
      const files = await this.keyFiles(settings);
      const meta = await this.runner.start(settings, files, {
        kind,
        prompt,
        session,
        model,
        agentId: callerAgentId,
      });
      // Give the session header a moment: it is the first record of the stream
      // and the caller needs it to follow up (§ 3.2).
      let observed = meta;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        observed = (await this.store.read(meta.runId)) ?? observed;
        if (observed.session || observed.state !== "running") break;
        await Bun.sleep(500);
      }
      if (observed.state === "failed") {
        return {
          text: `The run failed to start: ${observed.error ?? "ssh failed"}`,
          isError: true,
        };
      }
      const agentId = observed.session ? piAgentId(observed.session) : null;
      return {
        // Naming the host is what makes per-agent hosts usable: the model can
        // say where a task went instead of guessing.
        text:
          `Started remote-pi ${kind} ${observed.runId} on ${observed.target}` +
          (observed.session
            ? ` on session ${observed.session} (agent ${agentId})`
            : " — session id not yet visible") +
          `${sessionNote}. Poll with pi_status {run:"${observed.runId}"}.`,
        isError: false,
      };
    } catch (error) {
      return {
        text: `Could not start the remote-pi run: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }

  /** pi_run: start a fresh pi session on the remote host. */
  readonly piRun: ToolHandler = (args, context) =>
    this.startRun("run", args, context?.agentId ?? null);

  /** pi_send: follow up on an existing session (spike-proven iteration, § 3.3). */
  readonly piSend: ToolHandler = (args, context) =>
    this.startRun("send", args, context?.agentId ?? null);

  /** pi_status: state of one run, with the tail of its last assistant text. */
  readonly piStatus: ToolHandler = async (args) => {
    const off = this.guard();
    if (off) return off;
    const runId = typeof args.run === "string" ? args.run.trim() : "";
    if (!runId) return { text: "`run` is a run id from a previous pi_run/pi_send", isError: true };
    const meta = await this.store.read(runId);
    if (!meta) return { text: `No remote-pi run ${runId}`, isError: true };
    const lines = [
      `run ${meta.runId} — ${meta.state}${meta.exitCode !== null ? ` (exit ${meta.exitCode})` : ""}`,
      meta.session
        ? `session ${meta.session} (follow up with pi_send {session:"${meta.session}"})`
        : "session not yet visible",
      `events ${meta.eventCount}, started ${meta.startedAt}${meta.lastEventAt ? `, last activity ${meta.lastEventAt}` : ""}`,
    ];
    if (meta.error) lines.push(`error: ${meta.error}`);
    const tail = await this.store.readEventsTail(runId, 4_000);
    if (tail) {
      const answer = lastAssistantText(tail);
      if (answer)
        lines.push(`last assistant text:\n${capText(answer, "older output is in the run viewer")}`);
    }
    return { text: lines.join("\n"), isError: false };
  };

  /** stop the local capture of a run (detach; the remote keeps working). */
  readonly piStop: ToolHandler = async (args) => {
    const off = this.guard();
    if (off) return off;
    const runId = typeof args.run === "string" ? args.run.trim() : "";
    if (!runId) return { text: "`run` is a run id from a previous pi_run/pi_send", isError: true };
    const meta = await this.store.read(runId);
    if (!meta) return { text: `No remote-pi run ${runId}`, isError: true };
    if (!this.runner.stop(runId))
      return {
        text: `Run ${runId} is not being captured by this BFF (state: ${meta.state})`,
        isError: true,
      };
    return {
      text: `Stopped capturing run ${runId}. The remote pi keeps running until its turn ends (detach-only; docs/remote-pi-plan.md § 4.5).`,
      isError: false,
    };
  };

  handlers(): ReadonlyMap<string, ToolHandler> {
    return new Map<string, ToolHandler>([
      ["pi_run", this.piRun],
      ["pi_send", this.piSend],
      ["pi_status", this.piStatus],
      ["pi_stop", this.piStop],
    ]);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isPiRunId(value: string): boolean {
  return UUID_RE.test(value);
}

/** The last assistant message_end text in a captured stream tail (lenient). */
export function lastAssistantText(tail: string): string | null {
  let answer: string | null = null;
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      if (record.type !== "message_end" || record.message?.role !== "assistant") continue;
      const content = record.message.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .filter(
          (p): p is { type: "text"; text: string } =>
            Boolean(p) &&
            typeof p === "object" &&
            (p as { type?: string }).type === "text" &&
            typeof (p as { text?: unknown }).text === "string",
        )
        .map((p) => p.text)
        .join("");
      if (text) answer = text;
    } catch {
      // A partial line (cut tail) is skipped.
    }
  }
  return answer;
}

// ── the mod's tool declarations ──────────────────────────────────────────────

const RUN_PARAMETERS = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description:
        "The task for the remote pi agent, in full. It runs autonomously on the remote host.",
    },
    model: {
      type: "string",
      description: "Optional pi model id; default: the remote pi's own default.",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
};

const SEND_PARAMETERS = {
  type: "object",
  properties: {
    session: { type: "string", description: "The pi session id from pi_run's answer." },
    prompt: { type: "string", description: "The follow-up message for that session." },
  },
  required: ["session", "prompt"],
  additionalProperties: false,
};

const STATUS_PARAMETERS = {
  type: "object",
  properties: { run: { type: "string", description: "The run id from pi_run/pi_send's answer." } },
  required: ["run"],
  additionalProperties: false,
};

export const PI_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "pi_run",
    description:
      "Dispatch a task to the remote pi coding agent over SSH and start it now. " +
      "It starts in the working folder configured for this agent, on the host configured for it " +
      "(one agent may point at a different folder or machine than another). " +
      "Returns a run id and a pi session id immediately; the run continues in the background. " +
      "Poll with pi_status, continue the conversation with pi_send.",
    parameters: RUN_PARAMETERS,
    approval: "ask",
  },
  {
    name: "pi_send",
    description:
      "Send a follow-up to an existing remote pi session (from pi_run). Same background semantics as pi_run.",
    parameters: SEND_PARAMETERS,
    approval: "ask",
  },
  {
    name: "pi_status",
    description:
      "State of a remote-pi run: running/completed/detached/failed, its session id, and the tail of its last assistant text.",
    parameters: STATUS_PARAMETERS,
    approval: "auto",
  },
  {
    name: "pi_stop",
    description:
      "Stop Lettuce capturing a remote-pi run (detach). The remote pi is NOT killed; its session stays resumable.",
    parameters: STATUS_PARAMETERS,
    approval: "auto",
  },
];

/** Names the pi mod registers — the per-agent hidden map keys off these. */
export const PI_TOOL_NAMES: readonly string[] = PI_TOOL_SPECS.map((spec) => spec.name);
