import type { IconName } from "../components/Icon.tsx";
import { type FeatureFlags, type FeatureName, featureEnabled } from "./features.ts";
import { defaultStorage, readStored } from "./storage.ts";

/**
 * The Settings sections, in the order the rail and the phone's chip bar show them.
 *
 * Settings is a pane like any other, so its sections are the rail's cells while it
 * is open — which forces two things the old modal never had to care about: every
 * section needs a glyph (a rail cell is a glyph beside a word), and a group header
 * has to be a word the column can fit. `label` is the full name the pane's own title
 * uses; `short` is the one word both rails show — the phone's chip and the desktop's
 * section cell are the same list at the same size, so they get the same word.
 */
export type GlobalSection =
  | "providers"
  | "web"
  | "mcp"
  | "google"
  | "codex"
  | "claude"
  | "pi"
  | "telegram"
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
        icon: "model",
      },
    ],
  },
  {
    label: "Tools",
    sections: [
      { id: "web", label: "Web search", short: "Web", icon: "globe" },
      { id: "mcp", label: "MCP servers", short: "MCP", icon: "braces" },
      { id: "google", label: "Google Workspace", short: "Workspace", icon: "grid" },
      { id: "codex", label: "Codex workers", short: "Codex", icon: "terminal" },
      {
        id: "claude",
        label: "Claude Code workers",
        short: "Claude",
        icon: "terminal",
      },
      { id: "pi", label: "Remote Pi", short: "Remote Pi", icon: "terminal" },
      { id: "telegram", label: "Telegram", short: "Telegram", icon: "send" },
      { id: "skills", label: "Global skills", short: "Skills", icon: "memory" },
    ],
  },
  {
    label: "Access",
    sections: [
      { id: "access", label: "Access", short: "Access", icon: "shield" },
      { id: "signin", label: "Sign-in", short: "Sign-in", icon: "pin" },
    ],
  },
  {
    label: "App",
    sections: [
      { id: "notifications", label: "Notifications", short: "Push", icon: "bell" },
      { id: "about", label: "About", short: "About", icon: "info" },
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
  telegram: "telegram",
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
