import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readReleaseTag, readUiVersion } from "./version.ts";

const dirs: string[] = [];
function tempDir(): URL {
  const dir = mkdtempSync(join(tmpdir(), "lettuce-version-"));
  dirs.push(dir);
  return pathToFileURL(`${dir}/`);
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

test("an untagged build carries its commit as build metadata", () => {
  const root = tempDir();
  writeFileSync(new URL("VERSION", root), "v0.1.0-letta_0.33.3\n");
  writeFileSync(new URL("BUILD_INFO", root), "sha=9400080\ndirty=0\n");
  expect(readUiVersion(root)).toBe("v0.1.0-letta_0.33.3+9400080");
});

test("a dirty tree says so", () => {
  const root = tempDir();
  writeFileSync(new URL("VERSION", root), "v0.1.0-letta_0.33.3\n");
  writeFileSync(new URL("BUILD_INFO", root), "sha=9400080\ndirty=1\n");
  expect(readUiVersion(root)).toBe("v0.1.0-letta_0.33.3+9400080-dirty");
});

test("the commit is shown even at a release tag; the tag itself stays separate", () => {
  const root = tempDir();
  writeFileSync(new URL("VERSION", root), "v0.1.0-letta_0.33.3\n");
  writeFileSync(new URL("BUILD_INFO", root), "sha=9400080\ndirty=0\n");
  expect(readUiVersion(root)).toBe("v0.1.0-letta_0.33.3+9400080");
  expect(readReleaseTag(root)).toBe("v0.1.0-letta_0.33.3");
});

test("no build info at all is honest about not knowing", () => {
  const root = tempDir();
  writeFileSync(new URL("VERSION", root), "v0.1.0-letta_0.33.3\n");
  expect(readUiVersion(root)).toBe("v0.1.0-letta_0.33.3+unknown");
});

test("missing VERSION reads as dev", () => {
  expect(readUiVersion(tempDir())).toBe("dev");
});

test("empty VERSION reads as dev", () => {
  const root = tempDir();
  writeFileSync(new URL("VERSION", root), "  \n");
  expect(readUiVersion(root)).toBe("dev");
});

test("the repo checkout reports a release tag, optionally with its commit", () => {
  expect(readUiVersion()).toMatch(
    /^v\d+\.\d+\.\d+-letta_\d+\.\d+\.\d+(\+[0-9a-f]{7,40}(-dirty)?)?$/,
  );
  expect(readReleaseTag()).toMatch(/^v\d+\.\d+\.\d+-letta_\d+\.\d+\.\d+$/);
});
