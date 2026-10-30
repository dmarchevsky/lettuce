/**
 * An unsent message, kept across a tab switch.
 *
 * The composer lives inside the `tab === "Chat"` branch of the workspace, so
 * moving to Files/Tasks/Memory/Settings unmounts it and its `useState` text is
 * gone. Persisting the in-progress text here means switching away and back —
 * or reloading — leaves what you had typed in place.
 *
 * Keyed per conversation (`<agentId>::<conversationId>`), so two conversations
 * do not share one draft. The map is bounded: past `MAX_DRAFTS` distinct
 * conversations the oldest entry is dropped, so a long-lived browser cannot
 * grow this without limit. Storage failures degrade to "no draft" — see
 * `./storage.ts`.
 */
import { defaultStorage, type MaybeStorage, readStored } from "./storage.ts";

const KEY = "lettuce:draft";
const MAX_DRAFTS = 20;

/** `order` is oldest-first; `drafts` is the text by conversation key. */
interface DraftStore {
  order: string[];
  drafts: Record<string, string>;
}

const EMPTY_STORE: DraftStore = { order: [], drafts: {} };

/** The conversation key a draft is filed under. */
export function draftKey(agentId: string | null, conversationId: string | null): string | null {
  return agentId && conversationId ? `${agentId}::${conversationId}` : null;
}

function readStore(storage: MaybeStorage): DraftStore {
  try {
    const raw = readStored(storage, KEY);
    if (!raw) return EMPTY_STORE;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY_STORE;
    const record = parsed as { order?: unknown; drafts?: unknown };
    const drafts: Record<string, string> = {};
    if (record.drafts && typeof record.drafts === "object") {
      for (const [key, value] of Object.entries(record.drafts as Record<string, unknown>)) {
        if (typeof value === "string") drafts[key] = value;
      }
    }
    const order = Array.isArray(record.order)
      ? record.order.filter((k): k is string => typeof k === "string" && k in drafts)
      : Object.keys(drafts);
    return { order, drafts };
  } catch {
    // Corrupt JSON, or storage that throws on access. Either way: no draft.
    return EMPTY_STORE;
  }
}

function writeStore(storage: MaybeStorage, store: DraftStore): void {
  try {
    storage?.setItem(KEY, JSON.stringify(store));
  } catch {
    // Quota, private mode, disabled storage — none of it is worth an error.
  }
}

/** The saved draft for a conversation, or `""` when there is none. */
export function readDraft(key: string, storage: MaybeStorage = defaultStorage()): string {
  return readStore(storage).drafts[key] ?? "";
}

/**
 * Save (or, for empty text, discard) the draft for a conversation. Silently
 * does nothing when storage is unavailable.
 */
export function writeDraft(
  key: string,
  text: string,
  storage: MaybeStorage = defaultStorage(),
): void {
  const store = readStore(storage);
  const order = store.order.filter((k) => k !== key);
  const drafts = { ...store.drafts };

  if (text) {
    drafts[key] = text;
    order.push(key);
    while (order.length > MAX_DRAFTS) {
      const evicted = order.shift();
      if (evicted !== undefined) delete drafts[evicted];
    }
  } else {
    delete drafts[key];
  }

  writeStore(storage, { order, drafts });
}

/** Drop the draft for a conversation, e.g. once its message has been sent. */
export function clearDraft(key: string, storage: MaybeStorage = defaultStorage()): void {
  writeDraft(key, "", storage);
}

/**
 * Text a button puts in the composer, after whatever is already being typed there
 * rather than over it: the draft is the user's, the addition is only a start.
 */
export function appendToDraft(draft: string, text: string): string {
  const kept = draft.trimEnd();
  return kept ? `${kept}\n\n${text}` : text;
}
