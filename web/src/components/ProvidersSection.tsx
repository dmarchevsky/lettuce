import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import { KEEP_STORED_HINT } from "../lib/field-hints.ts";
import { fetchModelCaps, type ModelCapsStore } from "../lib/model-caps.ts";
import {
  type ConnectionModels,
  fetchProviders,
  type Provider,
  type ProviderType,
  removeProvider,
} from "../lib/provider-registry.ts";
import { handleProvider, normalizeProviderKey } from "../lib/providers.ts";
import { SAVED_NO_AGENT, SAVED_NOW, SAVED_ON_RECONNECT } from "../lib/save-result.ts";
import { type ModelEntry, type ModelsApi, useModels } from "../state/use-models.ts";
import type { SessionApi } from "../state/use-session.ts";
import { ConnectionPickerSheet, type ConnectionTarget } from "./ConnectionPickerSheet.tsx";
import { Icon } from "./Icon.tsx";
import { ModelEditSheet, type ModelEditTarget } from "./ModelEditSheet.tsx";
import { ProviderFormSheet } from "./ProviderFormSheet.tsx";
import { Sheet } from "./Sheet.tsx";
import { toast } from "./Toast.tsx";

interface ProviderField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
}

interface ConnectionState {
  is_connected?: boolean;
  base_url?: string;
}

/** One connection the app-server holds itself (`list_connect_providers`). */
interface ConnectionEntry {
  id: string;
  display_name: string;
  provider_name: string;
  provider_names?: string[];
  requires_api_key: boolean;
  is_oauth?: boolean;
  fields?: ProviderField[];
  /** The nested flag is `is_connected`, not `connected`. */
  connected?: ConnectionState | boolean;
  connected_providers?: ConnectionState[];
}

function isConnected(provider: ConnectionEntry): boolean {
  if (typeof provider.connected === "boolean") return provider.connected;
  if (provider.connected && typeof provider.connected === "object") {
    return provider.connected.is_connected === true;
  }
  return (provider.connected_providers?.length ?? 0) > 0;
}

function connectionUrl(provider: ConnectionEntry): string {
  if (typeof provider.connected === "object" && provider.connected.base_url) {
    return provider.connected.base_url;
  }
  const first = provider.connected_providers?.[0];
  return typeof first === "object" && first?.base_url ? first.base_url : "";
}

/** Handle prefixes a connection answers to, normalised (llama.cpp ↔ llama-cpp). */
function connectionKeys(entry: ConnectionEntry): Set<string> {
  const keys = new Set<string>();
  for (const name of [entry.provider_name, ...(entry.provider_names ?? [])]) {
    if (name) keys.add(normalizeProviderKey(name));
  }
  return keys;
}

function tokenLabel(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : String(tokens);
}

/** One row of the list: a provider this screen owns, or an app-server connection. */
interface Row {
  prefix: string;
  name: string;
  typeLabel: string;
  meta: string;
  metaOk: boolean;
  scope: "local" | "cloud";
  models: string[];
  /** Stored custom-header count; a header value is never shown, only counted. */
  headerCount: number;
  /** False for a connection the app-server holds: Disconnect, not Remove. */
  owned: boolean;
  /** Why it serves nothing (or less than it lists); shown in place of the meta line. */
  problem?: string;
  /** No Edit: a stored provider of a type the app-server's own connection now serves. */
  removeOnly?: boolean;
  /** Everything a connection serves, when picks trim what is shown: "N of M". */
  total?: number;
  /**
   * Its models report their own capabilities and cannot be declared here: a
   * host naming models `vendor/model`, whose ids the providers mod refuses.
   */
  capsFixed?: boolean;
  provider?: Provider;
  connection?: ConnectionEntry;
}

/**
 * Settings → Providers & models.
 *
 * The list is the operator's own providers, not the catalog of everything that
 * could be connected: a row is something with a name they chose, and any number
 * of rows may share a type. Connections made on the app-server side still render
 * (tagged `app-server`) so an existing deployment is not left invisible, and
 * served models that belong to no row stay listed under Other models.
 */
export function ProvidersSection({ session }: { session: SessionApi }) {
  const models: ModelsApi = useModels(session);
  const [types, setTypes] = useState<ProviderType[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [connections, setConnections] = useState<ConnectionEntry[]>([]);
  const [picks, setPicks] = useState<Record<string, ConnectionModels>>({});
  const [picker, setPicker] = useState<ConnectionTarget | null>(null);
  const [caps, setCaps] = useState<ModelCapsStore>({ models: {}, endpoints: {} });
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<{ editing: Provider | null } | null>(null);
  const [editingConnection, setEditingConnection] = useState<ConnectionEntry | null>(null);
  const [editingModel, setEditingModel] = useState<ModelEditTarget | null>(null);

  const load = useCallback(async () => {
    setProgress("Loading providers…");
    try {
      const registry = await fetchProviders();
      setTypes(registry.types);
      setProviders(registry.providers);
      setPicks(registry.connections);
      const response = await session.request<{
        providers?: ConnectionEntry[];
        success?: boolean;
        error?: string;
      }>("list_connect_providers", { target: "local" });
      setConnections((response?.providers ?? []).filter(isConnected));
      setCaps(await fetchModelCaps());
      setStatus(response?.success === false ? (response.error ?? "") : "");
    } catch (cause) {
      setStatus(errorMessage(cause));
    } finally {
      setProgress("");
    }
  }, [session.request]);

  useEffect(() => {
    if (session.ready) void load();
  }, [session.ready, load]);

  const modelsByPrefix = new Map<string, ModelEntry[]>();
  const other: ModelEntry[] = [];
  for (const entry of models.models) {
    const prefix = handleProvider(entry.handle);
    const bucket = modelsByPrefix.get(prefix);
    if (bucket) bucket.push(entry);
    else modelsByPrefix.set(prefix, [entry]);
  }

  const registryPrefixes = new Set(providers.map((provider) => provider.prefix));
  const connectionRows: Row[] = [];
  for (const entry of connections) {
    const keys = connectionKeys(entry);
    const owned: string[] = [];
    for (const [prefix, entries] of modelsByPrefix) {
      if (registryPrefixes.has(prefix)) continue;
      const alias = models.aliases[prefix] ?? prefix;
      if (keys.has(normalizeProviderKey(alias))) owned.push(...entries.map((m) => m.handle));
    }
    if (owned.length > 0) registryPrefixes.add(handleProvider(owned[0] ?? "unknown"));
    const served = picks[entry.id];
    connectionRows.push({
      prefix: entry.id,
      name: entry.display_name,
      typeLabel: "app-server",
      meta: `${connectionUrl(entry)}`,
      metaOk: true,
      scope: entry.requires_api_key || entry.is_oauth ? "cloud" : "local",
      models: owned,
      headerCount: 0,
      owned: false,
      connection: entry,
      ...(served?.selected ? { total: served.served.length } : {}),
      capsFixed: types.some((type) => type.connection === entry.id),
    });
  }

  const registryRows: Row[] = providers.map((provider) => ({
    prefix: provider.prefix,
    name: provider.name,
    typeLabel:
      types.find((type) => type.id === provider.type)?.label ??
      (provider.type || "declared endpoint"),
    meta: provider.baseUrl,
    metaOk: false,
    scope: provider.scope,
    // What the provider declares, plus anything already served under its prefix —
    // an endpoint seeded before this screen existed (or gained outside it) still
    // lists its models here rather than in "Other models".
    models: Array.from(
      new Set([
        ...provider.models.map((id) => `${provider.prefix}/${id}`),
        ...(modelsByPrefix.get(provider.prefix) ?? []).map((entry) => entry.handle),
      ]),
    ),
    headerCount: provider.headerNames.length,
    owned: true,
    ...(provider.problem ? { problem: provider.problem } : {}),
    // Saved before its type became a connection and holding ids the mod refuses:
    // its fix is Remove and add the connection. Any other problem — a load error
    // included — leaves it editable.
    removeOnly: Boolean(
      provider.unregistrable && types.find((type) => type.id === provider.type)?.connection,
    ),
    provider,
  }));

  const claimed = new Set<string>();
  for (const row of [...registryRows, ...connectionRows])
    for (const handle of row.models) claimed.add(handle);
  for (const entry of models.models) {
    if (!claimed.has(entry.handle)) other.push(entry);
  }

  const remove = async (provider: Provider) => {
    if (
      !window.confirm(
        `Remove "${provider.name}"? Its ${provider.models.length} model(s) stop being available.`,
      )
    ) {
      return;
    }
    setProgress(`Removing ${provider.name}…`);
    try {
      await removeProvider(provider.prefix);
      toast(`Removed ${provider.name}.`);
      await load();
      void models.refresh();
    } catch (cause) {
      toast(`Could not remove ${provider.name}: ${errorMessage(cause)}`, "bad");
    } finally {
      // The toast says the result; the in-flight line must not outlive it.
      setProgress("");
    }
  };

  // A connection of one of the hosts naming models `vendor/model` edits in the
  // picker (endpoint, key, which models to show); any other keeps its own fields.
  const editConnection = (entry: ConnectionEntry) => {
    const type = types.find((candidate) => candidate.connection === entry.id);
    if (!type) {
      setEditingConnection(entry);
      return;
    }
    // Blank when the app-server stores none: the connection uses the catalog's own.
    setPicker({ type, baseUrl: connectionUrl(entry), editing: true });
  };

  const disconnect = async (entry: ConnectionEntry) => {
    try {
      await session.request("disconnect_provider", {
        target: "local",
        provider_id: entry.id,
        provider_name: entry.provider_name,
      });
      toast(`Disconnected ${entry.display_name}.`);
      await load();
      void models.refresh();
    } catch (cause) {
      toast(`Could not disconnect ${entry.display_name}: ${errorMessage(cause)}`, "bad");
    }
  };

  const renderRow = (row: Row) => {
    const expanded = open[row.prefix] === true;
    const handles = expanded ? row.models : [];
    // A connection the app-server holds only lists what belongs to it; with
    // nothing attributed there is nothing to expand, and "add some" would be
    // advice you cannot act on — its models are discovered upstream.
    const showModels = row.models.length > 0 || row.owned;
    return (
      <li key={row.prefix}>
        <div className="row static">
          <span className="grow-text">
            <strong>{row.name}</strong>
            <span className="tag muted type">{row.typeLabel}</span>
          </span>
          {row.owned ? (
            <>
              {row.removeOnly ? null : (
                <button
                  type="button"
                  className="link"
                  onClick={() => setForm({ editing: row.provider ?? null })}
                >
                  Edit
                </button>
              )}
              <button
                type="button"
                className="link danger"
                onClick={() => void remove(row.provider as Provider)}
              >
                Remove
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="link"
                onClick={() => editConnection(row.connection as ConnectionEntry)}
              >
                Edit
              </button>
              <button
                type="button"
                className="link danger"
                onClick={() => void disconnect(row.connection as ConnectionEntry)}
              >
                Disconnect
              </button>
            </>
          )}
        </div>
        {row.problem ? (
          <p className="warning small">{row.problem}</p>
        ) : (
          <div className="prov-meta muted small">
            {row.metaOk ? <span className="ok">Connected</span> : null}
            {row.metaOk && row.meta ? " · " : null}
            <code>{row.meta}</code>
            {row.headerCount > 0
              ? ` · ${row.headerCount} header${row.headerCount === 1 ? "" : "s"}`
              : null}
          </div>
        )}
        {showModels ? (
          <>
            <div className="models-head">
              <button
                type="button"
                className="tool-head"
                aria-expanded={expanded}
                onClick={() => setOpen({ ...open, [row.prefix]: !expanded })}
              >
                <span className="tag">
                  {row.total !== undefined
                    ? `Models (${row.models.length} of ${row.total})`
                    : row.models.length === 1
                      ? "Model (1)"
                      : `Models (${row.models.length})`}
                </span>
                <Icon name={expanded ? "chevron-down" : "chevron-right"} className="chevron" />
              </button>
            </div>
            {expanded ? (
              handles.length > 0 ? (
                <ul className="list nested">
                  {handles.map((handle) => {
                    const model = models.models.find((entry) => entry.handle === handle);
                    const declared = caps.models[handle];
                    return (
                      <li key={handle}>
                        <div className="row static">
                          <span className="grow-text">
                            {model?.label ?? handle.slice(handle.indexOf("/") + 1)}
                            {declared?.vision ? <span className="tag muted">Vision</span> : null}
                            {declared?.thinking ? (
                              <span className="tag muted">Thinking</span>
                            ) : null}
                          </span>
                          {declared ? (
                            <span className="muted small">
                              {tokenLabel(declared.contextWindow)}
                            </span>
                          ) : null}
                          {row.capsFixed ? null : (
                            <button
                              type="button"
                              className="link"
                              onClick={() =>
                                setEditingModel({
                                  handle,
                                  label: model?.label ?? handle,
                                  baseUrl: row.meta || undefined,
                                  requiresKey: row.owned
                                    ? true
                                    : row.connection?.requires_api_key === true,
                                  caps: declared ?? null,
                                })
                              }
                            >
                              Edit
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="muted small pad">No models yet — edit the provider and add some.</p>
              )
            ) : null}
          </>
        ) : null}
      </li>
    );
  };

  const local = [...registryRows, ...connectionRows].filter((row) => row.scope === "local");
  const cloud = [...registryRows, ...connectionRows].filter((row) => row.scope === "cloud");

  return (
    <>
      <div className="pane-bar">
        <button type="button" className="link" onClick={() => setForm({ editing: null })}>
          <Icon name="plus" /> Add provider
        </button>
        <span className="spacer" />
        <span className="muted small">
          {providers.length + connectionRows.length}{" "}
          {providers.length + connectionRows.length === 1 ? "provider" : "providers"}
        </span>
        <button
          type="button"
          className="link"
          disabled={models.loading}
          onClick={() => void models.refresh()}
          title="Refresh models"
          aria-label="Refresh models"
        >
          <Icon name="refresh" />
        </button>
      </div>

      {progress && !status ? <p className="muted small pad">{progress}</p> : null}
      {status ? (
        <p className="warning small" role="alert">
          <span>{status}</span>
          <button type="button" className="link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}

      {/* The empty state waits for the load: while the list is still on its way this
         same frame used to say “Loading providers…” and “No providers yet — an agent
         has no model to answer with”, and a one-second fetch read as wiped state. */}
      {local.length === 0 && cloud.length === 0 && !progress ? (
        <ul className="list">
          <li className="muted pad">
            No providers yet — an agent has no model to answer with until you add one.
          </li>
        </ul>
      ) : null}
      {local.length > 0 ? (
        <>
          <p className="section-note">Local</p>
          <ul className="list">{local.map(renderRow)}</ul>
        </>
      ) : null}
      {cloud.length > 0 ? (
        <>
          <p className="section-note">Cloud</p>
          <ul className="list">{cloud.map(renderRow)}</ul>
        </>
      ) : null}

      {other.length > 0 ? (
        <>
          <p className="section-note">Other models ({other.length})</p>
          <ul className="list">
            {other.map((entry) => (
              <li key={entry.id}>
                <div className="row static">
                  <span className="grow-text">{entry.label}</span>
                  <code className="muted small">{handleProvider(entry.handle)}</code>
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      setEditingModel({
                        handle: entry.handle,
                        label: entry.label,
                        baseUrl: undefined,
                        requiresKey: false,
                        caps: caps.models[entry.handle] ?? null,
                      })
                    }
                  >
                    Edit
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <p className="pad-x muted small">
            Served by a connection the app-server holds or an endpoint seeded on its host.
          </p>
        </>
      ) : null}

      {form ? (
        <ProviderFormSheet
          types={types}
          editing={form.editing}
          onClose={() => {
            setForm(null);
            // A save the app-server refused kept the sheet open; its row now says why.
            void load();
          }}
          onConnected={(target) => {
            setForm(null);
            toast(`Connected ${target.type.label}.`);
            setPicker(target);
            void load();
          }}
          onSaved={(mod) => {
            setForm(null);
            toast(
              mod === "failed"
                ? SAVED_ON_RECONNECT
                : mod === "reload-pending"
                  ? SAVED_NO_AGENT
                  : SAVED_NOW,
              mod === "failed" ? "warn" : "ok",
            );
            void load();
            void models.refresh();
          }}
        />
      ) : null}

      {editingModel ? (
        <ModelEditSheet
          target={editingModel}
          onClose={() => setEditingModel(null)}
          onSaved={() => {
            setEditingModel(null);
            void load();
            void models.refresh();
          }}
        />
      ) : null}

      {picker ? (
        <ConnectionPickerSheet
          target={picker}
          onClose={() => setPicker(null)}
          onSaved={() => {
            setPicker(null);
            toast(SAVED_NOW);
            void load();
            void models.refresh();
          }}
        />
      ) : null}

      {editingConnection ? (
        <ConnectionSheet
          session={session}
          entry={editingConnection}
          onClose={() => setEditingConnection(null)}
          onSaved={() => {
            setEditingConnection(null);
            toast(SAVED_NOW);
            void load();
            void models.refresh();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The fields of a connection the app-server holds. `connect_provider` routes to
 * create-or-update keyed on the provider id, so re-issuing it with new fields IS
 * the edit — and only typed-in fields are sent, because a blank field reads as
 * *absent* and would clear a stored key.
 */
function ConnectionSheet({
  session,
  entry,
  onClose,
  onSaved,
}: {
  session: SessionApi;
  entry: ConnectionEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    const url = connectionUrl(entry);
    if (url) initial.baseUrl = url;
    return initial;
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const fields = Object.fromEntries(
        Object.entries(values).filter(([, value]) => value.trim() !== ""),
      );
      await session.request("connect_provider", {
        target: "local",
        provider_id: entry.id,
        fields,
      });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={entry.display_name}
      size="compact"
      status={error}
      onClose={onClose}
      actions={
        <>
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
        This connection belongs to the app-server, so its fields are theirs, and it discovers its
        own models.
      </p>
      {(entry.fields ?? []).map((field) => (
        <label className="field" key={field.key}>
          {field.label}
          <input
            type={field.secret ? "password" : "text"}
            placeholder={field.secret ? KEEP_STORED_HINT : (field.placeholder ?? "")}
            value={values[field.key] ?? ""}
            onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
          />
        </label>
      ))}
    </Sheet>
  );
}
