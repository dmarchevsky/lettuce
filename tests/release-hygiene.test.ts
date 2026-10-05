/**
 * The release-contract rules must fire on the things `AGENTS.md` says they fire
 * on, and stay quiet on the things it excuses. Run under `bun test`.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  appDirsTouched,
  decideBump,
  reviewPr,
  reviewReleaseState,
} from "../scripts/check-release-hygiene.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const errors = (input: Parameters<typeof reviewPr>[0]) => reviewPr(input).errors;

test("a change to a user-visible directory owes a changelog entry", () => {
  expect(errors({ changedFiles: ["bff/src/index.ts"] })).toHaveLength(1);
  expect(errors({ changedFiles: ["web/src/App.tsx", "docker/compose.yml"] })).toHaveLength(1);
  expect(errors({ changedFiles: ["bff/src/index.ts"] })[0]).toContain("CHANGELOG.md is untouched");
});

test("editing the changelog, or labeling bump:none, discharges the duty", () => {
  expect(errors({ changedFiles: ["bff/src/index.ts", "CHANGELOG.md"] })).toHaveLength(0);
  expect(
    errors({
      changedFiles: ["bff/src/index.ts"],
      labels: ["bump:none"],
      commitSubject: "chore: x",
    }),
  ).toHaveLength(0);
});

test("docs-only changes owe nothing", () => {
  expect(errors({ changedFiles: ["AGENTS.md", "docs/x.md"] })).toHaveLength(0);
});

test("the bump comes from the label, else the commit subject, else the changelog", () => {
  expect(decideBump({ changedFiles: [], labels: ["bump:minor"] })).toEqual({
    bump: "minor",
    why: "label bump:minor",
  });
  expect(decideBump({ changedFiles: [], commitSubject: "feat(web): add pinning" }).bump).toBe(
    "minor",
  );
  expect(decideBump({ changedFiles: [], commitSubject: "fix(bff): stop crash" }).bump).toBe(
    "patch",
  );
  expect(decideBump({ changedFiles: [], commitSubject: "docs: reword" }).bump).toBe("none");
  expect(
    decideBump({ changedFiles: [], commitSubject: "merge stuff", changelogSections: ["Added"] })
      .bump,
  ).toBe("minor");
  expect(decideBump({ changedFiles: [], commitSubject: "merge stuff" }).bump).toBe("unknown");
});

test("labels that contradict each other or the changelog are reported, not guessed", () => {
  expect(
    decideBump({ changedFiles: [], labels: ["bump:minor", "bump:patch"], commitSubject: "feat: x" })
      .bump,
  ).toBe("unknown");
  expect(
    decideBump({
      changedFiles: [],
      labels: ["bump:patch"],
      commitSubject: "feat: x",
      changelogSections: ["Added"],
    }).bump,
  ).toBe("unknown");
  expect(
    decideBump({ changedFiles: [], labels: ["bump:weekly"], commitSubject: "feat: x" }).bump,
  ).toBe("unknown");
});

test("bump:none alongside a changelog edit is worth a warning", () => {
  const findings = reviewPr({
    changedFiles: ["bff/src/index.ts", "CHANGELOG.md"],
    labels: ["bump:none"],
  });
  expect(findings.errors).toHaveLength(0);
  expect(findings.warnings.join(" ")).toContain("bump:none yet edits CHANGELOG");
});

test("appDirsTouched names only the user-visible roots", () => {
  expect(appDirsTouched(["bff/src/a.ts", "web/x.ts", "docs/y.md", "scripts/z.ts"])).toEqual([
    "bff",
    "web",
  ]);
  expect(appDirsTouched(["README.md"])).toEqual([]);
});

test("this checkout satisfies its own release contract", () => {
  const version = readFileSync(`${ROOT}VERSION`, "utf8");
  const changelog = readFileSync(`${ROOT}CHANGELOG.md`, "utf8");
  expect(reviewReleaseState(version, changelog)).toEqual([]);
});

test("reviewReleaseState catches a bump that forgot the changelog, and vice versa", () => {
  const good = {
    version: "v1.2.3-letta_0.34.1",
    changelog: "## [Unreleased]\n\n## [v1.2.3-letta_0.34.1] - 2026-01-01\n",
  };
  expect(reviewReleaseState(good.version, good.changelog)).toEqual([]);
  expect(reviewReleaseState("0.6.1", good.changelog).length).toBeGreaterThan(1);
  expect(reviewReleaseState("v9.9.9-letta_0.34.1", good.changelog).join(" ")).toContain(
    "newest CHANGELOG section",
  );
  expect(
    reviewReleaseState("v1.2.3-letta_0.34.1", "## [v1.2.3-letta_0.34.1]\n").join(" "),
  ).toContain("[Unreleased]");
});
