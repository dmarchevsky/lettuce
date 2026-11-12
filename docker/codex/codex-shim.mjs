#!/usr/bin/env node
/**
 * Installed as `/usr/local/bin/codex` in the app-server image; the real CLI
 * lives under /opt/codex.
 *
 * letta-code starts Codex subagent workers as `codex app-server --stdio` and
 * sends a sandbox policy on every turn. It used to ask for `workspaceWrite`,
 * which Codex builds with bubblewrap — needing user namespaces and mounts that
 * Docker's default seccomp and AppArmor profiles deny, and relaxing those
 * profiles is the trade-off this stack already rejected (AGENTS.md, sandbox
 * section). Since 0.34.14 it asks for `dangerFullAccess` instead, so the shim's
 * job is no longer rescuing a refused sandbox but keeping the policy ours: it
 * declares the container as the sandbox (`externalSandbox`) and changes nothing
 * else. No fork delta: letta-code finds `codex` on PATH.
 *
 * It is also the on/off switch: with workers disabled in Settings → Codex,
 * every invocation — including letta-code's `codex --version` preflight —
 * fails with a message saying so, and the task reports it.
 */

import { spawn } from "node:child_process";
import {
  codexHome,
  DISABLED_MESSAGE,
  isAppServerInvocation,
  isEnabled,
  readShimSettings,
  rewriteLine,
} from "./shim-core.mjs";

const REAL = process.env.CODEX_REAL_BIN || "/opt/codex/bin/codex";
const settings = readShimSettings(codexHome(process.env));

if (!isEnabled(settings)) {
  process.stderr.write(`${DISABLED_MESSAGE}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const rewriting = isAppServerInvocation(args);
const child = spawn(REAL, args, {
  stdio: [rewriting ? "pipe" : "inherit", "inherit", "inherit"],
});

if (rewriting) {
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      child.stdin.write(`${rewriteLine(line)}\n`);
      newline = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => {
    if (buffer) child.stdin.write(rewriteLine(buffer));
    child.stdin.end();
  });
}

// letta-code stops a worker by signalling this process; pass it on.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  process.stderr.write(`codex shim: cannot start ${REAL}: ${error.message}\n`);
  process.exit(127);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
