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
 * configuration the CLI has no config file for — either the Claude subscription's
 * OAuth token or an Anthropic-compatible endpoint, model and token, injected as
 * the environment Claude Code reads — and the on/off switch,
 * which gates **execution**: with workers disabled in Settings → Claude Code,
 * every invocation that would run a worker — including letta-code's
 * `claude auth status --json` preflight — fails with a message saying so, and the
 * task reports it. `--version` is the one exception and answers either way, since
 * naming the CLI is how an operator (and the image marker) surveys what is here;
 * it needs no configuration, so it runs on the inherited environment untouched.
 * No fork delta: letta-code finds `claude` on PATH.
 */

import { spawn } from "node:child_process";
import {
  buildEnv,
  claudeConfigDir,
  DISABLED_MESSAGE,
  isEnabled,
  isVersionInvocation,
  readShimSettings,
} from "./claude-shim-core.mjs";

const REAL = process.env.CLAUDE_REAL_BIN || "/opt/claude-code/bin/claude";
const settings = readShimSettings(claudeConfigDir(process.env));
const args = process.argv.slice(2);

if (!isEnabled(settings) && !isVersionInvocation(args)) {
  process.stderr.write(`${DISABLED_MESSAGE}\n`);
  process.exit(1);
}

// Only a run gets the injected endpoint and token: a version call needs neither,
// and with the switch off there is no settings object to inject from.
const child = spawn(REAL, args, {
  stdio: ["inherit", "inherit", "inherit"],
  env: isEnabled(settings) ? buildEnv(settings, process.env) : process.env,
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
