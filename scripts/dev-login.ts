/**
 * An authenticated handle on the dev stack, printed instead of re-derived.
 *
 * Four flows have hand-rolled this against a password-protected local stack: a
 * wrong endpoint (`/api/auth/signin`), a form post where the BFF requires a JSON
 * body, two mis-parses of the local password file, and one run that printed the
 * password into its own transcript while hunting for it. So the endpoint, the
 * content type, where the password lives and what a usable handle looks like all
 * live here now, and no value is ever echoed — what is printed is a **path** and a
 * command that reads the cookie from that path.
 *
 * Usage: bun scripts/dev-login.ts [bffOrigin] [--agent-ids]
 *
 *   --agent-ids   also print the agent ids, which are the directory names under
 *                 `$LETTA_STATE_DIR/workspaces` and are on no obvious API surface
 *                 — three flows wanted them to call `/api/skills?agent_id=…`.
 *
 * The stack's own auth mode decides the flow: `SIGNIN=password` posts the JSON
 * body `/auth/login` demands, anything else mints a cookie with no body.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutRoot, cookieJarLine, devSignIn, parseArgs } from "./harness.ts";

const { origin: ORIGIN } = parseArgs(process.argv.slice(2));
const WANTED_AGENT_IDS = process.argv.includes("--agent-ids");

/**
 * The stack's origin, parsed once and up front: a bare `127.0.0.1:8099` (no scheme)
 * is the mistake worth naming, and every URL below is derived from this one.
 */
function parseOrigin(value: string): URL {
  try {
    return new URL(value);
  } catch {
    console.error(
      `\u2717 "${value}" is not an origin — pass one with a scheme, e.g. http://127.0.0.1:8090`,
    );
    process.exit(2);
  }
}
const url = parseOrigin(ORIGIN);

/**
 * A Netscape cookie jar, which is what `curl -b` and `curl -c` speak — so the
 * handle outlives this process and no secret passes through a shell command line,
 * where it would land in a transcript and in shell history.
 *
 * It goes next to the stack password the local file already holds (gitignored, and
 * a worktree has none of its own), so a flow can reuse one handle instead of
 * signing in four times, and the path is the same tomorrow.
 */
function jarPath(): string {
  const dir = join(checkoutRoot(), ".pi", "local-secrets");
  const target = existsSync(dir) ? dir : join(tmpdir(), "lettuce-dev-login");
  mkdirSync(target, { recursive: true });
  return join(target, `${url.hostname}-${url.port || "80"}.cookies`);
}

function writeJar(jar: string, cookie: string): void {
  Bun.write(jar, `${cookieJarLine(ORIGIN, cookie)}\n`);
  // 0600: this file is a credential for a stack that reaches a real inbox.
  Bun.spawnSync(["chmod", "600", jar]);
}

const cookie = await devSignIn(ORIGIN);
const jar = jarPath();
writeJar(jar, cookie);

console.log(`signed in to ${ORIGIN}`);
console.log(`cookie jar: ${jar}`);
console.log(`\n  curl -sS -b ${jar} ${ORIGIN}/api/status | head -40`);
console.log(
  `\nAnything that wants a Cookie header can read it back out of the jar: ` +
    `\`cookie=$(awk -F'\\t' 'NR==1{print $6"="$7}' ${jar})\`.`,
);

if (WANTED_AGENT_IDS) {
  const stateDir = stateDirFromEnv();
  if (!stateDir) {
    console.error(
      "\n✗ could not resolve LETTA_STATE_DIR. It is set in docker/.env of the main checkout " +
        `(${join(checkoutRoot(), "docker", ".env")}), which is what this reads.`,
    );
    process.exit(1);
  }
  const workspaces = join(stateDir, "workspaces");
  if (!existsSync(workspaces)) {
    console.error(`✗ no workspaces directory at ${workspaces}`);
    process.exit(1);
  }
  const ids = readdirSync(workspaces, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("agent-"))
    .map((entry) => entry.name);
  console.log(`\nagent ids (from ${workspaces}):`);
  for (const id of ids) console.log(`  ${id}`);
  if (ids.length === 0) console.log("  (none — the agent has never made a workspace)");
}

/**
 * `LETTA_STATE_DIR` as an absolute path, read from the **main** checkout's
 * `docker/.env` — a worktree has none, and the default in compose is relative to
 * the compose file, which resolves somewhere else in a worktree (see AGENTS.md).
 */
function stateDirFromEnv(): string | null {
  for (const file of [
    join(checkoutRoot(), "docker", ".env"),
    join(homedir(), ".config", "lettuce", ".env"),
  ]) {
    if (!existsSync(file)) continue;
    const line = readFileSync(file, "utf-8")
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.startsWith("LETTA_STATE_DIR="));
    const value = line
      ?.slice("LETTA_STATE_DIR=".length)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (value && value.startsWith("/")) return value;
  }
  return null;
}
