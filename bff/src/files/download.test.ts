import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardDownload } from "./download.ts";

function workspace() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "lettuce-download-")));
  const root = join(base, "work");
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(join(root, "agent", "notes.txt"), "hello");
  writeFileSync(join(base, "secret"), "outside");
  return { base, root, deps: { root, maxBytes: 1024 } };
}

describe("guardDownload", () => {
  test("a file in the workspace is opened where it really is", () => {
    const { root, deps } = workspace();
    expect(guardDownload(deps, join(root, "agent", "notes.txt"))).toEqual({
      ok: true,
      real: join(root, "agent", "notes.txt"),
      size: 5,
      filename: "notes.txt",
    });
  });

  test("outside the workspace is refused before the filesystem is asked", () => {
    const { base, root, deps } = workspace();
    for (const path of [join(base, "secret"), `${root}/agent/../../secret`, "/etc/passwd", root]) {
      const result = guardDownload(deps, path);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.status).toBe(400);
    }
    expect(guardDownload(deps, "agent/notes.txt").ok).toBe(false);
    expect(guardDownload(deps, undefined).ok).toBe(false);
  });

  test("a link out of the workspace is not followed — file or folder", () => {
    const { base, root, deps } = workspace();
    symlinkSync(join(base, "secret"), join(root, "agent", "link"));
    symlinkSync(base, join(root, "agent", "dir"));
    const file = guardDownload(deps, join(root, "agent", "link"));
    expect(!file.ok && file.status).toBe(400);
    const through = guardDownload(deps, join(root, "agent", "dir", "secret"));
    expect(!through.ok && through.status).toBe(400);
  });

  test("a path that resolves elsewhere after the walk is still clamped", () => {
    // The walk said yes and the tree changed underneath it: realpath is the
    // second opinion, taken on the path that will actually be opened.
    const { base, root, deps } = workspace();
    const result = guardDownload(
      { ...deps, realpath: () => join(base, "secret") },
      join(root, "agent", "notes.txt"),
    );
    expect(!result.ok && result.status).toBe(400);
  });

  test("folders, missing files and oversized files each get their own answer", () => {
    const { root, deps } = workspace();
    const folder = guardDownload(deps, join(root, "agent"));
    expect(!folder.ok && folder.status).toBe(404);
    const missing = guardDownload(deps, join(root, "agent", "nope"));
    expect(!missing.ok && missing.status).toBe(404);
    writeFileSync(join(root, "agent", "big"), "x".repeat(2000));
    const big = guardDownload(deps, join(root, "agent", "big"));
    expect(!big.ok && big.status).toBe(413);
  });
});
