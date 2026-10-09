import { describe, expect, it } from "bun:test";
import { type DeploymentInput, deploymentComponents, parseCodingMarker } from "./deployment.ts";

const PINS = {
  searxng: "2026.10.9-9f042d2f6",
  googleMcp: "2.1.0",
  cloudflared: "2026.10.0",
  ddgMcp: "0.7.0",
};
const OFF = { web: false, google: false, codex: false, claude: false };

function rows(input: Partial<DeploymentInput>): string[] {
  return deploymentComponents({
    features: OFF,
    tunnel: false,
    pinVersions: PINS,
    webReader: true,
    marker: null,
    lettaCodeVersion: null,
    ...input,
  }).map((row) => `${row.name}=${row.version}`);
}

describe("parseCodingMarker", () => {
  it("reads name and version, and tolerates blanks", () => {
    const marker = parseCodingMarker("codex 0.162.0\n\n claude 2.1.295 \ngh 2.102.0\n");
    expect(marker.names).toEqual(["codex", "claude", "gh"]);
    expect(marker.versions.get("codex")).toBe("0.162.0");
    expect(marker.versions.get("gh")).toBe("2.102.0");
  });

  it("reads an old marker's bare names as installed with no version", () => {
    const marker = parseCodingMarker("codex\nclaude\n");
    expect(marker.names).toEqual(["codex", "claude"]);
    expect(marker.versions.size).toBe(0);
  });
});

describe("deploymentComponents", () => {
  it("shows only what the deployment switched on, in order", () => {
    expect(
      rows({
        lettaCodeVersion: "0.34.9",
        features: { web: true, google: true, codex: false, claude: false },
        marker: parseCodingMarker("gh 2.102.0"),
      }),
    ).toEqual([
      "letta-code=0.34.9",
      "GitHub CLI=2.102.0",
      "Web search (SearXNG)=2026.10.9-9f042d2f6",
      "Page reading (ddg-mcp)=0.7.0",
      "Google (workspace-mcp)=2.1.0",
    ]);
  });

  it("leaves ddg-mcp out when page reading is not wired", () => {
    expect(rows({ features: { ...OFF, web: true }, webReader: false })).toEqual([
      "Web search (SearXNG)=2026.10.9-9f042d2f6",
    ]);
  });

  it("says not installed when the token is on and the image has no CLI", () => {
    expect(
      rows({ features: { ...OFF, codex: true }, marker: parseCodingMarker("gh 2.102.0") }),
    ).toContain("Codex CLI=not installed");
    // Nothing read from the marker at all (predates it): still not "0.x" invented.
    expect(rows({ features: { ...OFF, claude: true } })).toEqual(["Claude Code CLI=not installed"]);
  });

  it("says unknown for an image whose marker predates versions", () => {
    expect(rows({ features: { ...OFF, codex: true }, marker: parseCodingMarker("codex") })).toEqual(
      ["Codex CLI=unknown"],
    );
  });

  it("shows the tunnel only where the tunnel container exists", () => {
    expect(rows({ tunnel: true })).toContain("Cloudflare Tunnel=2026.10.0");
    expect(rows({})).toEqual([]);
  });

  it("drops a pin the BFF was never given", () => {
    expect(
      rows({
        features: { ...OFF, web: true },
        pinVersions: { ...PINS, searxng: "", ddgMcp: "" },
      }),
    ).toEqual([]);
  });
});
