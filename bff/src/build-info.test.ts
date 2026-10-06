import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BuildInfo,
  decodeBuildInfo,
  encodeBuildInfo,
  resolveFromGitMeta,
  versionString,
} from "./build-info.ts";

const SHA = "9".repeat(40);

function gitDir(write: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "lettuce-gitmeta-"));
  write(dir);
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const info = (over: Partial<BuildInfo>): BuildInfo => ({
  base: "v0.6.1-letta_0.34.1",
  sha: null,
  dirty: false,
  ...over,
});

test("the four shapes of a version string", () => {
  expect(versionString(info({ sha: "9400080" }))).toBe("v0.6.1-letta_0.34.1+9400080");
  expect(versionString(info({ sha: "9400080", dirty: true }))).toBe(
    "v0.6.1-letta_0.34.1+9400080-dirty",
  );
  expect(versionString(info({}))).toBe("v0.6.1-letta_0.34.1+unknown");
  expect(versionString(info({ base: "", sha: "9400080" }))).toBe("dev");
});

test("what a build bakes is what a runtime reads back", () => {
  const baked = info({ sha: "abcdef1", dirty: true });
  expect(decodeBuildInfo(encodeBuildInfo(baked))).toEqual({ ...baked, base: "" });
  expect(decodeBuildInfo("nonsense")).toBeNull();
});

test("HEAD pointing at a loose ref", () => {
  const dir = gitDir((d) => {
    mkdirSync(join(d, "refs/heads"), { recursive: true });
    writeFileSync(join(d, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(d, "refs/heads/main"), `${SHA}\n`);
  });
  expect(resolveFromGitMeta(dir)).toEqual({ sha: SHA.slice(0, 8) });
  cleanup(dir);
});

test("HEAD pointing at a packed ref", () => {
  const dir = gitDir((d) => {
    mkdirSync(join(d, "refs"), { recursive: true });
    writeFileSync(join(d, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(d, "packed-refs"), `${SHA} refs/heads/main\n`);
  });
  expect(resolveFromGitMeta(dir)).toEqual({ sha: SHA.slice(0, 8) });
  cleanup(dir);
});

test("detached HEAD is still a commit", () => {
  const dir = gitDir((d) => writeFileSync(join(d, "HEAD"), `${SHA}\n`));
  expect(resolveFromGitMeta(dir).sha).toBe(SHA.slice(0, 8));
  cleanup(dir);
});

test("no metadata means unknown, not a wrong answer", () => {
  expect(resolveFromGitMeta(gitDir(() => {}))).toEqual({ sha: null });
});

test("no .git at all means unknown — the deploy manager's build", () => {
  // Dockhand builds from its copy of the tree, so `ctx/.git` is simply absent and
  // the Dockerfile points --gitmeta at a path that does not exist.
  const dir = gitDir(() => {});
  expect(resolveFromGitMeta(join(dir, "does-not-exist"))).toEqual({ sha: null });
  cleanup(dir);
});

test("a linked worktree's .git is a file, and still says unknown", () => {
  const dir = gitDir((d) =>
    writeFileSync(join(d, ".git"), "gitdir: /somewhere/.git/worktrees/x\n"),
  );
  expect(resolveFromGitMeta(join(dir, ".git"))).toEqual({ sha: null });
  cleanup(dir);
});
