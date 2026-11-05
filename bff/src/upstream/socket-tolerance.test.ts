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
  const tolerant = run("tolerant");
  expect(tolerant.status).toBe(0);

  // And the case that must still fail: without the permanent socket listener the
  // same handshake kills the process. Without this line the test above could pass
  // forever on a fixture that stopped exercising the bug.
  const raw = run("raw");
  expect(raw.status).toBe(1);
  expect(`${raw.stdout}${raw.stderr}`).toContain("Unhandled error");
});
