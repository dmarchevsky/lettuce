/**
 * The offline half of the definition of done (see AGENTS.md).
 *
 * Runs every gate that needs no running stack, cheapest first, and stops at the
 * first failure. On success it prints the steps that are NOT automated, because
 * the failure this script exists to prevent was reporting work "done" when it
 * had been typechecked and built but never committed or deployed.
 *
 * A stage's own output is captured and echoed only when it fails: the test stage
 * prints about 2,300 lines to surface one, and a red gate that buries its failure
 * under a wall of green tells the driver nothing. On a red run the verdict is the
 * last thing printed, so the tail of this output is the answer.
 *
 * Usage: bun run verify
 */

const ROOT = new URL("..", import.meta.url).pathname;

/** How much of a failing stage's own output to echo. */
const TAIL_LINES = 60;

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
let failureOutput = "";

for (const stage of STAGES) {
  const started = Date.now();
  const result = Bun.spawnSync(stage.cmd, { cwd: ROOT });
  const out = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.exitCode === 0) {
    // One line per green stage: what ran, how long, and the last line of its own
    // summary, so a stage that quietly did less than it claims is still visible.
    const summary = out.trimEnd().split("\n").pop() ?? "";
    console.log(`  ✓ ${stage.name} (${seconds}s)${summary ? ` — ${summary}` : ""}`);
    continue;
  }
  failed = stage.name;
  failureOutput = out;
  break;
}

if (failed) {
  // The failing stage's own words first, then the verdict, so the last lines read
  // are the verdict and where to look, not a passing stage's chatter.
  const lines = failureOutput.trimEnd().split("\n");
  console.log(`\n── ${failed} said:`);
  if (lines.length > TAIL_LINES) {
    console.log(
      `  … ${lines.length - TAIL_LINES} earlier line(s) omitted — the stage's own command ` +
        "prints all of it.",
    );
  }
  for (const line of lines.slice(-TAIL_LINES)) console.log(line);
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
    pre-release   the review, the CHANGELOG entry + VERSION bump in one commit, then Release?
    release       one flow release does it: push the branch, open the PR, wait for CI, merge,
                  tag the merge commit, publish the release — and only then bun run deploy-check,
                  ui-check / smoke where they apply.

  Production deploy is the operator's alone — the flow stops at the tag and never asks about it.
  Never remove a worktree or a branch by hand: flow finish does the checking.
`);
