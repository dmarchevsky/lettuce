import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import { fetchModelCaps, type ModelCapsStore } from "../lib/model-caps.ts";
import {
  fetchProviders,
  type Provider,
  type ProviderType,
  removeProvider,
} from "../lib/provider-registry.ts";
import { handleProvider, normalizeProviderKey } from "../lib/providers.ts";
import { type ModelEntry, type ModelsApi, useModels } from "../state/use-models.ts";
import type { SessionApi } from "../state/use-session.ts";
import { Icon } from "./Icon.tsx";
import { ModelEditSheet, type ModelEditTarget } from "./ModelEditSheet.tsx";
import { ProviderFormSheet } from "./ProviderFormSheet.tsx";
import { Sheet } from "./Sheet.tsx";

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
  /** False for a connection the app-server holds: Disconnect, not Remove. */
  owned: boolean;
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
  const [caps, setCaps] = useState<ModelCapsStore>({ models: {}, endpoints: {} });
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<{ editing: Provider | null } | null>(null);
  const [editingConnection, setEditingConnection] = useState<ConnectionEntry | null>(null);
  const [editingModel, setEditingModel] = useState<ModelEditTarget | null>(null);

  const load = useCallback(async () => {
    setStatus("Loading providers…");
    try {
      const registry = await fetchProviders();
      setTypes(registry.types);
      setProviders(registry.providers);
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
    connectionRows.push({
      prefix: entry.id,
      name: entry.display_name,
      typeLabel: "app-server",
      meta: `${connectionUrl(entry)}`,
      metaOk: true,
      scope: entry.requires_api_key || entry.is_oauth ? "cloud" : "local",
      models: owned,
      owned: false,
      connection: entry,
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
    owned: true,
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
    setStatus(`Removing ${provider.name}…`);
    try {
      await removeProvider(provider.prefix);
      setStatus(`Removed ${provider.name}.`);
      await load();
      void models.refresh();
    } catch (cause) {
      setStatus(errorMessage(cause));
    }
  };

  const disconnect = async (entry: ConnectionEntry) => {
    setStatus(`Disconnecting ${entry.display_name}…`);
    try {
      await session.request("disconnect_provider", {
        target: "local",
        provider_id: entry.id,
        provider_name: entry.provider_name,
      });
      setStatus("");
      await load();
      void models.refresh();
    } catch (cause) {
      setStatus(errorMessage(cause));
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
              <button
                type="button"
                className="link"
                onClick={() => setForm({ editing: row.provider ?? null })}
              >
                Edit
              </button>
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
                onClick={() => setEditingConnection(row.connection ?? null)}
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
        <div className="prov-meta muted small">
          {row.metaOk ? <span className="ok">Connected</span> : null}
          {row.metaOk && row.meta ? " · " : null}
          <code>{row.meta}</code>
        </div>
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
                  {row.models.length === 1 ? "Model (1)" : `Models (${row.models.length})`}
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

      {status ? <p className="muted small pad">{status}</p> : null}
      {models.changed ? (
        <p className="warning small">
          An endpoint returned a different set of models on the last refresh —{" "}
          {models.changed.currentCount} now versus {models.changed.previousCount} before. That
          usually means it load-balances <code>/models</code> across several backends, so each call
          is answered by a different one. Point one provider at an aggregating endpoint, or at a
          single backend.
        </p>
      ) : null}

      {local.length === 0 && cloud.length === 0 ? (
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
          onClose={() => setForm(null)}
          onSaved={(mod) => {
            setForm(null);
            setStatus(
              mod === "failed"
                ? "Saved, but the app-server could not be reloaded — it applies on reconnect."
                : mod === "reload-pending"
                  ? "Saved. It applies once an agent exists to carry the reload."
                  : "Saved. Agents see it on their next turn.",
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

      {editingConnection ? (
        <ConnectionSheet
          session={session}
          entry={editingConnection}
          onClose={() => setEditingConnection(null)}
          onSaved={() => {
            setEditingConnection(null);
            setStatus("Saved. Agents see it on their next turn.");
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
            placeholder={
              field.secret ? "Leave blank to keep the stored value" : (field.placeholder ?? "")
            }
            value={values[field.key] ?? ""}
            onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
          />
        </label>
      ))}
    </Sheet>
  );
}
