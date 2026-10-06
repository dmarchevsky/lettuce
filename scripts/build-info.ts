/**
 * Print or bake this build's version string (the rules and the why live in
 * `bff/src/build-info.ts`).
 *
 * Usage:
 *   bun scripts/build-info.ts                                   # print it
 *   bun scripts/build-info.ts --emit BUILD_INFO [--git-sha X]   # what the image bakes
 *   bun scripts/build-info.ts --gitmeta <dir>                   # resolve from copied refs
 *
 * Nothing resolving is not an error. A builder with no git metadata anywhere — a
 * deploy manager's copy of the tree, which has no `.git` — emits an empty sha and
 * the version says `+unknown`; see `docker/bff.Dockerfile`.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BuildInfo,
  encodeBuildInfo,
  readBase,
  resolveFromGit,
  resolveFromGitMeta,
  versionString,
} from "../bff/src/build-info.ts";

const ROOT = new URL("..", import.meta.url).pathname;

function flag(name: string, argv: string[]): string | null {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? "");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const gitmeta = flag("--gitmeta", argv);
  const override = flag("--git-sha", argv) || process.env.GIT_SHA || "";
  const resolved = gitmeta
    ? { ...resolveFromGitMeta(join(ROOT, gitmeta)), dirty: false }
    : resolveFromGit(ROOT);
  const info: BuildInfo = {
    base: readBase(ROOT),
    // Always eight, whoever supplied it: CI passes a full 40-hex `github.sha` and the
    // About row must not grow depending on which builder ran.
    sha: (override !== "" ? override : (resolved.sha ?? "")).slice(0, 8) || null,
    // Only a live checkout can tell the tree was dirty; a build arg or copied refs cannot.
    dirty: argv.includes("--dirty") || (!gitmeta && override === "" && resolved.dirty),
  };

  const emit = flag("--emit", argv);
  if (emit) {
    writeFileSync(join(ROOT, emit), encodeBuildInfo(info));
    console.log(`wrote ${emit}: ${versionString(info)}`);
  } else {
    console.log(versionString(info));
  }
}
