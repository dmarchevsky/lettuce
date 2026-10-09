/**
 * Asserts every copy of the letta-code version literal agrees.
 *
 * The app-server image, the channel-gateway image and the protocol types the UI
 * compiles against must all be the SAME release, or the UI is typechecked
 * against one protocol and talks to another. The literal is repeated in six
 * tracked places and nothing used to check them — AGENTS.md said so outright
 * ("Nothing asserts they agree").
 *
 * `docker/.env` must not carry the key at all: Compose reads that file and its
 * value outranks the pin in `docker/compose.yml`, so a leftover there quietly
 * freezes the stack on an older release — that exact drift once sat unnoticed
 * through a whole release cycle. It is gitignored, so no one reading this repo
 * fresh can fix it, which is why a leftover is said out loud rather than failed
 * on: `bun run sync-upstream v<x.y.z>` deletes it wherever it finds one.
 *
 * Usage: bun scripts/check-version-pin.ts
 */

const ROOT = new URL("..", import.meta.url).pathname;

interface Site {
  file: string;
  label: string;
  pattern: RegExp;
  /** Reported, never fatal. */
  advisory?: boolean;
}

const SITES: Site[] = [
  // The app-server is built FROM letta/letta (docker/codex/Dockerfile), so its
  // literal lives in the build arg and in the local image tag. The
  // `(?:(?!^ {2}\S)…)` guard keeps each match inside the app-server block: a
  // plain lazy `[\s\S]*?` would run on into channel-gateway's image line and
  // report that one instead.
  {
    file: "docker/compose.yml",
    label: "compose app-server base image (build arg)",
    pattern:
      /^ {2}app-server:(?:(?!^ {2}\S)[\s\S])*?LETTA_CODE_VERSION:\s*\$\{LETTA_CODE_VERSION:-([0-9][^}]*)\}/m,
  },
  {
    file: "docker/compose.yml",
    label: "compose app-server image tag",
    pattern:
      /^ {2}app-server:(?:(?!^ {2}\S)[\s\S])*?image:\s*lettuce-app-server:\$\{LETTA_CODE_VERSION:-([0-9][^}]*)\}/m,
  },
  {
    file: "docker/compose.yml",
    label: "compose channel-gateway image",
    pattern:
      /^ {2}channel-gateway:[\s\S]*?image:\s*letta\/letta:\$\{LETTA_CODE_VERSION:-([0-9][^}]*)\}/m,
  },
  {
    file: "package.json",
    label: "root devDependency",
    pattern: /"@letta-ai\/letta-code":\s*"([^"]+)"/,
  },
  {
    file: "bff/package.json",
    label: "bff dependency",
    pattern: /"@letta-ai\/letta-code":\s*"([^"]+)"/,
  },
  {
    file: "web/package.json",
    label: "web dependency",
    pattern: /"@letta-ai\/letta-code":\s*"([^"]+)"/,
  },
  {
    // The user-facing defaults table in the docs. It states the compose default,
    // so a sync that missed it tells every reader the wrong version, and nothing
    // else reads that file to find out.
    file: "docs/CONFIGURATION.md",
    label: "docs defaults table",
    pattern: /`LETTA_CODE_VERSION` \| `([^`]+)`/,
  },
  {
    file: "docker/.env",
    label: "docker/.env (gitignored)",
    pattern: /^LETTA_CODE_VERSION=(.+)$/m,
    advisory: true,
  },
];

interface Found extends Site {
  version: string;
}

const found: Found[] = [];
const problems: string[] = [];

for (const site of SITES) {
  const text = await Bun.file(`${ROOT}${site.file}`)
    .text()
    .catch(() => null);

  if (text === null) {
    if (!site.advisory) problems.push(`${site.file}: not found`);
    continue;
  }

  const match = text.match(site.pattern);
  if (!match?.[1]) {
    if (!site.advisory) problems.push(`${site.file}: no ${site.label} found`);
    continue;
  }

  found.push({ ...site, version: match[1].trim() });
}

const authoritative = found.filter((site) => !site.advisory);
const versions = new Set(authoritative.map((site) => site.version));

for (const site of found) {
  const mark = site.advisory ? "!" : " ";
  console.log(`  ${mark} ${site.version.padEnd(12)} ${site.file}  (${site.label})`);
}

/**
 * The component pins, each written in every place it is used: a build arg, an
 * image tag, and (for what Settings → About can name) the BFF's own env.
 * Compose interpolates every `${NAME:-literal}` separately, so two literals that
 * disagree give one host an image and an About row that disagree, silently.
 * Same for the docs table, which is what a human reads before overriding one.
 */
const COMPONENT_VARS = [
  "CODEX_VERSION",
  "CLAUDE_CODE_VERSION",
  "GH_VERSION",
  "SEARXNG_VERSION",
  "WORKSPACE_MCP_VERSION",
  "DDG_MCP_VERSION",
  "CLOUDFLARED_VERSION",
];

const compose = await Bun.file(`${ROOT}docker/compose.yml`).text();
const docs = await Bun.file(`${ROOT}docs/CONFIGURATION.md`).text();
for (const name of COMPONENT_VARS) {
  const places: [string, string][] = [];
  for (const m of compose.matchAll(new RegExp(`\\$\\{${name}:-([^}]*)\\}`, "g"))) {
    places.push(["docker/compose.yml", m[1]]);
  }
  const doc = docs.match(new RegExp("`" + name + "` \\| `([^`]+)`"));
  if (doc) places.push(["docs/CONFIGURATION.md", doc[1]]);
  if (places.length === 0) {
    problems.push(`${name}: no pin found in docker/compose.yml`);
    continue;
  }
  const values = new Set(places.map(([, value]) => value));
  if (values.size > 1) {
    const byValue = new Map<string, string[]>();
    for (const [file, value] of places) byValue.set(value, [...(byValue.get(value) ?? []), file]);
    problems.push(
      `${name}: ${[...byValue]
        .map(([value, files]) => `${value} (${files.join(", ")})`)
        .join(" vs ")}`,
    );
    continue;
  }
  console.log(
    `    ${[...values][0].padEnd(16)} ${name} (${places.length} place${places.length > 1 ? "s" : ""})`,
  );
}

if (versions.size > 1) {
  problems.push(`pins disagree: ${[...versions].sort().join(" vs ")}`);
}

for (const site of found.filter((site) => site.advisory)) {
  console.log(
    `\n  ! ${site.file} sets LETTA_CODE_VERSION (${site.version}) and should not.` +
      `\n    Compose reads this file and its value outranks the pin in docker/compose.yml, so` +
      `\n    the build quietly takes the older of the two. Delete the line (or run` +
      `\n    \`bun run sync-upstream\`, which does), and pass an override in the environment` +
      `\n    instead if a host truly needs one.`,
  );
}

if (problems.length > 0) {
  console.log(`\n✗ version pin check FAILED`);
  for (const problem of problems) console.log(`    ${problem}`);
  process.exit(1);
}

console.log(`\n✓ letta-code pinned consistently at ${[...versions][0]}`);
