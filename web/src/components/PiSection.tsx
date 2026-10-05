import { useCallback, useEffect, useState } from "react";
import {
  fetchPiSettings,
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

/**
 * Settings → Remote pi worker: where agents reach a pi installed on another
 * host, over SSH only (see bff/src/pi/ and docs/remote-pi-plan.md). The
 * private key is saved server-side and never returns to this page; the host
 * key is pinned from this page (trust on first use) because runs always
 * demand `StrictHostKeyChecking=yes`.
 */
export function PiSection() {
  const [settings, setSettings] = useState<PiSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pinning, setPinning] = useState(false);

  const load = useCallback(async () => {
    try {
      const loaded = await fetchPiSettings();
      setSettings(loaded.settings);
      setDraft(draftOf(loaded.settings));
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
          title="Allow remote pi runs"
          description="Agents may dispatch coding tasks to the remote pi agent"
          checked={draft.enabled}
          onChange={(enabled) => set({ enabled })}
        />

        <label className="field">
          Host
          <input
            value={draft.host}
            placeholder="pi.example.com"
            autoComplete="off"
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
            onChange={(event) => set({ port: event.target.value })}
          />
        </label>

        <label className="field">
          User
          <input
            value={draft.user}
            placeholder="worker"
            autoComplete="off"
            onChange={(event) => set({ user: event.target.value })}
          />
        </label>

        <label className="field">
          Workdir
          <input
            value={draft.workdir}
            placeholder="/home/worker/pi"
            autoComplete="off"
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
            onChange={(event) => set({ model: event.target.value })}
          />
        </label>

        <label className="field">
          SSH private key
          <textarea
            rows={4}
            value={draft.privateKey}
            disabled={settings.hasKey}
            placeholder={
              settings.hasKey
                ? "Saved — never shown again"
                : "Paste the OpenSSH private key (-----BEGIN …)"
            }
            onChange={(event) => set({ privateKey: event.target.value })}
          />
          <span className="muted small">
            Key-only auth, unencrypted, stored on the server and never shown to the browser again.
            {settings.hasKey ? " Clear it from the settings file to replace it." : ""}
          </span>
        </label>

        <button
          type="button"
          className="button ghost"
          disabled={pinning || !draft.host.trim()}
          onClick={() => void pin()}
        >
          {pinning ? "Pinning…" : "Verify & pin host key"}
        </button>
        <span className="muted small">
          {" "}
          Run this after changing host/port, or on first setup — runs only accept pinned hosts.
        </span>

        <button type="button" className="button" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}
