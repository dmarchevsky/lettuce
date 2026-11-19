/**
 * The offline suite, run in a scratch directory it owns.
 *
 * Every test that needs a filesystem calls `mkdtemp(tmpdir())` and none of them
 * clean up — six `verify` runs once left about 1,900 empty directories behind, and
 * dev-flow points `TMPDIR` at the feature's own `tmp/`, so the litter buried the
 * reflection digest next to it. Per-test cleanup is the right long answer, but it
 * is 28 files of `afterAll` and every new test would have to remember it; aiming the
 * whole suite at one directory it owns fixes the leak at the one place that can
 * forget it, and leaves `mkdtemp` in the tests as the isolation it is for.
 *
 * Anything left in the scratch dir (a test that wrote outside its own mkdtemp)
 * goes with it, which is the point: the suite's footprint is now exactly one
 * directory, gone when the run is.
 *
 * Usage: bun run test [bun test args…]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "lettuce-suite-"));

// A kill still cleans up: the leak this exists for is a leak across runs, and an
// interrupted run is the common way to leave one behind.
let done = false;
function cleanup(): void {
  if (done) return;
  done = true;
  rmSync(scratch, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

const child = Bun.spawn(["bun", "test", ...process.argv.slice(2)], {
  cwd: ROOT,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, TMPDIR: scratch },
});

const code = await child.exited;
cleanup();
process.exit(code);
