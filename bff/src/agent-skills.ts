import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { errorMessage } from "./errors.ts";

/** Where letta-code discovers global skills, inside the app-server container. */
export const GLOBAL_SKILLS_DIR = "/root/.letta/skills";

export interface SkillFile {
  /** Relative to the skills root, e.g. `serving-web-apps/SKILL.md`. */
  path: string;
  content: string;
}

/**
 * Every file of every skill under `root` — a skill being a directory with a
 * `SKILL.md`. Directories without one are ignored, so a stray folder never
 * becomes a half-installed skill.
 */
export function readSkillTree(root: string): SkillFile[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const files: SkillFile[] = [];
  for (const name of entries.sort()) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    try {
      statSync(join(dir, "SKILL.md"));
    } catch {
      continue;
    }
    const walk = (current: string) => {
      for (const entry of readdirSync(current).sort()) {
        const full = join(current, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push({ path: relative(root, full), content: readFileSync(full, "utf8") });
      }
    };
    walk(dir);
  }
  return files;
}

/**
 * Install the skills this repo ships into the app-server's global skills
 * directory, through the app-server itself.
 *
 * Not a bind mount: under the prod deploy manager, compose runs inside its own
 * container, so a relative bind source resolves to a path that exists there
 * but not on the host — the daemon mounted an empty directory and the skill
 * silently never reached any agent. Builds are unaffected (the context is
 * streamed), so the files travel in the bff image and are written with the
 * same `write_file` the MCP settings route uses, which creates the parent
 * directories. Runs on every upstream connect, so a deploy or an app-server
 * restart always leaves the shipped version in place — an agent's edit to
 * one of these files does not survive, by design.
 */
export async function installAgentSkills(
  files: readonly SkillFile[],
  write: (path: string, content: string) => Promise<void>,
  log: (message: string) => void,
  target: string = GLOBAL_SKILLS_DIR,
): Promise<number> {
  let installed = 0;
  for (const file of files) {
    const path = `${target}/${file.path}`;
    try {
      await write(path, file.content);
      installed += 1;
    } catch (error) {
      log(`Agent skill ${file.path} not installed: ${errorMessage(error)}`);
    }
  }
  if (files.length > 0) {
    const skills = new Set(files.map((f) => f.path.split("/")[0])).size;
    log(
      `Agent skills: installed ${installed} of ${files.length} file(s) across ${skills} skill(s)`,
    );
  }
  return installed;
}
