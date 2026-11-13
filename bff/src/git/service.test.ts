import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logArgs, NOT_A_REPOSITORY_STDERR, showArgs } from "./log.ts";
import {
  checkGitAvailability,
  type GitChild,
  type GitSpawn,
  MAX_INFLIGHT,
  makeRunner,
  privilegeDrop,
  runGit,
} from "./service.ts";

const encoder = new TextEncoder();

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function childFor(options: { stdout?: string; stderr?: string; code?: number }): GitChild {
  return {
    stdout: streamFrom(options.stdout ?? ""),
    stderr: streamFrom(options.stderr ?? ""),
    kill: () => {},
    exited: Promise.resolve(options.code ?? 0),
  };
}

/**
 * A child that produces nothing and stays running until killed. `stderr`
 * stays null on purpose: an open stream that nobody reads would keep
 * `runUncapped` waiting for it even after the kill.
 */
function stalledChild(): GitChild {
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  let close: () => void = () => {};
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => controller.close();
    },
  });
  return {
    stdout,
    stderr: null,
    kill: () => {
      close();
      resolveExited(137);
    },
    exited,
  };
}

function spawning(handler: (cmdline: string[]) => GitChild): {
  spawn: GitSpawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    spawn: (cmdline) => {
      calls.push(cmdline);
      return handler(cmdline);
    },
  };
}

describe("runGit", () => {
  test("a successful run returns stdout and the argv it spawned", async () => {
    const fake = spawning(() => childFor({ stdout: "hello\n" }));
    const result = await makeRunner(fake.spawn)("/work/one", ["status"]);
    expect(result).toEqual({ ok: true, stdout: "hello\n" });
    expect(fake.calls[0]?.[0]).toBe("git");
    expect(fake.calls[0]).toContain("status");
  });

  test("no shell is ever involved: arguments with shell syntax stay single argv elements", async () => {
    const fake = spawning(() => childFor({ stdout: "x" }));
    await makeRunner(fake.spawn)("/work/a b; rm -rf /", [
      "log",
      "--pretty=format:%H %an ; echo $HOME `id` | tee -",
      "--end-of-options",
      "--",
      "weird && $(path)",
    ]);
    const cmdline = fake.calls[0] ?? [];
    expect(cmdline).toContain("/work/a b; rm -rf /");
    expect(cmdline).toContain("--pretty=format:%H %an ; echo $HOME `id` | tee -");
    expect(cmdline).toContain("weird && $(path)");
    expect(cmdline).not.toContain("sh");
    expect(cmdline).not.toContain("bash");
    expect(cmdline.every((part) => typeof part === "string")).toBe(true);
  });

  test("a stalled run is killed and classified as timed-out", async () => {
    const runner = makeRunner(() => stalledChild());
    const result = await runner("/work/one", ["log"], { timeoutMs: 30 });
    expect(!result.ok && result.error.kind).toBe("timed-out");
  });

  test("oversized output kills the child and is classified, not buffered", async () => {
    const runner = makeRunner(() => childFor({ stdout: "x".repeat(4096), code: 0 }));
    const result = await runner("/work/one", ["log"], { maxBytes: 100 });
    expect(!result.ok && result.error.kind).toBe("output-too-large");
  });

  test("a missing git binary is git-unavailable, not a crash", async () => {
    const runner = makeRunner(() => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    });
    const result = await runner("/work/one", ["status"]);
    expect(!result.ok && result.error.kind).toBe("git-unavailable");
  });

  test("git's refusal becomes a classification, not a stack", async () => {
    const runner = makeRunner(() =>
      childFor({ code: 128, stderr: `${NOT_A_REPOSITORY_STDERR}\n` }),
    );
    const result = await runner("/work/one", ["rev-parse", "--git-dir"]);
    expect(!result.ok && result.error.kind).toBe("not-a-repository");
  });

  test("the in-flight cap answers busy instead of piling up children", async () => {
    const pending: Promise<unknown>[] = [];
    try {
      for (let i = 0; i < MAX_INFLIGHT; i++) {
        pending.push(makeRunner(() => stalledChild())("/", ["log"], { timeoutMs: 60 }));
      }
      // The cap is process-wide on purpose: it is the total git children this
      // container may hold, not per caller. The fifth runner would spawn a
      // child if the cap let it through — that must not happen.
      const fifth = await makeRunner(() => childFor({ stdout: "must not spawn" }))("/", ["log"]);
      expect(!fifth.ok && fifth.error.kind).toBe("busy");
    } finally {
      await Promise.all(pending);
    }
    // Released once the held runs finished.
    const result = await makeRunner(() => childFor({ stdout: "ok\n" }))("/", ["log"]);
    expect(result.ok).toBe(true);
  });
});

describe("checkGitAvailability", () => {
  test("logs what it found, loudly when the image lacks git", async () => {
    const lines: string[] = [];
    const log = (message: string): void => {
      lines.push(message);
    };
    expect(
      await checkGitAvailability(async () => ({ ok: true, stdout: "git version 2.39.5\n" }), log, [
        "setpriv",
      ]),
    ).toBe(true);
    expect(lines).toEqual(["git available: git version 2.39.5 (runs unprivileged)"]);

    // Root with nothing to drop privileges with is the one case worth a warning.
    lines.length = 0;
    await checkGitAvailability(
      async () => ({ ok: true, stdout: "git version 2.39.5\n" }),
      log,
      null,
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("setpriv is missing");

    lines.length = 1;
    expect(
      await checkGitAvailability(
        async () => ({ ok: false, error: { kind: "git-unavailable" as const, detail: "x" } }),
        log,
      ),
    ).toBe(false);
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("NOT available");
  });
});

describe("privilegeDrop", () => {
  test("root drops to nobody through setpriv, with no way back", () => {
    expect(privilegeDrop(0, "/usr/bin/setpriv")).toEqual([
      "/usr/bin/setpriv",
      "--reuid=65534",
      "--regid=65534",
      "--clear-groups",
      "--no-new-privs",
      "--",
    ]);
  });

  test("a non-root process has nothing to drop", () => {
    expect(privilegeDrop(1000, "/usr/bin/setpriv")).toEqual([]);
    expect(privilegeDrop(1000, null)).toEqual([]);
  });

  test("root without setpriv is reported, not papered over", () => {
    expect(privilegeDrop(0, null)).toBeNull();
  });
});

/**
 * The reproduction, against real git: a repository whose own config names a
 * program for signature checks, and a commit that carries a signature. Before
 * the pinned config in `gitArgv`, opening History on it ran that program in this
 * process's container.
 */
describe("a hostile repository", () => {
  const git = Bun.which("git");
  const run = (cwd: string, args: string[], stdin?: string): string => {
    const result = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd,
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "a",
        GIT_AUTHOR_EMAIL: "a@example.com",
        GIT_COMMITTER_NAME: "a",
        GIT_COMMITTER_EMAIL: "a@example.com",
      },
    });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };

  test.skipIf(!git)("cannot make log or show run the program its config names", async () => {
    const base = mkdtempSync(join(tmpdir(), "git-hostile-"));
    const repo = join(base, "repo");
    const marker = join(base, "RAN");
    const script = join(base, "pwn.sh");
    writeFileSync(script, `#!/bin/sh\necho ran > ${marker}\nexit 1\n`);
    chmodSync(script, 0o755);

    run(base, ["init", "-q", repo]);
    writeFileSync(join(repo, "a"), "hi\n");
    run(repo, ["add", "a"]);
    const tree = run(repo, ["write-tree"]);
    const commit = run(
      repo,
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      `tree ${tree}\nauthor a <a@example.com> 1700000000 +0000\n` +
        "committer a <a@example.com> 1700000000 +0000\n" +
        "gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n" +
        "\nmsg\n",
    );
    run(repo, ["update-ref", "HEAD", commit]);
    run(repo, ["config", "log.showSignature", "true"]);
    run(repo, ["config", "gpg.program", script]);
    run(repo, ["config", "core.fsmonitor", script]);

    // The setup is real: git with no pinning does run it.
    Bun.spawnSync({
      cmd: ["git", "-C", repo, "log", "-n", "1"],
      env: { PATH: process.env.PATH ?? "", HOME: base, GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(existsSync(marker)).toBe(true);
    await Bun.file(marker).delete();

    const log = await runGit(repo, logArgs({ limit: 5, skip: 0, pathspec: null }));
    expect(log.ok).toBe(true);
    const show = await runGit(repo, showArgs(commit));
    expect(show.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});
