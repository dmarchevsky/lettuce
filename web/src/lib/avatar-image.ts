/**
 * Turning the file someone picked into a face worth storing.
 *
 * The browser does the resize because it is the only side holding the original: a
 * phone photo is 4000px and several megabytes, and the largest thing in the app
 * that draws a face is the 34px rail — 68 device pixels, so a 128px square is
 * already four times what any surface can show. Uploading the original would put
 * it on the wire four times (rail, switcher, sidebar, header) for nothing, and the
 * BFF has no rasteriser to fix it after the fact: it can refuse an oversized image
 * by reading its header, but it cannot shrink one.
 *
 * Webp at quality 0.85 is the target because it keeps the alpha channel — a cut-out
 * logo or a drawn mask sits on the agent's own colour instead of a white box — and
 * a browser that cannot encode webp falls back to png, which also keeps alpha. A
 * source jpeg has no alpha to keep and simply covers the colour.
 */

/** The edge length every stored face is resized to. */
export const FACE_SIZE = 128;

/** Webp quality: the face is drawn at ~34px, so this is generous. */
const QUALITY = 0.85;

/** Something drawable at a known size, however this browser decoded it. */
interface Drawable {
  width: number;
  height: number;
  source: CanvasImageSource;
  /** Frees the decoded source. Called after the canvas has taken its copy. */
  release?: () => void;
}

async function loadBitmap(source: Blob): Promise<Drawable> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(source);
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      release: () => bitmap.close(),
    };
  }
  // A browser with no `createImageBitmap` still has `<img>`. The object URL is
  // only revoked once the canvas has drawn from it, so the release is handed back
  // rather than done here.
  const url = URL.createObjectURL(source);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not read that image"));
      image.src = url;
    });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    source: image,
    release: () => URL.revokeObjectURL(url),
  };
}

function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (webp) => {
        if (webp && webp.type === "image/webp") {
          resolve(webp);
          return;
        }
        // Safari encoded webp only recently; png is the alpha-preserving fallback.
        canvas.toBlob(
          (png) => (png ? resolve(png) : reject(new Error("Could not encode that image"))),
          "image/png",
        );
      },
      "image/webp",
      QUALITY,
    );
  });
}

/**
 * Centre-crop `source` to a square and re-encode it at `size` px.
 *
 * Centre-crop rather than fit-or-letterbox because the face is drawn in a circle:
 * letterboxing would put the agent's colour through the bars and read as part of
 * the picture, and stretching distorts whatever it is.
 */
export async function resizeToFace(source: Blob, size = FACE_SIZE): Promise<Blob> {
  const bitmap = await loadBitmap(source);
  if (!bitmap.width || !bitmap.height) throw new Error("That image has no pixels");
  const side = Math.min(bitmap.width, bitmap.height);
  const offset = (bitmap.width - side) / 2;
  const offsetTop = (bitmap.height - side) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.release?.();
    throw new Error("This browser cannot resize an image");
  }
  try {
    context.drawImage(bitmap.source, offset, offsetTop, side, side, 0, 0, size, size);
  } finally {
    // A decoded bitmap is the biggest thing this page holds — a 4000×3000 photo is
    // ~48 MB of pixels — and a throw on the way out, from a browser that refused to
    // draw, would leave it held for the life of the tab.
    bitmap.release?.();
  }
  return await encode(canvas);
}
