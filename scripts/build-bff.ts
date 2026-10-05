/**
 * Rebuild the bff image the way the definition of done requires, with one thing
 * added: the commit it was built from.
 *
 * `docker compose build bff` stamps the image from the git refs in the build
 * context, which is right for a clean tree and wrong for a dirty one — inside the
 * build there is no working tree to compare against. This wrapper reads the host
 * checkout and passes what it knows, so a build you make by hand always answers
 * "which commit is this" and `bun run deploy-check` can hold the running container
 * to that answer.
 *
 * Usage: bun scripts/build-bff.ts [extra compose args…]
 */

const ROOT = new URL("..", import.meta.url).pathname;

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

const sha = git("rev-parse", "--short", "HEAD");
if (sha === "") {
  console.error("  not a git checkout — nothing to stamp the image with");
  process.exit(1);
}
const dirty = git("status", "--porcelain") !== "";

console.log(`building bff from ${sha}${dirty ? " (dirty tree)" : ""}`);
const child = Bun.spawn(
  ["docker", "compose", "-f", "docker/compose.yml", "build", ...process.argv.slice(2), "bff"],
  {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, GIT_SHA: dirty ? `${sha}-dirty` : sha },
  },
);
process.exit(await child.exited);
