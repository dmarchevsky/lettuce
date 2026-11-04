import type { ReactNode } from "react";
import { AccessSection } from "../components/AccessSection.tsx";
import { ClaudeSection } from "../components/ClaudeSection.tsx";
import { CodexSection } from "../components/CodexSection.tsx";
import { GoogleSection } from "../components/GoogleSection.tsx";
import { McpEditor } from "../components/McpEditor.tsx";
import { NotificationsSection } from "../components/NotificationsSection.tsx";
import { PiSection } from "../components/PiSection.tsx";
import { ProvidersSection } from "../components/ProvidersSection.tsx";
import { SignInSection } from "../components/SignInSection.tsx";
import { GlobalSkills } from "../components/SkillsSections.tsx";
import { WebToolsSection } from "../components/WebToolsSection.tsx";
import type { FeatureFlags } from "../lib/features.ts";
import type { Component } from "../lib/protocol.ts";
import { type GlobalSection, globalSectionInfo, visibleGroups } from "../lib/settings-sections.ts";
import { type Access, identityLabel, SIGNIN_LABELS, type Signin } from "../lib/signin.ts";
import type { SessionApi } from "../state/use-session.ts";
import { useWide } from "../state/use-wide.ts";

interface Props {
  session: SessionApi;
  /** Global skills are listed through one agent's view; any agent will do. */
  agentId: string | null;
  cwd: string | null;
  skillsVersion: number;
  user: { email: string } | null;
  /** From `/api/status`: the two halves of what used to be a single `mode`. */
  access: Access;
  signin: Signin;
  hostBind?: string;
  publicOrigin?: string;
  passwordUpdatedAt?: string | null;
  /** This build's release tag from `/api/status`; absent on an untagged dev run. */
  version?: string;
  /** This deployment's components with their versions, from `/api/status`. */
  components?: Component[];
  /**
   * Profile-gated sections from `/api/status`: a section whose token is off
   * does not appear at all — the integration behind it cannot be configured,
   * and the BFF refuses its save routes anyway. Absent (older BFF) = all on.
   */
  features?: FeatureFlags;
  /** The open section. App owns it: the rail's cells and this pane are one list. */
  section: GlobalSection;
  onPick: (section: GlobalSection) => void;
}

/**
 * Settings shared by every agent, plus this device's — a pane, not a modal.
 *
 * It was a full-screen dialog over the pane you were reading, which put a second
 * navigation system on top of the first: the rail kept showing panes you could not
 * reach, and Settings carried its own list of sections beside them. Now it is a
 * pane (`tab === "Settings"`): while it is open the rail holds its sections and the
 * the rail's foot cell is the door, so there is one navigation column again.
 *
 * Which leaves the sections needing a place on a phone too, where the rail is not
 * on screen — the Agent tab's wrapping chips, short names, over the section. A list
 * you had to back out of to reach the next section cost a tap per visit.
 *
 * Every section here is global: what an agent *is* lives under Agent, and what it
 * may use lives under Tools, both reached from the agent itself. The one cross
 * connection that actually confused people — the per-agent Remote Pi folder under
 * Tools while its default lives here — is said where it matters, in that section.
 */
export function SettingsPane({
  session,
  agentId,
  cwd,
  skillsVersion,
  user,
  access,
  signin,
  hostBind,
  publicOrigin,
  passwordUpdatedAt,
  version,
  components,
  features,
  section,
  onPick,
}: Props) {
  const wide = useWide();
  const info = globalSectionInfo(section);

  const content: Record<GlobalSection, () => ReactNode> = {
    providers: () => <ProvidersSection session={session} />,
    web: () => <WebToolsSection />,
    mcp: () => <McpEditor session={session} />,
    google: () => <GoogleSection />,
    codex: () => <CodexSection />,
    claude: () => <ClaudeSection />,
    pi: () => <PiSection />,
    skills: () => (
      <GlobalSkills session={session} agentId={agentId} cwd={cwd} version={skillsVersion} />
    ),
    access: () => (
      <AccessSection
        access={access}
        signin={signin}
        hostBind={hostBind}
        publicOrigin={publicOrigin}
        components={components}
      />
    ),
    signin: () => (
      <SignInSection
        signin={signin}
        email={user?.email ?? null}
        passwordUpdatedAt={passwordUpdatedAt}
      />
    ),
    notifications: () => <NotificationsSection />,
    about: () => (
      <AboutSection user={user} signin={signin} version={version} components={components} />
    ),
  };

  return (
    <div className="pane settings-pane">
      {/* The phone has no rail, so the sections live here as chips — the Agent tab's
          treatment, for the same reason: a list you had to back out of to reach the
          next section cost a tap per visit. On desktop the rail IS the section list,
          and a second copy beside it is the drift this pane used to carry. */}
      {wide ? null : (
        <nav className="pane-bar section-tabs wrap" aria-label="Settings sections">
          {visibleGroups(features)
            .flatMap((group) => group.sections)
            .map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === section ? "active" : undefined}
                aria-current={item.id === section ? "true" : undefined}
                onClick={() => onPick(item.id)}
              >
                {item.short}
              </button>
            ))}
        </nav>
      )}

      {/* The section's own name, because the chips are abbreviated and the rail's word
          is shorter still. On a phone the active chip already says it. */}
      {wide && info ? <h3 className="settings-content-title">{info.label}</h3> : null}
      {content[section]()}
    </div>
  );
}

function AboutSection({
  user,
  signin,
  version,
  components,
}: {
  user: Props["user"];
  signin: Signin;
  version?: string;
  components?: Component[];
}) {
  const rows: [string, ReactNode][] = [
    ["Signed in as", identityLabel(user?.email ?? null) ?? "—"],
    ["Sign-in", SIGNIN_LABELS[signin]],
    ["lettuce", version ?? "—"],
  ];
  return (
    <>
      <ul className="list">
        {rows.map(([label, value]) => (
          <li key={label} className="row-between pad">
            <span className="muted">{label}</span>
            <span>{value}</span>
          </li>
        ))}
      </ul>
      {/* What this deployment runs. The BFF decides which rows exist — it knows
          which profile tokens are on and what the app-server image really has —
          so this renders the list as given. */}
      {components && components.length > 0 ? (
        <>
          <p className="section-note">Components</p>
          <ul className="list">
            {components.map((component) => (
              <li key={component.name} className="row-between pad">
                <span className="muted">{component.name}</span>
                <span>{component.version}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
