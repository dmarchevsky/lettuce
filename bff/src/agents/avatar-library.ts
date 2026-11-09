/**
 * The library of uploaded agent faces, and the recent-glyph list that shares
 * their volume.
 *
 * Ours, not upstream's: the protocol has no avatar field at all, so the choice
 * lives here next to the tint and glyph prefs (`agents/avatar-prefs.ts`) and for
 * the same reason — a phone and a laptop must agree on what each agent looks
 * like. Stored **content-addressed**: the file name is the first 16 hex
 * characters of the picture's sha256, so the directory *is* the index (no
 * manifest to drift), re-uploading a picture is a no-op, and the URL a browser
 * caches forever is a hash of what it fetches.
 *
 * **The BFF never rasterises and never re-encodes.** The client resizes to 128px
 * and picks the format (webp, so a cut-out keeps its alpha and the agent's tint
 * shows through); this module only checks what it can check without a codec: the
 * type comes from the magic bytes — the client's `Content-Type` is never
 * trusted, it is attacker text — a byte cap, and the width and height read out of
 * the image header. A header lying about its size costs nothing: the file is
 * still 512 KiB of bytes we serve as-is. Bytes are stored exactly as received,
 * which is what keeps transparency intact.
 *
 * Nothing user-controlled becomes a path: the id is matched against a fixed
 * pattern *before* it is joined to the directory, and the name written is derived
 * from a hash of the content.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type AgentAvatarPref,
  type AgentAvatarStore,
  isAvatarImageId,
  normalizeGlyph,
} from "./avatar-prefs.ts";

/**
 * Longest accepted upload. A 128px webp face is tens of kilobytes, so this is
 * room for a PNG of the same size and a refusal for anything else — and it is
 * enforced *while reading* (see `readAvatarBody`), not after buffering.
 */
export const MAX_AVATAR_IMAGE_BYTES = 512 * 1024;
/** Refused above this on either side: a face is drawn at 34px at best. */
export const MAX_AVATAR_IMAGE_DIMENSION = 512;
/**
 * Library size. Over the cap a new face is *refused*, not evicted: an agent's
 * face changing behind the user's head is worse than a message saying the
 * library is full.
 */
export const MAX_AVATAR_FACES = 40;
/** How many recent glyphs the sheet remembers. */
export const MAX_RECENT_GLYPHS = 12;

export type AvatarImageKind = "png" | "jpeg" | "webp";

const EXTENSION: Record<AvatarImageKind, string> = { png: ".png", jpeg: ".jpg", webp: ".webp" };
const CONTENT_TYPE: Record<AvatarImageKind, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
const KIND_BY_EXTENSION: Record<string, AvatarImageKind> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".webp": "webp",
};

/** One stored face as the UI lists it (`bytes` is its size, not its payload). */
export interface AvatarImageEntry {
  id: string;
  bytes: number;
  /** Epoch milliseconds of the last write — a re-upload is a no-op, so this is when it arrived. */
  mtime: number;
  kind: AvatarImageKind;
}

/** A face plus which agents are wearing it — what `listFaces` answers. */
export interface AvatarFaceEntry extends AvatarImageEntry {
  usedBy: string[];
}

/** Why a face was refused, with the status the route should answer, or the stored id. */
export type PutAvatarImageResult =
  | { id: string }
  | { error: string; status: 409 | 413 | 415 | 500 };

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function asciiAt(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) =>
  ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32le = (b: Uint8Array, i: number) =>
  (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

/** What this really is, from its magic bytes, or null when it is not an accepted image. */
export function detectImageKind(bytes: Uint8Array): AvatarImageKind | null {
  if (PNG_MAGIC.every((byte, i) => bytes[i] === byte) && bytes.length >= PNG_MAGIC.length) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "webp";
  return null;
}

/**
 * The declared size, read out of the header: PNG `IHDR`, JPEG `SOF0/2`, WebP
 * `VP8X`/`VP8L`/`VP8 `. Null when it cannot be read, which is a refusal too —
 * an image whose size is unknowable is an image whose cap is unknowable.
 */
export function readImageSize(
  bytes: Uint8Array,
  kind: AvatarImageKind,
): { width: number; height: number } | null {
  if (kind === "png") {
    if (!asciiAt(bytes, 12, "IHDR") || bytes.length < 24) return null;
    return positive(u32be(bytes, 16), u32be(bytes, 20));
  }
  if (kind === "jpeg") return jpegSize(bytes);
  return webpSize(bytes);
}

function positive(width: number, height: number) {
  return width > 0 && height > 0 ? { width, height } : null;
}

/** JPEG is a marker chain; the frame header (`SOFn`) carries the dimensions. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    // Standalone markers aside, a segment states its own length including it.
    const length = u16be(bytes, at + 2);
    if (length < 2) return null;
    // 0xC0 baseline, 0xC2 progressive; 0xC4 (DHT), 0xC8 (reserved) and 0xCC (DAC)
    // are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // precision(1), height(2), width(2) — height first, which is the trap.
      return positive(u16be(bytes, at + 7), u16be(bytes, at + 5));
    }
    at += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 20) return null;
  const chunk = asciiAt(bytes, 12, "VP8X")
    ? "VP8X"
    : asciiAt(bytes, 12, "VP8L")
      ? "VP8L"
      : asciiAt(bytes, 12, "VP8 ")
        ? "VP8 "
        : null;
  if (chunk === "VP8X") {
    if (bytes.length < 30) return null;
    return positive(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
  }
  if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const bits = u32le(bytes, 21);
    return positive((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8 ") {
    // A keyframe hides its size behind a 3-byte start code, a few bytes into the
    // payload; the frame tag before it is 1–3 bytes, so look for the code rather
    // than assume an offset.
    for (let at = 20; at + 7 < bytes.length; at += 1) {
      if (bytes[at] === 0x9d && bytes[at + 1] === 0x01 && bytes[at + 2] === 0x2a) {
        return positive((u16le(bytes, at + 3) & 0x3fff) + 1, (u16le(bytes, at + 5) & 0x3fff) + 1);
      }
    }
    return null;
  }
  return null;
}

export class AvatarImageLibrary {
  constructor(private readonly dir: string) {}

  /**
   * Validate, then store. Dedupe is free: the name is the hash, so the same bytes
   * land on the same file and the second upload writes nothing.
   */
  put(bytes: Uint8Array): PutAvatarImageResult {
    const kind = detectImageKind(bytes);
    if (!kind) return { status: 415, error: "Upload a png, jpeg or webp image" };
    if (bytes.length > MAX_AVATAR_IMAGE_BYTES) {
      return {
        status: 413,
        error: `A face is at most ${MAX_AVATAR_IMAGE_BYTES / 1024} KiB`,
      };
    }
    const size = readImageSize(bytes, kind);
    if (!size) {
      return { status: 415, error: "Could not read the image dimensions" };
    }
    if (size.width > MAX_AVATAR_IMAGE_DIMENSION || size.height > MAX_AVATAR_IMAGE_DIMENSION) {
      return {
        status: 415,
        error: `An image must be ${MAX_AVATAR_IMAGE_DIMENSION}px or smaller (this one is ${size.width}x${size.height})`,
      };
    }
    const id = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const path = join(this.dir, `${id}${EXTENSION[kind]}`);
    if (!existsSync(path)) {
      if (this.list().length >= MAX_AVATAR_FACES) {
        return {
          status: 409,
          error: `The face library holds ${MAX_AVATAR_FACES} images; delete one first`,
        };
      }
      mkdirSync(this.dir, { recursive: true });
      try {
        // Same discipline as the prefs store: a half-written file is never what
        // the next reader sees, and a unique temp name keeps two concurrent
        // uploads out of each other's bytes.
        const temp = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temp, bytes);
        renameSync(temp, path);
      } catch {
        return { status: 500, error: "Failed to store the image" };
      }
    }
    return { id };
  }

  /** The bytes and their type, or null for an unknown or malformed id. */
  get(id: string): { bytes: Buffer; contentType: string } | null {
    const found = this.find(id);
    if (!found) return null;
    try {
      return { bytes: readFileSync(found.path), contentType: CONTENT_TYPE[found.kind] };
    } catch {
      return null;
    }
  }

  /**
   * Every stored face, newest first — the library strip lists what was added
   * most recently at the top, and an upload lands in front of the user.
   */
  list(): AvatarImageEntry[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      // A missing or unreadable directory is an empty library: faces fall back to
      // their letter, they do not stop the BFF booting.
      return [];
    }
    const entries: AvatarImageEntry[] = [];
    for (const name of names) {
      const dot = name.lastIndexOf(".");
      const id = name.slice(0, dot);
      const kind = KIND_BY_EXTENSION[name.slice(dot)];
      if (!kind || !isAvatarImageId(id)) continue;
      try {
        const stat = statSync(join(this.dir, name));
        entries.push({ id, kind, bytes: stat.size, mtime: Math.round(stat.mtimeMs) });
      } catch {
        // Deleted between the listing and the stat; it will be gone next time.
      }
    }
    return entries.sort((a, b) => b.mtime - a.mtime);
  }

  /** Delete one face. An unknown id is a no-op, not an error. */
  remove(id: string): boolean {
    const found = this.find(id);
    if (!found) return false;
    try {
      unlinkSync(found.path);
      return true;
    } catch {
      return false;
    }
  }

  private find(id: string): { path: string; kind: AvatarImageKind } | null {
    // The pattern check is first and absolute: nothing reaches `join` until it
    // has passed, so `../..`, a `%2f` or an uppercase id is simply not an id.
    if (!isAvatarImageId(id)) return null;
    for (const [extension, kind] of Object.entries(KIND_BY_EXTENSION)) {
      const path = join(this.dir, `${id}${extension}`);
      if (existsSync(path)) return { path, kind };
    }
    return null;
  }
}

/**
 * The recent glyphs, most-recently-saved first. A list, not a per-agent thing:
 * what you reach for is a habit, and habits are shared between devices — which is
 * why this lives on the server at all.
 */
export class AvatarRecentGlyphs {
  private glyphs: string[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly onWriteError: (error: unknown) => void,
  ) {
    if (!existsSync(filePath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (Array.isArray(parsed)) this.set(parsed);
    } catch {
      // Unreadable: the sheet shows no recents, which is a smaller deal than a
      // BFF that will not start.
    }
  }

  list(): string[] {
    return [...this.glyphs];
  }

  /**
   * Replace the list. Every entry goes through `normalizeGlyph`, so a recent is
   * held to the same 1–2 grapheme rule as a chosen glyph, and the cap is applied
   * here rather than trusted from the caller.
   */
  set(values: unknown): string[] {
    const next: string[] = [];
    if (Array.isArray(values)) {
      for (const value of values) {
        if (typeof value !== "string") continue;
        const glyph = normalizeGlyph(value);
        if (glyph && !next.includes(glyph)) next.push(glyph);
        if (next.length >= MAX_RECENT_GLYPHS) break;
      }
    }
    this.glyphs = next;
    this.persist();
    return this.list();
  }

  /** Record a glyph that was just saved: to the front, deduped, capped. */
  push(glyph: string | undefined): string[] {
    if (!glyph) return this.list();
    return this.set([glyph, ...this.glyphs]);
  }

  /** Resolves once every queued write has settled; never rejects. */
  drain(): Promise<void> {
    return this.writeQueue;
  }

  private persist(): void {
    const snapshot = JSON.stringify(this.glyphs, null, 2);
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => {
        try {
          mkdirSync(join(this.filePath, ".."), { recursive: true });
          const temp = `${this.filePath}.tmp`;
          writeFileSync(temp, snapshot);
          renameSync(temp, this.filePath);
        } catch (error) {
          this.onWriteError(error);
        }
      });
  }
}

// ── Reading the body ────────────────────────────────────────────────────────
// The workspace upload route (`files/upload.ts`) allows 25 MB because a phone
// sends real documents; a face is two orders of magnitude smaller and the same
// rule applies at that size, so this route carries its own cap instead of
// importing a number that would be wrong here.

/** Why this body must be refused before it is read, or null when it may be read. */
export function declaredAvatarSizeViolation(contentLength: string | null): string | null {
  const declared = Number(contentLength);
  // A chunked request has no header; NaN fails the comparison and the byte count
  // is checked while reading instead.
  if (Number.isFinite(declared) && declared > MAX_AVATAR_IMAGE_BYTES) {
    return `A face is at most ${MAX_AVATAR_IMAGE_BYTES / 1024} KiB`;
  }
  return null;
}

/** The bytes, or null when they exceeded the cap. Read chunk-wise so an
 * over-long body is refused while it arrives, not after it is buffered. */
export async function readAvatarBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let next = await reader.read();
  while (!next.done) {
    total += next.value.byteLength;
    if (total > MAX_AVATAR_IMAGE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
    next = await reader.read();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// ── The two places faces and prefs meet ─────────────────────────────────────
// Both the list and the delete answer need the library joined against the prefs
// store, and `index.ts` cannot be imported by a test — so the join lives here,
// where "delete a face and every agent wearing it falls back to its letter" is
// something a unit test can actually assert.

/** Every stored face plus who is wearing it, newest first. */
export function listFaces(images: AvatarImageLibrary, prefs: AgentAvatarStore): AvatarFaceEntry[] {
  const used = new Map<string, string[]>();
  for (const [agentId, pref] of Object.entries(prefs.all())) {
    if (!pref.image) continue;
    const owners = used.get(pref.image) ?? [];
    owners.push(agentId);
    used.set(pref.image, owners);
  }
  return images.list().map((entry) => ({ ...entry, usedBy: used.get(entry.id) ?? [] }));
}

/**
 * Delete a face and clear it from every pref that referenced it, so no agent is
 * left pointing at bytes that are gone (and no `<img>` is left broken). Returns
 * the agents that fell back to their letter, which is what the UI says out loud.
 */
export function deleteFace(
  images: AvatarImageLibrary,
  prefs: AgentAvatarStore,
  id: string,
): { removed: boolean; cleared: string[]; avatars: Record<string, AgentAvatarPref> } {
  const cleared: string[] = [];
  for (const [agentId, pref] of Object.entries(prefs.all())) {
    if (pref.image !== id) continue;
    const { image: _image, ...rest } = pref;
    prefs.set(agentId, rest);
    cleared.push(agentId);
  }
  const removed = images.remove(id);
  return { removed, cleared, avatars: prefs.all() };
}
