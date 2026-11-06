/**
 * The offline half of the UI verification suite (see AGENTS.md, `lettuce-ui-verification`).
 *
 * `ui-check` and `screenshots` assert against the *running* app, so an assertion
 * whose selector matches nothing does not fail — it passes forever on an empty
 * result set. A redesign that deletes a class silently retires every assertion
 * written against it, and a `count() === 0` check on a class that no longer
 * exists is the worst case: provably always true, green in every CI tier. This
 * script is what catches that at the commit that deletes the class.
 *
 * Two kinds of claim are read out of the scripts and the UI skills:
 *
 *  - **`.class` selectors** inside quoted strings (`.rail .rail-agent.active` →
 *    three claims), which must be a class the app renders.
 *  - **`--token` design tokens** in backticks, which must be defined in the
 *    stylesheet.
 *
 * A dead selector inside a negative assertion (`... .count()) === 0`) is not a
 * hard failure — it is a vacuous check to delete, reported as a warning with the
 * assertion's own label so the next person deletes the right line. A dead
 * selector anywhere else fails: the assertion it feeds is not measuring what it
 * claims.
 *
 * Usage: bun scripts/check-ui-claims.ts
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const SCRIPTS = ["scripts/ui-check.ts", "scripts/screenshots.ts", "scripts/signin-screens.ts"];
const SKILL_GLOB = ".agents/skills";
const WEB_DIR = "web/src";

/**
 * CLI flags that wear a CSS custom property's clothes (`--no-sandbox`,
 * `--window-size`). Headless-chromium recipes appear in both scripts and the
 * UI skills, so the skip list is shared.
 */
const NOT_A_TOKEN = new Set([
  "no-sandbox",
  "disable-gpu",
  "hide-scrollbars",
  "window-size",
  "user-data-dir",
  "screenshot",
  "timeout",
  "lang",
  "type",
  "size",
  "ui",
  "confirmed",
  "docs",
  "patch",
  "force",
  "json",
]);

/**
 * File-extension keys (`".js"`, `".woff2"`) wear a class selector's clothes. A
 * static asset list is the one place a script quotes a leading-dot word that is
 * not a selector, so the list lives here rather than in the app.
 */
const NOT_A_CLASS = new Set([
  "js",
  "css",
  "json",
  "png",
  "svg",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "map",
  "webmanifest",
  "html",
  "txt",
  "wasm",
  // Output-directory names that are quoted like a selector (`.ui-check`).
  "ui-check",
]);

interface Claim {
  token: string;
  /** Where the claim was made, `file:line`. */
  at: string;
  /** A leading dot means it was read out of a selector string. */
  selector: boolean;
  /** The assertion this claim feeds looks like a "must NOT be there" check. */
  negative: boolean;
}

const problems: string[] = [];
const warnings: string[] = [];

/** Every class name and CSS custom property the app actually defines. */
function readWebCorpus(): { classes: Set<string>; tokens: Set<string> } {
  const classes = new Set<string>();
  const tokens = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
        continue;
      }
      if (!/\.(tsx?|css)$/.test(entry.name)) continue;
      const isCss = entry.name.endsWith(".css");
      const text = readFileSync(full, "utf8");
      // JSX `className="a b"` / `className={"a"}`, template-built class lists,
      // and CSS rule selectors — one flat vocabulary, matching the loose way a
      // selector can be assembled in a script.
      for (const m of text.matchAll(/class(?:Name)?\s*=\s*[{"'`]([^"}'`]*)/g)) {
        for (const word of (m[1] ?? "").split(/[\s{}]+/)) {
          const name = word.trim();
          if (/^[a-z][a-z0-9-]*$/.test(name)) classes.add(name);
        }
      }
      for (const m of text.matchAll(/classList\.(?:add|toggle|remove)\(\s*["'`]([a-z0-9-]+)/g)) {
        classes.add(m[1]!);
      }
      for (const m of text.matchAll(/className=\{`([^`]*)`\}/g)) {
        for (const word of (m[1] ?? "").split(/[\s${}]+/)) {
          const name = word.trim();
          if (/^[a-z][a-z0-9-]*$/.test(name)) classes.add(name);
        }
      }
      // `.foo` shaped text is only a class rule inside the stylesheet. Over .ts/.tsx
      // it registers property accesses (`state.again`) and extensions in comments
      // (`.pdf`), and a vocabulary padded with common words is a silent false pass
      // for a deleted class that happens to share one.
      if (isCss) {
        for (const m of text.matchAll(/\.([a-z][a-z0-9-]*)\s*[,{:\s]/g)) classes.add(m[1]!);
      }
      for (const m of text.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)) tokens.add(m[1]!);
    }
  };
  walk(join(ROOT, WEB_DIR));
  return { classes, tokens };
}

/** `file:line` claims pulled out of one file's text. */
function claimsIn(path: string, text: string, skill: boolean): Claim[] {
  const out: Claim[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const at = `${path}:${i + 1}`;
    // A comment line documents the app; it does not claim anything the app must
    // satisfy. (Its prose is the claim-level sweep's job, not this one's.)
    const code = line.replace(/^\s*(\/\/|\*)+\s?/, "");
    if (code !== line) return;
    // A negative assertion is decided by the claim's OWN line, never by a window
    // of neighbours: the label above a `check(` often says "nothing else appeared",
    // and a nearby `count() === 0` from the previous assertion is not this one's
    // business. Reading a window downgraded dead-positive assertions to a warning,
    // which is the exact bug this script exists to catch.
    const negative =
      /\.count\(\)\)?\s*===?\s*0\b|\.count\(\)\)?\s*<\s*1\b|not\.exists|length\s*===?\s*0\b|===?\s*false\b|==\s*null\b/.test(
        line,
      ) || /\b(must be gone|no longer|must be absent|is gone)\b/i.test(line);

    // CSS custom properties in backticks (docs voice) or in a `var(--)` call.
    for (const m of line.matchAll(/`--([a-z][a-z0-9-]*)`|var\(\s*--([a-z][a-z0-9-]*)/g)) {
      const name = m[1] ?? m[2]!;
      if (NOT_A_TOKEN.has(name)) continue;
      out.push({ token: `--${name}`, at, selector: false, negative: false });
    }
    if (skill) {
      // A skill names a class as a claim only in its backtick form.
      for (const m of line.matchAll(/`\.([a-z][a-z0-9-]*)`/g)) {
        out.push({ token: m[1]!, at, selector: true, negative: false });
      }
      return;
    }
    // Selector strings: every `.foo` segment of a string whose every
    // space-separated segment starts with a dot. That requirement is what keeps
    // `foo.png`, `a.join(b)` and prose out of the claim set.
    for (const m of line.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
      // `.some("…")` and friends: a quoted string reached through a member call
      // is an argument, not a selector.
      if ((line[Math.max(0, m.index ?? 1) - 1] ?? "") === ".") continue;
      const body = (m[1] ?? "").trim();
      if (!body.startsWith(".") || body.length < 3) continue;
      const segs = body.split(/\s+/);
      // A path (`../.ui-check/`) is not a selector list.
      if (segs.some((s) => s.includes("/"))) continue;
      if (!segs.every((s) => s.startsWith("."))) continue;
      for (const seg of segs) {
        const base = seg.split(/[:[]/)[0] ?? "";
        for (const c of base.matchAll(/\.([a-z][a-z0-9-]*)/g)) {
          if (NOT_A_CLASS.has(c[1]!)) continue;
          out.push({ token: c[1]!, at, selector: true, negative });
        }
      }
    }
  });
  return out;
}

const { classes, tokens } = readWebCorpus();

const files: { path: string; skill: boolean }[] = SCRIPTS.map((path) => ({ path, skill: false }));
for (const dir of readdirSync(join(ROOT, SKILL_GLOB), { withFileTypes: true })) {
  if (!dir.isDirectory() || !/^lettuce-ui-/.test(dir.name)) continue;
  files.push({ path: `${SKILL_GLOB}/${dir.name}/SKILL.md`, skill: true });
}

const claims: Claim[] = [];
for (const { path, skill } of files) {
  const abs = join(ROOT, path);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    problems.push(`${path}: missing — the checker's own input list is stale`);
    continue;
  }
  claims.push(...claimsIn(path, readFileSync(abs, "utf8"), skill));
}

const dead = new Map<string, Claim[]>();
for (const claim of claims) {
  const known = claim.token.startsWith("--") ? tokens.has(claim.token) : classes.has(claim.token);
  if (known) continue;
  if (!dead.has(claim.token)) dead.set(claim.token, []);
  dead.get(claim.token)!.push(claim);
}

for (const [token, seen] of [...dead].sort()) {
  const where = seen.map((c) => c.at).join(", ");
  if (seen.every((c) => c.selector && c.negative)) {
    warnings.push(
      `${token}: matches nothing in ${WEB_DIR}, and every claim on it is a "must be absent" ` +
        `assertion (${where}) — that check is vacuously true and can never fail; delete it`,
    );
    continue;
  }
  problems.push(
    `${token}: cited at ${where} but no such ${token.startsWith("--") ? "token" : "class"} exists in ${WEB_DIR}`,
  );
}

if (warnings.length > 0) {
  console.log(`\n  ! vacuous UI assertions (${warnings.length}):`);
  for (const w of warnings) console.log(`    ${w}`);
}

if (problems.length > 0) {
  console.log(`\n✗ UI claim check FAILED (${problems.length}):`);
  for (const p of problems) console.log(`    ${p}`);
  process.exit(1);
}

console.log(
  `✓ UI claims green — ${claims.length} selectors/tokens from ${files.length} files against ` +
    `${classes.size} classes / ${tokens.size} tokens in ${WEB_DIR}` +
    (warnings.length > 0 ? ` (${warnings.length} vacuous, above)` : ""),
);
