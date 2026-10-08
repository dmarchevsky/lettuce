import { useEffect, useRef, useState } from "react";
import { MAX_IMAGES_PER_MESSAGE, type PreparedImage, prepareImages } from "../lib/attachments.ts";
import {
  clampComposerHeight,
  readComposerHeight,
  writeComposerHeight,
} from "../lib/composer-height.ts";
import { clearDraft, readDraft, writeDraft } from "../lib/draft.ts";
import {
  AT_DRAFT,
  caretAllowsHistory,
  type HistoryCursor,
  historyDown,
  historyUp,
} from "../lib/input-history.ts";
import { enterSends } from "../lib/input-mode.ts";
import type { FilterGroup, TranscriptEntry } from "../lib/messages.ts";
import type { QueuedItem } from "../lib/queue-actions.ts";
import { parseResponseFormat, type ResponseFormat } from "../lib/structured-output.ts";
import type { TurnUsage } from "../lib/usage.ts";
import {
  matchSlashCommands,
  PERMISSION_MODES,
  type PermissionMode,
  parseSlashCommand,
  type SlashCommand,
} from "../lib/workspace.ts";
import { FilterSheet, PermissionSheet, StructuredOutputSheet } from "./ComposerSheets.tsx";
import { Icon } from "./Icon.tsx";
import { WorkingLine } from "./WorkingLine.tsx";

/** Everything the working line reads; see `lib/working.ts`. */
export interface TurnSnapshot {
  entries: readonly TranscriptEntry[];
  queue: readonly QueuedItem[];
  cwd: string | null;
  turnStartedAt: number | null;
  lastActivityAt: number | null;
  usage: TurnUsage | null;
}

interface Props {
  disabled: boolean;
  processing: boolean;
  /**
   * `<agentId>::<conversationId>`, or `null` with no conversation selected.
   * The composer unmounts on every tab switch, so what was typed is kept
   * under this key and restored on the way back. See `lib/draft.ts`.
   */
  draftKey: string | null;
  onSend: (text: string, responseFormat: ResponseFormat | null, images: PreparedImage[]) => void;
  /**
   * Prepared images staged for the next message, owned by the caller so the
   * tray survives this component unmounting on a tab switch — the same
   * treatment `structuredText` gets. Cleared on conversation switch.
   */
  attachments: PreparedImage[];
  onAttachmentsChange: (next: PreparedImage[]) => void;
  /**
   * Structured-output state, owned by the caller so it survives this component
   * unmounting on a tab switch. `structuredText` is the schema as typed;
   * `structuredEnabled` decides whether the next send carries it.
   * `structuredSupported` is the `structured_outputs` capability — the
   * control is hidden without it.
   */
  structuredText: string;
  structuredEnabled: boolean;
  structuredSupported: boolean;
  onStructuredChange: (text: string, enabled: boolean) => void;
  onAbort: () => void;
  /** A stop was accepted but the turn has not ended yet. */
  stopping: boolean;
  /** Live turn state behind the working line; see `WorkingLine.tsx`. */
  turn: TurnSnapshot;
  filters: ReadonlySet<FilterGroup>;
  onToggleFilter: (group: FilterGroup) => void;
  onClearFilters: () => void;
  /** Transcript timestamps; the toggle lives in the filter sheet. */
  showTimestamps: boolean;
  onShowTimestamps: (show: boolean) => void;
  permissionMode: PermissionMode | null;
  onPermissionMode: (mode: PermissionMode) => void;
  commands: SlashCommand[];
  onRunCommand: (id: string, args?: string) => void;
  onOpenModels: () => void;
  modelsDisabled: boolean;
  /** The model in force for this conversation; shown on the button on desktop. */
  modelLabel: string | null;
  /** This conversation's past user messages, oldest first, for ↑/↓ recall. */
  history: readonly string[];
  /**
   * Text to put in the box — "Edit" on your last message. Applied once, then
   * `onPrefillApplied` clears it: the composer unmounts on a tab switch, and a
   * request still standing would overwrite the draft on every remount.
   */
  prefill: string | null;
  onPrefillApplied: () => void;
  /** Open the agents-and-conversations switcher (phone only; see styles). */
  onOpenSwitcher: () => void;
}

type OpenSheet = "filters" | "permissions" | "structured" | null;

/** The composer grows with its text up to this height, then scrolls. */
const MAX_TEXTAREA_HEIGHT = 160;

/**
 * Size the box to its text — unless the user has pinned a height by dragging
 * the grip, in which case the box holds that height and scrolls inside.
 * `scrollHeight` is rounded to a whole pixel while the content is not (16px ×
 * 1.4 lines plus padding is 30.4px), so a box sized to it sits a fraction
 * short — and with `overflow-y: auto` that drew a scrollbar on a single line.
 * It scrolls only once it has stopped growing.
 */
function fitToContent(textarea: HTMLTextAreaElement, manual: boolean): void {
  if (manual) {
    textarea.style.overflowY = "auto";
    return;
  }
  textarea.style.height = "auto";
  const height = textarea.scrollHeight;
  textarea.style.height = `${Math.min(height, MAX_TEXTAREA_HEIGHT)}px`;
  textarea.style.overflowY = height > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
}

/**
 * The single control surface for a turn: the textarea plus one row of controls
 * beneath it. Everything that used to sit in a chip row above the transcript
 * lives here instead — on a phone that row cost a whole line of vertical space
 * and put the model picker as far from the input as it could be.
 */
export function Composer({
  disabled,
  processing,
  draftKey,
  onSend,
  onAbort,
  stopping,
  turn,
  filters,
  onToggleFilter,
  onClearFilters,
  showTimestamps,
  onShowTimestamps,
  permissionMode,
  onPermissionMode,
  commands,
  onRunCommand,
  onOpenModels,
  modelsDisabled,
  modelLabel,
  history,
  prefill,
  onPrefillApplied,
  onOpenSwitcher,
  structuredText,
  structuredEnabled,
  structuredSupported,
  onStructuredChange,
  attachments,
  onAttachmentsChange,
}: Props) {
  const [value, setValue] = useState(() => (draftKey ? readDraft(draftKey) : ""));
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [highlight, setHighlight] = useState(0);
  /** Escape closes the popover without clearing what was typed. */
  const [dismissed, setDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionListRef = useRef<HTMLUListElement>(null);
  /**
   * A height pinned by dragging the box's top grip, in CSS pixels; `null` is
   * auto-fit. Reflected in state only to restyle the textarea, and remembered
   * on the device (see `lib/composer-height.ts`) — a resize is ergonomic
   * preference, not conversation state.
   */
  const [manualHeight, setManualHeight] = useState<number | null>(() => readComposerHeight());
  const manualRef = useRef<number | null>(manualHeight);
  /** Live drag state: where the pointer and the box were when the grip bit. */
  const resizeDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  /**
   * Position in `history`. A ref: moving through history re-renders through
   * `value` anyway. The saved draft lives here, not in draft storage, so the
   * stored draft is always what was typed — never a recalled message.
   */
  const cursorRef = useRef<HistoryCursor>(AT_DRAFT);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * Mirror of the `attachments` prop for async callbacks: a second drop that
   * lands while the first is still encoding must append to what the first
   * added, not to the list as it was when this render was drawn.
   */
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  /** `prepareImages` is decode + encode on the main thread; say so while it runs. */
  const [preparing, setPreparing] = useState(false);
  /** One line per rejected file from the last add attempt; cleared by the next one. */
  const [attachErrors, setAttachErrors] = useState<string[]>([]);

  /** Persist every edit so a tab switch (which unmounts this) does not lose it. */
  const remember = (next: string) => {
    if (draftKey) writeDraft(draftKey, next);
  };

  /**
   * Offer files to the tray: the picker, a clipboard paste (the primary mobile
   * path — phone keyboards paste screenshots here) and a drag-drop all funnel
   * through this. Rejections never throw away the accepted ones.
   */
  const addFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    const room = MAX_IMAGES_PER_MESSAGE - attachmentsRef.current.length;
    if (room <= 0) {
      setAttachErrors([`At most ${MAX_IMAGES_PER_MESSAGE} images per message — remove one first.`]);
      return;
    }
    setPreparing(true);
    // Everything offered goes to `prepareImages`, not just what passes the
    // type gate: a dropped or force-picked non-image must name itself in the
    // tray, exactly like one that is too large.
    const batch = await prepareImages(files.slice(0, room));
    setPreparing(false);
    const errors = [...batch.errors];
    if (files.length > room) {
      errors.push(
        `Only ${room} more image${room === 1 ? "" : "s"} fit — the limit is ${MAX_IMAGES_PER_MESSAGE} per message.`,
      );
    }
    if (batch.images.length > 0) {
      onAttachmentsChange([...attachmentsRef.current, ...batch.images]);
    }
    setAttachErrors(errors);
  };

  // A file dropped anywhere else made the browser navigate to it and threw the
  // app away. Swallow every file drag; the composer's own drop handler runs
  // first on its subtree, this one is the safety net for the rest of the page.
  useEffect(() => {
    const swallow = (event: DragEvent) => {
      if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  // Switching conversation without leaving the Chat tab keeps this mounted, so
  // the lazy initialiser above never re-runs — reload the draft for the new
  // conversation here. (Also runs on mount, harmlessly setting the same value.)
  useEffect(() => {
    setValue(draftKey ? readDraft(draftKey) : "");
    cursorRef.current = AT_DRAFT;
    setHighlight(0);
    setDismissed(false);
    const textarea = textareaRef.current;
    if (!textarea) return;
    // A remembered manual height survives a conversation switch; only the
    // auto-fit box re-fits to the restored text.
    textarea.style.height = manualRef.current === null ? "auto" : `${manualRef.current}px`;
    // The restored value has not hit the DOM yet; grow to fit it after paint,
    // the same clamp `onChange` uses, so a multi-line draft is not squashed.
    const frame = requestAnimationFrame(() => {
      fitToContent(textarea, manualRef.current !== null);
    });
    return () => cancelAnimationFrame(frame);
  }, [draftKey]);

  // "Edit" on your last message: the text replaces what is in the box, ready to
  // change and send as a new message (a sent message cannot be rewritten).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per request, not per render.
  useEffect(() => {
    if (prefill === null) return;
    setValue(prefill);
    remember(prefill);
    cursorRef.current = AT_DRAFT;
    setDismissed(true);
    onPrefillApplied();
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    requestAnimationFrame(() => {
      fitToContent(textarea, manualRef.current !== null);
      textarea.setSelectionRange(prefill.length, prefill.length);
    });
  }, [prefill]);

  const suggestions = disabled || dismissed ? [] : matchSlashCommands(value, commands);
  const highlighted = suggestions.length > 0 ? Math.min(highlight, suggestions.length - 1) : -1;
  const active = highlighted >= 0 ? suggestions[highlighted] : undefined;

  // The list is scroll-capped (styles.css), but arrow keys move a highlight
  // without ever focusing an element, so nothing scrolls with them. Follow the
  // highlight the way a native select does: `nearest` scrolls the list, and
  // only scrolls the page if the list itself cannot reach the row.
  useEffect(() => {
    if (highlighted < 0) return;
    const item = suggestionListRef.current?.children[highlighted];
    if (item) (item as HTMLElement).scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const reset = () => {
    setValue("");
    cursorRef.current = AT_DRAFT;
    if (draftKey) clearDraft(draftKey);
    setHighlight(0);
    setDismissed(false);
    const textarea = textareaRef.current;
    if (textarea) fitToContent(textarea, manualRef.current !== null);
  };

  /**
   * Put a recalled message (or the restored draft) in the box, sized to fit,
   * with the caret at the end — so a further ↓ continues at once and a further
   * ↑ first walks up through a multi-line message, as in a shell.
   */
  const recall = (next: string) => {
    setValue(next);
    // A recalled "/command" must not reopen the popover and steal the arrows.
    setDismissed(true);
    const textarea = textareaRef.current;
    if (!textarea) return;
    requestAnimationFrame(() => {
      fitToContent(textarea, manualRef.current !== null);
      textarea.setSelectionRange(next.length, next.length);
    });
  };

  /** Fill the box with a command name and leave the caret ready for its args. */
  const complete = (id: string) => {
    setValue(`/${id} `);
    remember(`/${id} `);
    setHighlight(0);
    textareaRef.current?.focus();
  };

  /**
   * Take a suggestion. One that declares arguments is completed rather than
   * fired: running it bare would hand the mod an empty `args` to work with.
   */
  const choose = (command: SlashCommand) => {
    if (command.args) {
      complete(command.id);
      return;
    }
    onRunCommand(command.id);
    reset();
  };

  /**
   * Drag the box's top grip to pin a height. Up is taller — the box grows by
   * however far the pointer moved up, clamped between one line and half the
   * viewport. The height commits (and is remembered) on release, not per move.
   */
  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // Release the auto-grow clamp the moment the grip is held — it would
    // otherwise pin a drag at 160px — and take the scroll back from the page.
    textarea.style.maxHeight = "none";
    textarea.style.overflowY = "auto";
    resizeDragRef.current = { startY: event.clientY, startHeight: textarea.offsetHeight };
  };

  const dragResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    const textarea = textareaRef.current;
    if (!drag || !textarea) return;
    const next = clampComposerHeight(
      drag.startHeight + (drag.startY - event.clientY),
      window.innerHeight,
    );
    textarea.style.height = `${next}px`;
    textarea.style.overflowY = "auto";
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    resizeDragRef.current = null;
    if (!drag) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const textarea = textareaRef.current;
    if (!textarea) return;
    const height = clampComposerHeight(textarea.offsetHeight, window.innerHeight);
    manualRef.current = height;
    setManualHeight(height);
    writeComposerHeight(height);
  };

  /** Double-click the grip: forget the height and let auto-fit have the box back. */
  const resetManualHeight = () => {
    manualRef.current = null;
    setManualHeight(null);
    writeComposerHeight(null);
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.maxHeight = "";
    textarea.style.height = "auto";
    requestAnimationFrame(() => fitToContent(textarea, false));
  };

  /**
   * Send what is in the box — or run it, when it names a command.
   *
   * The app-server's message path never inspects a leading slash: that parsing
   * lives only in the CLI, and running a command over the protocol takes an
   * explicit `execute_command` frame. So without this branch a typed "/clear"
   * reaches the agent as a literal question. `parseSlashCommand` matches only
   * advertised ids, which is what keeps a pasted path a message.
   */
  const submit = () => {
    const text = value.trim();
    // Images make a message on their own; an empty box with a tray is sendable.
    if ((!text && attachments.length === 0) || disabled || preparing) return;

    // A typed command never carries attachments — the tray stays put.
    const command = text ? parseSlashCommand(text, commands) : null;
    if (command) {
      onRunCommand(command.id, command.args);
      reset();
      return;
    }

    // Send is the primary action on a phone, where Enter is a newline key. With
    // the popover open it therefore has to do what Enter does on a hardware
    // keyboard — take the highlighted command — rather than hand the agent a
    // half-typed "/cl".
    if (active) {
      choose(active);
      return;
    }

    // A schema that stopped parsing between toggling and sending must not
    // silently ride along; drop it and let the turn go unstructured.
    const parsed = structuredEnabled ? parseResponseFormat(structuredText) : null;
    onSend(text, parsed?.value ?? null, attachments);
    reset();
    onAttachmentsChange([]);
    setAttachErrors([]);
  };

  /**
   * Whether the box holds something sendable. While the agent works this is
   * the whole button decision: empty box → the button stops the turn; text →
   * the button sends it, and upstream queues whatever arrives mid-turn.
   */
  const hasContent = value.trim().length > 0 || attachments.length > 0;

  const modeLabel =
    PERMISSION_MODES.find((mode) => mode.id === permissionMode)?.label ?? "Permissions";

  return (
    <>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onDragOver={(event) => {
          if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length > 0) {
            event.preventDefault();
            void addFiles(files);
          }
        }}
      >
        {/* Above the textarea, not below: on a phone the on-screen keyboard
            owns the bottom half of the viewport, so a list rendered under the
            composer would open behind it. */}
        {active ? (
          <ul
            className="composer-suggestions picker"
            id="composer-suggestions"
            ref={suggestionListRef}
          >
            {suggestions.map((command, index) => (
              <li key={command.id}>
                <button
                  type="button"
                  id={`composer-suggestion-${command.id}`}
                  className={index === highlighted ? "active" : undefined}
                  // Mouse-down, not click: click lands after the textarea has
                  // lost focus and the popover has already unmounted.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(command);
                  }}
                  onMouseEnter={() => setHighlight(index)}
                >
                  <strong>
                    /{command.id}
                    {command.args ? <span className="tag">{command.args}</span> : null}
                  </strong>
                  {command.description ? (
                    <span className="menu-row-desc">{command.description}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {processing ? (
          // Above the box, not in the transcript: the transcript's own dots
          // scroll away, this one says what the agent is doing, how long, and
          // how fast — and why the button under it is red.
          <WorkingLine
            entries={turn.entries}
            queue={turn.queue}
            cwd={turn.cwd}
            stopping={stopping}
            turnStartedAt={turn.turnStartedAt}
            lastActivityAt={turn.lastActivityAt}
            usage={turn.usage}
            onAbort={onAbort}
          />
        ) : null}

        <div className="composer-box">
          {/* The box's top border doubles as the resize grip: drag for a
              pinned height, double-click for auto-fit. Pointer-only by
              design — auto-fit already serves anyone who never touches it,
              so it stays hidden from assistive tech. */}
          <div
            className="composer-resize"
            aria-hidden="true"
            title="Drag to resize · double-click for auto-fit"
            onPointerDown={beginResize}
            onPointerMove={dragResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onDoubleClick={resetManualHeight}
          >
            <i />
          </div>
          {/* Above the textarea so the images you are about to send sit between
              you and the agent, not under the keyboard. */}
          {attachments.length > 0 || preparing || attachErrors.length > 0 ? (
            <div className="attach-tray">
              {attachments.map((image, index) => (
                <span className="attach-chip" key={`${index}:${image.name}`}>
                  <img src={image.previewUrl} alt={image.name} />
                  <button
                    type="button"
                    className="attach-remove"
                    onClick={() => onAttachmentsChange(attachments.filter((_, i) => i !== index))}
                    title={`Remove ${image.name}`}
                    aria-label={`Remove ${image.name}`}
                  >
                    <Icon name="close" />
                  </button>
                </span>
              ))}
              {preparing ? <span className="attach-note">Adding…</span> : null}
              {attachments.length > 0 ? (
                <span
                  className="attach-count"
                  title={`${attachments.length} of ${MAX_IMAGES_PER_MESSAGE} images`}
                >
                  {attachments.length}/{MAX_IMAGES_PER_MESSAGE}
                </span>
              ) : null}
              {attachErrors.map((line) => (
                <span className="attach-error" key={line} role="alert">
                  {line}
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            value={value}
            rows={1}
            className={manualHeight !== null ? "manual" : undefined}
            placeholder={disabled ? "Select a conversation" : "Message the agent…"}
            disabled={disabled}
            onPaste={(event) => {
              // A screenshot on the clipboard — the primary mobile attach path,
              // since phone keyboards paste images here rather than the box.
              const files = Array.from(event.clipboardData?.files ?? []);
              if (files.length > 0) {
                event.preventDefault();
                void addFiles(files);
              }
            }}
            onChange={(event) => {
              // Editing a recalled message makes it the draft.
              cursorRef.current = AT_DRAFT;
              setValue(event.target.value);
              remember(event.target.value);
              setHighlight(0);
              setDismissed(false);
              fitToContent(event.target, manualRef.current !== null);
            }}
            onKeyDown={(event) => {
              // An IME mid-composition owns every key; the send button is still
              // there for anyone who needs it.
              if (event.nativeEvent.isComposing) return;

              if (active) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setHighlight((highlighted + step + suggestions.length) % suggestions.length);
                  return;
                }
                if (event.key === "Tab") {
                  event.preventDefault();
                  complete(active.id);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDismissed(true);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && enterSends()) {
                  // The popover is open, so Enter takes the highlighted command
                  // rather than sending a half-typed name to the agent.
                  event.preventDefault();
                  choose(active);
                  return;
                }
              }

              if (
                (event.key === "ArrowUp" || event.key === "ArrowDown") &&
                !event.shiftKey &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey
              ) {
                const target = event.currentTarget;
                if (
                  caretAllowsHistory(
                    event.key,
                    target.value,
                    target.selectionStart,
                    target.selectionEnd,
                  )
                ) {
                  const step =
                    event.key === "ArrowUp"
                      ? historyUp(history, cursorRef.current, value)
                      : historyDown(history, cursorRef.current);
                  if (step) {
                    event.preventDefault();
                    cursorRef.current = step.cursor;
                    recall(step.value);
                    return;
                  }
                }
              }

              // Enter sends; Shift+Enter is a newline. On a phone Enter is always a
              // newline and only the send button sends (see `enterSends`).
              if (event.key === "Enter" && !event.shiftKey && enterSends()) {
                event.preventDefault();
                submit();
              }
            }}
            aria-controls={active ? "composer-suggestions" : undefined}
            aria-activedescendant={active ? `composer-suggestion-${active.id}` : undefined}
          />

          <div className="composer-row">
            {/* Only the switcher on the left; every other control clusters by the
                send button, under the thumb. The switcher button is phone-only —
                the desktop has the pinned sidebar. */}
            <button
              type="button"
              className="icon-button flat switcher-button"
              onClick={onOpenSwitcher}
              title="Agents and conversations"
              aria-label="Agents and conversations"
            >
              <Icon name="chats" />
            </button>

            <span className="spacer" />

            {/* The file input is invisible; the button is the label. `accept`
                keeps a phone's picker on the photo library, and `multiple`
                matches how screenshots get grabbed. */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="attach-input"
              tabIndex={-1}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                // Clear the input so picking the same file twice re-adds it.
                event.target.value = "";
                void addFiles(files);
              }}
            />
            <button
              type="button"
              className="icon-button flat"
              disabled={disabled || attachments.length >= MAX_IMAGES_PER_MESSAGE}
              onClick={() => fileInputRef.current?.click()}
              title={`Attach images (${attachments.length}/${MAX_IMAGES_PER_MESSAGE})`}
              aria-label="Attach images"
            >
              <Icon name="attach" />
            </button>

            <button
              type="button"
              className={`icon-button flat${filters.size > 0 ? " on" : ""}`}
              onClick={() => setSheet("filters")}
              title={
                filters.size > 0 ? `Filters (${filters.size} active)` : "Filter the transcript"
              }
              aria-label={
                filters.size > 0 ? `Filters, ${filters.size} active` : "Filter the transcript"
              }
            >
              <Icon name="filter" />
              {filters.size > 0 ? <span className="badge">{filters.size}</span> : null}
            </button>

            {/* Icon only: the shield's colour carries the mode, ordered by how
              much the agent may do without asking. Colour is never the sole
              channel — the accessible name spells the mode out, and the sheet
              marks the current one. */}
            <button
              type="button"
              className={`icon-button flat mode-${permissionMode ?? "unknown"}`}
              disabled={disabled}
              onClick={() => setSheet("permissions")}
              title={`Permission mode: ${modeLabel}`}
              aria-label={`Permission mode: ${modeLabel}`}
            >
              <Icon name="shield" />
            </button>

            {structuredSupported ? (
              <button
                type="button"
                className={`icon-button flat${structuredEnabled ? " on" : ""}`}
                onClick={() => setSheet("structured")}
                title={
                  structuredEnabled
                    ? "JSON output is required for the next message"
                    : "Require JSON output"
                }
                aria-label={
                  structuredEnabled
                    ? "JSON output required for the next message"
                    : "Require JSON output"
                }
              >
                <Icon name="braces" />
              </button>
            ) : null}

            <button
              type="button"
              className="icon-button flat model-btn"
              disabled={modelsDisabled}
              onClick={onOpenModels}
              title={modelLabel ? `Model: ${modelLabel}` : "Model for this conversation"}
              aria-label={modelLabel ? `Model: ${modelLabel}` : "Model for this conversation"}
            >
              <Icon name="model" />
              {modelLabel ? <span className="model-name">{modelLabel}</span> : null}
            </button>

            {processing ? (
              hasContent ? (
                // Text in the box while the agent works: send stays send — it
                // queues (upstream drains whatever arrives mid-turn) and the
                // queue chip grows steer / edit / delete actions.
                <button
                  type="submit"
                  className="glyph-btn go"
                  title="Queue this message"
                  aria-label="Queue this message"
                >
                  <Icon name="up" />
                </button>
              ) : stopping ? (
                // A second abort while the first is still unwinding is a
                // guaranteed no-op upstream (`handleAbortMessageInput` returns
                // early once the turn lifecycle is `cancelling`), so the button
                // stops offering it and pulses instead.
                <button
                  type="button"
                  className="glyph-btn halt pending"
                  disabled
                  title="Stopping…"
                  aria-label="Stopping"
                >
                  <Icon name="stop" />
                </button>
              ) : (
                <button
                  type="button"
                  className="glyph-btn halt"
                  onClick={onAbort}
                  title="Stop"
                  aria-label="Stop generating"
                >
                  <Icon name="stop" />
                </button>
              )
            ) : (
              <button
                type="submit"
                className="glyph-btn go"
                disabled={disabled || preparing || !hasContent}
                title="Send"
                aria-label="Send message"
              >
                <Icon name="up" />
              </button>
            )}
          </div>
        </div>
      </form>

      {sheet === "filters" ? (
        <FilterSheet
          active={filters}
          onToggle={onToggleFilter}
          onClear={onClearFilters}
          showTimestamps={showTimestamps}
          onShowTimestamps={onShowTimestamps}
          onClose={() => setSheet(null)}
        />
      ) : null}

      {sheet === "permissions" ? (
        <PermissionSheet
          current={permissionMode}
          onPick={onPermissionMode}
          onClose={() => setSheet(null)}
        />
      ) : null}

      {sheet === "structured" ? (
        <StructuredOutputSheet
          text={structuredText}
          enabled={structuredEnabled}
          onText={(next) => onStructuredChange(next, structuredEnabled)}
          onEnabled={(next) => onStructuredChange(structuredText, next)}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}
