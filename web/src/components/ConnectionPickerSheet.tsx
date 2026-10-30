import { useEffect, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import { KEEP_STORED_HINT } from "../lib/field-hints.ts";
import {
  connectionPicks,
  customEndpointNote,
  fetchProviders,
  type ProviderType,
  probeModels,
  saveConnectionModels,
  saveProvider,
} from "../lib/provider-registry.ts";
import { matchesQuery } from "../lib/text-filter.ts";
import { EndpointFields } from "./EndpointFields.tsx";
import { FilterField } from "./FilterField.tsx";
import { MenuRow } from "./MenuRow.tsx";
import { Sheet } from "./Sheet.tsx";

/** What the picker opens on: a connection the app-server holds, just made or being edited. */
export interface ConnectionTarget {
  type: ProviderType;
  /** The endpoint the app-server stores, blank when it uses the catalog's own. */
  baseUrl: string;
  /** The key typed for a connect a moment ago; it lets the live probe authenticate. */
  apiKey?: string;
  editing: boolean;
}

/**
 * Which models of a connection the app-server holds the browsers are shown
 * (OpenRouter and the other hosts naming models `vendor/model`), and, when
 * editing, its endpoint and key.
 *
 * The served list is letta-code's bundled catalog, so the picker also asks the
 * host what it lists today: with nothing stored, the default is what is served and
 * still listed (`connectionPicks`). The trimming happens in the BFF; an agent
 * already on a model left out keeps working.
 */
export function ConnectionPickerSheet({
  target,
  onClose,
  onSaved,
}: {
  target: ConnectionTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const prefix = target.type.connection ?? target.type.id;
  const [served, setServed] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [notListed, setNotListed] = useState<string[]>([]);
  const [notInCatalog, setNotInCatalog] = useState(0);
  const [query, setQuery] = useState("");
  const [baseUrl, setBaseUrl] = useState(target.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [registry, listed] = await Promise.all([
          fetchProviders(),
          // The host's list today; a failed probe only means no default narrowing.
          probeModels({
            api: target.type.api,
            baseUrl: target.baseUrl || target.type.baseUrl,
            apiKey: target.apiKey ?? "",
            type: target.type.id,
          })
            .then((found) => found.models)
            .catch(() => null),
        ]);
        if (!live) return;
        const connection = registry.connections[prefix];
        const servedIds = connection?.served ?? [];
        const picks = connectionPicks({
          served: servedIds,
          live: listed,
          stored: connection?.selected ?? null,
        });
        setServed(servedIds);
        setSelected(picks.selected);
        setNotListed(picks.notListed);
        setNotInCatalog(picks.notInCatalog);
      } catch (cause) {
        if (live) setError(errorMessage(cause));
      }
    })();
    return () => {
      live = false;
    };
  }, [prefix, target]);

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((model) => model !== id) : [...current, id],
    );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const endpointChanged = baseUrl.trim() !== target.baseUrl;
      if (target.editing && (endpointChanged || apiKey.trim())) {
        // connect_provider takes the key and the endpoint together; upstream never
        // reads a key back, so a new endpoint needs the key typed again.
        if (!apiKey.trim()) {
          setError("Type the API key again to change the endpoint.");
          return;
        }
        await saveProvider({
          name: "",
          type: target.type.id,
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          models: [],
          update: true,
        });
      }
      await saveConnectionModels(prefix, selected);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const shown = (served ?? []).filter((id) => matchesQuery(id, query));
  const label = target.type.label;
  const endpointNote = customEndpointNote(target.type, baseUrl);
  return (
    <Sheet
      title={target.editing ? `Edit ${label}` : label}
      size="compact"
      status={error}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button"
            disabled={busy || served === null || selected.length === 0}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      {target.editing ? (
        <>
          <div className="field">
            Type
            <span style={{ fontWeight: 600 }}>{label}</span>
            <span className="small">
              One {label} connection, served as <code>{prefix}/&lt;vendor&gt;/&lt;model&gt;</code>.
            </span>
          </div>
          <EndpointFields
            baseUrl={baseUrl}
            baseUrlPlaceholder={target.type.baseUrl}
            note={endpointNote}
            onBaseUrl={setBaseUrl}
            apiKey={apiKey}
            keyPlaceholder={KEEP_STORED_HINT}
            onApiKey={setApiKey}
          />
        </>
      ) : (
        <p className="muted small">
          <span className="ok">Connected</span> ·{" "}
          <code>{target.baseUrl || target.type.baseUrl}</code>
        </p>
      )}

      <p className="section-note" style={{ marginLeft: 0 }}>
        {served === null
          ? "Models — loading…"
          : `Models — ${selected.length} of ${served.length} selected`}
      </p>
      <FilterField
        label="Find a model"
        placeholder="Filter by name…"
        value={query}
        onChange={setQuery}
      />
      {served !== null && served.length === 0 ? (
        <p className="muted small pad">The connection serves nothing yet — try Refresh.</p>
      ) : (
        <ul className="menu-list">
          {shown.map((id) => (
            <MenuRow
              key={id}
              title={id}
              mark="checkbox"
              selected={selected.includes(id)}
              {...(notListed.includes(id)
                ? { description: `not listed by ${label} any more` }
                : {})}
              onClick={() => toggle(id)}
            />
          ))}
        </ul>
      )}
      <p className="muted small">
        {target.editing
          ? null
          : `Ticked: what letta-code's catalog serves and ${label} still lists. `}
        {notInCatalog > 0
          ? `${notInCatalog} live ${notInCatalog === 1 ? "model isn't" : "models aren't"} in letta-code's catalog yet; they arrive with a letta-code upgrade.`
          : null}
      </p>
    </Sheet>
  );
}
