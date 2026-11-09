import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAgentId } from "./id-list.ts";

/**
 * What the user picked for an agent's avatar — a tint, a glyph or an uploaded
 * face — kept by the BFF rather than in the browser so a phone and a laptop agree.
 *
 * Ours, not upstream's: `agent_update` has no avatar field, and the one free-form
 * thing an agent record does carry (`tags`) is what `agents/ancestry.ts` reads
 * for the `parent:` block chain and what the agent can see about itself. A UI
 * preference belongs to neither. Preferences, not state anything depends on: a
 * lost file only means every agent is back to its hash tint and initial.
 *
 * Absent field means "not chosen" and falls through to the default the UI
 * derives from the agent id (`web/src/lib/agent-tint.ts`), so an entry is stored
 * only while it differs from that.
 *
 * `image` is not the bytes and not a path: it is the id of a face in the
 * content-addressed library (`agents/avatar-library.ts`), so the pref file stays
 * small and a face shared by five agents is stored once.
 */
export interface AgentAvatarPref {
  tint?: string;
  glyph?: string;
  image?: string;
}

/** A `#rrggbb` literal — the palette colours are all six-digit. */
const TINT = /^#[0-9a-f]{6}$/i;

/** A face id: the first 16 hex characters of the picture's sha256. */
const IMAGE_ID = /^[0-9a-f]{16}$/;

/** The one shape an `image` may have — also the library's traversal guard. */
export function isAvatarImageId(value: unknown): value is string {
  return typeof value === "string" && IMAGE_ID.test(value);
}

/**
 * Zero-width, bidi and BOM marks: invisible, and they make a grapheme count lie.
 * ZWJ (U+200D) is deliberately NOT one of them — it is what glues a family emoji
 * into the single glyph it renders as.
 */
const INVISIBLE = /[\u200B\u200C\u200E\u200F\u202A-\u202E\u2060\u2061-\u2064\u2066-\u2069\uFEFF]/;

/** Emoji presentation and skin-tone modifiers, stripped before counting. */
const EMOJI_MODIFIERS = /[\uFE0E\uFE0F]|[\u{1F3FB}-\u{1F3FF}]/gu;

const segmenter: Intl.Segmenter | null =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function graphemes(value: string): string[] {
  // Without a segmenter, codepoints: close enough for the cap, and the BFF must
  // never be the reason a device cannot boot.
  if (!segmenter) return [...value];
  return [...segmenter.segment(value)].map((part) => part.segment);
}

/**
 * The glyph as stored, or null when it is not a glyph at all. One to two
 * graphemes so a pasted sentence cannot blow out a 22px circle; modifiers are
 * stripped so 🛠️ is one grapheme, not three. A plain two-letter monogram is
 * accepted on purpose — it is what a two-grapheme cap looks like when someone
 * types instead of picking.
 */
export function normalizeGlyph(raw: string): string | null {
  if (INVISIBLE.test(raw) || /\p{Cc}/u.test(raw)) return null;
  const stripped = raw.replace(EMOJI_MODIFIERS, "").trim();
  if (stripped === "") return null;
  const parts = graphemes(stripped);
  return parts.length >= 1 && parts.length <= 2 ? parts.join("") : null;
}

/**
 * Validates one stored or incoming preference. Returns null for anything that is
 * not a preference at all (so the route answers 400 rather than storing a typo),
 * and `{}` for one that asks for nothing — which the store reads as "default".
 */
export function parseAvatarPref(value: unknown): AgentAvatarPref | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pref: AgentAvatarPref = {};
  if (record.tint !== undefined && record.tint !== null) {
    if (typeof record.tint !== "string" || !TINT.test(record.tint)) return null;
    pref.tint = record.tint.toLowerCase();
  }
  if (record.glyph !== undefined && record.glyph !== null) {
    if (typeof record.glyph !== "string") return null;
    // Empty means "no glyph", not "invalid": clearing is a legitimate write.
    const glyph = normalizeGlyph(record.glyph);
    if (record.glyph.trim() !== "" && glyph === null) return null;
    if (glyph !== null) pref.glyph = glyph;
  }
  if (record.image !== undefined && record.image !== null) {
    // Same rule as the glyph: an empty string clears the field, anything else
    // that is not a face id is a typo.
    if (typeof record.image !== "string") return null;
    const id = record.image.trim();
    if (id !== "" && !isAvatarImageId(id)) return null;
    if (id !== "") pref.image = id;
  }
  return pref;
}

export function isDefaultAvatarPref(pref: AgentAvatarPref): boolean {
  return pref.tint === undefined && pref.glyph === undefined && pref.image === undefined;
}

/** Only agents that chose something are stored; an unknown agent gets the default. */
export class AgentAvatarStore {
  private entries = new Map<string, AgentAvatarPref>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly onWriteError: (error: unknown) => void,
  ) {
    if (!existsSync(filePath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [agentId, raw] of Object.entries(parsed)) {
        const pref = parseAvatarPref(raw);
        if (isAgentId(agentId) && pref && !isDefaultAvatarPref(pref)) {
          this.entries.set(agentId, pref);
        }
      }
    } catch {
      // Unreadable: every agent keeps its derived avatar rather than the BFF failing to boot.
    }
  }

  get(agentId: string): AgentAvatarPref {
    return { ...this.entries.get(agentId) };
  }

  /** Every agent the user has customized — this is what the client fetches. */
  all(): Record<string, AgentAvatarPref> {
    return Object.fromEntries(this.entries);
  }

  /** Returns whether anything changed. An all-default pref removes the entry. */
  set(agentId: string, pref: AgentAvatarPref): boolean {
    if (!isAgentId(agentId)) throw new Error("Not an agent id");
    const current = this.get(agentId);
    const same =
      (current.tint ?? null) === (pref.tint ?? null) &&
      (current.glyph ?? null) === (pref.glyph ?? null) &&
      (current.image ?? null) === (pref.image ?? null);
    if (same) return false;
    if (isDefaultAvatarPref(pref)) this.entries.delete(agentId);
    else this.entries.set(agentId, { ...pref });
    this.persist();
    return true;
  }

  /** Resolves once every queued write has settled; never rejects. */
  drain(): Promise<void> {
    return this.writeQueue;
  }

  private persist(): void {
    const snapshot = JSON.stringify(this.all(), null, 2);
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => {
        try {
          const temp = `${this.filePath}.tmp`;
          writeFileSync(temp, snapshot);
          renameSync(temp, this.filePath);
        } catch (error) {
          this.onWriteError(error);
        }
      });
  }
}
