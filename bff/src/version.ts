import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readBuildInfo, versionString } from "./build-info.ts";

/**
 * The version of this build: the release tag in `VERSION`, plus the commit it was
 * built from as SemVer build metadata — `v0.6.1-letta_0.34.1+9400080` for an
 * untagged build, the bare tag when a tag points at the commit. Without the
 * metadata every build between two releases reports the previous release, which
 * is how "what is prod actually running" had no answer.
 *
 * The rules, the baked `BUILD_INFO` file and the git-metadata fallback all live in
 * `build-info.ts`; the image cannot ask git at runtime because `.dockerignore`
 * keeps the repository out of the build context.
 *
 * A missing or empty `VERSION` file still means an untagged dev checkout and shows
 * as `dev` rather than hiding the row (see the About section).
 */
export function readUiVersion(root: URL = new URL("../../", import.meta.url)): string {
  return versionString(readBuildInfo(root.pathname));
}

/** The tag alone, with no commit metadata — what a release equals by definition. */
export function readReleaseTag(root: URL = new URL("../../", import.meta.url)): string {
  try {
    return readFileSync(join(root.pathname, "VERSION"), "utf8").trim();
  } catch {
    return "";
  }
}
