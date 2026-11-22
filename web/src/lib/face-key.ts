/**
 * Cutting a drawn face out of its background, so the agent's own colour shows through it.
 *
 * A model has no alpha channel to draw with: asking for a transparent background gets a
 * drawn checkerboard or a painted drop shadow. So the draw is asked for one flat colour
 * instead (`bff/src/images/face.ts`, `FACE_BACKGROUND_SUFFIX` — magenta, the colour a
 * drawn subject is least likely to contain) and the colour is removed here, where the
 * pixels already are because the face is being resized anyway.
 *
 * The key is **measured from the frame's own edge**, never assumed: what the model draws
 * for "magenta" is a magenta-ish field (about `rgb(220 20 150)` on the endpoint this was
 * built against, not `#FF00FF`), and a hard-coded key would leave a halo of the colour
 * the model actually used. An edge that is not one colour — a scene that fills the frame,
 * a gradient, a shadow under the subject — is no key at all, and the face stays as it
 * came rather than being eaten from the outside in.
 *
 * Everything here is pure array work on RGBA bytes, so it is testable without a canvas
 * and does the same thing in every browser.
 */

/** One RGB triple. */
type Rgb = [number, number, number];

/** How far a colour is on the way from opaque to transparent, as squared distances. */
export interface KeyBounds {
  /** At or below this distance from the key: fully transparent. */
  near: number;
  /** At or above this distance: untouched. Between them the edge is feathered. */
  far: number;
}

/**
 * The feather spans ~75 points of RGB distance: narrow enough that a flat field keys
 * clean, wide enough that an anti-aliased edge is a soft ramp and not a jagged hole.
 */
const DEFAULT_BOUNDS: KeyBounds = { near: 45, far: 120 };

/** The spread an edge may have and still be called one colour (measured: 0–14). */
const MAX_EDGE_SD = 24;
/** The spread two corners may differ by and still be the same background. */
const MAX_CORNER_SPREAD = 36;
/** How colourful a key must be. A white or grey field would key the subject too. */
const MIN_KEY_CHROMA = 40;
/** Keying more than this of the frame means the subject went with the background. */
const MAX_KEYED_SHARE = 0.95;

function distance(a: Rgb, b: Rgb): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function chroma(rgb: Rgb): number {
  return Math.max(...rgb) - Math.min(...rgb);
}

/**
 * The frame's background colour, or null when it has none.
 *
 * Two independent looks at the edge: the average of the border ring (with its spread) and
 * the four corners (with how far apart they are). Both must agree on one colourful colour,
 * which is what rules out a subject that fills the frame and a background with a gradient
 * or a shadow in it.
 */
export function edgeKeyColour(rgba: Uint8ClampedArray, width: number, height: number): Rgb | null {
  if (width < 8 || height < 8) return null;
  const at = (x: number, y: number): Rgb => {
    const i = (y * width + x) * 4;
    return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!];
  };

  let sum: Rgb = [0, 0, 0];
  let squared: Rgb = [0, 0, 0];
  let count = 0;
  const take = (rgb: Rgb) => {
    sum = [sum[0] + rgb[0], sum[1] + rgb[1], sum[2] + rgb[2]];
    squared = [squared[0] + rgb[0] ** 2, squared[1] + rgb[1] ** 2, squared[2] + rgb[2] ** 2];
    count += 1;
  };
  for (let x = 0; x < width; x += 1) {
    take(at(x, 0));
    take(at(x, height - 1));
  }
  for (let y = 1; y < height - 1; y += 1) {
    take(at(0, y));
    take(at(width - 1, y));
  }

  const mean: Rgb = [
    Math.round(sum[0] / count),
    Math.round(sum[1] / count),
    Math.round(sum[2] / count),
  ];
  const spread: Rgb = [
    Math.sqrt(Math.max(0, squared[0] / count - mean[0] ** 2)),
    Math.sqrt(Math.max(0, squared[1] / count - mean[1] ** 2)),
    Math.sqrt(Math.max(0, squared[2] / count - mean[2] ** 2)),
  ];
  if (Math.max(...spread) > MAX_EDGE_SD) return null;

  const corners: Rgb[] = [at(2, 2), at(width - 3, 2), at(2, height - 3), at(width - 3, height - 3)];
  for (const corner of corners) {
    if (distance(corner, mean) > MAX_CORNER_SPREAD) return null;
  }
  if (chroma(mean) < MIN_KEY_CHROMA) return null;
  return mean;
}

/**
 * Turn the key colour transparent, in place. Returns false and leaves the pixels alone
 * when the key would have eaten the subject.
 *
 * The alpha ramp is measured from the key, and a pixel that only partly matches is
 * **un-mixed** rather than left alone: what the model drew there is the subject bleeding
 * through the background (`p ≈ a·subject + (1-a)·key`), so solving for the subject is what
 * keeps a magenta halo off every edge.
 */
export function keyOut(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  key: Rgb,
  bounds: KeyBounds = DEFAULT_BOUNDS,
): boolean {
  const span = bounds.far - bounds.near;
  const alphas = new Float64Array(width * height);
  let keyed = 0;
  for (let i = 0; i < width * height; i += 1) {
    const at = i * 4;
    const pixel: Rgb = [rgba[at]!, rgba[at + 1]!, rgba[at + 2]!];
    const coverage = Math.min(1, Math.max(0, (distance(pixel, key) - bounds.near) / span));
    alphas[i] = coverage;
    if (coverage === 0) keyed += 1;
  }
  if (keyed / (width * height) > MAX_KEYED_SHARE) return false;

  for (let i = 0; i < width * height; i += 1) {
    const at = i * 4;
    const coverage = alphas[i]!;
    if (coverage === 1) {
      rgba[at + 3] = 255;
      continue;
    }
    if (coverage === 0) {
      rgba[at] = 0;
      rgba[at + 1] = 0;
      rgba[at + 2] = 0;
      rgba[at + 3] = 0;
      continue;
    }
    const back = (channel: number, keyChannel: number) =>
      Math.max(0, Math.min(255, Math.round((channel - (1 - coverage) * keyChannel) / coverage)));
    rgba[at] = back(rgba[at]!, key[0]);
    rgba[at + 1] = back(rgba[at + 1]!, key[1]);
    rgba[at + 2] = back(rgba[at + 2]!, key[2]);
    rgba[at + 3] = Math.round(coverage * 255);
  }
  return true;
}
