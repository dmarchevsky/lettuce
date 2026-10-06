import { useCallback, useEffect, useState } from "react";
import {
  fetchPiSettings,
  generatePiKey,
  type PiSettings,
  type PiSettingsUpdate,
  pinPiHostKey,
  savePiSettings,
} from "../lib/pi.ts";
import { ToggleRow } from "./MenuRow.tsx";

interface Draft {
  enabled: boolean;
  host: string;
  port: string;
  user: string;
  pathPrepend: string;
  workdir: string;
  model: string;
  /** Typed only; the stored key is never sent back. */
  privateKey: string;
}

/** What the server holds, as an editable draft. */
function draftOf(settings: PiSettings): Draft {
  return {
    enabled: settings.enabled,
    host: settings.host,
    port: String(settings.port),
    user: settings.user,
    pathPrepend: settings.pathPrepend,
    workdir: settings.workdir,
    model: settings.model ?? "",
    privateKey: "",
  };
}

/** Whether the draft differs from what is stored — Save is dead until it does. */
function isDirty(draft: Draft, settings: PiSettings): boolean {
  return (
    draft.enabled !== settings.enabled ||
    draft.host.trim() !== settings.host ||
    draft.port !== String(settings.port) ||
    draft.user.trim() !== settings.user ||
    draft.pathPrepend.trim() !== settings.pathPrepend ||
    draft.workdir.trim() !== settings.workdir ||
    draft.model.trim() !== (settings.model ?? "") ||
    draft.privateKey.trim() !== ""
  );
}

/**
 * Settings → Remote Pi: where agents reach a pi installed on another host, over
 * SSH only (see bff/src/pi/ and docs/remote-pi-plan.md).
 *
 * Two things shape this form. The switch gates the fields, because a form you
 * can fill in while it cannot be used is a form whose mistakes are discovered
 * by an agent's failed run. And the two ways to get a deploy key are rendered
 * as alternatives, never stacked: lettuce generating a pair (the operator only
 * ever copies the PUBLIC half) or pasting a private key you already have. The
 * private half never returns to this page, so `hasKey` and the public line are
 * all the UI has to say about the key — and `keySource` says who made it, so
 * the generated-key branch cannot claim credit for a pasted one.
 */
export function PiSection() {
  const [settings, setSettings] = useState<PiSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [rotateArmed, setRotateArmed] = useState(false);
  const [copied, setCopied] = useState(false);
  /** Which key flow the form shows: lettuce's, or the operator's own PEM. */
  const [keyChoice, setKeyChoice] = useState<"generated" | "pasted">("generated");

  const load = useCallback(async () => {
    try {
      const loaded = await fetchPiSettings();
      setSettings(loaded.settings);
      setDraft(draftOf(loaded.settings));
      setKeyChoice(loaded.settings.keySource);
      setStatus(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft) return;
    const update: PiSettingsUpdate = {
      enabled: draft.enabled,
      host: draft.host.trim(),
      port: Number(draft.port) || 22,
      user: draft.user.trim(),
      pathPrepend: draft.pathPrepend.trim(),
      workdir: draft.workdir.trim(),
      model: draft.model.trim() || null,
    };
    if (draft.privateKey.trim()) update.privateKey = draft.privateKey.trim();
    setSaving(true);
    try {
      const saved = await savePiSettings(update);
      setSettings(saved);
      setDraft(draftOf(saved));
      setKeyChoice(saved.keySource);
      setStatus("Saved. Agents get the pi tools from their next turn.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const pin = async () => {
    setPinning(true);
    try {
      const pinned = await pinPiHostKey();
      setStatus(`Pinned ${pinned.lines} host key(s) for ${pinned.target}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setPinning(false);
    }
  };

  /** Clipboard first; if the browser refuses (insecure origin), the input
   * still select-on-focus, so the key is never un-copyable. */
  const copyKey = async () => {
    if (!settings || !settings.publicKey) return;
    try {
      await navigator.clipboard.writeText(settings.publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setStatus(
        "Clipboard blocked by the browser — tap the public-key box to select it, then copy.",
      );
    }
  };

  /** Generate (first key) or rotate (two-click confirm) the lettuce-held pair. */
  const generate = async () => {
    if (!settings) return;
    if (settings.hasKey && !rotateArmed) {
      setRotateArmed(true);
      setStatus(
        "Click again to rotate. The new public key must be added on the remote host, and the old line removed there.",
      );
      return;
    }
    setRotateArmed(false);
    setGenerating(true);
    try {
      const next = await generatePiKey();
      setSettings(next);
      setDraft(draftOf(next));
      setKeyChoice("generated");
      setStatus(
        "Generated a fresh key pair. Add the public key below to the remote host's ~/.ssh/authorized_keys before the next run.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setGenerating(false);
    }
  };

  if (!draft || !settings) {
    return (
      <>
        {status ? <p className="small bad pad">{status}</p> : <p className="muted pad">Loading…</p>}
        <div className="pad-x">
          <button type="button" className="button ghost" onClick={() => void load()}>
            Reload
          </button>
        </div>
      </>
    );
  }

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const off = !draft.enabled;
  const dirty = isDirty(draft, settings);

  return (
    <>
      <p className="muted small pad">
        Agents can dispatch coding tasks to a <code>pi</code> agent running on another host, over
        SSH. Runs start in the background, continue the same pi session with follow-ups, and their
        transcripts appear under Tasks. Nothing is installed on the remote host beyond pi itself.
      </p>
      {status ? <p className="muted small pad">{status}</p> : null}

      <div className="pad-x">
        <ToggleRow
          title="Allow Remote Pi"
          description="Agents may dispatch coding tasks to the remote pi agent"
          checked={draft.enabled}
          onChange={(enabled) => set({ enabled })}
        />
        {off ? (
          <p className="muted small">
            Off — every field below is read-only, and no agent gets the pi tools.
          </p>
        ) : null}

        <label className="field">
          Host
          <input
            value={draft.host}
            placeholder="pi.example.com"
            autoComplete="off"
            spellCheck={false}
            disabled={off}
            onChange={(event) => set({ host: event.target.value })}
          />
        </label>

        <label className="field">
          Port
          <input
            value={draft.port}
            placeholder="22"
            inputMode="numeric"
            autoComplete="off"
            disabled={off}
            onChange={(event) => set({ port: event.target.value })}
          />
        </label>

        <label className="field">
          User
          <input
            value={draft.user}
            placeholder="worker"
            autoComplete="off"
            spellCheck={false}
            disabled={off}
            onChange={(event) => set({ user: event.target.value })}
          />
        </label>

        <label className="field">
          Workdir
          <input
            value={draft.workdir}
            placeholder="/home/worker/pi"
            autoComplete="off"
            spellCheck={false}
            disabled={off}
            onChange={(event) => set({ workdir: event.target.value })}
          />
          <span className="muted small">
            Absolute path on the remote host pi will work in. pi itself must already be installed
            and configured there.
          </span>
        </label>

        <label className="field">
          PATH prefix
          <input
            value={draft.pathPrepend}
            placeholder="/opt/node/bin:/opt/pi/bin"
            autoComplete="off"
            spellCheck={false}
            disabled={off}
            onChange={(event) => set({ pathPrepend: event.target.value })}
          />
          <span className="muted small">
            Prepended to PATH in every remote command — a non-interactive SSH shell usually misses
            pi and node without it.
          </span>
        </label>

        <label className="field">
          Model
          <input
            value={draft.model}
            placeholder="Optional — the remote pi's own default if empty"
            autoComplete="off"
            spellCheck={false}
            disabled={off}
            onChange={(event) => set({ model: event.target.value })}
          />
        </label>

        <label className="field">
          Deploy key
          <select
            value={keyChoice}
            disabled={off}
            onChange={(event) => {
              setKeyChoice(event.target.value as "generated" | "pasted");
              setRotateArmed(false);
            }}
          >
            <option value="generated">Lettuce-generated key pair (recommended)</option>
            <option value="pasted">A private key I already have</option>
          </select>
          <span className="muted small">
            {keyChoice === "generated"
              ? "Lettuce makes and keeps the private half — you only ever copy the public line to the remote host."
              : "Paste an existing OpenSSH private key; it replaces whatever is stored when you save."}
          </span>
        </label>

        {keyChoice === "generated" ? (
          settings.publicKey ? (
            <div className="field">
              Public key — add this line to the remote host’s ~/.ssh/authorized_keys
              <div className="field-inline">
                <input
                  className="mono-input"
                  readOnly
                  value={settings.publicKey}
                  title={settings.publicKey}
                  spellCheck={false}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button
                  type="button"
                  className="button compact ghost"
                  onClick={() => void copyKey()}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <span className="muted small">
                The private half never leaves this server
                {settings.keySource === "pasted" ? " (this key is the one you pasted)" : ""}.
                Optionally prefix the line with restrictions such as from="&lt;this
                server&gt;",no-pty.
              </span>
            </div>
          ) : settings.hasKey ? (
            <p className="muted small pad">
              Private key stored — its public part could not be derived from the stored PEM.
            </p>
          ) : null
        ) : (
          <label className="field">
            Private key (PEM)
            <textarea
              className="mono"
              rows={4}
              value={draft.privateKey}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              disabled={off}
              onChange={(event) => set({ privateKey: event.target.value })}
            />
            <span className="muted small">
              {settings.hasKey
                ? "A key is already stored; pasting replaces it when you save."
                : "Nothing is stored yet — the agent cannot run until a key is here."}
            </span>
          </label>
        )}

        <div className="button-row">
          {keyChoice === "generated" ? (
            settings.hasKey ? (
              <button
                type="button"
                className="button ghost"
                disabled={generating || off}
                onClick={() => void generate()}
              >
                {generating ? "Generating…" : rotateArmed ? "Confirm rotation" : "Rotate key pair"}
              </button>
            ) : (
              <button
                type="button"
                className="button"
                disabled={generating || off}
                onClick={() => void generate()}
              >
                {generating ? "Generating…" : "Generate key pair"}
              </button>
            )
          ) : null}
          <button
            type="button"
            className="button ghost"
            disabled={pinning || !draft.host.trim()}
            onClick={() => void pin()}
          >
            {pinning ? "Pinning…" : "Verify & pin host key"}
          </button>
        </div>
        <p className="muted small">
          Pin the host key after first setup or whenever the host or port changes — runs only accept
          pinned hosts.
        </p>

        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {dirty && !saving ? <span className="muted small">Unsaved changes</span> : null}
        </div>
      </div>
    </>
  );
}
