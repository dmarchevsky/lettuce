import { useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import { KEEP_STORED_HINT } from "../lib/field-hints.ts";
import { deleteModelCaps, type ModelCaps, saveModelCaps } from "../lib/model-caps.ts";
import { SAVED_NO_AGENT, SAVED_NOW, SAVED_ON_RECONNECT } from "../lib/save-result.ts";
import { ToggleRow } from "./MenuRow.tsx";
import { Sheet } from "./Sheet.tsx";
import { toast } from "./Toast.tsx";

export interface ModelEditTarget {
  handle: string;
  label: string;
  /** The endpoint URL the model's connection points at, for the header line. */
  baseUrl?: string;
  /** Whether the endpoint's connection requires a key (the field appears only then). */
  requiresKey: boolean;
  /** The current declaration, or null when nothing is declared yet. */
  caps: ModelCaps | null;
}

/** What auto-discovery gives an undeclared model — the harness clamp. */
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 32000;

/**
 * The per-model capability declaration (Settings → Providers & models).
 *
 * Only endpoints that report no capabilities get this sheet: a plain
 * OpenAI-compatible connection says nothing about what it serves, so letta-code
 * resolves every model behind it as text-only at the 128k clamp. The window
 * and output fields are part of the provider-mod API, so they stay in the
 * sheet even when both toggles are off — they lift the clamp without
 * claiming capabilities. The row's tags are the confirmation; this sheet only
 * ever shows errors.
 */
export function ModelEditSheet({
  target,
  onClose,
  onSaved,
}: {
  target: ModelEditTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [vision, setVision] = useState(target.caps?.vision ?? false);
  const [thinking, setThinking] = useState(target.caps?.thinking ?? false);
  const [contextWindow, setContextWindow] = useState(
    String(target.caps?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
  );
  const [maxTokens, setMaxTokens] = useState(String(target.caps?.maxTokens ?? DEFAULT_MAX_TOKENS));
  // Blank means keep the stored key: the protocol never echoes it back, so
  // every open starts blank — same non-destructive rule as the connections.
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await saveModelCaps(
        target.handle,
        {
          vision,
          thinking,
          contextWindow: Number(contextWindow),
          maxTokens: Number(maxTokens),
        },
        apiKey.trim() || undefined,
      );
      // A stored-but-not-yet-live reload is still a save; say which of the three
      // it was, then close — the row's own tags carry the rest.
      if (result.mod === "failed") toast(SAVED_ON_RECONNECT, "warn");
      else if (result.mod === "reload-pending") toast(SAVED_NO_AGENT);
      else toast(SAVED_NOW);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteModelCaps(target.handle);
      toast(`Removed ${target.handle}.`);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={target.label}
      size="compact"
      status={error}
      onClose={onClose}
      actions={
        <>
          {target.caps ? (
            <button
              type="button"
              className="button ghost danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              Remove
            </button>
          ) : null}
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <p className="muted small">
        {target.baseUrl ? <code>{target.baseUrl}</code> : null} This endpoint reports no
        capabilities, so declare what this model actually is. Applies from the agents&apos; next
        turn — no restart.
      </p>

      <ToggleRow
        title="Vision"
        description="Accepts image input"
        checked={vision}
        onChange={setVision}
      />
      <ToggleRow
        title="Thinking"
        description="Emits reasoning between steps"
        checked={thinking}
        onChange={setThinking}
      />

      <label className="field">
        Context window (tokens)
        <input
          type="number"
          min={1}
          value={contextWindow}
          onChange={(event) => setContextWindow(event.target.value)}
        />
      </label>
      <label className="field">
        Max output tokens
        <input
          type="number"
          min={1}
          value={maxTokens}
          onChange={(event) => setMaxTokens(event.target.value)}
        />
      </label>

      {target.requiresKey ? (
        <label className="field">
          API key
          <input
            type="password"
            value={apiKey}
            placeholder={KEEP_STORED_HINT}
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
      ) : null}
    </Sheet>
  );
}
