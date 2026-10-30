import { useEffect, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import type { RuntimeScope } from "../lib/protocol.ts";
import { groupByProvider } from "../lib/providers.ts";
import { matchesQuery } from "../lib/text-filter.ts";
import type { ToolsetSummary } from "../state/use-conversation.ts";
import { type ModelEntry, type ModelsApi, useModels } from "../state/use-models.ts";
import type { SessionApi } from "../state/use-session.ts";
import { FilterField } from "./FilterField.tsx";
import { Icon } from "./Icon.tsx";
import { MenuRow } from "./MenuRow.tsx";
import { Sheet } from "./Sheet.tsx";
import { toast } from "./Toast.tsx";

interface Props {
  session: SessionApi;
  scope: RuntimeScope | null;
  /** Lifted to App so the composer button reflects a switch made here. */
  currentModel: { handle: string | null; setHandle: (handle: string | null) => void };
  /** Live from device status — "auto" or an explicit toolset id. Null until the first status frame. */
  toolsetPreference: string | null;
  availableToolsets: ToolsetSummary[];
  onClose: () => void;
}

/** Past this many models the list gets a filter box; a llama.cpp box serves a handful. */
const FILTER_MIN = 10;

/**
 * Each provider's models narrowed to the query, matched on label and handle, with
 * the group's unfiltered size kept for its heading. A group left empty is dropped.
 */
export function filterGroups(
  groups: readonly { provider: string; models: ModelEntry[] }[],
  query: string,
): { provider: string; models: ModelEntry[]; total: number }[] {
  return groups
    .map(({ provider, models }) => ({
      provider,
      models: models.filter((model) => matchesQuery(`${model.label} ${model.handle}`, query)),
      total: models.length,
    }))
    .filter((group) => group.models.length > 0);
}

/**
 * The model list, shared by the two places a model is chosen: this sheet (a
 * conversation's runtime) and an agent's model field. Both used to have their own
 * list in their own idiom, which made "which endpoint serves this?" unanswerable
 * in one of them.
 *
 * It picks; it never applies. What applying means — an `update_model` for a
 * runtime, a staged draft handle on an agent — belongs to the caller.
 */
export function ModelChoices({
  models,
  currentHandle,
  emptyLabel,
  onPick,
  disabled = false,
}: {
  /** The live list: loading, availability and empty states come with it. */
  models: ModelsApi;
  /** The handle to mark; null marks nothing (or the `emptyLabel` row). */
  currentHandle: string | null;
  /** When given, a first row that picks `null` — "Unchanged", "Preset default". */
  emptyLabel?: string;
  /** `null` is the `emptyLabel` row's choice. */
  onPick: (handle: string | null) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const list = models.models;
  const served = list.some((model) => model.handle === currentHandle);
  // Counted on the whole list, so the box does not vanish as a query narrows it.
  const filtering = list.length > FILTER_MIN;
  // A Refresh that drops the list to a handful hides the box; its query goes
  // with it, or it would come back pre-filled when the list grows again.
  useEffect(() => {
    if (!filtering) setQuery("");
  }, [filtering]);
  const searching = filtering && query.trim() !== "";
  const groups = filterGroups(groupByProvider(list), filtering ? query : "");
  const notice =
    models.availability === "lookup-failed"
      ? "Could not reach the provider to check availability — showing the built-in list."
      : models.availability === "not-reported"
        ? "This server does not report model availability — showing the built-in list."
        : null;
  return (
    <>
      {filtering ? (
        <FilterField
          placeholder="Filter models by name…"
          value={query}
          onChange={setQuery}
          pinned
        />
      ) : null}
      {notice ? (
        <p className="warning small" role="status">
          {notice}
        </p>
      ) : null}
      {models.loading ? <p className="muted">Loading models…</p> : null}
      {!models.loading && list.length === 0 ? (
        <p className="muted">
          No models are being served. Connect a provider in Settings, then Refresh.
        </p>
      ) : null}
      {emptyLabel === undefined ? null : (
        <ul className="menu-list">
          <MenuRow
            title={emptyLabel}
            mark="check"
            selected={currentHandle === null}
            disabled={disabled}
            onClick={() => onPick(null)}
          />
        </ul>
      )}
      {/* A handle missing from the list must stay selectable: the endpoint
          stopped serving it, or it was left out of a connection's picks (and
          still answers). Either way the agent has to be able to save its name
          without being silently moved onto a different model. */}
      {currentHandle && !served ? (
        <ul className="menu-list">
          <MenuRow
            title={`${currentHandle} (not in the list)`}
            mark="check"
            selected
            disabled={disabled}
            onClick={() => onPick(currentHandle)}
          />
        </ul>
      ) : null}
      {searching && groups.length === 0 ? (
        <p className="muted">No model matches “{query.trim()}”.</p>
      ) : null}
      {groups.map(({ provider, models: group, total }) => (
        <section key={provider}>
          <p className="menu-section">
            {provider} · {searching ? `${group.length} of ` : ""}
            {total} {total === 1 ? "model" : "models"}
          </p>
          <ul className="menu-list">
            {group.map((model) => (
              <MenuRow
                key={model.id}
                title={model.label}
                // The handle is "<provider>/<label>" almost always; repeating it
                // under every row said the provider ten times. Kept only when it
                // adds something the title and heading do not.
                description={
                  model.handle === `${provider}/${model.label}` ? undefined : model.handle
                }
                mark="check"
                selected={model.handle === currentHandle}
                disabled={disabled}
                onClick={() => onPick(model.handle)}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** The toolset in force, as its own label — or "Auto" while nothing is chosen. */
export function toolsetLabel(
  preference: string | null,
  toolsets: readonly ToolsetSummary[],
): string {
  return toolsets.find((toolset) => toolset.id === preference)?.label ?? "Auto";
}

/** Applies to the conversation, not the agent, so each thread can differ. */
export function ModelPicker({
  session,
  scope,
  currentModel,
  toolsetPreference,
  availableToolsets,
  onClose,
}: Props) {
  const models = useModels(session);
  const current = currentModel;
  const [busy, setBusy] = useState(false);
  const [toolsetBusy, setToolsetBusy] = useState(false);

  const choose = async (handle: string) => {
    if (!scope) return;
    setBusy(true);
    try {
      // `isUpdateModelCommand` requires model_id or model_handle to be a
      // string. A payload without either (the old `{ model: handle }`, or the
      // entry's `updateArgs`) fails the guard, matches no handler, and gets
      // **no response at all** — same silent-hang class as `grep_in_files`
      // with the wrong key. Verified against the local app-server.
      const model = models.models.find((entry) => entry.handle === handle);
      const response = await session.request<{
        success?: boolean;
        model_handle?: string;
        error?: string;
      }>("update_model", {
        runtime: scope,
        // A handle with no entry (served when the list was last refreshed, not
        // now) still goes through by handle alone: an id we do not have would be
        // invented here.
        payload: model
          ? { model_id: model.id, model_handle: model.handle }
          : { model_handle: handle },
      });
      const label = model?.label ?? handle;

      if (response?.success === false) {
        toast(response.error ?? `Could not switch to ${label}`, "bad");
        return;
      }
      current.setHandle(response?.model_handle ?? handle);
      toast(`Switched to ${label}.`);
      onClose();
    } catch (cause) {
      toast(`Could not switch to ${handle}: ${errorMessage(cause)}`, "bad");
    } finally {
      setBusy(false);
    }
  };

  const chooseToolset = async (toolset: ToolsetSummary) => {
    if (!scope) return;
    setToolsetBusy(true);
    try {
      const response = await session.request<{ success?: boolean; error?: string }>(
        "update_toolset",
        { runtime: scope, toolset_preference: toolset.id },
      );
      // The picked value reflects back through the next update_device_status
      // frame, same as permission mode — no optimistic local state needed.
      if (response?.success === false) toast(response.error ?? "Could not switch toolset", "bad");
      else toast(`Switched to the ${toolset.label} toolset.`);
    } catch (cause) {
      toast(`Could not switch toolset: ${errorMessage(cause)}`, "bad");
    } finally {
      setToolsetBusy(false);
    }
  };

  return (
    <Sheet
      title="Model"
      onClose={onClose}
      status={models.error}
      headerAction={
        <button
          type="button"
          className="sheet-head-icon"
          disabled={models.loading}
          onClick={() => void models.refresh()}
          aria-label="Refresh the model list"
          title="Refresh"
        >
          <Icon name="refresh" />
        </button>
      }
    >
      <ModelChoices
        models={models}
        currentHandle={current.handle}
        onPick={(handle) => {
          // No emptyLabel here, so null never arrives; the guard is the type, not
          // a fourth state.
          if (handle !== null) void choose(handle);
        }}
        disabled={busy}
      />

      {availableToolsets.length > 0 ? (
        // Collapsed on every open: the toolset is chosen far less often than the
        // model, and the row's own header names what is in force, so nothing the
        // user needed is hidden behind the disclosure.
        <details className="menu-collapsible">
          <summary>
            <span className="menu-section">Toolset</span>
            <span className="menu-section-value">
              {toolsetLabel(toolsetPreference, availableToolsets)}
            </span>
            <Icon name="chevron-right" className="menu-collapsible-mark" />
          </summary>
          <ul className="menu-list">
            {availableToolsets
              .filter((toolset) => toolset.featured || toolset.id === toolsetPreference)
              .map((toolset) => (
                <MenuRow
                  key={toolset.id}
                  title={toolset.label}
                  description={toolset.description}
                  mark="check"
                  selected={toolset.id === toolsetPreference}
                  disabled={toolsetBusy}
                  onClick={() => void chooseToolset(toolset)}
                />
              ))}
          </ul>
        </details>
      ) : null}
    </Sheet>
  );
}
