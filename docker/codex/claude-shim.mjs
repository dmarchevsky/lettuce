#!/usr/bin/env node
/**
 * Installed as `/usr/local/bin/claude` in the app-server image; the real CLI
 * lives under /opt/claude-code.
 *
 * letta-code runs Claude Code subagent workers as `claude --print
 * --input-format stream-json --output-format stream-json …` and feeds the
 * prompt on stdin (`tools/impl/claude-stream-session.ts`). Unlike the Codex
 * shim there is nothing to rewrite: Claude Code takes argv and stdin verbatim,
 * and it builds no sandbox of its own here. What the shim adds is the
 * configuration the CLI has no config file for — either the Claude
 * subscription's OAuth token or an Anthropic-compatible endpoint, model and
 * token, injected as the environment Claude Code reads — and the on/off switch: with workers disabled in Settings → Claude Code,
 * every invocation — including letta-code's `claude auth status --json`
 * preflight — fails with a message saying so, and the task reports it.
 * No fork delta: letta-code finds `claude` on PATH.
 */

import { spawn } from "node:child_process";
import {
  buildEnv,
  claudeConfigDir,
  DISABLED_MESSAGE,
  isEnabled,
  readShimSettings,
} from "./claude-shim-core.mjs";

const REAL = process.env.CLAUDE_REAL_BIN || "/opt/claude-code/bin/claude";
const settings = readShimSettings(claudeConfigDir(process.env));

if (!isEnabled(settings)) {
  process.stderr.write(`${DISABLED_MESSAGE}\n`);
  process.exit(1);
}

const child = spawn(REAL, process.argv.slice(2), {
  stdio: ["inherit", "inherit", "inherit"],
  env: buildEnv(settings, process.env),
});

// letta-code stops a worker by signalling this process; pass it on.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  process.stderr.write(`claude shim: cannot start ${REAL}: ${error.message}\n`);
  process.exit(127);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
