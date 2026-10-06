import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type FeatureFlags, type FeatureName, featureEnabled } from "../lib/features.ts";
import type { LinkState } from "../lib/session-client.ts";
import { defaultStorage, readStored } from "../lib/storage.ts";
import { useBackToClose } from "../state/use-back-to-close.ts";
import type { SessionApi } from "../state/use-session.ts";
import { useWide } from "../state/use-wide.ts";
import { ClaudeSection } from "./ClaudeSection.tsx";
import { CodexSection } from "./CodexSection.tsx";
import { ConnectionSection } from "./ConnectionSection.tsx";
import { GoogleSection } from "./GoogleSection.tsx";
import { Icon } from "./Icon.tsx";
import { McpEditor } from "./McpEditor.tsx";
import { MenuRow } from "./MenuRow.tsx";
import { NotificationsSection } from "./NotificationsSection.tsx";
import { PiSection } from "./PiSection.tsx";
import { GlobalSkills } from "./SkillsSections.tsx";
import { WebToolsSection } from "./WebToolsSection.tsx";

export type GlobalSection =
  | "providers"
  | "web"
  | "mcp"
  | "google"
  | "codex"
  | "claude"
  | "pi"
  | "skills"
  | "notifications"
  | "about";

interface SectionInfo {
  id: GlobalSection;
  label: string;
  /** The phone's chip: eight full names do not fit two rows at 390px. */
  short: string;
}

/** The sections, grouped as the list shows them. */
export const GLOBAL_SECTION_GROUPS: { label: string; sections: SectionInfo[] }[] = [
  {
    label: "Model",
    sections: [{ id: "providers", label: "Providers & models", short: "Models" }],
  },
  {
    label: "Tools & integrations",
    sections: [
      { id: "web", label: "Web search", short: "Web" },
      { id: "mcp", label: "MCP servers", short: "MCP" },
      { id: "google", label: "Google", short: "Google" },
      { id: "codex", label: "Codex workers", short: "Codex" },
      { id: "claude", label: "Claude Code workers", short: "Claude" },
      { id: "pi", label: "Remote Pi", short: "Remote Pi" },
    ],
  },
  {
    label: "Skills",
    sections: [{ id: "skills", label: "Global skills", short: "Skills" }],
  },
  {
    label: "This device",
    sections: [{ id: "notifications", label: "Notifications", short: "Push" }],
  },
  {
    label: "App",
    sections: [{ id: "about", label: "About", short: "About" }],
  },
];

const ALL_SECTIONS = GLOBAL_SECTION_GROUPS.flatMap((group) => group.sections);
/**
 * Every section here is global, and the per-agent half of the UI moved twice:
 * what an agent may use is under Tools, what an agent *is* is under Agent. Naming
 * only one of them sends a reader looking for Remote Pi's per-agent folder to the
 * wrong tab.
 */
const SHARED_NOTE =
  "Shared by every agent. What one agent may use is under Tools; what it is named and told is under Agent.";
const LAST_SECTION_KEY = "lettuce:settings-section";

/** The profile token each gated section rides on; others are always visible. */
const SECTION_FEATURE: Partial<Record<GlobalSection, FeatureName>> = {
  web: "web",
  google: "google",
  codex: "codex",
  claude: "claude",
  pi: "pi",
};

function isSectionVisible(id: GlobalSection, features?: FeatureFlags): boolean {
  const feature = SECTION_FEATURE[id];
  return !feature || featureEnabled(features, feature);
}

/** The section groups with gated sections removed and empty groups dropped. */
function visibleGroups(features?: FeatureFlags) {
  return GLOBAL_SECTION_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter((section) => isSectionVisible(section.id, features)),
  })).filter((group) => group.sections.length > 0);
}

export function isGlobalSection(value: string | null): value is GlobalSection {
  return ALL_SECTIONS.some((section) => section.id === value);
}

function readLastSection(): GlobalSection | null {
  try {
    const value = readStored(defaultStorage(), LAST_SECTION_KEY);
    return isGlobalSection(value) ? value : null;
  } catch {
    return null;
  }
}

function writeLastSection(section: GlobalSection): void {
  try {
    defaultStorage()?.setItem(LAST_SECTION_KEY, section);
  } catch {
    // A convenience only: the list still opens, just on the first section.
  }
}

interface Props {
  session: SessionApi;
  /** Global skills are listed through one agent's view; any agent will do. */
  agentId: string | null;
  cwd: string | null;
  skillsVersion: number;
  user: { email: string } | null;
  authMode: "cf-access" | "dev-bypass" | "none";
  /** This build's release tag from `/api/status`; absent on an untagged dev run. */
  version?: string;
  /**
   * Profile-gated sections from `/api/status`: a section whose token is off
   * does not appear at all — the integration behind it cannot be configured,
   * and the BFF refuses its save routes anyway. Absent (older BFF) = all on.
   */
  features?: FeatureFlags;
  /** Open straight on a section, e.g. from the Agent tab's Skills link. */
  initialSection?: GlobalSection;
  onClose: () => void;
}

/**
 * Settings shared by every agent, plus this device's. Full screen like the
 * Switcher, opened from the top bar's gear: it has nothing to do with which
 * agent is selected, so it is not a tab beside the agent's own. Per-agent
 * settings are the Agent tab.
 *
 * Desktop: the grouped list beside the open section. Phone: the Agent tab's
 * wrapping chips, short names, over the section — a list you had to back out
 * of to reach the next section cost a tap per visit.
 */
export function GlobalSettings({
  session,
  agentId,
  cwd,
  skillsVersion,
  user,
  authMode,
  version,
  features,
  initialSection,
  onClose,
}: Props) {
  const wide = useWide();
  const groups = useMemo(() => visibleGroups(features), [features]);
  const sections = useMemo(() => groups.flatMap((group) => group.sections), [groups]);
  // One section is always open, so it resumes where it was — but only if what
  // it resumes to is visible: a deep link or a remembered section behind a
  // feature that is off lands on the first visible section instead.
  const [section, setSection] = useState<GlobalSection>(() => {
    const wanted = initialSection ?? readLastSection();
    return wanted && isSectionVisible(wanted, features) ? wanted : (sections[0]?.id ?? "providers");
  });

  const pick = (next: GlobalSection) => {
    setSection(next);
    writeLastSection(next);
  };

  useBackToClose(onClose);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A sheet opened from a section (a provider's fields) handles its own.
      if (document.querySelector(".sheet")) return;
      onClose();
    };
    // Capture phase, deliberately. A section's own sheet listens on document
    // in the bubble phase, and its close flushes before any bubble listener on
    // window runs — in bubble order this guard would always find the sheet
    // already gone and would close Settings along with it (Escape inside
    // Settings → Providers' model-edit sheet closed the whole screen). In
    // capture the sheet is still in the DOM, so the `.sheet` test means what
    // it says.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const info = ALL_SECTIONS.find((candidate) => candidate.id === section);

  const content: Record<GlobalSection, () => ReactNode> = {
    providers: () => <ConnectionSection session={session} />,
    web: () => <WebToolsSection />,
    mcp: () => <McpEditor session={session} />,
    google: () => <GoogleSection />,
    codex: () => <CodexSection />,
    claude: () => <ClaudeSection />,
    pi: () => <PiSection />,
    skills: () => (
      <GlobalSkills session={session} agentId={agentId} cwd={cwd} version={skillsVersion} />
    ),
    notifications: () => <NotificationsSection />,
    about: () => (
      <AboutSection session={session} user={user} authMode={authMode} version={version} />
    ),
  };

  return (
    <div className="switcher settings-screen" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="switcher-panel settings-panel">
        <header className="switcher-bar">
          <h2>Settings</h2>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        {wide ? null : (
          <>
            <nav className="pane-bar section-tabs" aria-label="Settings sections">
              {sections.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === section ? "active" : undefined}
                  aria-current={item.id === section ? "true" : undefined}
                  onClick={() => pick(item.id)}
                >
                  {item.short}
                </button>
              ))}
            </nav>
            <p className="scope-line small">{SHARED_NOTE}</p>
          </>
        )}

        <div className="settings-body">
          {wide ? (
            <nav className="settings-nav" aria-label="Settings sections">
              <p className="settings-nav-note small muted">{SHARED_NOTE}</p>
              {groups.map((group) => (
                <section key={group.label}>
                  <h3 className="switcher-group">{group.label}</h3>
                  <ul className="menu-list">
                    {group.sections.map((item) => (
                      // Selected by its border alone: a tick beside a list you
                      // navigate reads as a setting being switched on.
                      <MenuRow
                        key={item.id}
                        title={item.label}
                        selected={item.id === section}
                        onClick={() => pick(item.id)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </nav>
          ) : null}

          <div className="pane settings-content">
            {wide && info ? <h3 className="settings-content-title">{info.label}</h3> : null}
            {content[section]()}
          </div>
        </div>
      </div>
    </div>
  );
}

const LINK_LABELS: Record<LinkState, string> = {
  live: "Live",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  resyncing: "Resyncing…",
  offline: "Offline",
  "signed-out": "Signed out",
};

const AUTH_LABELS: Record<Props["authMode"], string> = {
  "cf-access": "Cloudflare Access",
  "dev-bypass": "Developer bypass (not authenticated)",
  none: "None configured",
};

function AboutSection({
  session,
  user,
  authMode,
  version,
}: {
  session: SessionApi;
  user: Props["user"];
  authMode: Props["authMode"];
  version?: string;
}) {
  const info = session.appServerInfo;
  const rows: [string, ReactNode][] = [
    ["Signed in as", user?.email ?? "—"],
    ["Sign-in", AUTH_LABELS[authMode]],
    ["Connection", LINK_LABELS[session.link]],
    ["lettuce", version ?? "—"],
    ["Backend", info?.backend ?? "—"],
  ];
  return (
    <ul className="list">
      {rows.map(([label, value]) => (
        <li key={label} className="row-between pad">
          <span className="muted">{label}</span>
          <span>{value}</span>
        </li>
      ))}
    </ul>
  );
}
