/**
 * The transcript filter, remembered per browser.
 *
 * What kinds of message you want to read is a reading preference like the
 * timestamps toggle — not conversation state — so it lives in `localStorage` and
 * nothing server-side has to know it. One key holds both halves: which groups are
 * shown (the empty set meaning every group, the representation `isShown` uses) and
 * which detail switches are off.
 *
 * A stored value is treated as hostile input: an unknown name is a feature that
 * went away (or a hand-edited key), so it is dropped rather than honoured, and
 * anything unparsable falls back to "everything".
 */
import { DETAIL_ORDER, FILTER_ORDER, type FilterDetail, type FilterGroup } from "./messages.ts";
import { defaultStorage, type MaybeStorage, readStored } from "./storage.ts";

const KEY = "lettuce:filters";

export interface Filters {
  /** Groups to show; empty means every group. */
  groups: ReadonlySet<FilterGroup>;
  /** Detail switches off; empty means all shown. */
  hidden: ReadonlySet<FilterDetail>;
}

interface Stored {
  show?: unknown;
  hide?: unknown;
}

/** Everything on screen — what a fresh browser, junk in the key and a Reset all mean. */
function everything(): Filters {
  return { groups: new Set(), hidden: new Set() };
}

/** Only the names this build knows, in its own order — so a stale key cannot add one. */
function keep<T extends string>(names: readonly T[], value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  const listed = new Set(value.filter((v): v is string => typeof v === "string"));
  return names.filter((name) => listed.has(name));
}

export function readFilters(storage: MaybeStorage = defaultStorage()): Filters {
  const raw = readStored(storage, KEY);
  if (!raw) return everything();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return everything();
  }
  if (!parsed || typeof parsed !== "object") return everything();
  const { show, hide } = parsed as Stored;
  const shown = keep(FILTER_ORDER, show);
  return {
    // All five shown is the same thing as none listed; normalise so the sheet and
    // the badge read the default the same way from either source.
    groups: new Set(shown.length === FILTER_ORDER.length ? [] : shown),
    hidden: new Set(keep(DETAIL_ORDER, hide)),
  };
}

export function writeFilters(filters: Filters, storage: MaybeStorage = defaultStorage()): void {
  try {
    const shown = FILTER_ORDER.filter((group) => filters.groups.has(group));
    storage?.setItem(
      KEY,
      JSON.stringify({
        // Same canonical form `readFilters` returns: all five listed *is* the default.
        show: shown.length === FILTER_ORDER.length ? [] : shown,
        hide: DETAIL_ORDER.filter((detail) => filters.hidden.has(detail)),
      }),
    );
  } catch {
    // No memory is fine — the sheet still works for this page.
  }
}
