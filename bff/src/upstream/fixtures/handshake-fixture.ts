/**
 * Run in a **child process** by `socket-tolerance.test.ts`. The thing it proves
 * is a process-level uncaught exception, so it cannot be exercised in the test
 * runner's own process — the crash it demonstrates would end the run.
 *
 *   bun <this> tolerant   the shipped client → exits 0, rejection handled
 *   bun <this> raw        the same client with nothing attached to the socket's
 *                         `error` event → exits 1 under bun
 *
 * The dead port is bound and released **here**, not handed in by the test: the
 * window in which another process could claim that port again is the child's own
 * few microseconds rather than a spawn's worth of milliseconds.
 *
 * Nothing here may install an `uncaughtException` handler — the raw case's exit 1
 * has to come from the crash itself.
 */
import { createServer } from "node:net";
import { AppServerClient } from "@letta-ai/letta-code/app-server-client";
import WebSocket from "ws";
import { createAppServerClient } from "../connection.ts";

const mode = process.argv[2];

const listener = createServer();
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
const address = listener.address();
if (address === null || typeof address === "string") throw new Error("no port was bound");
const url = `ws://127.0.0.1:${address.port}/ws`;
await new Promise<void>((resolve) => listener.close(() => resolve()));

const client =
  mode === "raw"
    ? new AppServerClient({ url, WebSocket: WebSocket as never })
    : createAppServerClient(url);

await client.connect().catch(() => {});
// Reached only if nothing threw its way out of the process on the way here.
setTimeout(() => process.exit(0), 250);
