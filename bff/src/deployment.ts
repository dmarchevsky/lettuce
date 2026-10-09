/**
 * What this deployment runs, with the version of each — the list Settings → About
 * shows, built here so the browser never has to know which sidecar a profile
 * token runs, or which of the versions it could only echo is a lie.
 *
 * Each version comes from wherever it can actually be read:
 * - letta-code reports its own over the protocol, on the hello frame;
 * - the coding CLIs report theirs from inside the image at build time, written
 *   to the marker (`docker/codex/Dockerfile`), because a stale image disproves
 *   whatever pin compose was told;
 * - a sidecar has no version endpoint and the BFF cannot read Compose, so compose
 *   hands over the same literal that picks its tag (`pinVersions`).
 *
 * A component whose token is off has no row: something that does not exist has no
 * version worth showing. A token that is ON says `not installed` when the image
 * has no CLI in it, and `unknown` when the image predates versioned markers —
 * that mismatch is the whole reason the marker exists.
 */

/** Where the app-server image records what it installed. */
export const CODING_MARKER_PATH = "/opt/lettuce/features";
export const CODING_MARKER_LEGACY_PATH = "/opt/letta-ui/features";

export interface CodingMarker {
  names: string[];
  /** Name to the version the CLI answered for `--version`; absent on an old marker. */
  versions: Map<string, string>;
}

/**
 * One `<name> <version>` per line. The version is optional because an image built
 * before the marker carried versions has bare names, and reading a missing one as
 * "unknown" is what keeps an old image working instead of guessing.
 */
export function parseCodingMarker(text: string): CodingMarker {
  const names: string[] = [];
  const versions = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [name, version] = line.trim().split(/\s+/);
    if (!name) continue;
    names.push(name);
    if (version) versions.set(name, version);
  }
  return { names, versions };
}

export interface Component {
  name: string;
  version: string;
}

export interface DeploymentInput {
  features: { web: boolean; google: boolean; codex: boolean; claude: boolean };
  /** Whether the tunnel container exists here, i.e. `mode === "cloudflared"`. */
  tunnel: boolean;
  pinVersions: { searxng: string; googleMcp: string; cloudflared: string };
  marker: CodingMarker | null;
  /** What the app-server said for `letta_code_version`, null before its hello. */
  lettaCodeVersion: string | null;
}

/** The rows, in display order. Anything unmeasurable is left out, not zeroed. */
export function deploymentComponents(input: DeploymentInput): Component[] {
  const marker = input.marker;
  const rows: Component[] = [];
  if (input.lettaCodeVersion) rows.push({ name: "letta-code", version: input.lettaCodeVersion });
  const cli = (on: boolean, key: string, label: string) => {
    if (!on) return;
    // Three honest answers, because there are three states: the marker said a
    // version, it said only the name (an image built before it carried versions,
    // which is what a production host has until its next app-server rebuild), or
    // the CLI is genuinely not in the image. Saying "not installed" for the
    // middle one would send someone off to rebuild an image that is fine.
    const version =
      marker?.versions.get(key) ?? (marker?.names.includes(key) ? "unknown" : "not installed");
    rows.push({ name: label, version });
  };
  cli(input.features.codex, "codex", "Codex CLI");
  cli(input.features.claude, "claude", "Claude Code CLI");
  // Always installed in the image (letta-code's WatchPR shells out to it), so it
  // rides on being measurable rather than on a token.
  const gh = marker?.versions.get("gh");
  if (gh) rows.push({ name: "GitHub CLI", version: gh });
  if (input.features.web && input.pinVersions.searxng)
    rows.push({ name: "Web search (SearXNG)", version: input.pinVersions.searxng });
  if (input.features.google && input.pinVersions.googleMcp)
    rows.push({ name: "Google (workspace-mcp)", version: input.pinVersions.googleMcp });
  if (input.tunnel && input.pinVersions.cloudflared)
    rows.push({ name: "Cloudflare Tunnel", version: input.pinVersions.cloudflared });
  return rows;
}
