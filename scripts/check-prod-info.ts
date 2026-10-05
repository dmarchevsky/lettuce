/**
 * The repo is public: prod is referred to by name only.
 *
 * Everything about the production host — its address, its Dockhand ids, the LAN address of a dev
 * box, the owner's mail address — is recon value for nobody who is already allowed in, and a
 * permanent leak once this tree is public. None of it belongs in a tracked file: `dockhand.sh
 * stacks letta` answers the prod questions at release time, and `docker/.env` (gitignored) is
 * where any address or address-like value actually used at runtime lives.
 *
 * Two classes are fatal anywhere in the tree: RFC 1918 addresses (10/8, 172.16/12, 192.168/16) and
 * personal mail domains. Use RFC 5737's documentation ranges (192.0.2.0/24, 198.51.100.0/24,
 * 203.0.113.0/24) in examples and tests instead — they read as real addresses and are reserved
 * from ever being routable.
 *
 * Matches are reported masked, so running this script cannot itself paste a finding into a log,
 * a screenshot or a session transcript. A line may be exempted with a trailing
 * `check-prod-info: allow` comment (there are none today).
 *
 * Usage: bun scripts/check-prod-info.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

interface Pattern {
  label: string;
  regex: RegExp;
}

const PATTERNS: Pattern[] = [
  {
    label: "private (RFC 1918) IPv4 address",
    regex:
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
  },
  {
    label: "personal mail address",
    regex:
      /\b[\w.+-]+@(?:gmail|googlemail|outlook|hotmail|live|msn|icloud|mac)\.com\b|\b[\w.+-]+@me\.com\b|\b[\w.+-]+@proton(?:mail)?\.(?:com|me)\b|\b[\w.+-]+@yandex\.(?:com|ru)\b|\b[\w.+-]+@yahoo\.[a-z.]{2,4}\b/i,
  },
];

/**
 * `bff/src/google/fixtures/` holds recorded `tools/list` output from the pinned workspace-mcp
 * image; it is reproducible upstream output, not something to hand-edit, and its sample text
 * carries a made-up personal mail address.
 */
const EXEMPT_PATHS = ["bff/src/google/fixtures/"];

/** Nothing binary or generated-by-the-package-manager. */
const SKIP_SUFFIXES = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".pdf",
  ".map",
  ".lock",
  ".svg",
];

function trackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  if (result.exitCode !== 0) {
    console.error("git ls-files failed — is this a git checkout?");
    process.exit(1);
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((file) => file.length > 0);
}

/** Keep the finding, hide the value: `192.0.2.10` → `19…`, `a***@gmail.com` → `a***@gmail.com`. */
function mask(match: string): string {
  const at = match.indexOf("@");
  if (at > 0) return `${match.slice(0, 1)}***${match.slice(at)}`;
  return `${match.slice(0, 2)}…`;
}

const failures: string[] = [];
let scanned = 0;

for (const file of trackedFiles()) {
  if (EXEMPT_PATHS.some((prefix) => file.startsWith(prefix))) continue;
  if (SKIP_SUFFIXES.some((suffix) => file.endsWith(suffix))) continue;

  let text: string;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue; // deleted-but-tracked, a broken symlink, an unreadable path
  }
  if (text.includes("\0")) continue; // binary that is not on the skip list

  scanned++;
  for (const [index, line] of text.split("\n").entries()) {
    if (line.includes("check-prod-info: allow")) continue;
    for (const pattern of PATTERNS) {
      const found = line.match(pattern.regex);
      if (found) {
        failures.push(`${file}:${index + 1}: ${pattern.label} — ${mask(found[0])}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(
    `\n✗ check-prod-info found ${failures.length} problem(s) in a public repo ` +
      `(scanned ${scanned} tracked files):\n`,
  );
  for (const failure of failures.slice(0, 30)) console.error(`  - ${failure}`);
  if (failures.length > 30) console.error(`  … and ${failures.length - 30} more`);
  console.error(
    "\n  Values like these belong in docker/.env (gitignored) or in a live query\n" +
      "  (`dockhand.sh stacks letta`). In docs and tests, use RFC 5737 documentation\n" +
      "  ranges (192.0.2.0/24) instead of a real LAN address.\n",
  );
  process.exit(1);
}

console.log(`✓ prod-info check green — ${scanned} tracked files, no private addresses or mail`);
