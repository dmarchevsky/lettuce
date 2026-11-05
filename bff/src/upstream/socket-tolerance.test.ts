import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The regression this pins is Bun's `ws` shim throwing a failed handshake at an
 * EventEmitter with no `error` listener, which ends the process no matter that
 * the rejected promise is handled (see `connection.ts`). It is a whole-process
 * event, so each case runs in its own child — in-process, the crash it proves
 * fixed would instead take the runner down — and each child closes its own port
 * so the refused connection is not a race with the rest of the machine.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/handshake-fixture.ts", import.meta.url));
const runsUnderBun = Boolean((process.versions as Record<string, string | undefined>).bun);

function run(mode: string) {
  return spawnSync(process.execPath, [FIXTURE, mode], { encoding: "utf8", timeout: 30_000 });
}

test("a failed handshake does not end the process", () => {
  // Under node the client only ever rejects, so there is nothing to prove there.
  if (!runsUnderBun) return;

  // The shipped contract, on every runtime: the BFF survives a refused handshake.
  expect(run("tolerant").status).toBe(0);

  // Whether the bug exists at all is a property of the runtime, not of this
  // branch: bun 1.3.0 — CI's pin, two minors behind the `oven/bun:1.3` the image
  // actually resolves to — lets the refusal through as a plain rejection, while
  // 1.3.14 throws it out of EventEmitter. So the runtime is asked first, and the
  // contrast is only claimed where there is one to claim.
  const raw = run("raw");
  const out = `${raw.stdout}${raw.stderr}`;
  if (raw.status === 1) {
    expect(out).toContain("Unhandled error");
  } else {
    // A bare client that exits 0 must not have crashed on the way out either:
    // that would mean the fixture lost its grip on the case it exists to show.
    expect(out).not.toContain("Unhandled error");
  }
});
