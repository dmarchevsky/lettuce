import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  AvatarImageLibrary,
  AvatarRecentGlyphs,
  declaredAvatarSizeViolation,
  deleteFace,
  detectImageKind,
  listFaces,
  MAX_AVATAR_FACES,
  MAX_AVATAR_IMAGE_BYTES,
  MAX_RECENT_GLYPHS,
  readAvatarBody,
  readImageSize,
} from "./avatar-library.ts";
import { AgentAvatarStore } from "./avatar-prefs.ts";

const dirIn = () => mkdtempSync(join(tmpdir(), "faces-"));
const fileIn = () => join(dirIn(), "avatar.json");
const idOf = (result: unknown): string => {
  if (typeof result === "object" && result !== null && "id" in result) return result.id as string;
  throw new Error(`refused: ${JSON.stringify(result)}`);
};

// ── Images built here, byte by byte ─────────────────────────────────────────
// The BFF parses headers and never rasterises, so headers are what these tests
// are about — but a PNG is built as a *real* PNG (CRCs and deflate included) so
// the alpha claim is about a file a browser would actually render.

const be16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
const be32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const le32 = (value: number) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
];
const le24 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** One PNG chunk, CRC included — a decoder reads these, so they are correct. */
const pngChunk = (type: string, payload: number[]): number[] => [
  ...be32(payload.length),
  ...ascii(type),
  ...payload,
  ...be32(crc32(Buffer.from([...ascii(type), ...payload])) >>> 0),
];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ihdr = (width: number, height: number) => [
  ...be32(width),
  ...be32(height),
  8, // bit depth
  6, // colour type 6: truecolour with alpha
  0,
  0,
  0,
];

/** Just a PNG signature and its IHDR: enough for a header that lies about size. */
function pngHeader(width: number, height: number): Uint8Array {
  return Uint8Array.from([...PNG_SIGNATURE, ...pngChunk("IHDR", ihdr(width, height))]);
}

/** A real RGBA PNG; `pixels` is width*height [r,g,b,a] quadruples. */
function png(width: number, height: number, pixels: number[][] = []): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rgba = pixels[y * width + x] ?? [0x11, 0x22, 0x33, 0xff];
      raw.set(rgba, y * (1 + width * 4) + 1 + x * 4);
    }
  }
  return Uint8Array.from([
    ...PNG_SIGNATURE,
    ...pngChunk("IHDR", ihdr(width, height)),
    ...pngChunk("IDAT", [...deflateSync(raw)]),
    ...pngChunk("IEND", []),
  ]);
}

/**
 * A JPEG header chain, same shape as a real file's: `SOF0` carries the
 * dimensions (height first) and that is as far as the library reads — no scan
 * data, because nothing here decodes one.
 */
function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    ...be16(16),
    ...ascii("JFIF\0"),
    1,
    1,
    0,
    ...be16(1),
    ...be16(1),
    0,
    0,
    0xff,
    0xc0, // SOF0
    ...be16(11),
    8, // precision
    ...be16(height),
    ...be16(width),
    1,
    1,
    0x22,
    0,
    0xff,
    0xd9, // EOI
  ]);
}

/** A WebP `VP8X` header, shaped like what a canvas re-encode starts with. */
function webp(width: number, height: number): Uint8Array {
  const payload = [0x10, 0, 0, 0, ...le24(width - 1), ...le24(height - 1), ...le24(0)];
  return Uint8Array.from([
    ...ascii("RIFF"),
    ...le32(4 + 8 + payload.length),
    ...ascii("WEBP"),
    ...ascii("VP8X"),
    ...le32(payload.length),
    ...payload,
  ]);
}

describe("detectImageKind / readImageSize", () => {
  test("the type comes from the bytes", () => {
    expect(detectImageKind(png(4, 4))).toBe("png");
    expect(detectImageKind(jpeg(4, 4))).toBe("jpeg");
    expect(detectImageKind(webp(4, 4))).toBe("webp");
    expect(detectImageKind(new Uint8Array())).toBeNull();
  });

  test("a text file named .webp is not a webp, and neither is an svg", () => {
    // The route never sees a filename at all, which is the point: only the bytes decide.
    expect(detectImageKind(Uint8Array.from(ascii("<html><img src=x></html>")))).toBeNull();
    expect(detectImageKind(Uint8Array.from(ascii('<svg xmlns="x"></svg>')))).toBeNull();
    expect(detectImageKind(Uint8Array.from(ascii("GIF89a")))).toBeNull();
  });

  test("the size is read out of each format's own header", () => {
    expect(readImageSize(png(3, 7), "png")).toEqual({ width: 3, height: 7 });
    expect(readImageSize(jpeg(640, 480), "jpeg")).toEqual({ width: 640, height: 480 });
    expect(readImageSize(webp(512, 512), "webp")).toEqual({ width: 512, height: 512 });
    // A PNG cut off before its IHDR has no size, and no size means no cap.
    expect(readImageSize(png(4, 4).subarray(0, 20), "png")).toBeNull();
  });
});

describe("AvatarImageLibrary", () => {
  test("a png with an alpha channel comes back exactly as it went in", () => {
    const lib = new AvatarImageLibrary(dirIn());
    // Two fully transparent pixels among four: what a cut-out logo looks like.
    const bytes = png(2, 2, [
      [0xff, 0x00, 0x00, 0xff],
      [0x00, 0x00, 0x00, 0x00],
      [0x00, 0xff, 0x00, 0x80],
      [0x00, 0x00, 0xff, 0x00],
    ]);
    const face = lib.get(idOf(lib.put(bytes)));
    expect(face?.contentType).toBe("image/png");
    // Byte-identical is the whole transparency story: no re-encode, no flatten.
    expect([...(face?.bytes ?? [])]).toEqual([...bytes]);
    // Colour type 6 (truecolour + alpha) still says 6 on the way out.
    expect(face?.bytes[25]).toBe(6);
  });

  test("webp and jpeg round-trip with their own content type", () => {
    const lib = new AvatarImageLibrary(dirIn());
    const cases: [Uint8Array, string, string][] = [
      [webp(128, 128), "image/webp", "webp"],
      [jpeg(128, 128), "image/jpeg", "jpeg"],
    ];
    for (const [bytes, contentType, kind] of cases) {
      const id = idOf(lib.put(bytes));
      expect(lib.get(id)?.contentType).toBe(contentType);
      expect([...lib.get(id)!.bytes]).toEqual([...bytes]);
      expect(lib.list().find((entry) => entry.id === id)).toMatchObject({
        kind,
        bytes: bytes.byteLength,
      });
    }
  });

  test("the same bytes are one file, however often they are uploaded", () => {
    const dir = dirIn();
    const lib = new AvatarImageLibrary(dir);
    const bytes = png(8, 8);
    expect(lib.put(bytes)).toEqual(lib.put(bytes));
    expect(readdirSync(dir)).toHaveLength(1);
  });

  test("an id that is not an id never reaches the filesystem", () => {
    const lib = new AvatarImageLibrary(dirIn());
    for (const id of [
      "../../etc/passwd",
      "..%2f..%2fpasswd",
      "ABCDEF0123456789",
      "0123456789abcdefg",
      "0".repeat(15),
      "0".repeat(17),
      "",
    ]) {
      expect(lib.get(id)).toBeNull();
      expect(lib.remove(id)).toBe(false);
    }
  });

  test("an unknown id is null, not an error", () => {
    expect(new AvatarImageLibrary(dirIn()).get("0123456789abcdef")).toBeNull();
  });

  test("a header claiming 4096px is refused before anything is written", () => {
    const dir = dirIn();
    const lib = new AvatarImageLibrary(dir);
    expect(lib.put(pngHeader(4096, 4096))).toMatchObject({ status: 415 });
    expect(lib.put(jpeg(513, 40))).toMatchObject({ status: 415 });
    expect(lib.put(webp(40, 513))).toMatchObject({ status: 415 });
    expect(lib.put(png(512, 512))).toHaveProperty("id");
    expect(readdirSync(dir)).toHaveLength(1);
  });

  test("bytes over the cap are refused, and so is a body that arrives too long", async () => {
    const lib = new AvatarImageLibrary(dirIn());
    const bloated = new Uint8Array(MAX_AVATAR_IMAGE_BYTES + 1);
    bloated.set(png(1, 1));
    expect(lib.put(bloated)).toMatchObject({ status: 413 });

    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readAvatarBody(endless)).toBeNull();
    // Refused *while* reading: it stopped pulling an endless stream, and said so.
    expect(pulled).toBeLessThanOrEqual(Math.ceil(MAX_AVATAR_IMAGE_BYTES / (64 * 1024)) + 1);
    expect(cancelled).toBe(true);
    expect(await readAvatarBody(null)).toEqual(new Uint8Array());
  });

  test("a declared length over the cap is refused before the body is read", () => {
    expect(declaredAvatarSizeViolation(String(MAX_AVATAR_IMAGE_BYTES))).toBeNull();
    expect(declaredAvatarSizeViolation(String(MAX_AVATAR_IMAGE_BYTES + 1))).toContain("KiB");
    // A chunked body carries no header; the byte count is checked while reading.
    expect(declaredAvatarSizeViolation(null)).toBeNull();
  });

  test("the library holds forty faces and refuses the forty-first", () => {
    const dir = dirIn();
    const lib = new AvatarImageLibrary(dir);
    // One face per distinct bytes, and each width below is a distinct byte string.
    for (let width = 1; width <= MAX_AVATAR_FACES; width += 1) {
      expect(lib.put(png(width + 1, 2))).toHaveProperty("id");
    }
    expect(lib.list()).toHaveLength(MAX_AVATAR_FACES);
    expect(lib.put(png(90, 2))).toMatchObject({ status: 409 });
    // Refused, not evicted — and a face it already has is still accepted, because
    // accepting it is a no-op.
    expect(lib.list()).toHaveLength(MAX_AVATAR_FACES);
    expect(lib.put(png(3, 2))).toHaveProperty("id");
    expect(readdirSync(dir)).toHaveLength(MAX_AVATAR_FACES);
  });

  test("a missing directory is an empty library, not a boot failure", () => {
    const lib = new AvatarImageLibrary(join(dirIn(), "never-created"));
    expect(lib.list()).toEqual([]);
    expect(lib.get("0123456789abcdef")).toBeNull();
    expect(lib.remove("0123456789abcdef")).toBe(false);
  });

  test("the newest face is listed first", async () => {
    const lib = new AvatarImageLibrary(dirIn());
    const small = idOf(lib.put(png(2, 2)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const big = idOf(lib.put(png(40, 40)));
    expect(lib.list().map((entry) => entry.id)).toEqual([big, small]);
    expect(lib.list()[0]!.mtime).toBeGreaterThan(lib.list()[1]!.mtime);
  });

  test("a write is atomic: no temp file is left beside the face", () => {
    const dir = dirIn();
    const lib = new AvatarImageLibrary(dir);
    lib.put(png(6, 6));
    expect(readdirSync(dir)).toHaveLength(1);
    expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("remove deletes the file, and deleting twice is a no-op", () => {
    const dir = dirIn();
    const lib = new AvatarImageLibrary(dir);
    const id = idOf(lib.put(webp(16, 16)));
    expect(lib.remove(id)).toBe(true);
    expect(lib.remove(id)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("listFaces / deleteFace", () => {
  test("every face names the agents wearing it", () => {
    const lib = new AvatarImageLibrary(dirIn());
    const prefs = new AgentAvatarStore(fileIn(), () => {});
    const shared = idOf(lib.put(png(5, 5)));
    const own = idOf(lib.put(webp(5, 5)));
    prefs.set("agent-a", { image: shared });
    prefs.set("agent-b", { tint: "#7aa2f7", image: shared });
    prefs.set("agent-c", { image: own });
    prefs.set("agent-d", { glyph: "🦊" });

    const faces = listFaces(lib, prefs);
    expect(faces.find((face) => face.id === shared)?.usedBy).toEqual(["agent-a", "agent-b"]);
    expect(faces.find((face) => face.id === own)?.usedBy).toEqual(["agent-c"]);
    expect(faces.every((face) => face.usedBy.length > 0)).toBe(true);
  });

  test("deleting a face clears it from every pref that used it", () => {
    const lib = new AvatarImageLibrary(dirIn());
    const prefs = new AgentAvatarStore(fileIn(), () => {});
    const id = idOf(lib.put(png(4, 4)));
    prefs.set("agent-a", { tint: "#7aa2f7", image: id });
    prefs.set("agent-b", { image: id });
    prefs.set("agent-c", { glyph: "🦊" });

    const result = deleteFace(lib, prefs, id);
    expect(result.removed).toBe(true);
    expect(result.cleared).toEqual(["agent-a", "agent-b"]);
    // The tint survives the clear: the face went away, not the colour.
    expect(result.avatars["agent-a"]).toEqual({ tint: "#7aa2f7" });
    expect(result.avatars["agent-b"]).toBeUndefined();
    expect(result.avatars["agent-c"]).toEqual({ glyph: "🦊" });
    expect(listFaces(lib, prefs)).toEqual([]);
  });

  test("deleting an unknown face touches nothing", () => {
    const lib = new AvatarImageLibrary(dirIn());
    const prefs = new AgentAvatarStore(fileIn(), () => {});
    prefs.set("agent-a", { glyph: "🦊" });
    expect(deleteFace(lib, prefs, "0123456789abcdef")).toMatchObject({
      removed: false,
      cleared: [],
    });
    expect(prefs.get("agent-a")).toEqual({ glyph: "🦊" });
  });
});

describe("AvatarRecentGlyphs", () => {
  const ELEVEN = ["😀", "😁", "😂", "😃", "😄", "😅", "😆", "😇", "😉", "😊", "🙂"];

  test("a saved glyph goes to the front, not to the end", async () => {
    const file = fileIn();
    const recents = new AvatarRecentGlyphs(file, () => {});
    expect(recents.push("🦊")).toEqual(["🦊"]);
    expect(recents.push("🤖")).toEqual(["🤖", "🦊"]);
    expect(recents.push("🦊")).toEqual(["🦊", "🤖"]);
    await recents.drain();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(["🦊", "🤖"]);
    expect(new AvatarRecentGlyphs(file, () => {}).list()).toEqual(["🦊", "🤖"]);
  });

  test("the list is normalized like a glyph, deduped and capped", () => {
    const recents = new AvatarRecentGlyphs(fileIn(), () => {});
    const over = [...ELEVEN, "🦊", "🦊", "too many graphemes", "", 3, null, "ab"];
    const list = recents.set(over);
    expect(list).toEqual([...ELEVEN, "🦊"]);
    expect(list).toHaveLength(MAX_RECENT_GLYPHS);
    expect(recents.push(undefined)).toEqual(list);
    expect(recents.set("🦊")).toEqual([]);
    expect(recents.set([])).toEqual([]);
  });

  test("an unreadable file means no recents, never a failed boot", () => {
    const file = fileIn();
    writeFileSync(file, "{not json");
    expect(new AvatarRecentGlyphs(file, () => {}).list()).toEqual([]);
    writeFileSync(file, JSON.stringify(["🦊", 3, "too many graphemes"]));
    expect(new AvatarRecentGlyphs(file, () => {}).list()).toEqual(["🦊"]);
    expect(new AvatarRecentGlyphs(join(dirIn(), "missing.json"), () => {}).list()).toEqual([]);
  });
});
