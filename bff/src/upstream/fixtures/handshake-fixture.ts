/**
 * Run in a **child process** by `socket-tolerance.test.ts`. The thing it proves
 * is a process-level uncaught exception, so it cannot be exercised in the test
 * runner's own process — the crash it demonstrates would end the run.
 *
 *   bun <this> tolerant <url>   the shipped client → exits 0, rejection handled
 *   bun <this> raw <url>        the same client with nothing attached to the
 *                               socket's `error` event → exits 1 under bun
 *
 * Nothing here may install an `uncaughtException` handler: an exit code of 1 in
 * the raw case has to come from the crash itself.
 */
import { AppServerClient } from "@letta-ai/letta-code/app-server-client";
import WebSocket from "ws";
import { createAppServerClient } from "../connection.ts";

const [mode, url] = process.argv.slice(2);
const client =
  mode === "raw"
    ? new AppServerClient({ url: url ?? "", WebSocket: WebSocket as never })
    : createAppServerClient(url ?? "");

await client.connect().catch(() => {});
// Reached only if nothing threw its way out of the process on the way here.
setTimeout(() => process.exit(0), 250);
