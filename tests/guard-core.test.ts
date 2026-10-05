/**
 * The guard rules must fire on what they claim to fire on, and stay quiet on
 * reads that merely quote a forbidden command. Run under `bun test`.
 */
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  commandSegments,
  protectedFileFor,
  relativeToRoot,
  reviewCommand,
  reviewPath,
} from "../.pi/extensions/guard-core.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const titles = (command: string) => reviewCommand(command).map((hit) => hit.rule.title);
const hard = (command: string) => reviewCommand(command).some((hit) => !!hit.rule.hard);

test("landing a branch is free; landing main or a tag is the release", () => {
  expect(titles("git push -u origin feat/build-sha")).toEqual([]);
  expect(titles("git push origin HEAD")).toEqual([]);
  expect(titles("git push origin release/v0.7.0-letta_0.34.1")).toEqual([]);
  expect(titles("git push origin main")).toEqual(["git push to main or tags"]);
  expect(titles("git push --follow-tags").sort()).toEqual([
    "git push to main or tags",
    "git push with no refspec",
  ]);
  expect(titles("git -C /elsewhere push")).toEqual(["git push with no refspec"]);
  expect(titles("git pushd .")).toEqual([]);
});

test("merging and approving a PR is the operator's, not the agent's", () => {
  expect(titles("gh pr merge 7 --squash")).toEqual(["gh pr merge"]);
  expect(titles("gh pr review 7 --approve")).toEqual(["gh pr review --approve"]);
  expect(titles('gh pr create --base main --title "x" --body "y"')).toEqual([]);
  expect(titles("gh pr view 7 --json state")).toEqual([]);
  expect(titles("gh pr checks 8")).toEqual([]);
});

test("force is blocked outright", () => {
  expect(hard("git push --force-with-lease origin main")).toBe(true);
});

test("removing a worktree or deleting a branch needs the operator; forcing them does not exist", () => {
  expect(titles("git worktree remove .worktrees/x")).toEqual(["git worktree remove"]);
  expect(hard("git worktree remove .worktrees/x")).toBe(false);
  expect(titles("git branch -d merged-branch")).toEqual(["git branch -d"]);
  expect(hard("git branch -d merged-branch")).toBe(false);
  expect(hard("git worktree prune")).toBe(true);
  // -D is confirmable now: squash merges make every merged branch look unmerged to git, so
  // `-d` can never work here and cleanup needs a deletable path. Still gated, never silent.
  expect(titles("git branch -D chore/merged-thing")).toEqual(["git branch -D"]);
  expect(hard("git branch -D chore/merged-thing")).toBe(false);
  expect(hard("git worktree remove --force .worktrees/x")).toBe(true);
  expect(hard("git branch --delete --force chore/x")).toBe(true);
  expect(titles("git branch --show-current")).toEqual([]);
});

test("an annotated tag is gated", () => {
  expect(titles('git tag -a "$(cat VERSION)" -m "release"')).toContain("git tag -a");
});

test("plain compose up is fine, scoped app-server is not", () => {
  expect(titles("docker compose -f docker/compose.yml up -d")).toEqual([]);
  expect(titles("docker compose -f docker/compose.yml up -d --build bff")).toEqual([]);
  expect(titles("docker compose -f docker/compose.yml up -d app-server")).toContain(
    "recreate app-server",
  );
});

test("stopping or removing containers is gated", () => {
  expect(
    titles("docker compose -f docker/compose.yml --profile telegram rm -sf channel-gateway"),
  ).toContain("docker compose (destructive)");
  expect(titles("docker compose -f docker/compose.yml stop bff")).toContain(
    "docker compose (destructive)",
  );
  expect(titles("docker compose -f docker/compose.yml restart channel-gateway")).toContain(
    "docker compose restart",
  );
});

test("reads that quote a forbidden command do not trip a gate", () => {
  expect(titles('grep -rn "git push origin main" AGENTS.md')).toEqual([]);
  expect(titles("cat AGENTS.md | rg git\\ push")).toEqual([]);
  expect(titles("echo 'then git push'")).toEqual([]);
  expect(commandSegments("cat x | git push")).toContain("git push");
});

test("compound commands check every doing segment", () => {
  expect(titles("git add -A && git commit -m x && git push origin main")).toEqual([
    "git push to main or tags",
  ]);
});

test("protected files match by path, not by prefix accidents", () => {
  const at = (path: string) => reviewPath(path, ROOT, ROOT)?.path;
  expect(at("docker/.env")).toBe("docker/.env");
  expect(at("./docker/.env")).toBe("docker/.env");
  expect(at(`${ROOT}docker/.env`)).toBe("docker/.env");
  expect(at("VERSION")).toBe("VERSION");
  expect(at("VERSIONS.md")).toBeUndefined();
  expect(at("docker/.env.example")).toBeUndefined();
  expect(at("docker/secrets/token.json")).toBe("docker/secrets");
  expect(at("web/src/main.ts")).toBeUndefined();
  expect(reviewPath("../elsewhere/docker/.env", ROOT, ROOT)).toBeNull();
});

test("docker/secrets is hard-protected, VERSION is only gated", () => {
  expect(protectedFileFor("docker/secrets")?.hard).toBe(true);
  expect(protectedFileFor("VERSION")?.hard).toBeFalsy();
});

test("paths outside the repo are never protected", () => {
  expect(relativeToRoot("/etc/VERSION", ROOT).startsWith("..")).toBe(true);
  expect(protectedFileFor(relativeToRoot("/etc/VERSION", ROOT))).toBeNull();
});
