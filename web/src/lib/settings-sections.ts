import type { IconName } from "../components/Icon.tsx";
import { type FeatureFlags, type FeatureName, featureEnabled } from "./features.ts";
import { defaultStorage, readStored } from "./storage.ts";

/**
 * The Settings sections, in the order the rail and the phone's chip bar show them.
 *
 * Settings is a pane like any other, so its sections are the rail's cells while it
 * is open — which forces two things the old modal never had to care about: every
 * section needs a glyph (a rail cell is a glyph over a word), and a group header
 * has to be a word that fits a 64px column. `label` is the full name the pane's own
 * title uses, `short` is the phone chip, `rail` the rail's word.
 */
export type GlobalSection =
  | "providers"
  | "web"
  | "mcp"
  | "google"
  | "codex"
  | "claude"
  | "pi"
  | "skills"
  | "access"
  | "signin"
  | "notifications"
  | "about";

export interface SectionInfo {
  id: GlobalSection;
  label: string;
  /** The phone's chip: twelve full names do not fit two rows at 390px. */
  short: string;
  /** The rail's word, at 9px inside a 64px column. */
  rail: string;
  icon: IconName;
}

export const GLOBAL_SECTION_GROUPS: { label: string; sections: SectionInfo[] }[] = [
  {
    label: "Core",
    sections: [
      {
        id: "providers",
        label: "Providers & models",
        short: "Models",
        rail: "Models",
        icon: "model",
      },
    ],
  },
  {
    label: "Tools",
    sections: [
      { id: "web", label: "Web search", short: "Web", rail: "Web", icon: "globe" },
      { id: "mcp", label: "MCP servers", short: "MCP", rail: "MCP", icon: "braces" },
      { id: "google", label: "Google Workspace", short: "Workspace", rail: "Google", icon: "grid" },
      { id: "codex", label: "Codex workers", short: "Codex", rail: "Codex", icon: "terminal" },
      {
        id: "claude",
        label: "Claude Code workers",
        short: "Claude",
        rail: "Claude",
        icon: "terminal",
      },
      { id: "pi", label: "Remote Pi", short: "Remote Pi", rail: "Pi", icon: "terminal" },
      { id: "skills", label: "Global skills", short: "Skills", rail: "Skills", icon: "memory" },
    ],
  },
  {
    label: "Access",
    sections: [
      { id: "access", label: "Access", short: "Access", rail: "Access", icon: "shield" },
      { id: "signin", label: "Sign-in", short: "Sign-in", rail: "Sign-in", icon: "pin" },
    ],
  },
  {
    label: "App",
    sections: [
      { id: "notifications", label: "Notifications", short: "Push", rail: "Push", icon: "bell" },
      { id: "about", label: "About", short: "About", rail: "About", icon: "info" },
    ],
  },
];

export const GLOBAL_SECTIONS: SectionInfo[] = GLOBAL_SECTION_GROUPS.flatMap(
  (group) => group.sections,
);

export function isGlobalSection(value: string | null): value is GlobalSection {
  return GLOBAL_SECTIONS.some((section) => section.id === value);
}

export function globalSectionInfo(id: GlobalSection): SectionInfo | undefined {
  return GLOBAL_SECTIONS.find((section) => section.id === id);
}

/** The profile token each gated section rides on; the rest are always visible. */
const SECTION_FEATURE: Partial<Record<GlobalSection, FeatureName>> = {
  web: "web",
  google: "google",
  codex: "codex",
  claude: "claude",
  pi: "pi",
};

/**
 * The sections this deployment can configure, group by group, empty groups dropped.
 *
 * A section whose compose token is off cannot be configured — the BFF refuses its
 * save routes — so it appears nowhere: not in the rail, not in the phone's chips.
 * Both surfaces call this, which is the only way they cannot drift.
 */
export function visibleGroups(features?: FeatureFlags) {
  return GLOBAL_SECTION_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter((section) => {
      const feature = SECTION_FEATURE[section.id];
      return !feature || featureEnabled(features, feature);
    }),
  })).filter((group) => group.sections.length > 0);
}

export function isSectionVisible(id: GlobalSection, features?: FeatureFlags): boolean {
  return visibleGroups(features).some((group) =>
    group.sections.some((section) => section.id === id),
  );
}

/** Settings is a pane with no default, so it resumes where you were. */
const LAST_SECTION_KEY = "lettuce:settings-section";

export function readLastSection(): GlobalSection | null {
  try {
    const value = readStored(defaultStorage(), LAST_SECTION_KEY);
    return isGlobalSection(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeLastSection(section: GlobalSection): void {
  try {
    defaultStorage()?.setItem(LAST_SECTION_KEY, section);
  } catch {
    // A convenience only: the pane still opens, just on the first section.
  }
}
