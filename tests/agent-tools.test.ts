/**
 * The agent-tools contract between the app-server image, compose and the
 * installing-tools agent skill.
 *
 * `docker/codex/Dockerfile` points the package managers at /opt/agent-tools,
 * `docker/compose.yml` makes that folder the `tools/` mount, and the skill tells
 * agents where things land and how a cron job runs. None of the three can see the
 * others, and a break is silent: tools vanish at the next recreate, an agent's
 * `npm i -g @letta-ai/letta-code` shadows the pinned server, or every cron job
 * fails. The live CI tier checks a running container; this checks the files, so it
 * fails before a merge.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

const MOUNT = "/opt/agent-tools";

/** The Dockerfile's instructions, one per entry, continuation lines joined. */
function dockerInstructions(): string[] {
  return read("docker/codex/Dockerfile")
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** Every `NAME=value` the image sets with ENV, in order (a later one wins). */
function imageEnv(): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of dockerInstructions()) {
    if (!line.startsWith("ENV ")) continue;
    for (const match of line.slice(4).matchAll(/([A-Z_][A-Z0-9_]*)=("[^"]*"|\S+)/g)) {
      env.set(match[1]!, match[2]!.replace(/^"|"$/g, ""));
    }
  }
  return env;
}

test("the agent-tools folders are appended to PATH, never prepended", () => {
  const paths = dockerInstructions().filter((line) => /^ENV PATH=/.test(line));
  expect(paths.at(-1)).toBe('ENV PATH="${PATH}:${AGENT_TOOLS_PATH}"');
  // Only that last line may name the folders: any earlier one could put them first.
  const earlier = paths.slice(0, -1);
  expect(
    earlier.filter((line) => line.includes(MOUNT) || line.includes("AGENT_TOOLS_PATH")),
  ).toEqual([]);
});

test("compose makes /opt/agent-tools the tools/ mount of the state dir", () => {
  expect(read("docker/compose.yml")).toContain(`- \${LETTA_STATE_DIR:-../..}/tools:${MOUNT}\n`);
});

test("every bin directory the skill installs into is on PATH", () => {
  const onPath = (imageEnv().get("AGENT_TOOLS_PATH") ?? "").split(":");
  const skill = read("docker/agent-skills/installing-tools/SKILL.md");
  const binDirs = new Set(
    [...skill.matchAll(/\/opt\/agent-tools\/(?:[a-z]+\/)*bin\b/g)].map((match) => match[0]),
  );
  expect(binDirs.size).toBeGreaterThan(0);
  expect([...binDirs].filter((dir) => !onPath.includes(dir))).toEqual([]);
});

test("caches stay off the mount, so a state backup carries only tools", () => {
  const env = imageEnv();
  // GOPATH holds Go's module cache unless GOMODCACHE moves it; GOBIN alone places tools.
  for (const name of ["GOPATH", "GOMODCACHE", "UV_CACHE_DIR", "npm_config_cache"]) {
    expect(env.get(name)?.startsWith(MOUNT) ?? false).toBe(false);
  }
});

test("the skill's cron recipe calls the agent-env the image installs", () => {
  const instructions = dockerInstructions();
  expect(instructions).toContain("COPY agent-env /usr/local/bin/agent-env");
  const skill = read("docker/agent-skills/installing-tools/SKILL.md");
  expect(skill).toMatch(/root \/usr\/local\/bin\/agent-env \/work\//);
  expect(read("docker/codex/agent-env")).toContain("/proc/1/environ");
});
