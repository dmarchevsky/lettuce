import { useState } from "react";
import type { Tab } from "../lib/tabs.ts";
import type { IconName } from "./Icon.tsx";
import { Icon } from "./Icon.tsx";
import { Sheet } from "./Sheet.tsx";

interface Props {
  /** Named on the More sheet's Agent row — the bar has no avatar any more, but the
   * row still has to say whose settings it opens. */
  agentName: string | null;
  tab: Tab;
  onSelectPane: (tab: Tab) => void;
  onOpenSettings: () => void;
  runsEnabled: boolean;
  /** Shown on the More row so a running worker is visible from the bar. */
  runsRunning: number;
}

/**
 * The phone's navigation: one bar under the composer, replacing the top tab
 * strip that used to squeeze six labels onto 390px.
 *
 * Six equal slots — Chat, the secondary panes that earn one on their own, and
 * Settings, which graduated out of More so the shared configuration is one press
 * from anywhere. More keeps only what belongs to the agent: its own settings and,
 * where the deployment has them, the coding workers. The agent's avatar is not
 * here; it moved to the header's left corner (`where-avatar` in App), because a
 * letter the size of a full stop never told you which agent you were talking to,
 * and the bar's job is panes, not identity.
 */
export function BottomBar({
  agentName,
  tab,
  onSelectPane,
  onOpenSettings,
  runsEnabled,
  runsRunning,
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  // More holds the agent's own panes; Settings got a slot of its own, so a pane
  // you are standing in must light its own slot, not this one.
  const inMore = tab === "Agent" || tab === "Runs";

  const secondary: { tab: Tab; label: string; icon: IconName }[] = [
    { tab: "Files", label: "Files", icon: "folder" },
    { tab: "Tasks", label: "Tasks", icon: "task" },
    { tab: "Tools", label: "Tools", icon: "model" },
  ];

  return (
    <>
      <nav className="bottombar" aria-label="Sections">
        <button
          type="button"
          className={tab === "Chat" ? "active" : ""}
          aria-current={tab === "Chat" ? "page" : undefined}
          onClick={() => onSelectPane("Chat")}
        >
          <Icon name="chats" />
          Chat
        </button>

        {secondary.map((pane) => (
          <button
            key={pane.tab}
            type="button"
            className={tab === pane.tab ? "active" : ""}
            aria-current={tab === pane.tab ? "page" : undefined}
            onClick={() => onSelectPane(pane.tab)}
          >
            <Icon name={pane.icon} />
            {pane.label}
          </button>
        ))}

        <button
          type="button"
          className={tab === "Settings" ? "active" : ""}
          aria-current={tab === "Settings" ? "page" : undefined}
          onClick={onOpenSettings}
        >
          <Icon name="settings" />
          Settings
        </button>

        <button
          type="button"
          className={inMore ? "active" : ""}
          aria-current={inMore ? "page" : undefined}
          onClick={() => setMoreOpen(true)}
        >
          <Icon name="menu" />
          More
        </button>
      </nav>

      {moreOpen ? (
        <Sheet title="More" onClose={() => setMoreOpen(false)}>
          <p className="menu-section">This agent</p>
          <ul className="menu-list">
            <li>
              <button
                type="button"
                className={`menu-row${tab === "Agent" ? " selected" : ""}`}
                onClick={() => {
                  setMoreOpen(false);
                  onSelectPane("Agent");
                }}
              >
                <Icon name="shield" />
                <span className="menu-row-text">
                  <span className="menu-row-title">Agent</span>
                  <span className="menu-row-desc">
                    {agentName ?? "No agent"} — model, secrets, reflection, skills
                  </span>
                </span>
              </button>
            </li>
            {runsEnabled ? (
              <li>
                <button
                  type="button"
                  className={`menu-row${tab === "Runs" ? " selected" : ""}`}
                  onClick={() => {
                    setMoreOpen(false);
                    onSelectPane("Runs");
                  }}
                >
                  <Icon name="terminal" />
                  <span className="menu-row-text">
                    <span className="menu-row-title">Runs</span>
                    <span className="menu-row-desc">Coding workers</span>
                  </span>
                  {runsRunning > 0 ? (
                    <span className="menu-row-count">{runsRunning} running</span>
                  ) : null}
                </button>
              </li>
            ) : null}
          </ul>
        </Sheet>
      ) : null}
    </>
  );
}
