/**
 * The env-name contract between Compose and the BFF.
 *
 * `docker/compose.yml` maps `docker/.env` into the container, and `bff/src/config.ts`
 * reads the names it picks. Nothing checks the two lists agree: `LETTA_SIGNIN`
 * on one side and `SIGNIN` on the other typechecked, passed every unit test, and
 * left every container running the derived default instead of the operator's
 * choice. Both sides are configuration the other cannot see, so the check lives
 * here, where it can read both files.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The `environment:` keys of the `bff:` service, as compose spells them. */
function bffServiceEnvKeys(): string[] {
  const lines = readFileSync(join(ROOT, "docker/compose.yml"), "utf8").split("\n");
  const keys: string[] = [];
  let inBff = false;
  let inEnv = false;
  for (const line of lines) {
    if (/^ {2}[a-z][a-z0-9-]*:$/.test(line)) {
      inBff = line.trim() === "bff:";
      inEnv = false;
      continue;
    }
    if (!inBff || line.trim() === "" || line.trim().startsWith("#")) continue;
    // A sibling block of the environment map (volumes:, ports:) ends it; anything
    // less indented than an entry ends the service.
    if (/^ {4}[a-z_]+:$/.test(line)) {
      inEnv = line.trim().startsWith("environment:");
      continue;
    }
    if (/^ {2}\S/.test(line)) {
      inBff = false;
      continue;
    }
    if (inEnv && /^ {6}[A-Z][A-Z0-9_]*:/.test(line)) {
      keys.push(line.slice(6).split(":")[0]!.trim());
    }
  }
  return keys;
}

/** Every name the BFF source can read, from `process.env.X` and from bare strings. */
function bffSource(): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
    }
  };
  walk(join(ROOT, "bff/src"));
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

/** Named by Compose for the process or the runtime itself, never read by name. */
const RUNTIME_PROVIDED = new Set(["TZ", "PATH"]);

test("every variable compose hands the bff is one the bff reads", () => {
  const source = bffSource();
  const unread = bffServiceEnvKeys().filter(
    (key) => !RUNTIME_PROVIDED.has(key) && !new RegExp(`\\b${key}\\b`).test(source),
  );
  expect(unread).toEqual([]);
});

test("the auth axes are wired through compose by the names config reads", () => {
  // The four whose absence is not an error but a silently different deployment.
  const keys = bffServiceEnvKeys();
  for (const key of ["ACCESS", "SIGNIN", "LETTA_HOST_BIND", "SIGNIN_DIR"]) {
    expect(keys).toContain(key);
  }
});
