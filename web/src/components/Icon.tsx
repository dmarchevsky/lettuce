/**
 * The app's icons, as inline SVG.
 *
 * Replaces a mix of emoji (🗄 🧠 📁 📄) and dingbats (☰ ■ ↑ ✎ ▾ ⚠ ⚙ ✕ ↻ ↩ ↓)
 * that rendered at different weights and colours depending on the platform's
 * emoji font, and where one glyph could mean two things — `↑` was both "send"
 * and "go to parent directory".
 *
 * One 24×24 grid, one stroke weight, `currentColor`, sized by CSS (`1em`), so
 * an icon always matches the text or button colour around it. Every icon is
 * `aria-hidden`: the accessible name belongs on the button, not the glyph.
 */

export type IconName =
  | "menu"
  | "send"
  | "stop"
  | "filter"
  | "shield"
  | "model"
  | "up"
  | "folder"
  | "file"
  | "refresh"
  | "edit"
  | "archive"
  | "unarchive"
  | "close"
  | "chevron-right"
  | "chevron-down"
  | "arrow-down"
  | "download"
  | "warning"
  | "memory"
  | "settings"
  | "plus"
  | "task"
  | "braces"
  | "branch"
  | "history"
  | "copy"
  | "check"
  | "chats"
  | "back"
  | "more"
  | "search"
  | "terminal"
  | "globe"
  | "pin"
  | "trash"
  | "attach";

/** Path data on a 24×24 grid; stroked, except the icons in `FILLED`. */
const PATHS: Record<IconName, string> = {
  menu: "M4 7h16M4 12h16M4 17h16",
  // Paper plane, filled: the send verb on the queue chip's steer action.
  send: "M22 2 15 22l-4-9-9-4Z",
  stop: "M7 7h10v10H7z",
  filter: "M4 6h16M7 12h10M10 18h4",
  shield: "M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z",
  model: "M4 8l8-4 8 4-8 4zM4 12l8 4 8-4M4 16l8 4 8-4",
  up: "M12 19V5M5 12l7-7 7 7",
  folder: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z",
  file: "M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5",
  refresh: "M20 12a8 8 0 11-2.3-5.7M20 4v4h-4",
  edit: "M4 20h4L19 9a2 2 0 00-3-3L5 17zM15 6l3 3",
  archive: "M3 7h18v3H3zM5 10v9h14v-9M10 14h4",
  unarchive: "M20 12a8 8 0 11-2.3-5.7M20 4v4h-4",
  close: "M6 6l12 12M18 6L6 18",
  "chevron-right": "M9 5l7 7-7 7",
  "chevron-down": "M5 9l7 7 7-7",
  "arrow-down": "M12 5v14M5 12l7 7 7-7",
  // An arrow onto a line, not the bare "arrow-down" above: that one already
  // means "scroll to latest", and one glyph meaning two things is the problem
  // this icon set exists to solve.
  download: "M12 4v10M8 10l4 4 4-4M5 19h14",
  warning: "M12 4l9 16H3zM12 10v4M12 17h.01",
  memory:
    "M9 4a3 3 0 00-3 3 3 3 0 00-1 5 3 3 0 001 5 3 3 0 003 3 3 3 0 003-3V7a3 3 0 00-3-3zM15 7a3 3 0 013-3 3 3 0 013 3",
  // Six rounded lobes: the hand-drawn polygon it replaces had square, uneven
  // teeth. Path from Lucide's "settings" icon — ISC License, Copyright (c)
  // Lucide Contributors 2022, https://github.com/lucide-icons/lucide/blob/main/LICENSE
  settings:
    "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  plus: "M12 5v14M5 12h14",
  // A push pin: the head, the collar, the point.
  pin: "M9 4h6M10 4v5l-3 4v1h10v-1l-3-4V4M12 14v6",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  // Clipboard with a tick: background work that reported back.
  task: "M9 4h6v3H9zM8 5H6a1 1 0 00-1 1v13a1 1 0 001 1h12a1 1 0 001-1V6a1 1 0 00-1-1h-2M9 13l2 2 4-4",
  // Curly braces: a JSON-schema-constrained reply.
  braces:
    "M8 4c-2 0-2 2-2 4s0 4-2 4c2 0 2 2 2 4s0 4 2 4M16 4c2 0 2 2 2 4s0 4 2 4c-2 0-2 2-2 4s0 4-2 4",
  // Git branch: two nodes on a line with a diverging one.
  branch:
    "M7 5v10M7 19a2 2 0 100-4 2 2 0 000 4zM7 7a2 2 0 100-4 2 2 0 000 4zM17 9a2 2 0 100-4 2 2 0 000 4zM17 9c0 4-4 4-4 8",
  // Clock outline: git history — the log of what already happened.
  history: "M12 3a9 9 0 100 18 9 9 0 100-18M12 7v5l3 2",
  // Two overlapping sheets: copy to the clipboard.
  copy: "M9 9h10v10H9zM15 9V5H5v10h4",
  check: "M5 12l5 5 9-10",
  // Two speech bubbles: switch conversation (or agent).
  chats: "M4 5h13v9H9l-5 4zM8 17v1h8l4 3V9h-3",
  back: "M15 5l-7 7 7 7",
  // Three dots in a row: a row's menu (rename, archive, edit).
  more: "M6 12h.01M12 12h.01M18 12h.01",
  search: "M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4",
  // Angle brackets and a prompt line: a shell command is running (the working
  // line's Bash verb). Path from Lucide's "terminal" — ISC License.
  terminal: "M4 17l6-6-6-6M12 19h8",
  // Meridian globe: fetching a web page, distinct from the magnifier's search.
  globe:
    "M12 3a9 9 0 100 18 9 9 0 000-18M3 12h18M12 3c2.5 2.6 4 5.6 4 9s-1.5 6.4-4 9c-2.5-2.6-4-5.6-4-9s1.5-6.4 4-9z",
  // Paper clip: attach an image to the message. Path from Lucide's
  // "paperclip" icon — ISC License, Copyright (c) Lucide Contributors.
  attach:
    "m21.44 11.05-9.19 9.19a6 6 0 01-8.49-8.49l8.57-8.57A4 4 0 1118 8.84l-8.59 8.57a2 2 0 01-2.83-2.83l8.49-8.48",
};

/** Icons painted solid rather than outlined — see the notes on their paths. */
const FILLED: ReadonlySet<IconName> = new Set<IconName>(["send"]);

interface Props {
  name: IconName;
  /** Extra classes; `icon` is always applied. */
  className?: string;
}

export function Icon({ name, className }: Props) {
  const filled = FILLED.has(name);
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
