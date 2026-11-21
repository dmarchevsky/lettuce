import { useState } from "react";
import type { TranscriptImage } from "../lib/messages.ts";
import { ImageLightbox } from "./ImageLightbox.tsx";

/**
 * The thumbnails one message or tool result carries, and their full-size preview.
 *
 * One component because three rows show pictures — a message you attached them
 * to, a tool return that drew them, and a backgrounded tool's result card — and
 * the thing a person comes to a picture for is the same in all three: tap it and
 * it fills the screen. A data: URL cannot be opened in a tab (browsers refuse a
 * top-level `data:` from a click), so the preview lives here.
 */
export function ImageStrip({ images }: { images: TranscriptImage[] }) {
  const [zoom, setZoom] = useState<number | null>(null);
  return (
    <>
      <div className="msg-images">
        {images.map((image, index) => (
          // The thumbnails of one row are fixed once it is rendered, and the
          // index is also what `setZoom` shows — they are one array, so the
          // position is the only identity they have. (No `biome-ignore` here:
          // the formatter keeps `key` off the element's own line, and a
          // suppression comment has to sit directly above what it excuses.)
          <button
            key={index}
            type="button"
            className="msg-image-thumb"
            onClick={() => setZoom(index)}
            aria-label={`View image ${index + 1} full size`}
          >
            {/* The button's aria-label is the accessible name; the image itself
                is decorative beside it. */}
            <img src={image.dataUrl} alt="" loading="lazy" />
          </button>
        ))}
      </div>
      {zoom !== null && images[zoom] ? (
        <ImageLightbox
          src={images[zoom].dataUrl}
          alt={`Image ${zoom + 1}`}
          onClose={() => setZoom(null)}
        />
      ) : null}
    </>
  );
}
