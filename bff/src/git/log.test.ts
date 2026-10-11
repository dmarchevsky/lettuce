import { describe, expect, test } from "bun:test";
import {
  capToBytes,
  clampLimit,
  clampSkip,
  classifyGitFailure,
  DEFAULT_LIMIT,
  type GitResult,
  gitArgv,
  LOG_FORMAT,
  logArgs,
  NOT_A_REPOSITORY_STDERR,
  parseLog,
  parseRefs,
  parseRepoProbe,
  parseShow,
  pathspecFor,
  showArgs,
  validSha,
} from "./log.ts";

const ok = (stdout: string): GitResult => ({ ok: true, stdout });
const fail = (stderr: string): GitResult => ({
  ok: false,
  error: classifyGitFailure(stderr, 128),
});

describe("gitArgv", () => {
  test("is argv-only, read-only by construction", () => {
    const argv = gitArgv("/work/agent-1/repo", ["status"]);
    expect(argv).toEqual([
      "git",
      "--no-optional-locks",
      "-c",
      "safe.directory=*",
      "-c",
      "core.quotepath=false",
      "-C",
      "/work/agent-1/repo",
      "status",
    ]);
  });
});

describe("logArgs", () => {
  test("requests limit + 1 so hasMore needs no second call", () => {
    const args = logArgs({ limit: DEFAULT_LIMIT, skip: 0, pathspec: null });
    expect(args.slice(0, 3)).toEqual(["log", "--no-color", `--pretty=format:${LOG_FORMAT}`]);
    const nIndex = args.indexOf("-n");
    expect(args[nIndex + 1]).toBe("51");
    expect(args[args.indexOf("--skip") + 1]).toBe("0");
    // The per-subcommand position matters: --end-of-options is not a global
    // git option, so it must come after the options and before any rev or
    // pathspec that came from a request.
    const end = args.indexOf("--end-of-options");
    expect(end).toBeGreaterThan(args.indexOf(`--pretty=format:${LOG_FORMAT}`));
    expect(args.slice(end)).toEqual(["--end-of-options"]);
    expect(args).not.toContain("--");
  });

  test("appends the pathspec only when non-empty", () => {
    const args = logArgs({ limit: 5, skip: 10, pathspec: "src/app.ts" });
    expect(args).toEqual([
      "log",
      "--no-color",
      `--pretty=format:${LOG_FORMAT}`,
      "-n",
      "6",
      "--skip",
      "10",
      "--end-of-options",
      "--",
      "src/app.ts",
    ]);
  });

  test("a pathspec that looks like an option stays behind --", () => {
    const args = logArgs({ limit: 1, skip: 0, pathspec: "--all" });
    expect(args.slice(args.indexOf("--end-of-options"))).toEqual([
      "--end-of-options",
      "--",
      "--all",
    ]);
  });
});

describe("showArgs", () => {
  test("the sha travels only after --end-of-options", () => {
    const args = showArgs("889c5f8");
    expect(args.indexOf("--end-of-options")).toBe(args.length - 2);
    expect(args[args.length - 1]).toBe("889c5f8");
    expect(args.slice(0, 4)).toEqual(["show", "--no-patch", "--raw", "--numstat"]);
  });
});

describe("validSha", () => {
  test("only lowercase hex git itself would have printed", () => {
    expect(validSha("889c5f8")).toBe(true);
    expect(validSha("889c5f8a4d4a872ed73823c4862cdb868f89fc9a")).toBe(true);
    expect(validSha("889C5F8")).toBe(false);
    expect(validSha("889")).toBe(false);
    expect(validSha("xyz1234")).toBe(false);
    expect(validSha("889c5f8; rm -rf /")).toBe(false);
  });
});

describe("clamps", () => {
  test("limit: default 50, integer 1..200, null on garbage", () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit("")).toBe(50);
    expect(clampLimit("5")).toBe(5);
    expect(clampLimit("200")).toBe(200);
    expect(clampLimit("500")).toBe(200);
    expect(clampLimit("0")).toBeNull();
    expect(clampLimit("-3")).toBeNull();
    expect(clampLimit("2.5")).toBeNull();
    expect(clampLimit("abc")).toBeNull();
  });

  test("skip: default 0, non-negative integer", () => {
    expect(clampSkip(undefined)).toBe(0);
    expect(clampSkip("0")).toBe(0);
    expect(clampSkip("50")).toBe(50);
    expect(clampSkip("-1")).toBeNull();
    expect(clampSkip("x")).toBeNull();
  });
});

describe("classifyGitFailure", () => {
  test("git's exact not-a-repository refusal", () => {
    const failure = classifyGitFailure(`${NOT_A_REPOSITORY_STDERR}\n`, 128);
    expect(failure.kind).toBe("not-a-repository");
    expect(failure.detail).toBe(
      "fatal: not a git repository (or any of the parent directories): .git",
    );
  });

  test("unknown revisions are bad objects", () => {
    expect(
      classifyGitFailure(
        "fatal: ambiguous argument 'deadbeef': unknown revision or path not in the working tree.",
        128,
      ).kind,
    ).toBe("bad-object");
    expect(classifyGitFailure("fatal: bad object deadbeef", 128).kind).toBe("bad-object");
  });

  test("anything else keeps git's first stderr line", () => {
    const failure = classifyGitFailure("error: one\nerror: two", 1);
    expect(failure.kind).toBe("failed");
    expect(failure.detail).toBe("failed:error: one");
  });
});

describe("parseRepoProbe", () => {
  test("the ok answer names root and branch", () => {
    const probe = parseRepoProbe({
      gitDir: ok(".git\n"),
      toplevel: ok("/work/agent-1/repo\n"),
      branch: ok("main\n"),
    });
    expect(probe).toEqual({ ok: true, root: "/work/agent-1/repo", branch: "main" });
  });

  test("detached HEAD answers HEAD", () => {
    const probe = parseRepoProbe({
      gitDir: ok(".git\n"),
      toplevel: ok("/work/repo\n"),
      branch: ok("HEAD\n"),
    });
    expect(probe.ok && probe.branch).toBe("HEAD");
  });

  test("not-a-repository comes from the git-dir probe's exact line", () => {
    const probe = parseRepoProbe({
      gitDir: fail(NOT_A_REPOSITORY_STDERR),
      toplevel: fail(NOT_A_REPOSITORY_STDERR),
      branch: fail(
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
      ),
    });
    expect(!probe.ok && probe.failure.kind).toBe("not-a-repository");
  });

  test("a bad object stays a bad object", () => {
    const probe = parseRepoProbe({
      gitDir: ok(".git\n"),
      toplevel: ok("/work/repo\n"),
      branch: fail(
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
      ),
    });
    expect(!probe.ok && probe.failure.kind).toBe("bad-object");
  });

  test("a generic failure keeps git's line", () => {
    const probe = parseRepoProbe({
      gitDir: ok(".git\n"),
      toplevel: fail("fatal: cannot run builtin: nope"),
      branch: ok("main\n"),
    });
    expect(!probe.ok && probe.failure.kind).toBe("failed");
  });
});

describe("parseLog", () => {
  const record = (fields: string[]): string => `${fields.join("\x1f")}\x1e`;

  test("one record, refs decorated", () => {
    const text = record([
      "889c5f8a4d4a872ed73823c4862cdb868f89fc9a",
      "889c5f8",
      "Tester",
      "2026-10-02T11:16:37-07:00",
      "HEAD -> main",
      "fé first commit",
    ]);
    expect(parseLog(text)).toEqual([
      {
        sha: "889c5f8a4d4a872ed73823c4862cdb868f89fc9a",
        shortSha: "889c5f8",
        author: "Tester",
        date: "2026-10-02T11:16:37-07:00",
        refs: ["main"],
        isCurrent: true,
        subject: "fé first commit",
      },
    ]);
  });

  test("records joined by newlines, with and without a trailing separator", () => {
    const a = record(["a".repeat(40), "aaaaaaa", "A", "2026-01-01T00:00:00+00:00", "", "second"]);
    const b = record(["b".repeat(40), "bbbbbbb", "B", "2026-01-01T00:00:00+00:00", "", "first"]);
    const joined = `${a}\n${b}`;
    const withTrailing = `${a}\n${b}\n`;
    for (const text of [joined, withTrailing]) {
      const commits = parseLog(text);
      expect(commits.map((commit) => commit.shortSha)).toEqual(["aaaaaaa", "bbbbbbb"]);
      expect(commits[0]?.refs).toEqual([]);
      expect(commits[0]?.isCurrent).toBe(false);
    }
  });

  test("empty stdout parses to no commits", () => {
    expect(parseLog("")).toEqual([]);
  });
});

describe("parseRefs", () => {
  test("HEAD -> branch is current and badges the branch", () => {
    expect(parseRefs("HEAD -> main")).toEqual({ refs: ["main"], isCurrent: true });
  });

  test("detached tip is a bare HEAD among other refs", () => {
    expect(parseRefs("HEAD, main, tag: v1.2.3")).toEqual({
      refs: ["HEAD", "main", "v1.2.3"],
      isCurrent: true,
    });
  });

  test("remote and empty decorations", () => {
    expect(parseRefs("origin/main")).toEqual({ refs: ["origin/main"], isCurrent: false });
    expect(parseRefs("")).toEqual({ refs: [], isCurrent: false });
    expect(parseRefs("(HEAD -> main)").refs).toEqual(["main"]);
  });
});

describe("pathspecFor", () => {
  test("empty at the repo root, relative below it, null outside", () => {
    expect(pathspecFor("/work/agent-1/repo", "/work/agent-1/repo")).toBe("");
    expect(pathspecFor("/work/agent-1/repo/", "/work/agent-1/repo")).toBe("");
    expect(pathspecFor("/work/agent-1/repo", "/work/agent-1/repo/src/app")).toBe("src/app");
    expect(pathspecFor("/work/agent-1/repo", "/work/agent-1/other")).toBeNull();
    expect(pathspecFor("/work/agent-1/repo", "/work/agent-1/repo2")).toBeNull();
  });
});

describe("parseShow", () => {
  const header = (sha: string, author: string, date: string, body: string): string =>
    `${sha}\x1f${author}\x1f${date}\x1f${body}\x1e`;

  test("renames, binary and a plain modification, statuses zipped from --raw", () => {
    const output =
      header(
        "889c5f8a4d4a872ed73823c4862cdb868f89fc9a",
        "Tester",
        "2026-10-02T11:19:01-07:00",
        "second commit\n",
      ) +
      "\n\n" +
      ":100644 100644 587be6b 587be6b R100\tREADME.md\tNOTES.md\n" +
      ":000000 100644 0000000 8352675 A\tbin.dat\n" +
      ":100644 100644 422c2b7 de98044 M\tsrc/a.txt\n" +
      "0\t0\tREADME.md => NOTES.md\n" +
      "-\t-\tbin.dat\n" +
      "1\t0\tsrc/a.txt\n";
    const detail = parseShow(output);
    expect(detail.shortSha).toBe("889c5f8");
    expect(detail.author).toBe("Tester");
    expect(detail.message).toBe("second commit");
    expect(detail.fileCount).toBe(3);
    expect(detail.files).toEqual([
      { status: "R", path: "NOTES.md", oldPath: "README.md", additions: 0, deletions: 0 },
      { status: "A", path: "bin.dat", oldPath: null, additions: null, deletions: null },
      { status: "M", path: "src/a.txt", oldPath: null, additions: 1, deletions: 0 },
    ]);
  });

  test("the braced rename form collapses to old and new paths", () => {
    const output =
      header("a".repeat(40), "A", "2026-01-01T00:00:00+00:00", "move\n") +
      "\n\n" +
      ":100644 100644 aaaaaaa bbbbbbb R098\tsrc/old.ts\tsrc/new.ts\n" +
      "1\t1\tsrc/{old.ts => new.ts}\n";
    expect(parseShow(output).files).toEqual([
      { status: "R", path: "src/new.ts", oldPath: "src/old.ts", additions: 1, deletions: 1 },
    ]);
  });

  test("a multi-line body with colons and --- lines stays in the message", () => {
    const body = "fé first\n\nbody line: with colon\n--- looks like a rule\n0\t0\tnot-a-numstat\n";
    const output = `${header("a".repeat(40), "A", "2026-01-01T00:00:00+00:00", body)}\n\n0\t1\treal.txt\n`;
    const detail = parseShow(output);
    expect(detail.message).toBe(
      "fé first\n\nbody line: with colon\n--- looks like a rule\n0\t0\tnot-a-numstat",
    );
    expect(detail.fileCount).toBe(1);
    expect(detail.files[0]?.path).toBe("real.txt");
    // No raw line to pair with: status stays null rather than guessing.
    expect(detail.files[0]?.status).toBeNull();
  });

  test("a merge commit (suppressed diff) has no files", () => {
    const detail = parseShow(header("m".repeat(40), "M", "2026-01-01T00:00:00+00:00", "merge\n"));
    expect(detail.files).toEqual([]);
    expect(detail.fileCount).toBe(0);
  });

  test("messages are capped at 8 KB and say so", () => {
    const long = "é".repeat(5000); // 2 bytes each
    const detail = parseShow(header("a".repeat(40), "A", "2026-01-01T00:00:00+00:00", `${long}\n`));
    expect(detail.messageTruncated).toBe(true);
    expect(new TextEncoder().encode(detail.message).length).toBeLessThanOrEqual(8192);
  });
});

describe("capToBytes", () => {
  test("never splits a multi-byte character", () => {
    const capped = capToBytes("aéb", 2);
    expect(capped.text).toBe("a");
    expect(capped.truncated).toBe(true);
    expect(capToBytes("abc", 10)).toEqual({ text: "abc", truncated: false });
  });
});
