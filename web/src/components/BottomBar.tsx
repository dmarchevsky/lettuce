import type { Tab } from "../lib/tabs.ts";
import type { IconName } from "./Icon.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  tab: Tab;
  onSelectPane: (tab: Tab) => void;
  onOpenSettings: () => void;
  runsEnabled: boolean;
  /** Shown on the Runs slot so a running worker is visible from the bar. */
  runsRunning: number;
}

/**
 * The phone's navigation: one bar under the composer, replacing the top tab
 * strip that used to squeeze six labels onto 390px.
 *
 * Six equal slots — Chat, Files, Tasks, Runs where a coding worker is deployed,
 * Settings, and Agent. `Runs` earns a slot of its own because a running worker is
 * the one thing on this bar worth interrupting for; without a worker deployed the
 * bar is five slots rather than padded out to six with a filler verb. There is no
 * More: once Runs and Settings had slots the umbrella held exactly one row, and an
 * umbrella over one thing is a step with no view. The agent's own pane takes its
 * place under its own name — Tools is a chip inside that pane now, not a pane,
 * because the record behind it is keyed by `agent_id`.
 * Pressing Chat while Chat is the open pane also opens the conversation list (the
 * switcher), which is App's decision, not this bar's: the bar is panes and nothing
 * else.
 *
 * The agent's avatar is not here; it moved to the header's left corner
 * (`where-avatar` in App), because a letter the size of a full stop never told you
 * which agent you were talking to.
 */
export function BottomBar({ tab, onSelectPane, onOpenSettings, runsEnabled, runsRunning }: Props) {
  const secondary: { tab: Tab; label: string; icon: IconName; count?: number }[] = [
    { tab: "Files", label: "Files", icon: "folder" },
    { tab: "Tasks", label: "Tasks", icon: "task" },
    ...(runsEnabled
      ? [{ tab: "Runs" as const, label: "Runs", icon: "terminal" as IconName, count: runsRunning }]
      : []),
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
            {pane.count && pane.count > 0 ? <span className="slot-count">{pane.count}</span> : null}
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
          className={tab === "Agent" ? "active" : ""}
          aria-current={tab === "Agent" ? "page" : undefined}
          onClick={() => onSelectPane("Agent")}
        >
          <Icon name="shield" />
          Agent
        </button>
      </nav>
    </>
  );
}
