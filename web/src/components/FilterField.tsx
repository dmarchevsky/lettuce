/**
 * The "Filter by name…" box over a long list (models, branches). Never
 * autofocused: on a phone that opens the keyboard over half the sheet before
 * anyone asked to type. Escape clears a typed query first; only an empty box
 * lets it through to close the sheet.
 *
 * Without a `label` the placeholder is the whole prompt, and the input's
 * accessible name. `pinned`, for a box that is the first thing in a sheet,
 * keeps it in view while the list scrolls and holds the sheet's height
 * (`.filter-field.pinned` in styles.css).
 */
export function FilterField({
  label,
  placeholder,
  value,
  onChange,
  pinned = false,
}: {
  label?: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  pinned?: boolean;
}) {
  return (
    <label className={`field filter-field${pinned ? " pinned" : ""}`}>
      {label}
      <input
        value={value}
        placeholder={placeholder}
        aria-label={label ? undefined : placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || value === "") return;
          // Sheet's Escape listener is on `document`, above React's root, so
          // stopping it here keeps the sheet open.
          event.stopPropagation();
          onChange("");
        }}
      />
    </label>
  );
}
