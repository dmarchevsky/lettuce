import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

/**
 * The regression this pins is Bun's `ws` shim throwing a failed handshake at an
 * EventEmitter with no `error` listener, which ends the process no matter that
 * the rejected promise is handled (see `connection.ts`). It is a whole-process
 * event, so each case runs in its own child: in-process, the crash it proves
 * fixed would instead take the runner down.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/handshake-fixture.ts", import.meta.url));
const runsUnderBun = Boolean((process.versions as Record<string, string | undefined>).bun);

/** A port that is certainly closed — the state of a container start that got here first. */
function closedPortUrl(): string {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port was bound");
  const port = address.port;
  server.close();
  return `ws://127.0.0.1:${port}/ws`;
}

function run(mode: string, url: string) {
  return spawnSync(process.execPath, [FIXTURE, mode, url], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("a failed handshake does not end the process", () => {
  // Under node the client only ever rejects, so there is nothing to prove there.
  if (!runsUnderBun) return;
  const url = closedPortUrl();

  const tolerant = run("tolerant", url);
  expect(tolerant.status).toBe(0);

  // And the case that must still fail: without the permanent socket listener the
  // same handshake kills the process. Without this line the test above could pass
  // forever on a fixture that stopped exercising the bug.
  const raw = run("raw", url);
  expect(raw.status).toBe(1);
  expect(`${raw.stdout}${raw.stderr}`).toContain("Unhandled error");
});
