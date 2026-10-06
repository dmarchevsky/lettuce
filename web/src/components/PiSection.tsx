import { useCallback, useEffect, useState } from "react";
import {
  ago,
  checkPiHost,
  fetchPiSettings,
  generatePiKey,
  type PiCheck,
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

/** `SHA256:abcdef…uvwxyz` — a fingerprint you can read at a glance. */
function shortFingerprint(value: string | null): string {
  if (!value) return "none";
  const hex = value.replace(/^SHA256:/, "");
  return hex.length <= 12 ? value : `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

/**
 * The one line that says whether this host would work. "Saved" is not that
 * answer: every run pins, so a saved-but-unpinned host fails silently inside an
 * agent's run. The pill goes stale with the form on purpose — editing a field
 * after a good check means the good check is about another host.
 */
export function piStatusPill(
  check: PiCheck | null,
  stale: boolean,
): { cls: "ok" | "warn" | "bad"; text: string } {
  if (stale) return { cls: "warn", text: "Changed since the last check" };
  if (!check) return { cls: "warn", text: "Never checked — an unpinned host fails every run" };
  const pinned = check.pinnedFingerprint
    ? ` · pinned ${shortFingerprint(check.pinnedFingerprint)}`
    : "";
  if (check.ok)
    return {
      cls: "ok",
      text: `${check.detail} · ${check.target}${pinned} · checked ${ago(check.at)}`,
    };
  return { cls: "bad", text: `${check.detail} · ${check.target} · ${ago(check.at)}` };
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
  /** The last word the BFF had about this host, and the form's staleness. */
  const [check, setCheck] = useState<PiCheck | null>(null);
  const [checking, setChecking] = useState(false);
  /** A host key that does not match the pinned one needs a second, explicit click. */
  const [pinArmed, setPinArmed] = useState(false);
  /** Which key flow the form shows: lettuce's, or the operator's own PEM. */
  const [keyChoice, setKeyChoice] = useState<"generated" | "pasted">("generated");
  /** Agents that point at a host or folder of their own (Tools → Remote Pi). */
  const [ownAgents, setOwnAgents] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const loaded = await fetchPiSettings();
      setSettings(loaded.settings);
      setDraft(draftOf(loaded.settings));
      setKeyChoice(loaded.settings.keySource);
      setCheck(loaded.check);
      setOwnAgents((loaded.agents ?? []).filter((a) => a.mode === "own").map((a) => a.agentId));
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
      setSettings(saved.settings);
      setDraft(draftOf(saved.settings));
      setKeyChoice(saved.settings.keySource);
      // Save answers the host question itself — the server checked on the way by.
      setCheck(saved.check);
      setPinArmed(false);
      setStatus(
        saved.check?.ok
          ? "Saved. Agents get the pi tools from their next turn."
          : "Saved, but the host check below is not clean yet.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  /** The values a check or a pin should use: the form's, saved or not. */
  const targetOf = (from: Draft) => ({
    host: from.host.trim(),
    port: Number(from.port) || 22,
    user: from.user.trim(),
    pathPrepend: from.pathPrepend.trim(),
    workdir: from.workdir.trim(),
  });

  const runCheck = async () => {
    const form = draft;
    if (!form) return;
    setChecking(true);
    try {
      setCheck(await checkPiHost(targetOf(form)));
      setStatus(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  };

  /**
   * Pin, then check, in the one action the form offers: the two are always both
   * wanted, and pinning alone tells you nothing about whether a run would work.
   * A mismatched host key is refused (409) and needs a second click.
   */
  const pinAndCheck = async (force = false) => {
    const form = draft;
    if (!form) return;
    setPinning(true);
    try {
      const { host, port } = targetOf(form);
      const pinned = await pinPiHostKey({ host, port, force });
      if (pinned.changed) {
        setPinArmed(true);
        setStatus(
          `${pinned.target} presents a different host key than the pinned one (${shortFingerprint(
            pinned.oldFingerprint,
          )} → ${shortFingerprint(pinned.newFingerprint)}). Press again only if the host really changed.`,
        );
        return;
      }
      setPinArmed(false);
      setCheck(await checkPiHost(targetOf(form)));
      setStatus(`Pinned ${pinned.target} (${shortFingerprint(pinned.fingerprint)}).`);
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

  const set = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setPinArmed(false);
  };
  const off = !draft.enabled;
  const dirty = isDirty(draft, settings);
  const pill = piStatusPill(check, dirty);
  const hostTyped = draft.host.trim() !== "";
  const needsPin = !check || check.state === "unpinned";
  const busy = checking || pinning;

  return (
    <>
      <p className="muted small pad">
        Agents can dispatch coding tasks to a <code>pi</code> agent running on another host, over
        SSH. Runs start in the background, continue the same pi session with follow-ups, and their
        transcripts appear under Tasks. Nothing is installed on the remote host beyond pi itself.
      </p>
      {status ? <p className="muted small pad">{status}</p> : null}

      {ownAgents.length ? (
        <p className="muted small pad">
          {ownAgents.length === 1
            ? "One agent has its own Remote Pi settings"
            : `${ownAgents.length} agents have their own Remote Pi settings`}
          {" — "}their host or working folder is set per agent under Tools. This page is the default
          they inherit and the key they all use: switching it off here stops every one of them.
        </p>
      ) : null}

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
        </div>

        <div className="button-row">
          <span className={`pill ${pill.cls}`}>{pill.text}</span>
        </div>

        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="button ghost"
            disabled={busy || !hostTyped}
            onClick={() => void (needsPin ? pinAndCheck(pinArmed) : runCheck())}
          >
            {busy
              ? "Checking…"
              : needsPin
                ? pinArmed
                  ? "Replace pinned key & check"
                  : "Check & pin host key"
                : "Check host"}
          </button>
          {dirty && !saving ? <span className="muted small">Unsaved changes</span> : null}
        </div>
        <p className="muted small">
          Checking runs a real ssh: it pins the host key the first time, then asks the remote for
          its pi version with the same PATH a run gets. Runs only ever accept a pinned host.
        </p>
      </div>
    </>
  );
}
