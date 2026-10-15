/**
 * The offline half of the definition of done (see AGENTS.md).
 *
 * Runs every gate that needs no running stack, cheapest first, and stops at the
 * first failure. On success it prints the steps that are NOT automated, because
 * the failure this script exists to prevent was reporting work "done" when it
 * had been typechecked and built but never committed or deployed.
 *
 * Usage: bun run verify
 */

const ROOT = new URL("..", import.meta.url).pathname;

interface Stage {
  name: string;
  cmd: string[];
  why: string;
}

const STAGES: Stage[] = [
  {
    name: "worktree",
    cmd: ["bun", "scripts/check-worktree.ts"],
    why: "feature work happens in a worktree, not the main checkout",
  },
  {
    name: "version-pin",
    cmd: ["bun", "scripts/check-version-pin.ts"],
    why: "one letta-code release across images and types",
  },
  {
    name: "prod-info",
    cmd: ["bun", "scripts/check-prod-info.ts"],
    why: "no prod addresses or personal mail in a public tree",
  },
  {
    name: "hygiene",
    cmd: ["bun", "scripts/check-release-hygiene.ts"],
    why: "VERSION and CHANGELOG agree",
  },
  {
    name: "docs",
    cmd: ["bun", "scripts/check-docs.ts"],
    why: "AGENTS.md and .agents/skills point at things that exist",
  },
  { name: "lint", cmd: ["bun", "run", "lint"], why: "biome check" },
  {
    name: "typecheck",
    cmd: ["bun", "run", "typecheck"],
    why: "also the protocol-drift detector",
  },
  { name: "test", cmd: ["bun", "run", "test"], why: "bun:test, including the harness guard" },
  { name: "build", cmd: ["bun", "run", "build"], why: "writes web/dist" },
];

let failed: string | null = null;

for (const stage of STAGES) {
  console.log(`\n── ${stage.name} (${stage.why})`);
  const result = Bun.spawnSync(stage.cmd, {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    failed = stage.name;
    break;
  }
}

if (failed) {
  console.log(`\n✗ verify FAILED at: ${failed}`);
  console.log("  Later stages were not run.");
  process.exit(1);
}

console.log(`\n✓ verify passed — ${STAGES.map((s) => s.name).join(", ")}`);
console.log(`
  This is NOT done yet. It is the offline half only — the stage ladder in
  .dev-flow/project.md still requires:

    implement     build, deploy and run it locally from the worktree (setup copies docker/.env in),
                  then STOP: the operator tests it in the container and says it works
    pre-release   ponytail-review, the CHANGELOG entry + VERSION bump in one commit, then Release?
    release       push the branch, open the PR, the operator merges it (squash), tag main's tip
                  and only then bun run deploy-check, ui-check / smoke where they apply

  Production deploy is the operator's alone — the flow stops at the tag and never asks about it.
  Never remove a worktree or a branch by hand: bun run cleanup and flow finish do the checking.
`);
