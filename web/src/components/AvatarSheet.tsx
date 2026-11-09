import { useEffect, useRef, useState } from "react";
import { type FaceEntry, fetchFaceLibrary, removeFace, uploadFace } from "../lib/agent-flags.ts";
import {
  AVATAR_TINTS,
  type AvatarPref,
  faceUrl,
  graphemeCount,
  tintFor,
} from "../lib/agent-tint.ts";
import { GLYPH_CATEGORIES, glyphSections } from "../lib/avatar-glyphs.ts";
import { resizeToFace } from "../lib/avatar-image.ts";
import { errorMessage } from "../lib/errors.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { Sheet } from "./Sheet.tsx";

interface Props {
  agentId: string;
  name: string;
  /** The face staged in the caller's form; every pick writes straight back to it. */
  pref: AvatarPref;
  /** Stages the pick. Nothing is written anywhere until the caller saves. */
  onPick: (pref: AvatarPref) => void;
  onClose: () => void;
  /**
   * Called when the library itself changed — a face uploaded or deleted — so the
   * caller can refetch what it caches. Deleting also cleared the pref of every
   * agent that was wearing the face, which only the BFF knows about.
   */
  onLibraryChanged?: () => void;
  /** A line under the body, e.g. when the staged face will be applied. */
  note?: string;
}

type Tab = "glyph" | "image";

/**
 * Picking an agent's face, in one sheet: the preview, the colour, then either a
 * glyph from the library or one of the pictures every agent shares.
 *
 * It used to be two controls — a tint row in the form and a glyph-only sheet — and
 * the split showed: neither half could preview the other, and "the colour you get
 * is the one over there" is a sentence nobody should have to read. One sheet also
 * means the New agent form can open the same component instead of inventing a
 * third way to pick a face.
 *
 * Everything here **stages**: each pick calls `onPick` and updates the preview, and
 * the caller's Save commits — exactly as the model field in the same form does.
 * `Default` stages the empty pref, which is what makes an agent derive its own
 * letter and colour again.
 */
export function AvatarSheet({
  agentId,
  name,
  pref,
  onPick,
  onClose,
  onLibraryChanged,
  note,
}: Props) {
  const [tab, setTab] = useState<Tab>(pref.image ? "image" : "glyph");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  /** The free-text glyph box, seeded so reopening the sheet shows the choice. */
  const [typed, setTyped] = useState(pref.glyph ?? "");
  const [images, setImages] = useState<FaceEntry[]>([]);
  const [recents, setRecents] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A face whose ✕ was tapped once; a second tap on it deletes. */
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchFaceLibrary()
      .then((library) => {
        if (cancelled) return;
        setImages(library.images);
        setRecents(library.recents ?? []);
      })
      .catch(() => {
        // A sheet that cannot reach the library still opens on the glyph grid,
        // which is the half that needs no server at all.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The BFF applies the real glyph rule; this one exists so the box says so while
  // typing instead of failing on Save.
  const tooLong = typed.trim() !== "" && graphemeCount(typed) > 2;
  const sections = glyphSections(query, category);
  const searching = query.trim() !== "";

  /**
   * A glyph pick: a face is a glyph or a picture, never both, and the colour stays.
   *
   * It does **not** close the sheet. Picking a face is a comparison — this fox or
   * that owl, against the tint in the row above — and closing on the first tap
   * turns every comparison into open, tap, reopen, which is three gestures per
   * candidate. The staged face is already live in the preview, so staying open
   * shows the answer; `Done` is the one gesture that ends it.
   */
  const pickGlyph = (glyph: string | undefined) => onPick({ tint: pref.tint, glyph });

  const pickTyped = () => onPick({ tint: pref.tint, glyph: typed.trim() || undefined });

  const setTint = (tint: string | undefined) => onPick({ ...pref, tint });

  const pickFace = (id: string | undefined) => onPick({ tint: pref.tint, image: id });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setStatus("Resizing…");
    try {
      // Resize here, not on the server: the browser holds the original and the BFF
      // has no rasteriser, and 128px is four times what the largest surface shows.
      const blob = await resizeToFace(file);
      setStatus("Uploading…");
      const library = await uploadFace(blob);
      setImages(library.images);
      onPick({ tint: pref.tint, image: library.id });
      setStatus(null);
      onLibraryChanged?.();
    } catch (cause) {
      // The BFF's own reason is the useful one ("an image must be 512px or
      // smaller"), so it is what goes on the sheet, not a generic failure.
      setStatus(errorMessage(cause));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
      setBusy(false);
    }
  };

  const deleteFace = async (id: string) => {
    if (armedDelete !== id) {
      setArmedDelete(id);
      return;
    }
    setArmedDelete(null);
    setBusy(true);
    try {
      const result = await removeFace(id);
      setImages(result.images);
      // The BFF cleared this face off every agent wearing it; if that includes
      // the one this sheet is about, the staged pref has to stop pointing at it.
      if (pref.image === id) onPick({ tint: pref.tint, image: undefined });
      onLibraryChanged?.();
      setStatus(
        result.cleared.length > 0
          ? `Deleted — ${result.cleared.length} agent(s) are back to their letter.`
          : null,
      );
    } catch (cause) {
      setStatus(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const renderTiles = (glyphs: { glyph: string; keywords: string[] }[]) => (
    <div className="avatar-grid">
      {glyphs.map((entry) => (
        <button
          key={entry.glyph}
          type="button"
          className={`avatar-glyph${pref.glyph === entry.glyph ? " sel" : ""}`}
          aria-pressed={pref.glyph === entry.glyph}
          title={entry.keywords.join(", ")}
          onClick={() => pickGlyph(entry.glyph)}
        >
          {entry.glyph}
        </button>
      ))}
    </div>
  );

  return (
    <Sheet
      title="Avatar"
      onClose={onClose}
      status={status}
      actions={
        <>
          <button type="button" className="button ghost leading" onClick={() => onPick({})}>
            Default
          </button>
          <button type="button" className="button" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {/* The face at the picker's own size and at the smallest size anything draws
          it, so a picture is judged where it will actually be seen. */}
      <div className="avatar-preview-row">
        <AgentAvatar
          agentId={agentId}
          name={name}
          pref={pref}
          className="agent-avatar avatar-preview"
        />
        <AgentAvatar
          agentId={agentId}
          name={name}
          pref={pref}
          className="agent-avatar avatar-preview-tiny"
        />
        <span className="small">as a conversation header shows it</span>
      </div>

      <div className="avatar-colour">
        <span className="avatar-cat">Colour</span>
        <span className="avatar-tints">
          <button
            type="button"
            className={`avatar-tint auto${pref.tint === undefined ? " sel" : ""}`}
            title="The colour this agent's id hashes to"
            onClick={() => setTint(undefined)}
          >
            Auto
          </button>
          {AVATAR_TINTS.map((tint) => (
            <button
              key={tint}
              type="button"
              className={`avatar-tint${pref.tint === tint ? " sel" : ""}`}
              style={{ background: tint }}
              aria-label={`Tint ${tint}`}
              aria-pressed={pref.tint === tint}
              onClick={() => setTint(tint)}
            />
          ))}
          {/* Anything off the palette: the BFF accepts any `#rrggbb`, so the picker
              costs one input and no server change. */}
          <input
            type="color"
            className="avatar-tint custom"
            value={pref.tint ?? tintFor(agentId)}
            aria-label="Custom colour"
            title="Any colour off the palette"
            onChange={(event) => setTint(event.target.value)}
          />
        </span>
      </div>

      <div className="avatar-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "glyph"}
          className={`avatar-tab${tab === "glyph" ? " sel" : ""}`}
          onClick={() => setTab("glyph")}
        >
          Glyph
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "image"}
          className={`avatar-tab${tab === "image" ? " sel" : ""}`}
          onClick={() => setTab("image")}
        >
          Image
        </button>
      </div>

      {tab === "glyph" ? (
        <>
          <div className="avatar-filter">
            <input
              value={query}
              placeholder="type a word — fox, mail, moon…"
              aria-label="Filter glyphs"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="avatar-chips">
            <button
              type="button"
              className={`avatar-chip${category === null ? " sel" : ""}`}
              onClick={() => setCategory(null)}
            >
              All
            </button>
            {GLYPH_CATEGORIES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`avatar-chip${category === entry.id ? " sel" : ""}`}
                onClick={() => setCategory(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {/* Recent first — but not against a query, where a stale pick is noise. */}
          {recents.length > 0 && !searching ? (
            <>
              <p className="avatar-cat">Recent</p>
              {renderTiles(recents.map((glyph) => ({ glyph, keywords: [] })))}
            </>
          ) : null}

          {sections.length === 0 ? (
            <p className="switcher-empty">Nothing in the library matches “{query.trim()}”.</p>
          ) : (
            sections.map((section) => (
              <section key={section.label}>
                <p className="avatar-cat">{section.label}</p>
                {renderTiles(section.glyphs)}
              </section>
            ))
          )}

          <label className="avatar-custom">
            <input
              value={typed}
              placeholder="🦊"
              aria-label="Or type any emoji"
              onChange={(event) => setTyped(event.target.value)}
            />
            <span className="small">
              {tooLong ? "One emoji, or two at most." : "or type any emoji — one, or two at most"}
            </span>
            <button
              type="button"
              className="button ghost compact"
              disabled={tooLong}
              onClick={pickTyped}
            >
              Use it
            </button>
          </label>
        </>
      ) : (
        <>
          <label className="avatar-image-drop">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(event) => void onFile(event.target.files?.[0])}
            />
            {busy
              ? "Working…"
              : "Choose an image — cropped to a square, resized, transparency kept"}
          </label>
          <p className="avatar-cat">Saved faces</p>
          {images.length === 0 ? (
            <p className="switcher-empty">
              No saved faces yet. Upload one; every agent can use it.
            </p>
          ) : (
            <div className="avatar-lib">
              {images.map((image) => (
                <span
                  key={image.id}
                  className={`avatar-lib-item${pref.image === image.id ? " sel" : ""}${
                    armedDelete === image.id ? " pending" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="avatar-lib-face"
                    aria-label="Use this face"
                    onClick={() => pickFace(image.id)}
                  >
                    <img className="agent-avatar-img" src={faceUrl(image.id)} alt="" />
                  </button>
                  {image.usedBy.length > 0 ? (
                    <span className="avatar-lib-used" title={image.usedBy.join(", ")}>
                      {image.usedBy.length}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="avatar-lib-del"
                    aria-label={armedDelete === image.id ? "Tap again to delete" : "Delete face"}
                    onClick={() => void deleteFace(image.id)}
                  >
                    {armedDelete === image.id ? "Sure?" : "✕"}
                  </button>
                </span>
              ))}
            </div>
          )}
          <p className="small">
            A png or webp keeps its transparency and the colour above shows through it; a jpeg is
            opaque. Faces are shared by every agent — ✕ removes one for good, and anyone wearing it
            is back to their letter.
          </p>
        </>
      )}

      {note ? <p className="small">{note}</p> : null}
    </Sheet>
  );
}
