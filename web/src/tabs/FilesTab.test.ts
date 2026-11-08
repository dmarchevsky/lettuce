import { describe, expect, test } from "bun:test";
import { isEditableFile } from "../components/FileViewer.tsx";
import {
  gitActionsVisible,
  isSameOrInside,
  newFilePath,
  parentDirectory,
  resolve,
  uploadNameProblem,
} from "./FilesTab.tsx";

const ROOT = "/work";
const AGENT = "/work/agent-local-e596ee28-7374-4a66-b410-f4f8cab1abdf";

describe("Files navigation", () => {
  test("Up stops at the workspace root", () => {
    expect(parentDirectory(`${AGENT}/src`)).toBe(AGENT);
    expect(parentDirectory(AGENT)).toBe(ROOT);
    // The step that used to yield "/" and escape the workspace.
    expect(parentDirectory(ROOT)).toBeNull();
  });

  test("Up refuses to operate outside the workspace at all", () => {
    expect(parentDirectory("/")).toBeNull();
    expect(parentDirectory("/etc/ssl")).toBeNull();
    expect(parentDirectory("/workspace")).toBeNull();
  });

  test("trailing slashes do not produce an extra level", () => {
    expect(parentDirectory(`${AGENT}/src/`)).toBe(AGENT);
  });

  test("resolve never returns a root-relative path", () => {
    expect(resolve(ROOT, "agent-local-e596")).toBe("/work/agent-local-e596");
    expect(resolve(AGENT, "notes.md")).toBe(`${AGENT}/notes.md`);
    // The exact regression: root "/" used to collapse to "" and drop /work.
    expect(resolve("/", "agent-local-e596")).toBe("/agent-local-e596");
    expect(resolve(`${AGENT}/`, "notes.md")).toBe(`${AGENT}/notes.md`);
  });

  test("an already-absolute entry path passes through", () => {
    expect(resolve(AGENT, `${AGENT}/notes.md`)).toBe(`${AGENT}/notes.md`);
  });
});

describe("New file", () => {
  test("a plain filename joins onto the current directory", () => {
    expect(newFilePath(AGENT, "notes.md")).toBe(`${AGENT}/notes.md`);
    expect(newFilePath(ROOT, "todo.txt")).toBe("/work/todo.txt");
    expect(newFilePath(AGENT, "  spaced name.md  ")).toBe(`${AGENT}/spaced name.md`);
  });

  test("path separators and traversal are refused", () => {
    // write_file mkdir -p's the parent, so an unchecked "a/b" would build "a".
    expect(newFilePath(AGENT, "a/b")).toBeNull();
    expect(newFilePath(AGENT, "a\\b")).toBeNull();
    expect(newFilePath(AGENT, "../escape")).toBeNull();
    expect(newFilePath(AGENT, "..")).toBeNull();
    expect(newFilePath(AGENT, ".")).toBeNull();
    expect(newFilePath(AGENT, "/etc/passwd")).toBeNull();
    expect(newFilePath(AGENT, "")).toBeNull();
    expect(newFilePath(AGENT, "   ")).toBeNull();
  });
});

describe("git controls", () => {
  const PROBED = `${AGENT}/repo`;

  test("nothing is offered until the BFF answers", () => {
    // In flight, and the folder the tab opens before any answer lands.
    expect(gitActionsVisible(null, PROBED)).toBe(false);
  });

  test("a plain folder never gets the buttons", () => {
    expect(gitActionsVisible({ path: PROBED, repo: false }, PROBED)).toBe(false);
  });

  test("a repository shows them", () => {
    expect(gitActionsVisible({ path: PROBED, repo: true }, PROBED)).toBe(true);
  });

  test("an answer about another folder is not an answer about this one", () => {
    // The race: a slow probe for the folder you left must not open the
    // controls for the plain one you just navigated into.
    expect(gitActionsVisible({ path: PROBED, repo: true }, AGENT)).toBe(false);
    expect(gitActionsVisible({ path: PROBED, repo: true }, `${PROBED}/src`)).toBe(false);
  });
});

describe("editable files", () => {
  test("text files are editable, images are not", () => {
    expect(isEditableFile("notes.md")).toBe(true);
    expect(isEditableFile("README")).toBe(true);
    expect(isEditableFile(".gitignore")).toBe(true);
    expect(isEditableFile("photo.png")).toBe(false);
    expect(isEditableFile("photo.jpeg")).toBe(false);
  });
});

describe("upload names", () => {
  const existing = ["IMG_0421.jpg", "weekly-review.md"];

  test("a fresh name in this folder is fine", () => {
    expect(uploadNameProblem("IMG_0430.jpg", existing)).toBeNull();
    expect(uploadNameProblem("  report.pdf  ", existing)).toBeNull();
  });

  test("a name that exists here is refused, not auto-suffixed", () => {
    expect(uploadNameProblem("IMG_0421.jpg", existing)).toContain("already exists here");
    // The suffix is the user's to type — Files has no rename to undo a silent one.
    expect(uploadNameProblem("IMG_0421 (1).jpg", existing)).toBeNull();
  });

  test("a name the folder cannot hold is refused before the request", () => {
    expect(uploadNameProblem("", existing)).toContain("plain filename");
    expect(uploadNameProblem("a/b.jpg", existing)).toContain("plain filename");
    expect(uploadNameProblem("..", existing)).toContain("plain filename");
    expect(uploadNameProblem("/etc/passwd", existing)).toContain("plain filename");
  });
});

describe("what a delete takes with it", () => {
  test("a deleted path closes the viewer only for that file or one under it", () => {
    // The file open in the viewer, and the folder that was removed.
    expect(isSameOrInside(`${AGENT}/notes/a.md`, `${AGENT}/notes`)).toBe(true);
    expect(isSameOrInside(`${AGENT}/notes`, `${AGENT}/notes`)).toBe(true);
    // A sibling that survived keeps its viewer open.
    expect(isSameOrInside(`${AGENT}/persona.md`, `${AGENT}/notes`)).toBe(false);
    // And a folder is not "inside" something deeper than it.
    expect(isSameOrInside(`${AGENT}`, `${AGENT}/notes`)).toBe(false);
  });

  test("a trailing slash on either side is the same path", () => {
    expect(isSameOrInside(`${AGENT}/notes/`, `${AGENT}/notes/`)).toBe(true);
    expect(isSameOrInside(`${AGENT}/notes/a.md`, `${AGENT}/notes/`)).toBe(true);
  });
});
