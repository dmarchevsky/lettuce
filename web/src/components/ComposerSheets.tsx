import {
  activeFilterCount,
  DETAIL_DESCRIPTIONS,
  DETAIL_LABELS,
  DETAIL_ORDER,
  DETAIL_PARENT,
  detailEnabled,
  detailsSummary,
  FILTER_LABELS,
  FILTER_ORDER,
  type FilterDetail,
  type FilterGroup,
  isShown,
} from "../lib/messages.ts";
import { parseResponseFormat } from "../lib/structured-output.ts";
import { PERMISSION_MODES, type PermissionMode } from "../lib/workspace.ts";
import { Icon } from "./Icon.tsx";
import { MenuRow } from "./MenuRow.tsx";
import { Sheet } from "./Sheet.tsx";

/*
 * The composer's menus. One set of rules for all of them (and the model
 * picker): a header with the title, any extra action and a ✕; no footer —
 * choices apply at once; `MenuRow` rows with the selection marked on the right,
 * a tick for pick-one and a checkbox for pick-several.
 */

export function FilterSheet({
  active,
  onToggle,
  hidden,
  onToggleDetail,
  onClear,
  showTimestamps,
  onShowTimestamps,
  onClose,
}: {
  active: ReadonlySet<FilterGroup>;
  onToggle: (group: FilterGroup) => void;
  hidden: ReadonlySet<FilterDetail>;
  onToggleDetail: (detail: FilterDetail) => void;
  onClear: () => void;
  showTimestamps: boolean;
  onShowTimestamps: (show: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      title="Filter"
      onClose={onClose}
      headerAction={
        <button
          type="button"
          className="sheet-head-text"
          disabled={activeFilterCount(active, hidden) === 0}
          onClick={onClear}
        >
          Reset
        </button>
      }
    >
      <p className="menu-intro">Untick a kind of message to hide it.</p>
      <ul className="menu-list">
        {FILTER_ORDER.map((group) => {
          const shown = isShown(active, group);
          // The last one shown stays: an empty filter means everything.
          const onlyOne = shown && FILTER_ORDER.filter((g) => isShown(active, g)).length === 1;
          return (
            <MenuRow
              key={group}
              title={FILTER_LABELS[group]}
              mark="checkbox"
              selected={shown}
              disabled={onlyOne}
              onClick={() => onToggle(group)}
            />
          );
        })}
      </ul>

      {/* The finer cuts, behind one disclosure so the five rows a reader uses stay
          the sheet's whole first screen. Collapsed on every open like the Model
          sheet's Toolset, and its header names what is hidden, so nothing needed
          is behind a fold. */}
      <details className="menu-collapsible">
        <summary>
          <span className="menu-section">Details</span>
          <span className="menu-section-value">{detailsSummary(active, hidden)}</span>
          <Icon name="chevron-right" className="menu-collapsible-mark" />
        </summary>
        <ul className="menu-list">
          {DETAIL_ORDER.map((detail) => {
            // A switch whose whole group is hidden rides with it: disabled, and
            // still showing its own tick, so showing the group back restores it.
            const reachable = detailEnabled(active, detail);
            return (
              <MenuRow
                key={detail}
                title={DETAIL_LABELS[detail]}
                description={
                  reachable
                    ? DETAIL_DESCRIPTIONS[detail]
                    : `Hidden with ${FILTER_LABELS[DETAIL_PARENT[detail]]}`
                }
                mark="checkbox"
                selected={!hidden.has(detail)}
                disabled={!reachable}
                onClick={() => onToggleDetail(detail)}
              />
            );
          })}
        </ul>
      </details>

      <p className="menu-section">Display</p>
      <ul className="menu-list">
        <MenuRow
          title="Timestamps"
          description="The time on each message"
          mark="checkbox"
          selected={showTimestamps}
          onClick={() => onShowTimestamps(!showTimestamps)}
        />
      </ul>
    </Sheet>
  );
}

export function PermissionSheet({
  current,
  onPick,
  onClose,
}: {
  current: PermissionMode | null;
  onPick: (mode: PermissionMode) => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      title="Permission mode"
      onClose={onClose}
      status={current === null ? "Waiting for the agent to report its current mode…" : null}
    >
      <ul className="menu-list">
        {PERMISSION_MODES.map((mode) => (
          <MenuRow
            key={mode.id}
            title={mode.label}
            description={mode.description}
            mark="check"
            selected={mode.id === current}
            onClick={() => {
              onPick(mode.id);
              onClose();
            }}
          />
        ))}
      </ul>
    </Sheet>
  );
}

/**
 * Per-turn structured output.
 *
 * The schema is free text here and only parsed on demand, so a half-written
 * schema stays editable instead of being wiped: the toggle is disabled with the
 * parse error shown, and the text is kept either way.
 */
export function StructuredOutputSheet({
  text,
  enabled,
  onText,
  onEnabled,
  onClose,
}: {
  text: string;
  enabled: boolean;
  onText: (text: string) => void;
  onEnabled: (enabled: boolean) => void;
  onClose: () => void;
}) {
  const { value, error } = parseResponseFormat(text);
  const canEnable = value !== null;

  return (
    <Sheet title="JSON output" onClose={onClose}>
      <p className="menu-intro">
        Constrain the agent&apos;s reply to a JSON Schema. Kept for this conversation, so it
        survives a tab switch or a reload; turn it off when you want plain prose back.
      </p>

      <label className="field">
        Schema
        <textarea
          value={text}
          rows={10}
          spellCheck={false}
          placeholder={
            '{\n  "type": "object",\n  "properties": {\n    "answer": { "type": "string" }\n  },\n  "required": ["answer"]\n}'
          }
          onChange={(event) => onText(event.target.value)}
        />
      </label>

      {error ? <p className="small bad">{error}</p> : null}

      <ul className="menu-list">
        <MenuRow
          title="Require JSON"
          description={
            canEnable
              ? "For every message in this conversation"
              : "Fix the schema above to enable this"
          }
          mark="checkbox"
          selected={enabled}
          disabled={!canEnable && !enabled}
          onClick={() => onEnabled(!enabled)}
        />
      </ul>
    </Sheet>
  );
}
