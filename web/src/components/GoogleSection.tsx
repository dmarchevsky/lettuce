import { useCallback, useEffect, useState } from "react";
import {
  disconnectGoogle,
  fetchGoogleStatus,
  GOOGLE_LEVELS,
  GOOGLE_SERVICES,
  type GooglePermissions,
  type GoogleResult,
  type GoogleSettingsUpdate,
  type GoogleStatus,
  levelLabel,
  reachesAddresses,
  recipientLines,
  SERVICE_LABELS,
  saveGoogleSettings,
  shortScope,
  startGoogleConnect,
  verifyGoogle,
  wouldNarrow,
} from "../lib/google.ts";
import { describeGoogleTools, fetchNativeTools, type NativeTools } from "../lib/native-tools.ts";
import { ToggleRow } from "./MenuRow.tsx";
import { toast } from "./Toast.tsx";

interface Draft {
  enabled: boolean;
  clientId: string;
  /** Typed only; the stored secret is never sent back. */
  clientSecret: string;
  permissions: GooglePermissions;
  /** The textarea, one entry per line. */
  allowedRecipients: string;
}

function draftOf(status: GoogleStatus): Draft {
  const { settings } = status;
  return {
    enabled: settings.enabled,
    clientId: settings.clientId,
    clientSecret: "",
    permissions: { ...settings.permissions },
    allowedRecipients: settings.allowedRecipients.join("\n"),
  };
}

function isDirty(draft: Draft, status: GoogleStatus): boolean {
  const { settings } = status;
  return (
    draft.enabled !== settings.enabled ||
    draft.clientId.trim() !== settings.clientId ||
    draft.clientSecret.trim() !== "" ||
    GOOGLE_SERVICES.some(
      (service) => draft.permissions[service] !== settings.permissions[service],
    ) ||
    recipientLines(draft.allowedRecipients).join("\n") !== settings.allowedRecipients.join("\n")
  );
}

/**
 * Settings → Google Workspace: which of Gmail, Calendar, Tasks and Contacts agents may
 * use, and how far. Enforced by the `google-mcp` sidecar and by the OAuth
 * token's own scopes, both kept where no agent can reach them (bff/src/google/).
 */
export function GoogleSection() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nativeTools, setNativeTools] = useState<NativeTools | null>(null);

  // A status line, not a gate: a failure here leaves the section as it was.
  const loadNativeTools = useCallback(() => {
    fetchNativeTools()
      .then(setNativeTools)
      .catch(() => setNativeTools(null));
  }, []);

  const load = useCallback(async () => {
    try {
      const loaded = await fetchGoogleStatus();
      setStatus(loaded);
      setDraft(draftOf(loaded));
      setMessage(null);
      loadNativeTools();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [loadNativeTools]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<GoogleResult | null>, done: string) => {
    setBusy(true);
    try {
      const result = await action();
      const loaded = await fetchGoogleStatus();
      setStatus(loaded);
      setDraft(draftOf(loaded));
      // A warning is the part the refreshed status does not show — the levels
      // saved but the token no longer matches them.
      if (result?.warning) toast(result.warning, "warn");
      else toast(done);
      // The sidecar restarts with the new access over a few seconds, and the
      // BFF re-reads its tools after it; look again once that has happened.
      loadNativeTools();
      setTimeout(loadNativeTools, 15_000);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "bad");
    } finally {
      setBusy(false);
    }
  };

  if (!draft || !status) {
    return (
      <>
        {message ? (
          <p className="small bad pad">{message}</p>
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

  const { settings } = status;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const dirty = isDirty(draft, status);
  const locked = !status.writable || busy;
  const anyService = GOOGLE_SERVICES.some((service) => draft.permissions[service] !== null);
  const canConnect =
    status.writable &&
    !dirty &&
    !busy &&
    settings.clientId !== "" &&
    settings.hasClientSecret &&
    anyService;
  const limitsRecipients =
    reachesAddresses(draft.permissions) && recipientLines(draft.allowedRecipients).length > 0;

  const save = () => {
    const update: GoogleSettingsUpdate = {
      enabled: draft.enabled,
      clientId: draft.clientId,
      permissions: draft.permissions,
      // Sent even while the field is hidden: unchanged, it keeps the stored list.
      allowedRecipients: recipientLines(draft.allowedRecipients),
    };
    if (draft.clientSecret.trim()) update.clientSecret = draft.clientSecret.trim();
    const revokes =
      settings.grant !== null &&
      (wouldNarrow(settings.effective, draft.permissions) ||
        update.clientSecret !== undefined ||
        draft.clientId.trim() !== settings.clientId);
    if (
      revokes &&
      !window.confirm(
        "This takes access away from the current Google token, so it will be revoked. " +
          "Agents lose Google until you connect again. Continue?",
      )
    ) {
      return;
    }
    void run(() => saveGoogleSettings(update), "Saved.");
  };

  const connect = async () => {
    setBusy(true);
    try {
      window.location.assign(await startGoogleConnect());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  const disconnect = () => {
    if (!window.confirm("Revoke the Google token? Agents lose Google access at once.")) return;
    void run(disconnectGoogle, "Disconnected. The token was revoked at Google.");
  };

  return (
    <>
      <p className="muted small pad">
        Lets every agent — chats, crons and Telegram alike — use Gmail, Calendar, Tasks and Contacts
        as one Google account, at the access levels set below.
      </p>

      {!status.writable ? (
        <p className="warning small">
          Read-only here: this deployment signs nobody in, and an agent could sign itself in the
          same way and change these settings. Ask for a method in <code>docker/.env</code>(
          <code>SIGNIN=password</code> is enough), or accept the risk with
          <code>GOOGLE_ALLOW_INSECURE_SIGNIN=true</code> on a machine only you use.
        </p>
      ) : null}
      {message ? (
        <p className="warning small" role="alert">
          <span>{message}</span>
        </p>
      ) : null}

      <div className="pad-x">
        {settings.grant?.lostAt ? (
          // Google refused the token: found by a failed tool call or by the
          // check this screen runs on open. Agents are told to send the user
          // here, so the way out is the first thing on it.
          <div className="google-lost">
            <p className="small">
              <strong className="bad">Access lost for {settings.grant.email}</strong>
              {" · agents cannot use Google"}
            </p>
            <p className="small">
              Google stopped accepting the sign-in on{" "}
              {new Date(settings.grant.lostAt).toLocaleString()} — it was revoked, or expired
              (unused for a long time, or a password change). Reconnect to give agents access again.
            </p>
            <button
              type="button"
              className="button"
              disabled={!canConnect}
              title={dirty ? "Save first" : undefined}
              onClick={() => void connect()}
            >
              Reconnect Google
            </button>
          </div>
        ) : (
          <p className="small">
            <strong>
              {settings.grant ? `Connected as ${settings.grant.email}` : "Not connected"}
            </strong>
            {" · "}
            {settings.serving
              ? status.sidecarUp
                ? "agents have access"
                : "starting…"
              : "agents have no access"}
          </p>
        )}
        {nativeTools ? (
          <p className="small muted">{describeGoogleTools(nativeTools.google)}</p>
        ) : null}
        {settings.needsReconnect && !settings.grant?.lostAt ? (
          <p className="small bad">
            The token does not cover everything chosen below
            {settings.grant ? " — reconnect to grant the rest" : " — connect to grant it"}. Until
            then agents get only what it covers.
          </p>
        ) : null}
        {settings.grant ? (
          <ul className="small muted">
            {GOOGLE_SERVICES.map((service) => (
              <li key={service}>
                {SERVICE_LABELS[service]}: {levelLabel(service, settings.effective[service])}
              </li>
            ))}
          </ul>
        ) : null}

        <ToggleRow
          title="Allow agents to use Google"
          checked={draft.enabled}
          disabled={locked}
          onChange={(enabled) => set({ enabled })}
        />

        {GOOGLE_SERVICES.map((service) => (
          <label key={service} className="field">
            {SERVICE_LABELS[service]}
            <select
              value={draft.permissions[service] ?? ""}
              disabled={locked}
              onChange={(event) =>
                set({
                  permissions: { ...draft.permissions, [service]: event.target.value || null },
                })
              }
            >
              <option value="">Off</option>
              {GOOGLE_LEVELS[service].map((entry) => (
                <option key={entry.level} value={entry.level}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
        ))}
        {limitsRecipients ? (
          <p className="muted small">
            Mind what combines: email an agent reads can carry instructions aimed at it. Mail and
            calendar invitations still reach only the allowed recipients below.
          </p>
        ) : (
          <p className="muted small">
            Mind what combines: an agent that can create calendar events can invite any address,
            which sends that person mail even when Gmail is read-only — and email it reads can carry
            instructions aimed at it.
          </p>
        )}
        {reachesAddresses(draft.permissions) ? (
          // Hidden is not cleared: the stored list stays, and comes back with a sending level.
          <label className="field">
            Allowed recipients
            <textarea
              rows={4}
              value={draft.allowedRecipients}
              disabled={locked}
              placeholder={"alice@example.com\n@example.org"}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set({ allowedRecipients: event.target.value })}
            />
            <span className="muted small">
              Gmail recipients and calendar invitees. One address per line, or <code>@domain</code>{" "}
              for a whole domain. Matching is exact: <code>alice+news@</code> is not{" "}
              <code>alice@</code>. Empty: agents can email anyone.
            </span>
          </label>
        ) : null}

        {settings.clientSource === "env" ? (
          <p className="muted small">
            The client in force comes from <code>GOOGLE_CLIENT_ID</code> in <code>docker/.env</code>{" "}
            — the one this instance signs in with too — so what is saved here waits until those
            variables are removed.
          </p>
        ) : null}
        <label className="field">
          OAuth client ID
          <input
            value={draft.clientId}
            disabled={locked}
            placeholder="….apps.googleusercontent.com"
            autoComplete="off"
            onChange={(event) => set({ clientId: event.target.value })}
          />
        </label>
        <label className="field">
          OAuth client secret
          <input
            type="password"
            value={draft.clientSecret}
            disabled={locked}
            placeholder={settings.hasClientSecret ? "Saved — type to replace" : "Required"}
            autoComplete="off"
            onChange={(event) => set({ clientSecret: event.target.value })}
          />
          <span className="muted small">
            A Web application client in your own Google Cloud project, with this redirect URI:{" "}
            <code>{status.redirectUri}</code>
          </span>
        </label>

        <div className="button-row">
          <button type="button" className="button" disabled={locked || !dirty} onClick={save}>
            {busy ? "Working…" : "Save"}
          </button>
          <button
            type="button"
            className="button ghost"
            disabled={!canConnect}
            title={dirty ? "Save first" : undefined}
            onClick={() => void connect()}
          >
            {settings.grant ? "Reconnect" : "Connect Google"}
          </button>
          {settings.grant ? (
            <>
              <button
                type="button"
                className="button ghost"
                disabled={busy}
                onClick={() => void run(verifyGoogle, "Google confirmed the token.")}
              >
                Check with Google
              </button>
              <button
                type="button"
                className="button danger ghost"
                disabled={locked}
                onClick={disconnect}
              >
                Disconnect
              </button>
            </>
          ) : null}
        </div>

        {settings.grant ? (
          <details className="small muted">
            <summary>Scopes Google granted</summary>
            <ul>
              {settings.grant.scopes.map((scope) => (
                <li key={scope}>
                  <code>{shortScope(scope)}</code>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </>
  );
}
