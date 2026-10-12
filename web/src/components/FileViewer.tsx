/**
 * View a single workspace file in the app: a chat file link opens this, and so
 * does the Files tab. Markdown is rendered, other text shown verbatim, an image
 * previewed from a base64 read; a file that is not valid UTF-8 is not text, so
 * it downloads instead of showing an error (which is all this could do before).
 *
 * Lifted out of `FilesTab` so both entry points share one behaviour. Previewing
 * still goes through `read_file` over the multiplexed WS session — the bytes
 * have to reach JS to build a data URL or show text — while the Download button
 * hands off to the BFF's HTTP route.
 *
 * Text files are also editable here: Edit swaps the view for a textarea and
 * Save writes the whole content back with `write_file` (allowlisted and
 * workspace-clamped BFF-side). There is no mtime or etag check upstream, so a
 * save silently wins over any change the agent made between open and save —
 * single-user, small window, accepted.
 */
import { useEffect, useRef, useState } from "react";
import {
  downloadUrl,
  isBinaryReadError,
  isImageFile,
  isMarkdownFile,
  mimeTypeFor,
  triggerDownload,
} from "../lib/download.ts";
import { errorMessage } from "../lib/errors.ts";
import type { SessionApi } from "../state/use-session.ts";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import { Sheet } from "./Sheet.tsx";
import { toast } from "./Toast.tsx";

interface ReadResponse {
  content?: string | null;
  success?: boolean;
  error?: string;
}

const basename = (path: string) => path.split("/").pop() || path;

/**
 * Whether this file can be edited as text. Decided from the name, exactly like
 * the preview decision: a binary file never reaches edit mode anyway — a
 * non-UTF-8 read auto-downloads and closes the sheet.
 */
export function isEditableFile(name: string): boolean {
  return !isImageFile(name);
}

export function FileViewer({
  session,
  path,
  onClose,
  onSaved,
}: {
  session: SessionApi;
  path: string;
  onClose: () => void;
  /** Called after a successful save so the caller can refresh its listing. */
  onSaved?: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading…");
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  /** In-flight text lives on the Save button; the sheet's slot is only for a read failure. */
  const [saving, setSaving] = useState(false);

  // Inline handlers from the caller change identity every render; keep the
  // effect keyed on `path` alone so it does not re-read the file each time.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let cancelled = false;
    const name = basename(path);
    setContent(null);
    setImage(null);
    setMode("view");
    setDraft("");
    setPreview(false);
    setStatus("");

    void (async () => {
      try {
        const response = await session.request<ReadResponse>("read_file", {
          path,
          encoding: isImageFile(name) ? "base64" : "utf8",
        });
        if (cancelled) return;
        if (response?.success === false || typeof response?.content !== "string") {
          const error = response?.error ?? "Failed to read file";
          if (!isImageFile(name) && isBinaryReadError(error)) {
            onCloseRef.current();
            triggerDownload(downloadUrl(path));
            return;
          }
          setStatus(error);
          return;
        }
        if (isImageFile(name)) {
          setImage(`data:${mimeTypeFor(name)};base64,${response.content}`);
        } else {
          setContent(response.content);
        }
        setStatus("");
      } catch (cause) {
        if (!cancelled) setStatus(errorMessage(cause));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session, path]);

  const dirty = mode === "edit" && draft !== content;

  /** Every close path (✕, scrim, Back, Escape) goes through this guard. */
  const requestClose = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  };

  const startEdit = () => {
    if (content === null) return;
    setDraft(content);
    setPreview(false);
    setMode("edit");
    setStatus("");
  };

  const save = async () => {
    setSaving(true);
    try {
      const response = await session.request<{ success?: boolean; error?: string }>("write_file", {
        path,
        content: draft,
      });
      if (response?.success === false) {
        toast(response.error ?? `Could not save ${basename(path)}`, "bad");
        return;
      }
      setContent(draft);
      setMode("view");
      toast(`Saved ${basename(path)}.`);
      onSaved?.();
    } catch (cause) {
      toast(`Could not save ${basename(path)}: ${errorMessage(cause)}`, "bad");
    } finally {
      setSaving(false);
    }
  };

  const name = basename(path);
  const markdown = isMarkdownFile(name);
  return (
    <Sheet
      title={name}
      fill
      size="spacious"
      status={status || null}
      onClose={requestClose}
      actions={
        mode === "edit" ? (
          <>
            <button
              type="button"
              className="button ghost"
              onClick={() => {
                setMode("view");
                setPreview(false);
                setStatus("");
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button"
              disabled={saving || draft === content}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        ) : (
          <>
            {content !== null && isEditableFile(name) ? (
              <button type="button" className="button" onClick={startEdit}>
                <Icon name="edit" /> Edit
              </button>
            ) : null}
            <button
              type="button"
              className="button"
              onClick={() => triggerDownload(downloadUrl(path))}
            >
              Download
            </button>
            <button type="button" className="button ghost" onClick={requestClose}>
              Close
            </button>
          </>
        )
      }
    >
      {mode === "edit" ? (
        <>
          {markdown ? (
            <button
              type="button"
              className="link file-preview-toggle"
              onClick={() => setPreview((on) => !on)}
            >
              {preview ? "Edit source" : "Preview"}
            </button>
          ) : null}
          {preview ? (
            <div className="md-document">
              <Markdown text={draft} />
            </div>
          ) : (
            <textarea
              className="file-editor"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
            />
          )}
        </>
      ) : image !== null ? (
        <img className="file-preview" src={image} alt={name} />
      ) : content !== null && markdown ? (
        // Not `.tool-args`: that is the monospace box for tool output, with
        // `white-space: pre-wrap`, and react-markdown puts a newline text node
        // between every block — pre-wrap drew each one as a blank line, an
        // extra line after every paragraph and bullet.
        <div className="md-document">
          <Markdown text={content} />
        </div>
      ) : content !== null ? (
        <pre className="tool-args">{content}</pre>
      ) : null}
    </Sheet>
  );
}
