import { describe, expect, test } from "bun:test";
import { edgeKeyColour, keyOut } from "./face-key.ts";

type Rgb = [number, number, number];

const MAGENTA: Rgb = [220, 20, 150];
const BLACK: Rgb = [0, 0, 0];

/** An `n×n` RGBA buffer painted with `fill`, then with `block` painted at x0,y0,w,h. */
function frame(
  n: number,
  fill: Rgb,
  block?: { x: number; y: number; w: number; h: number; rgb: Rgb },
): { rgba: Uint8ClampedArray; width: number; height: number } {
  const rgba = new Uint8ClampedArray(n * n * 4);
  const put = (x: number, y: number, rgb: Rgb) => {
    const i = (y * n + x) * 4;
    rgba[i] = rgb[0];
    rgba[i + 1] = rgb[1];
    rgba[i + 2] = rgb[2];
    rgba[i + 3] = 255;
  };
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) put(x, y, fill);
  if (block) {
    for (let y = block.y; y < block.y + block.h; y += 1) {
      for (let x = block.x; x < block.x + block.w; x += 1) put(x, y, block.rgb);
    }
  }
  return { rgba, width: n, height: n };
}

const alphaAt = (rgba: Uint8ClampedArray, n: number, x: number, y: number) =>
  rgba[(y * n + x) * 4 + 3]!;
const rgbAt = (rgba: Uint8ClampedArray, n: number, x: number, y: number): Rgb => {
  const i = (y * n + x) * 4;
  return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!];
};

describe("the background a drawn face came on", () => {
  test("a flat field is the key, measured from the frame rather than assumed", () => {
    // What the endpoint actually draws for "magenta": not #FF00FF, and close enough to
    // itself along the edge that it can be keyed.
    const { rgba, width, height } = frame(16, MAGENTA, {
      x: 5,
      y: 5,
      w: 6,
      h: 6,
      rgb: BLACK,
    });
    expect(edgeKeyColour(rgba, width, height)).toEqual(MAGENTA);
    expect(keyOut(rgba, width, height, MAGENTA)).toBe(true);
    expect(alphaAt(rgba, 16, 1, 1)).toBe(0);
    expect(alphaAt(rgba, 16, 8, 8)).toBe(255);
  });

  test("an edge that is not one colour is no key at all", () => {
    const { rgba, width, height } = frame(16, MAGENTA, {
      x: 0,
      y: 0,
      w: 8,
      h: 16,
      rgb: [20, 220, 200],
    });
    expect(edgeKeyColour(rgba, width, height)).toBeNull();
  });

  test("a white or grey field is not a key — it would eat the subject with it", () => {
    const { rgba, width, height } = frame(16, [250, 250, 250], {
      x: 5,
      y: 5,
      w: 6,
      h: 6,
      rgb: BLACK,
    });
    expect(edgeKeyColour(rgba, width, height)).toBeNull();
  });

  test("a subject that fills the frame is left exactly as it came", () => {
    // A dark red field is colourful enough to look like a key, so the share guard is
    // what saves it: keying this would remove the whole picture.
    const { rgba, width, height } = frame(16, [70, 12, 12]);
    const before = [...rgba];
    const key = edgeKeyColour(rgba, width, height);
    expect(key).not.toBeNull();
    expect(keyOut(rgba, width, height, key!)).toBe(false);
    expect([...rgba]).toEqual(before);
  });

  test("an edge pixel is un-mixed back toward the subject, not left tinted magenta", () => {
    // A 1 px rim the model painted as the subject bleeding through the background — the
    // pixels between a black subject and the magenta field. Solving the mix for the
    // subject is what keeps a magenta halo off every edge, so the rim must come back black
    // at partial alpha rather than magenta at partial alpha.
    const n = 40;
    const half: Rgb = [110, 10, 75];
    const { rgba, width, height } = frame(n, MAGENTA, {
      x: 12,
      y: 12,
      w: 16,
      h: 16,
      rgb: BLACK,
    });
    const rim = (x: number, y: number) => {
      const i = (y * n + x) * 4;
      rgba[i] = half[0];
      rgba[i + 1] = half[1];
      rgba[i + 2] = half[2];
    };
    for (let k = 11; k < 29; k += 1) {
      rim(k, 11);
      rim(k, 28);
      rim(11, k);
      rim(28, k);
    }
    // A ramp wide enough to hold the half-mix at its middle: this pixel is 133 points from
    // the key, so at half coverage it sits at (90 + 180) / 2.
    expect(keyOut(rgba, width, height, MAGENTA, { near: 90, far: 180 })).toBe(true);
    expect(alphaAt(rgba, n, 1, 1)).toBe(0);
    expect(alphaAt(rgba, n, 20, 20)).toBe(255);
    expect(alphaAt(rgba, n, 20, 11)).toBeGreaterThan(60);
    expect(alphaAt(rgba, n, 20, 11)).toBeLessThan(200);
    expect(rgbAt(rgba, n, 20, 11)).toEqual(BLACK);
  });

  test("a subject that wears the key colour keeps it — only what touches the frame goes", () => {
    // A magenta patch sealed inside the subject is the same colour to a per-pixel test as
    // the field behind it, so the per-pixel version of this keyed a hole through it.
    const { rgba, width, height } = frame(16, MAGENTA, {
      x: 1,
      y: 1,
      w: 14,
      h: 14,
      rgb: BLACK,
    });
    for (let y = 6; y < 10; y += 1) {
      for (let x = 6; x < 10; x += 1) {
        const i = (y * 16 + x) * 4;
        rgba[i] = MAGENTA[0];
        rgba[i + 1] = MAGENTA[1];
        rgba[i + 2] = MAGENTA[2];
      }
    }
    expect(keyOut(rgba, width, height, MAGENTA)).toBe(true);
    expect(alphaAt(rgba, 16, 0, 0)).toBe(0);
    expect(alphaAt(rgba, 16, 2, 2)).toBe(255);
    expect(alphaAt(rgba, 16, 7, 7)).toBe(255);
    expect(rgbAt(rgba, 16, 7, 7)).toEqual(MAGENTA);
  });

  test("the shipped ramp keys what the real endpoint draws, jitter and all", () => {
    // Measured on the endpoint this was built against: border means around
    // rgb(206–229, 8–33, 116–155) with a per-channel spread of 0–14. The default ramp has
    // to key that whole field without help, or the tuning is fiction.
    const n = 64;
    const rgba = new Uint8ClampedArray(n * n * 4);
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const i = (y * n + x) * 4;
        rgba[i] = 213 - 14 + ((x * 7 + y * 3) % 28);
        rgba[i + 1] = 20 - 7 + ((x * 5 + y * 11) % 15);
        rgba[i + 2] = 145 - 14 + ((x * 13 + y) % 28);
        rgba[i + 3] = 255;
      }
    }
    // A subject big enough to hold the share guard down.
    for (let y = 16; y < 48; y += 1) {
      for (let x = 16; x < 48; x += 1) {
        const i = (y * n + x) * 4;
        rgba[i] = 40;
        rgba[i + 1] = 90;
        rgba[i + 2] = 60;
      }
    }
    const key = edgeKeyColour(rgba, n, n);
    expect(key).not.toBeNull();
    expect(keyOut(rgba, n, n, key!)).toBe(true);
    let clear = 0;
    for (let i = 0; i < n * n; i += 1) if (rgba[i * 4 + 3] === 0) clear += 1;
    expect(clear / (n * n)).toBeGreaterThan(0.6);
    expect(alphaAt(rgba, n, 32, 32)).toBe(255);
  });

  test("paint in the corners is not a background — no vignette, no shadow", () => {
    // Four dark patches, one in each corner: small enough that the ring still averages one
    // colour, far enough from it that the corners disagree with their own frame.
    const n = 128;
    const { rgba, width, height } = frame(n, MAGENTA);
    for (const [ox, oy] of [
      [0, 0],
      [n - 3, 0],
      [0, n - 3],
      [n - 3, n - 3],
    ] as [number, number][]) {
      for (let y = oy; y < oy + 3; y += 1) {
        for (let x = ox; x < ox + 3; x += 1) {
          const i = (y * n + x) * 4;
          rgba[i] = 150;
          rgba[i + 1] = 8;
          rgba[i + 2] = 80;
        }
      }
    }
    expect(edgeKeyColour(rgba, width, height)).toBeNull();
  });
});
