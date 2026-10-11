// Preloaded into every node process in the app-server container
// (NODE_OPTIONS=--require, see Dockerfile). Logs a failed spawn's real error.
//
// letta-code launches each subagent as a child `letta` process and, when the
// spawn itself fails, drops the error: `childProcess.once("error", () =>
// finish({ exitCode: null, exitSignal: null }))` (subagent-process.ts). The
// transcript then says only "Subagent process exited with code unknown before
// returning a result", with no errno. This prints one line to stderr per
// failed spawn — errno, what was spawned, and how full the container's process
// table is — so `docker logs` names the cause. It observes only: it never adds
// an "error" listener (which would swallow an otherwise-fatal error) and never
// changes a return value.
"use strict";

const fs = require("node:fs");

/** "11874" → 11874; "max" or unreadable → null. */
function readNumber(file) {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

/** Zombie processes in this PID namespace (state Z in /proc/<pid>/stat). */
function countZombies(procRoot = "/proc") {
  let zombies = 0;
  let entries;
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`${procRoot}/${entry}/stat`, "utf8");
      // The state follows the parenthesised command, which may contain spaces.
      if (stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z") zombies++;
    } catch {
      // Exited while we looked.
    }
  }
  return zombies;
}

/** The one line logged for a failed spawn. */
function describeSpawnFailure(error, child, env = {}) {
  const code = (error && (error.code || error.errno)) || "unknown";
  const file = child.spawnfile || error?.path || "?";
  const args = Array.isArray(child.spawnargs) ? child.spawnargs.slice(1).join(" ") : "";
  const cwd = child.__lettuceSpawnCwd || process.cwd();
  const current =
    env.pidsCurrent === undefined ? readNumber("/sys/fs/cgroup/pids.current") : env.pidsCurrent;
  const max = env.pidsMax === undefined ? readNumber("/sys/fs/cgroup/pids.max") : env.pidsMax;
  const zombies = env.zombies === undefined ? countZombies() : env.zombies;
  const pids = current === null ? "?" : `${current}/${max === null ? "max" : max}`;
  return (
    `[lettuce spawn-diag] spawn failed: ${code} file=${file}` +
    ` args=${JSON.stringify(args.slice(0, 160))} cwd=${cwd}` +
    ` pids=${pids} zombies=${zombies === null ? "?" : zombies} parent=${process.pid}`
  );
}

function install() {
  const { ChildProcess } = require("node:child_process");
  if (ChildProcess.prototype.__lettuceSpawnDiag) return;
  ChildProcess.prototype.__lettuceSpawnDiag = true;

  const spawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function (options) {
    if (options && typeof options.cwd === "string") this.__lettuceSpawnCwd = options.cwd;
    return spawn.apply(this, arguments);
  };

  const emit = ChildProcess.prototype.emit;
  ChildProcess.prototype.emit = function (event, error) {
    // No pid means the process never started: a spawn failure, not a kill or
    // IPC error on a running child.
    if (event === "error" && this.pid === undefined) {
      try {
        process.stderr.write(`${describeSpawnFailure(error, this)}\n`);
      } catch {
        // Diagnostics must never change what happens next.
      }
    }
    return emit.apply(this, arguments);
  };
}

module.exports = { countZombies, describeSpawnFailure, install };

// `LETTA_UI_SPAWN_DIAG_OFF` is this switch's pre-lettuce name, still honoured.
if (
  require.main !== module &&
  !process.env.LETTUCE_SPAWN_DIAG_OFF &&
  !process.env.LETTA_UI_SPAWN_DIAG_OFF
)
  install();
