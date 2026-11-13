/**
 * The guard chain of `POST /api/files/delete`, against a real tree on disk.
 *
 * A delete is the one file verb that cannot be undone, so the tests are mostly
 * about paths that must NOT be removed — and the interesting property is the
 * ORDER: a refusal has to happen before the filesystem is touched, which is why
 * `remove` is injected and records what it was asked for rather than deleting
 * in the fixture. The paths that should be removed are removed in a temp tree.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteWorkspaceEntry, removeWorkspacePath } from "./delete.ts";

let root = "";
/** Every path `remove` was called with — the proof a refusal removed nothing. */
let removed: string[];

const deps = (over: Record<string, unknown> = {}) => ({
  hasSession: true,
  root,
  remove: (path: string) => {
    removed.push(path);
    return removeWorkspacePath(path);
  },
  ...over,
});

const ok = (path: string | undefined) => deleteWorkspaceEntry(deps(), { path });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lettuce-delete-"));
  removed = [];
  mkdirSync(join(root, "agent-local-1", "notes"), { recursive: true });
  writeFileSync(join(root, "agent-local-1", "persona.md"), "hello", "utf8");
  writeFileSync(join(root, "agent-local-1", "notes", "a.md"), "a", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the floor", () => {
  test("the workspace root itself is never a delete", async () => {
    const result = await ok(root);
    expect(result.status).toBe(400);
    expect(removed).toEqual([]);
    expect(existsSync(root)).toBe(true);
  });

  test("an agent's own directory is never a delete — a runtime is standing in it", async () => {
    const agent = join(root, "agent-local-1");
    const result = await ok(agent);
    expect(result.status).toBe(400);
    expect(removed).toEqual([]);
    expect(existsSync(join(agent, "persona.md"))).toBe(true);
  });

  test("the floor survives spelling: a link whose realpath is the agent directory", async () => {
    const agent = join(root, "agent-local-1");
    // `/work/agent-local-1/deep/../` normalises to the agent directory lexically,
    // so the lexical floor is what refuses it — before any filesystem call.
    const result = await ok(join(agent, "notes", ".."));
    expect(result.status).toBe(400);
    expect(removed).toEqual([]);
  });

  test("a deeper path whose realpath walks back up to the floor is refused too", async () => {
    const agent = join(root, "agent-local-1");
    // The realpath re-check, separately from the lexical one: here the real path
    // is the floor even though the requested one was spelled two levels down.
    const result = await deleteWorkspaceEntry(deps({ realpath: () => agent }), {
      path: join(agent, "notes", "a.md"),
    });
    expect(result.status).toBe(400);
    expect(removed).toEqual([]);
  });
});

describe("the clamp", () => {
  test("outside the workspace is refused", async () => {
    expect((await ok("/etc/passwd")).status).toBe(400);
    expect((await ok(`${root}/../outside`)).status).toBe(400);
    expect(removed).toEqual([]);
  });

  test("a relative path is refused rather than resolved against anything", async () => {
    expect((await ok("agent-local-1/persona.md")).status).toBe(400);
  });

  test("a null byte is a bad request, not Node's argument error", async () => {
    expect((await ok(`${root}/agent-local-1/persona.md\0.md`)).status).toBe(400);
    expect(removed).toEqual([]);
  });

  test("a missing path is a 400, and a vanished one is a 404", async () => {
    expect((await ok(undefined)).status).toBe(400);
    expect((await ok(join(root, "agent-local-1", "gone.md"))).status).toBe(404);
  });

  test("without a session nothing is considered at all", async () => {
    const result = await deleteWorkspaceEntry(
      { hasSession: false, root },
      {
        path: join(root, "agent-local-1", "persona.md"),
      },
    );
    expect(result.status).toBe(401);
    expect(existsSync(join(root, "agent-local-1", "persona.md"))).toBe(true);
  });
});

describe("symlinks", () => {
  test("a link out of the workspace is refused, not followed", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lettuce-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "s", "utf8");
      const link = join(root, "agent-local-1", "escape");
      symlinkSync(outside, link);
      const result = await ok(join(link, "secret.txt"));
      expect(result.status).toBe(400);
      expect(removed).toEqual([]);
      expect(existsSync(join(outside, "secret.txt"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("the link itself may be removed — that is unlinking it, not its target", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lettuce-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "s", "utf8");
      const link = join(root, "agent-local-1", "escape");
      symlinkSync(outside, link);
      // The component walk refuses a path whose component IS a link, which is
      // right for reading *through* it and wrong for removing the link itself.
      // The route therefore declines links, and this test records that decision
      // rather than pretending otherwise: a browser cannot use a link to delete
      // anything, and removing a stray link belongs to the agent's own shell.
      const result = await ok(link);
      expect(result.status).toBe(400);
      expect(removed).toEqual([]);
      expect(existsSync(join(outside, "secret.txt"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("what does get deleted", () => {
  test("one file, by its real path", async () => {
    const file = join(root, "agent-local-1", "persona.md");
    const real = realpathSync(file); // before the delete — afterwards it is gone
    const result = await ok(file);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ deleted: real, type: "file" });
    expect(removed).toEqual([real]);
    expect(existsSync(file)).toBe(false);
  });

  test("a folder takes its contents, recursively", async () => {
    const dir = join(root, "agent-local-1", "notes");
    const real = realpathSync(dir);
    const result = await ok(dir);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ deleted: real, type: "dir" });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(root, "agent-local-1", "persona.md"))).toBe(true);
  });

  test("the removal sees the real path, never the spelling it was handed", async () => {
    const spelled = join(root, "agent-local-1", "notes", "..", "persona.md");
    const real = realpathSync(join(root, "agent-local-1", "persona.md"));
    const result = await ok(spelled);
    expect(result.status).toBe(200);
    expect(removed).toEqual([real]);
  });

  test("a removal that fails is reported, not swallowed", async () => {
    const result = await deleteWorkspaceEntry(
      deps({
        remove: () => {
          throw Object.assign(new Error("Directory not empty"), { code: "ENOTEMPTY" });
        },
      }),
      { path: join(root, "agent-local-1", "notes") },
    );
    expect(result.status).toBe(500);
    expect(String(result.text)).toContain("Directory not empty");
    expect(existsSync(join(root, "agent-local-1", "notes"))).toBe(true);
  });

  test("a path that vanished between the check and the removal is a 404", async () => {
    const result = await deleteWorkspaceEntry(
      deps({
        remove: () => {
          throw Object.assign(new Error("no such file"), { code: "ENOENT" });
        },
      }),
      { path: join(root, "agent-local-1", "persona.md") },
    );
    expect(result.status).toBe(404);
  });

  test("the real removal keeps lstat's view of a directory", async () => {
    const dir = realpathSync(join(root, "agent-local-1", "notes"));
    expect(lstatSync(dir).isDirectory()).toBe(true);
    await removeWorkspacePath(dir);
    expect(existsSync(dir)).toBe(false);
  });

  test("a path that stopped resolving to itself is not removed", async () => {
    // What the last-moment check is for: between the guard and the removal a
    // component became a link, so the delete would land somewhere else.
    const outside = mkdtempSync(join(tmpdir(), "lettuce-delete-outside-"));
    writeFileSync(join(outside, "keep.md"), "keep", "utf8");
    const swapped = join(realpathSync(root), "agent-local-1", "notes");
    rmSync(swapped, { recursive: true });
    symlinkSync(outside, swapped);
    await expect(removeWorkspacePath(join(swapped, "keep.md"))).rejects.toThrow("changed");
    expect(existsSync(join(outside, "keep.md"))).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });
});
