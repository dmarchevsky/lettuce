import { useCallback, useEffect, useState } from "react";
import {
  describeImagesStatus,
  fetchImagesSettings,
  fetchImagesStatus,
  type ImagesSettings,
  type ImagesSettingsUpdate,
  type ImagesStatus,
  type ImagesTestResult,
  saveImagesSettings,
  testImageDraw,
} from "../lib/images.ts";
import { SAVED_NO_AGENT } from "../lib/save-result.ts";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { ToggleRow } from "./MenuRow.tsx";
import { toast } from "./Toast.tsx";

/** What the form holds while it is being edited; the key is typed, never read. */
interface Draft {
  enabled: boolean;
  baseUrl: string;
  model: string;
  size: string;
  /** Write-only: a blank keeps the stored key, `clearApiKey` removes it. */
  apiKey: string;
  clearApiKey: boolean;
}

function draftOf(settings: ImagesSettings): Draft {
  return {
    enabled: settings.enabled,
    baseUrl: settings.baseUrl,
    model: settings.model ?? "",
    size: settings.size ?? "",
    apiKey: "",
    clearApiKey: false,
  };
}

function isDirty(draft: Draft, settings: ImagesSettings): boolean {
  return (
    draft.enabled !== settings.enabled ||
    draft.baseUrl.trim() !== settings.baseUrl ||
    draft.model.trim() !== (settings.model ?? "") ||
    draft.size.trim() !== (settings.size ?? "") ||
    draft.apiKey.trim() !== "" ||
    draft.clearApiKey
  );
}

/**
 * Settings → Image generation: the OpenAI-compatible endpoint every agent's
 * `generate_image` tool draws through (bff/src/images/). The tool is installed
 * as a letta-code mod the BFF writes, so a save applies at once (or as soon as
 * an agent exists), and the *test draw* below runs exactly what an agent's call
 * runs — it is the reachability probe, not a preview of something else.
 */
export function ImagesSection() {
  const [settings, setSettings] = useState<ImagesSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<ImagesStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [test, setTest] = useState<ImagesTestResult | null>(null);
  const [zoom, setZoom] = useState(false);
  const [busy, setBusy] = useState<"save" | "draw" | null>(null);

  const load = useCallback(async () => {
    try {
      const loaded = await fetchImagesSettings();
      setSettings(loaded);
      setDraft(draftOf(loaded));
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await fetchImagesStatus());
    } catch (error) {
      // Status needs a connected app-server; the settings above still render.
      setStatus(null);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadStatus();
  }, [load, loadStatus]);

  const save = async () => {
    if (!draft) return;
    const update: ImagesSettingsUpdate = {
      enabled: draft.enabled,
      baseUrl: draft.baseUrl,
      model: draft.model,
      size: draft.size,
    };
    if (draft.clearApiKey) update.clearApiKey = true;
    else if (draft.apiKey.trim()) update.apiKey = draft.apiKey.trim();
    setBusy("save");
    try {
      const saved = await saveImagesSettings(update);
      setSettings(saved.settings);
      setDraft(draftOf(saved.settings));
      toast(saved.pending ? SAVED_NO_AGENT : "Saved — generate_image is set for every agent");
      setMessage(null);
      await loadStatus();
    } catch (error) {
      toast(
        `Could not save the image endpoint: ${error instanceof Error ? error.message : String(error)}`,
        "bad",
      );
    } finally {
      setBusy(null);
    }
  };

  const draw = async () => {
    setBusy("draw");
    setTest(null);
    try {
      setTest(await testImageDraw(prompt.trim()));
    } catch (error) {
      setTest({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  if (!draft || !settings) {
    return (
      <>
        {message ? (
          <p className="warning small" role="alert">
            <span>{message}</span>
          </p>
        ) : (
          <p className="muted pad">Loading…</p>
        )}
        <div className="pad-x">
          <button type="button" className="button ghost" onClick={() => void load()}>
            Reload
          </button>
        </div>
      </>
    );
  }

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const line = status ? describeImagesStatus(status, test) : null;
  const picture = test?.ok ? test.dataUrl : undefined;

  return (
    <>
      <p className="muted small pad">
        Gives every agent the <code>generate_image</code> tool, in chats, crons and Telegram alike;
        subagents do not get it. Pictures are drawn by any OpenAI-compatible image server (
        <code>POST &lt;url&gt;/images/generations</code>) you point at below — a local server or a
        cloud API. Nothing leaves this server except the prompt itself.
      </p>

      <div className="pad-x">
        <ToggleRow
          title="Native image generation"
          description="generate_image, for every agent"
          checked={draft.enabled}
          disabled={busy !== null}
          onChange={(enabled) => set({ enabled })}
        />

        <label className="field">
          Endpoint URL
          <input
            value={draft.baseUrl}
            placeholder="http://192.0.2.10:8731/v1"
            autoComplete="off"
            onChange={(event) => set({ baseUrl: event.target.value })}
          />
          <span className="muted small">The image server&rsquo;s API root.</span>
        </label>

        <label className="field">
          API key
          <input
            type="password"
            value={draft.apiKey}
            disabled={draft.clearApiKey}
            placeholder={settings.hasKey ? "Saved — leave blank to keep" : "None (optional)"}
            autoComplete="new-password"
            onChange={(event) => set({ apiKey: event.target.value })}
          />
          <span className="muted small">
            Sent as a bearer token.
            {settings.hasKey
              ? " Saved — type to replace, or clear it below to remove."
              : " Only servers that ask for one."}
          </span>
        </label>
        {settings.hasKey ? (
          <ToggleRow
            title="Remove the saved key"
            checked={draft.clearApiKey}
            onChange={(clearApiKey) => set({ clearApiKey, apiKey: "" })}
          />
        ) : null}

        <label className="field">
          Model
          <input
            value={draft.model}
            placeholder="Model id as the server names it, e.g. flux.1-dev"
            autoComplete="off"
            onChange={(event) => set({ model: event.target.value })}
          />
        </label>

        <label className="field">
          Default size
          <input
            value={draft.size}
            placeholder="1024x1024"
            autoComplete="off"
            onChange={(event) => set({ size: event.target.value })}
          />
          <span className="muted small">
            Whatever this server accepts — e.g. 512x512, 1024x1024.
          </span>
        </label>

        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={busy !== null || !isDirty(draft, settings)}
            onClick={() => void save()}
          >
            {busy === "save" ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* One line about the tool's state, plus the mod's own load errors in the
          same warning slot: "not installed yet" and "it refused to load" are the
          two ends of one fact, and two banners stacked read as one long panic. */}
      {line ? <p className="small pad">{line}</p> : null}
      {status && (!status.modInstalled || status.modErrors.length > 0) ? (
        <p className="warning small" role="alert">
          {!status.modInstalled
            ? "The tool is not installed in the app-server yet — it is written on the BFF's next connection to it."
            : `Loading the tool failed: ${status.modErrors.join("; ")}`}
        </p>
      ) : null}
      {message && settings ? (
        <p className="warning small" role="alert">
          <span>{message}</span>
        </p>
      ) : null}

      <p className="section-note">Test draw</p>
      <div className="pad-x">
        <label className="field">
          Prompt
          <input
            value={prompt}
            placeholder="a flat vector icon of a cloud with a lightning bolt"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void draw();
            }}
          />
          <span className="muted small">The same call agents make, at the default size.</span>
        </label>
        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={busy !== null}
            onClick={() => void draw()}
          >
            {busy === "draw" ? "Drawing…" : "Draw"}
          </button>
          <button
            type="button"
            className="button ghost"
            disabled={busy !== null}
            onClick={() => void loadStatus()}
          >
            Refresh status
          </button>
        </div>
      </div>
      {test && !test.ok ? (
        <pre className="tool-args pad-x bad">{test.error ?? "The server refused."}</pre>
      ) : null}
      {picture ? (
        <div className="pad-x">
          <div className="msg-images">
            <button
              type="button"
              className="msg-image-thumb"
              onClick={() => setZoom(true)}
              aria-label="View the test draw full size"
            >
              <img src={picture} alt="" loading="lazy" />
            </button>
          </div>
        </div>
      ) : null}
      {picture && zoom ? (
        <ImageLightbox src={picture} alt="Test draw" onClose={() => setZoom(false)} />
      ) : null}
    </>
  );
}
