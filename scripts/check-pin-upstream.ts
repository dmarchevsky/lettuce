/**
 * Reports how far behind each upstream pin is. A report, never a gate.
 *
 * `check-version-pin.ts` proves every copy of a pin agrees. It says nothing about
 * whether the pin is *current*, and that half used to be a manual sweep of four
 * registries by hand — the sweep that turns "check upstream" into a whole session.
 * This is that sweep, kept.
 *
 * Two things it exists to catch, both of which bit for real:
 *
 *  1. **npm is not the newest image.** Docker Hub publishes `letta/letta` only for
 *     some releases (0.34.22 and 0.34.23 were on npm with no image at all), so the
 *     npm version is not a legal sync target and the newest one is. The sync refuses
 *     to pin what it cannot pull, so the only useful question is "what is the newest
 *     release that has both", and that is what this prints first.
 *  2. **A pin can be current and still need a bump.** `WORKSPACE_MCP_VERSION` has a
 *     recorded `tools/list` fixture per version, so it never moves on its own.
 *     Columns exist so a human sees it rather than learns it later.
 *
 * Network-dependent by nature: it exits 0 with a warning when a registry is
 * unreachable, because being offline is not being out of date.
 *
 * Usage: bun scripts/check-pin-upstream.ts
 */

const ROOT = new URL("..", import.meta.url).pathname;

type Source =
  | { kind: "npm"; pkg: string }
  | { kind: "pypi"; pkg: string }
  | { kind: "docker"; image: string }
  | { kind: "github"; repo: string };

interface Pin {
  name: string;
  /** Where the literal lives, for the human who has to move it. */
  where: string;
  pattern: RegExp;
  source: Source;
  /** Anything a plain "latest" comparison cannot say. */
  note?: string;
}

const PINS: Pin[] = [
  {
    name: "LETTA_CODE_VERSION",
    where: "docker/compose.yml (+ package.json, web/package.json, docs)",
    pattern: /LETTA_CODE_VERSION:\s*\$\{LETTA_CODE_VERSION:-([^}]+)\}/,
    source: { kind: "docker", image: "letta/letta" },
    note: "sync target = newest tag with BOTH an image and an npm package; bun run sync-upstream v<x.y.z>",
  },
  {
    name: "CODEX_VERSION",
    where: "docker/compose.yml (app-server build args)",
    pattern: /CODEX_VERSION:\s*\$\{CODEX_VERSION:-([^}]+)\}/,
    source: { kind: "npm", pkg: "@openai/codex" },
    note: "the shim in docker/codex speaks its app-server protocol; re-run a worker after a bump",
  },
  {
    name: "CLAUDE_CODE_VERSION",
    where: "docker/compose.yml (app-server build args)",
    pattern: /CLAUDE_CODE_VERSION:\s*\$\{CLAUDE_CODE_VERSION:-([^}]+)\}/,
    source: { kind: "npm", pkg: "@anthropic-ai/claude-code" },
    note: "npm's `latest` is the channel we follow (this package's `stable` tag trails it on purpose); the shim depends on its stream-json flags and `auth status --json` shape, so re-run a worker after a bump",
  },
  {
    name: "WORKSPACE_MCP_VERSION",
    where: "docker/compose.yml (google-mcp)",
    pattern: /WORKSPACE_MCP_VERSION:\s*\$\{WORKSPACE_MCP_VERSION:-([^}]+)\}/,
    source: { kind: "pypi", pkg: "workspace-mcp" },
    note: "a bump must re-record bff/src/google/fixtures/workspace-mcp-<v>.{full,readonly}.json",
  },
  {
    name: "DDG_MCP_VERSION",
    where: "docker/compose.yml (ddg-mcp)",
    pattern: /DDG_MCP_VERSION:\s*\$\{DDG_MCP_VERSION:-([^}]+)\}/,
    source: { kind: "pypi", pkg: "duckduckgo-mcp-server" },
  },
  {
    name: "SEARXNG_VERSION",
    where: "docker/compose.yml (searxng)",
    pattern: /SEARXNG_VERSION:\s*\$\{SEARXNG_VERSION:-([^}]+)\}/,
    source: { kind: "docker", image: "searxng/searxng" },
    note: "dated image tags; `latest` is the moving one",
  },
  {
    name: "GH_VERSION",
    where: "docker/compose.yml (app-server build args)",
    pattern: /GH_VERSION:\s*\$\{GH_VERSION:-([^}]+)\}/,
    source: { kind: "github", repo: "cli/cli" },
  },
  {
    name: "CLOUDFLARED_VERSION",
    where: "docker/compose.yml (cloudflared)",
    pattern: /CLOUDFLARED_VERSION:\s*\$\{CLOUDFLARED_VERSION:-([^}]+)\}/,
    source: { kind: "github", repo: "cloudflare/cloudflared" },
  },
];

interface Remote {
  latest: string;
  /** Extra colour: how many releases newer, or why "latest" is not the answer. */
  detail?: string;
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function isSemverish(tag: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(tag.replace(/^v/, ""));
}

function compare(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[.\-_]/)
      .map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest tag Docker Hub has, newest-first, for images whose tags are releases. */
async function dockerTags(image: string): Promise<string[]> {
  const data = (await getJson(
    `https://hub.docker.com/v2/repositories/${image}/tags?page_size=100&ordering=last_updated`,
  )) as { results?: { name: string }[] };
  return (data.results ?? []).map((t) => t.name);
}

async function latestFor(source: Source): Promise<Remote> {
  switch (source.kind) {
    case "npm": {
      const data = (await getJson(
        `https://registry.npmjs.org/${source.pkg.replaceAll("/", "%2F")}/latest`,
      )) as { version?: string };
      if (!data.version) throw new Error("no version in the npm answer");
      return { latest: data.version };
    }
    case "pypi": {
      const data = (await getJson(`https://pypi.org/pypi/${source.pkg}/json`)) as {
        info?: { version?: string };
      };
      if (!data.info?.version) throw new Error("no version in the PyPI answer");
      return { latest: data.info.version };
    }
    case "github": {
      const data = (await getJson(`https://api.github.com/repos/${source.repo}/releases/latest`, {
        headers: { accept: "application/vnd.github+json" },
      })) as { tag_name?: string };
      if (!data.tag_name) throw new Error("no tag in the GitHub answer");
      return { latest: data.tag_name };
    }
    case "docker": {
      const tags = await dockerTags(source.image);
      if (tags.length === 0) throw new Error("no tags on Docker Hub");
      const releases = tags.filter((t) => t !== "latest" && isSemverish(t));
      const newest = releases.sort((a, b) => compare(b, a))[0];
      if (!newest) return { latest: tags[0] ?? "?" };
      // letta/letta publishes every other day; say so rather than imply npm's tip.
      const skipped = tags.filter((t) => t !== "latest" && !isSemverish(t)).length;
      return {
        latest: newest,
        detail: skipped ? `${skipped} non-release tag(s) beside it` : undefined,
      };
    }
  }
}

/**
 * letta-code: the npm package document, fetched at most once. The full doc (not
 * `/latest`) is what carries every version, and the same answer serves both the
 * sync target and npm's tip — two numbers, one request.
 */
let lettaDoc: Promise<{
  tip: string | null;
  versions: string[];
}> | null = null;
function lettaNpm(): Promise<{ tip: string | null; versions: string[] }> {
  lettaDoc ??= getJson("https://registry.npmjs.org/@letta-ai%2Fletta-code")
    .then((raw) => {
      const data = raw as { "dist-tags"?: { latest?: string }; versions?: Record<string, unknown> };
      return {
        tip: data["dist-tags"]?.latest ?? null,
        versions: Object.keys(data.versions ?? {})
          .filter(isSemverish)
          .sort((a, b) => compare(b, a)),
      };
    })
    .catch(() => ({ tip: null, versions: [] }));
  return lettaDoc;
}

/** The newest letta-code that can actually be pinned: an image AND an npm package. */
async function lettaSyncTarget(imageLatest: string): Promise<string> {
  const { tip, versions } = await lettaNpm();
  // Anything above the newest image cannot be pulled, so the image list bounds it.
  return versions.filter((v) => compare(v, imageLatest) <= 0)[0] ?? tip ?? imageLatest;
}

interface Row {
  name: string;
  pinned: string;
  latest: string;
  behind: boolean;
  detail?: string;
  note?: string;
  where: string;
}

const compose = await Bun.file(`${ROOT}docker/compose.yml`).text();
const rows: Row[] = [];
let offline = 0;

for (const pin of PINS) {
  const found = compose.match(pin.pattern);
  if (!found) {
    console.error(`check-pin-upstream: ${pin.name} not found in docker/compose.yml`);
    process.exitCode = 1;
    continue;
  }
  const pinned = found[1];
  try {
    const remote = await latestFor(pin.source);
    const latest = remote.latest.replace(/^v/, "");
    let detail = remote.detail;
    if (pin.source.kind === "docker" && pin.source.image === "letta/letta") {
      const target = await lettaSyncTarget(latest);
      const { tip } = await lettaNpm();
      if (target !== latest) {
        detail = `npm offers ${target} but the image stops at ${latest}`;
      } else if (tip && compare(tip, latest) > 0) {
        // npm's own tip is the honest "newest release", even without an image.
        detail = `npm is at ${tip} with no image yet`;
      }
    }
    const behind = compare(pinned, latest) < 0;
    rows.push({
      name: pin.name,
      pinned,
      latest,
      behind,
      detail,
      note: pin.note,
      where: pin.where,
    });
  } catch (error) {
    offline += 1;
    rows.push({
      name: pin.name,
      pinned,
      latest: "unreachable",
      behind: false,
      detail: error instanceof Error ? error.message : String(error),
      note: pin.note,
      where: pin.where,
    });
  }
}

const nameWidth = Math.max(...rows.map((r) => r.name.length));
const pinnedWidth = Math.max(...rows.map((r) => r.pinned.length));
console.log("upstream pin freshness (a report — nothing here fails a build)\n");
for (const row of rows) {
  const mark = row.behind ? "behind" : "current";
  console.log(
    `  ${row.name.padEnd(nameWidth)}  ${row.pinned.padEnd(pinnedWidth)} -> ${row.latest.padEnd(
      24,
    )} ${mark}${row.detail ? `  (${row.detail})` : ""}`,
  );
  if (row.behind && row.note)
    console.log(`  ${" ".repeat(nameWidth)}  ${" ".repeat(pinnedWidth)}      note: ${row.note}`);
}
console.log(
  rows.some((r) => r.behind)
    ? "\nBehind on purpose is fine; behind unnoticed is not. Every move is its own flow."
    : "\nEvery pin is at its newest.",
);
if (offline > 0) {
  console.log(`\n${offline} registry check(s) unreachable — offline, not out of date.`);
}
