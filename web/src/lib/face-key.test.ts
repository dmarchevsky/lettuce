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
    // A pixel the model painted as the subject at half coverage over the key. Given a
    // ramp wide enough to catch it, solving for the subject is what keeps the halo off.
    const half: Rgb = [110, 10, 75];
    const { rgba, width, height } = frame(16, MAGENTA, {
      x: 4,
      y: 4,
      w: 8,
      h: 8,
      rgb: half,
    });
    expect(keyOut(rgba, width, height, MAGENTA, { near: 60, far: 200 })).toBe(true);
    expect(alphaAt(rgba, 16, 4, 4)).toBeGreaterThan(60);
    expect(alphaAt(rgba, 16, 4, 4)).toBeLessThan(200);
    // Left alone it would still read magenta (110/10/75 leans red-blue); un-mixed it is
    // nearly the black subject it was covering.
    const [r, g, b] = rgbAt(rgba, 16, 4, 4);
    expect(r).toBeLessThan(30);
    expect(g).toBeLessThan(30);
    expect(b).toBeLessThan(30);
  });
});
