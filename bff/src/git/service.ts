/**
 * Running git. One spawn path, argv-only — never a shell string, so a path or
 * a sha can never become syntax. Failure is always a classification from
 * `log.ts`, never a thrown stack: an agent-authored repository is expected to
 * be weird, and a weird repository is a sheet message, not a 500.
 *
 * The environment is minimal on purpose: `GIT_CONFIG_NOSYSTEM` keeps any
 * system gitconfig out of the picture, `GIT_TERMINAL_PROMPT=0` makes git fail
 * instead of waiting on a prompt that no one will answer, `GIT_CEILING_DIRECTORIES=/`
 * stops repository discovery from climbing out of the container's view of the
 * filesystem, and `HOME=/tmp` with `GIT_CONFIG_GLOBAL=/dev/null` keeps git out
 * of any real home directory and any global config.
 *
 * The child also runs **unprivileged** when this process is root (the
 * container): the repository is agent-authored, git honours its config, and a
 * config key can name a program to run. `gitArgv` pins the keys known to do
 * that; dropping to `nobody` is what holds when a key is missed — that uid
 * cannot read the sign-in hash, the Google token and policy or the remote-pi
 * key (all root-only files), nor this process's environment.
 */

import {
  classifyGitFailure,
  type GitFailure,
  type GitResult,
  gitArgv,
  PROBE_BRANCH,
  PROBE_GIT_DIR,
  PROBE_TOPLEVEL,
  parseRepoProbe,
  type RepoProbe,
} from "./log.ts";

export interface RunGitOptions {
  /** The child is killed and the call reports `timed-out` after this. */
  timeoutMs?: number;
  /** Killing limit on stdout+stderr combined; exceeding it reports `output-too-large`. */
  maxBytes?: number;
}

/** The sliver of a child process this module needs; `service.test.ts` fakes exactly this. */
export interface GitChild {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  kill(): unknown;
  exited: Promise<number>;
}

export type GitSpawn = (cmdline: string[]) => GitChild;

export type GitRunner = (dir: string, args: string[], opts?: RunGitOptions) => Promise<GitResult>;

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** At most this many git children at once; a fifth caller is told to wait (429). */
export const MAX_INFLIGHT = 4;

let inflight = 0;

function gitEnv(): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: "/",
    HOME: "/tmp",
    GIT_CONFIG_GLOBAL: "/dev/null",
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
}

/** `nobody` on Debian, which is what the image is built from. */
const UNPRIVILEGED_ID = "65534";

/**
 * The argv prefix that runs a child as `nobody`, or `[]` when this process is
 * not root (a bare `bun run dev`, the test suite) and so has nothing to drop.
 * `null` means root with no `setpriv` to drop with — `checkGitAvailability`
 * says that out loud once at boot.
 */
export function privilegeDrop(
  uid: number | undefined = process.getuid?.(),
  setpriv: string | null = Bun.which("setpriv"),
): string[] | null {
  if (uid !== 0) return [];
  if (!setpriv) return null;
  return [
    setpriv,
    `--reuid=${UNPRIVILEGED_ID}`,
    `--regid=${UNPRIVILEGED_ID}`,
    "--clear-groups",
    "--no-new-privs",
    "--",
  ];
}

let dropPrefix: string[] | null | undefined;

const defaultSpawn: GitSpawn = (cmdline) => {
  if (dropPrefix === undefined) dropPrefix = privilegeDrop();
  const child = Bun.spawn([...(dropPrefix ?? []), ...cmdline], {
    env: gitEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: child.stdout as ReadableStream<Uint8Array>,
    stderr: child.stderr as ReadableStream<Uint8Array>,
    kill: () => child.kill(),
    exited: child.exited,
  };
};

/** The process-wide runner the routes use. */
export const runGit: GitRunner = (dir, args, opts) => spawnRun(defaultSpawn, dir, args, opts);

/** A runner over a different spawn implementation — the seam `service.test.ts` uses. */
export function makeRunner(spawn: GitSpawn): GitRunner {
  return (dir, args, opts) => spawnRun(spawn, dir, args, opts);
}

async function spawnRun(
  spawn: GitSpawn,
  dir: string,
  args: string[],
  opts: RunGitOptions = {},
): Promise<GitResult> {
  if (inflight >= MAX_INFLIGHT) {
    return {
      ok: false,
      error: { kind: "busy", detail: `Already ${MAX_INFLIGHT} git commands are running.` },
    };
  }
  inflight++;
  try {
    return await runUncapped(spawn, dir, args, opts);
  } finally {
    inflight--;
  }
}

async function runUncapped(
  spawn: GitSpawn,
  dir: string,
  args: string[],
  opts: RunGitOptions,
): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let child: GitChild;
  try {
    child = spawn(gitArgv(dir, args));
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") {
      return {
        ok: false,
        error: {
          kind: "git-unavailable",
          detail: "The git binary is not installed in this image.",
        },
      };
    }
    return {
      ok: false,
      error: { kind: "failed", detail: `failed:${errorText(error)}` },
    };
  }

  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* the child is already gone */
      }
    },
    Math.max(1, timeoutMs),
  );

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout, maxBytes),
      readStream(child.stderr, 64 * 1024),
      child.exited,
    ]);

    if (timedOut) {
      return { ok: false, error: { kind: "timed-out", detail: "git timed out." } };
    }
    if (stdout.overflow || stderr.overflow) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      return { ok: false, error: { kind: "output-too-large", detail: "git output too large." } };
    }
    if (exitCode === 0) return { ok: true, stdout: stdout.text };
    return { ok: false, error: classifyGitFailure(stderr.text, exitCode) };
  } finally {
    clearTimeout(timer);
  }
}

interface StreamRead {
  text: string;
  overflow: boolean;
}

async function readStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<StreamRead> {
  if (!stream) return { text: "", overflow: false };
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total > maxBytes) {
      overflow = true;
      break;
    }
  }
  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  text += decoder.decode();
  return { text, overflow };
}

/** The three probes, then their fold into one repository answer. */
export async function probeRepo(runner: GitRunner, dir: string): Promise<RepoProbe> {
  const gitDir = await runner(dir, PROBE_GIT_DIR);
  if (!gitDir.ok) return { ok: false, failure: gitDir.error };
  const toplevel = await runner(dir, PROBE_TOPLEVEL);
  if (!toplevel.ok) return { ok: false, failure: toplevel.error };
  const branch = await runner(dir, PROBE_BRANCH);
  if (!branch.ok) return { ok: false, failure: branch.error };
  return parseRepoProbe({ gitDir, toplevel, branch });
}

/** One probe to answer "where is the root, if there is one" for the commit route. */
export async function probeRoot(runner: GitRunner, dir: string): Promise<GitResult> {
  return runner(dir, PROBE_TOPLEVEL);
}

/**
 * Boot-time `git --version`. The routes already answer 503 with
 * `git-unavailable` when the binary is missing; this only makes a misbuilt
 * image loud in the log once, instead of quietly on the first History open.
 */
export async function checkGitAvailability(
  runner: GitRunner = runGit,
  log: (message: string) => void = (message) => console.log(message),
  drop: string[] | null = privilegeDrop(),
): Promise<boolean> {
  const result = await runner("/", ["--version"]);
  if (result.ok) {
    log(
      `git available: ${result.stdout.trim()}${
        drop === null
          ? ""
          : drop.length > 0
            ? " (runs unprivileged)"
            : " (not root: nothing to drop)"
      }`,
    );
    if (drop === null) {
      log(
        "! setpriv is missing from this image: git runs as root against agent-authored " +
          "repositories. The pinned config in git/log.ts is then the only guard.",
      );
    }
    return true;
  }
  if (result.error.kind === "git-unavailable") {
    log(
      "git is NOT available in this image — /api/git/* will answer 503. (bff.Dockerfile installs git.)",
    );
    return false;
  }
  return false;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { GitFailure };
