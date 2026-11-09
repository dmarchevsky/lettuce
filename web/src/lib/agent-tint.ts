/** Avatar tints, picked by agent id so a given agent keeps its colour everywhere.
 * Exported because the picker offers exactly these: a palette the hash cannot
 * produce would be a second palette to explain.
 *
 * Sixteen, not six: six colours across a handful of agents means two agents that
 * read as the same face, and a tint only earns its keep if it tells them apart at
 * a glance from 34px. The mix is the app's own token colours plus enough
 * neighbours to fill two rows of eight on a phone.
 *
 * Literals, not `var(--accent)` and its friends: a chosen tint is stored, and the
 * BFF accepts a `#rrggbb` literal and nothing else, so a swatch showing a CSS
 * variable was a swatch that could not be saved. */
export const AVATAR_TINTS = [
  "#9ece6a",
  "#7aa2f7",
  "#e0af68",
  "#bb9af7",
  "#7dcfff",
  "#f7768e",
  "#f7a072",
  "#c0caf5",
  "#73daca",
  "#41a6b6",
  "#2ac3de",
  "#b9f27c",
  "#ff9e64",
  "#db4b4b",
  "#e879a6",
  "#cfc9c2",
];

export function tintFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return AVATAR_TINTS[Math.abs(hash) % AVATAR_TINTS.length] ?? "#7aa2f7";
}

/** The avatar's letter. */
export function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

/** What the user chose for one agent (`bff/src/agents/avatar-prefs.ts`). */
export interface AvatarPref {
  tint?: string;
  glyph?: string;
  /** The id of a face in the shared library (`bff/src/agents/avatar-library.ts`). */
  image?: string;
}

export interface AvatarFace {
  background: string;
  content: string;
  /** Set when the face is an uploaded picture rather than a glyph. */
  image?: string;
}

/**
 * Where a stored face is served from. The id is a content hash, so this URL never
 * changes for the same picture — which is what lets the BFF answer it with
 * `immutable`.
 */
export function faceUrl(id: string): string {
  return `/api/avatars/${id}`;
}

/**
 * How many graphemes a string would render as — the glyph picker's cap, so a
 * pasted sentence cannot reach a 22px circle. The BFF validates the same rule at
 * the boundary (`bff/src/agents/avatar-prefs.ts`); this one exists only to say
 * "that is too long" while typing.
 */
export function graphemeCount(value: string): number {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length;
  }
  return [...value].length;
}

/**
 * The precedence every avatar surface must agree on: an uploaded face beats a
 * chosen glyph, which beats the name's initial. `background` is the tint in every
 * case — behind a glyph, and behind an image's transparency, which is what a cut
 * out logo or a drawn mask sits on instead of a white box. With no preference this
 * returns exactly what the avatar was before any of it existed, which is what
 * lets the whole feature ship without touching a single agent.
 */
export function resolveAvatar(id: string, name: string, pref?: AvatarPref): AvatarFace {
  const background = pref?.tint ?? tintFor(id);
  // The glyph or letter is resolved even under a picture, because it is what a
  // surface falls back to when the picture cannot be drawn — see AgentAvatar.
  const content = pref?.glyph || initialOf(name);
  if (pref?.image) return { background, content, image: faceUrl(pref.image) };
  return { background, content };
}
