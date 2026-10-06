/**
 * Asserts the engineering guide and the skills stay honest.
 *
 * `AGENTS.md` is in every session's context, and the moment a pointer in it is
 * stale an agent burns a turn chasing a file that is not there. Everything here
 * is an assertion, not a suggestion:
 *
 *   - `AGENTS.md` is the context file, `CLAUDE.md` is a symlink to it, and the
 *     whole guide stays inside its context budget.
 *   - every `docs/x.md#anchor` reference in the guide, the skills and the docs
 *     resolves to a real heading (GitHub's slug rules).
 *   - every relative markdown link resolves to a file that exists.
 *   - every repo path mentioned in the guide or a skill exists.
 *   - every `bun run <name>` in the guide is a real script.
 *   - every skill has valid frontmatter — one a real YAML parser accepts, not just
 *     the regexes here — and is named in the guide so it is actually discoverable.
 *
 * Usage: bun scripts/check-docs.ts [--print-size]
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

/**
 * The always-loaded guide's budget. It moved ~46 KB of task-scoped mechanics to
 * `.agents/skills/` on 2026-10-02 (from 81 KB to ~35 KB), and on 2026-10-05 the prose that
 * duplicated a skill description, an incident narrative already in `docs/upstream-notes.md`, or a
 * gate that already enforces the rule came down to ~28 KB. This number is that state plus room to
 * grow, not a target to fill. Raise it deliberately and say what you added.
 */
// The always-loaded guide's context budget. ~7k tokens; raise only by deleting something else,
// not by declaring the new size acceptable.
const SIZE_BUDGET_BYTES = 30_000;

const GUIDE = "AGENTS.md";

/** Files whose prose references get the anchor and path checks. */
const SCANNED = [
  "AGENTS.md",
  "README.md",
  "CHANGELOG.md",
  "docs/upstream-notes.md",
  "docs/CONFIGURATION.md",
];
for (const dir of [".agents/skills", ".pi/prompts"]) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    // Skills are directories with a SKILL.md; prompt templates are flat .md files.
    // Both are harness prose every session reads, so both get the same checks.
    const file = entry.isDirectory()
      ? join(dir, entry.name, "SKILL.md")
      : entry.isFile() && entry.name.endsWith(".md")
        ? join(dir, entry.name)
        : "";
    if (file && existsSync(join(ROOT, file))) SCANNED.push(file);
  }
}

/** Paths that are legitimately absent: gitignored, generated, or inside the container. */
const ABSENT_OK = [
  "docker/.env",
  "docker/secrets/",
  "node_modules/",
  "web/dist/",
  "dist/",
  ".ui-check/",
  "web/dist",
  ".pi/remote-pi",
  ".pi/npm/",
  ".pi/sessions/",
  ".pi/settings.json",
  ".pi/skills/",
  ".pi/goals/",
  ".pi/plans/",
  ".claude/",
];

const failures: string[] = [];
const notes: string[] = [];

function check(ok: boolean, label: string, detail?: string) {
  if (!ok) failures.push(detail ? `${label} — ${detail}` : label);
}

/**
 * Is this frontmatter value a scalar a real YAML parser will read as a string?
 *
 * Pi parses `SKILL.md` frontmatter with the `yaml` package, and a plain (unquoted)
 * YAML scalar may not contain `": "` — `description: a: b` is a nested mapping,
 * which errors out as "Nested mappings are not allowed in compact mappings" and
 * drops the *whole file*: pi loads no skill from it, with no warning in the UI.
 * On 2026-10-04 that silently killed all twelve `lettuce-*` skills at once, while
 * the regex below happily read the description back out. Quote the value (single
 * quotes, doubling any `'`) when it needs a colon.
 */
function isYamlScalar(value: string): boolean {
  if (value === "") return true;
  if (value[0] === "'" || value[0] === '"') return true; // quoted: colons are inert inside
  // Anchors, aliases, block scalars and flow collections are not plain scalars.
  if ("[&*!|>`{[".includes(value[0])) return false;
  return !value.includes(": ") && !value.endsWith(":");
}

/** GitHub's anchor rules: lowercase, drop punctuation, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function headingsOf(text: string): Set<string> {
  const set = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (match?.[1]) set.add(slug(match[1]));
  }
  return set;
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf-8");
}

// ---------------------------------------------------------------- guide shape

const guidePath = join(ROOT, GUIDE);
check(existsSync(guidePath), `${GUIDE} exists`);
let guideText = "";
if (existsSync(guidePath)) {
  guideText = read(GUIDE);
  const size = Buffer.byteLength(guideText);
  check(
    size <= SIZE_BUDGET_BYTES,
    `${GUIDE} is inside its context budget (${size} of ${SIZE_BUDGET_BYTES} bytes)`,
    `${size - SIZE_BUDGET_BYTES} bytes over. Move task-scoped mechanics into .agents/skills/.`,
  );
  const claude = join(ROOT, "CLAUDE.md");
  const isSymlink = existsSync(claude) && lstatSync(claude).isSymbolicLink();
  check(
    isSymlink && realpathSync(claude) === realpathSync(guidePath),
    "CLAUDE.md is a symlink to AGENTS.md",
    "Pi loads the first of AGENTS.md / CLAUDE.md per directory, so two real files means one " +
      "silently wins. Keep CLAUDE.md a symlink.",
  );
}

// ------------------------------------------------------------------- anchors

const anchors = new Map<string, Set<string>>();
function headings(file: string): Set<string> | null {
  const abs = join(ROOT, file);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  if (!anchors.has(file)) anchors.set(file, headingsOf(read(file)));
  return anchors.get(file) ?? null;
}

/** `docs/x.md#anchor`, `../../../docs/x.md#anchor`, `[text](x.md#anchor)`. */
const MD_REF =
  /(?:\.\.?\/|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.<>{}*-]+)*\/)?([A-Za-z0-9_.-]+\.md)(#([a-zA-Z0-9_-]+))?/g;

/** Bare `persona.md`-style mentions of files that are not ours to check. */
function looksLikeOurDoc(from: string, full: string): boolean {
  if (full.startsWith("./") || full.startsWith("../")) return true;
  const first = full.split("/")[0] ?? "";
  if (
    ["docs", "docker", "bff", "web", "scripts", ".agents", ".pi"].includes(first) ||
    ["README.md", "AGENTS.md", "CHANGELOG.md"].includes(full)
  ) {
    return true;
  }
  // A relative link written from a skill or prompt two levels down.
  return existsSync(resolve(dirname(join(ROOT, from)), full.split("#")[0] ?? full));
}

for (const from of SCANNED) {
  if (!existsSync(join(ROOT, from))) continue;
  const text = read(from);
  for (const match of text.matchAll(MD_REF)) {
    const [, file, , anchor] = match;
    if (!file) continue;
    const full = match[0];
    if (/node_modules|letta-code|package\.json/.test(full)) continue;
    if (/[*<>{}]/.test(full)) continue; // a glob or template path, e.g. lettuce-*/SKILL.md
    // A match that starts mid-token (`.agents/skills/lettuce-*/SKILL.md`) is part
    // of a glob or template, not a reference to one file.
    const before = text[(match.index ?? 0) - 1];
    if (before === "/" || before === "*" || before === "<") continue;
    if (!looksLikeOurDoc(from, full)) continue;
    // References are either relative to the file or root-relative; try both.
    const bare = (full.split("#")[0] ?? full) || ".";
    const target = [resolve(dirname(join(ROOT, from)), bare), resolve(ROOT, bare)].find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    );
    if (!target) {
      failures.push(`${from}: references ${full}, which does not exist`);
      continue;
    }
    if (!anchor) continue;
    const rel = relative(ROOT, target).split(sep).join("/");
    const known = headings(rel);
    check(
      known?.has(anchor) ?? false,
      `${from}: anchor #${anchor} resolves in ${file}`,
      known ? `headings there: ${[...known].slice(0, 8).join(", ")}…` : `${file} is unreadable`,
    );
  }
}

// ------------------------------------------------------- relative md links []()

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
for (const from of SCANNED) {
  if (!existsSync(join(ROOT, from))) continue;
  for (const match of read(from).matchAll(LINK)) {
    const href = match[1] ?? "";
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const [path, anchor] = href.split("#");
    if (!path) continue;
    const target = resolve(dirname(join(ROOT, from)), path);
    check(existsSync(target), `${from}: link ${href} points at a file`);
    if (anchor && existsSync(target)) {
      const rel = relative(ROOT, target).split(sep).join("/");
      check(headings(rel)?.has(anchor) ?? false, `${from}: link ${href} points at a heading`);
    }
  }
}

// -------------------------------------------------------------- repo paths

/**
 * Only slash-bearing paths are checked. A bare `turn-errors.ts` is a name, not
 * a path, and half of them live in the container or upstream.
 */
const PATH_REF = /`((?:bff|web|docker|docs|scripts|\.pi|\.agents)\/[A-Za-z0-9_./*{}<>-]*)`/g;

for (const from of SCANNED) {
  if (!existsSync(join(ROOT, from))) continue;
  const text = read(from);
  const seen = new Set<string>();
  for (const match of text.matchAll(PATH_REF)) {
    const path = match[1] ?? "";
    if (seen.has(path)) continue;
    seen.add(path);
    if (/[<>*{}]/.test(path)) continue; // template or glob, not one path
    if (ABSENT_OK.some((prefix) => path.startsWith(prefix))) continue;
    if (path.startsWith("letta-code/")) continue; // the read-only upstream checkout
    if (path === "SKILL.md") continue;
    const exists =
      existsSync(join(ROOT, path)) ||
      existsSync(join(ROOT, path, "index.ts")) ||
      // `connection-lifecycle.ts` style mentions of files we name but do not own.
      existsSync(join(ROOT, "letta-code", path));
    check(exists, `${from}: path ${path} does not exist`);
  }
}

// ------------------------------------------------------------- commands table

const scripts = new Set(
  Object.keys(JSON.parse(read("package.json")).scripts as Record<string, string>),
);
for (const from of SCANNED) {
  if (!existsSync(join(ROOT, from))) continue;
  for (const match of read(from).matchAll(/bun run ([a-z][a-z-]+)/g)) {
    const name = match[1];
    if (!name) continue;
    check(scripts.has(name), `${from}: bun run ${name} is a real script`);
  }
}

/**
 * The other direction: a real script the guide never mentions.
 *
 * `bun run check-release-hygiene` enforced the changelog rule for weeks before `AGENTS.md` named
 * it, which is how a gate becomes folklore — the rule survives in prose while nobody reads the
 * tool that enforces it. The self-explanatory ones are exempt because a row would only restate the
 * name; everything else owes one.
 */
const COMMANDS_EXEMPT = new Set([
  "lint",
  "format",
  "typecheck",
  "test",
  "build",
  "dev",
  "build-info",
  "screenshots",
]);
for (const name of scripts) {
  if (COMMANDS_EXEMPT.has(name)) continue;
  check(
    guideText.includes(name),
    `${GUIDE}: mentions bun run ${name}`,
    "add a row to the Commands table, or add the name to COMMANDS_EXEMPT in scripts/check-docs.ts " +
      "if the name says everything",
  );
}

// ------------------------------------------------------------------- skills

const skillDirs = readdirSync(join(ROOT, ".agents/skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

check(skillDirs.length > 0, "at least one skill exists");
for (const dir of skillDirs) {
  const file = `.agents/skills/${dir}/SKILL.md`;
  const text = read(file);
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  check(!!front, `${file}: has frontmatter`);
  if (!front) continue;
  const name = /^name:\s*(.+)$/m.exec(front[1] ?? "")?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(front[1] ?? "")?.[1]?.trim();
  check(name === dir, `${file}: name matches its directory`, `name: ${name}`);
  check(!!description && description.length > 40, `${file}: has a real description`);
  check(
    !!description && description.length <= 1024,
    `${file}: description is within pi's 1024-character limit`,
    `${description?.length ?? 0} chars`,
  );
  // Every key must be a scalar pi's YAML parser will accept, not just one the
  // regex above can pull out of the raw text.
  for (const line of (front[1] ?? "").split("\n")) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line.trim());
    if (!kv) continue;
    check(
      isYamlScalar(kv[2]?.trim() ?? ""),
      `${file}: ${kv[1]} is a YAML scalar`,
      "an unquoted `: ` fails the whole file to parse and the skill never loads — quote the value",
    );
  }
  check(
    guideText.includes(dir),
    `${file}: is named in ${GUIDE}`,
    "an unreferenced skill is invisible to the index table",
  );
}

// --------------------------------------------------------------------- report

if (existsSync(join(ROOT, GUIDE))) {
  const size = Buffer.byteLength(guideText);
  notes.push(
    `${GUIDE}: ${(size / 1024).toFixed(1)} KB of ~${(size / 4 / 1024).toFixed(1)}k tokens, ` +
      `budget ${(SIZE_BUDGET_BYTES / 1024).toFixed(0)} KB; ${skillDirs.length} skills in .agents/skills/`,
  );
}

if (process.argv.includes("--print-size")) {
  for (const note of notes) console.log(note);
}

if (failures.length > 0) {
  console.log(`\n✗ check-docs found ${failures.length} problem(s):`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}

console.log(`✓ docs check green — ${notes.join("; ")}`);
