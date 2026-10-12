import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import type { SessionApi } from "../state/use-session.ts";
import { Sheet } from "./Sheet.tsx";
import { toast } from "./Toast.tsx";

interface SecretEntry {
  key: string;
  value: string;
}

/** The add/edit form. `original` is null when creating a new key. */
interface SecretDraft {
  original: string | null;
  key: string;
  value: string;
}

interface Props {
  session: SessionApi;
  agentId: string | null;
}

/**
 * Agent secrets.
 *
 * `secret_list` deliberately returns plaintext values: upstream documents that
 * the modal needs them to populate the form, and the names-only behaviour
 * belongs to a different CLI code path. We mask them in the render anyway —
 * shoulder-surfing is a real threat on a phone — but the mask is not a
 * boundary. The values are on the wire and in this component's state.
 *
 * Writes are batched into ONE `secret_apply` per save. Upstream computes
 * `(current ∪ set) ∖ unset` and PATCHes core in a single call, which is what
 * removes the read-modify-write race that per-key calls would have. Keys
 * present in both lists resolve to `unset`, so a save must never send the same
 * key in both.
 */
export function SecretsSection({ session, agentId }: Props) {
  const [secrets, setSecrets] = useState<SecretEntry[]>([]);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<SecretDraft | null>(null);

  const load = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    setStatus("");
    try {
      const response = await session.request<{
        success?: boolean;
        secrets?: SecretEntry[];
        error?: string;
      }>("secret_list", { agent_id: agentId });
      if (response?.success === false) {
        setStatus(response.error ?? "Could not list secrets");
        return;
      }
      setSecrets(response?.secrets ?? []);
    } catch (cause) {
      setStatus(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [agentId, session.request]);

  useEffect(() => {
    if (session.ready && agentId) void load();
  }, [session.ready, agentId, load]);

  const save = async () => {
    if (!agentId || !draft) return;
    const key = draft.key.trim();
    if (!key) return;

    // Never let one key land in both `set` and `unset`: upstream resolves that
    // collision to a deletion, which would silently eat an edit.
    const set: Record<string, string> = { [key]: draft.value };
    const unset: string[] = draft.original && draft.original !== key ? [draft.original] : [];

    try {
      const response = await session.request<{
        success?: boolean;
        names?: string[];
        error?: string;
      }>("secret_apply", { agent_id: agentId, set, unset });
      if (response?.success === false) {
        toast(response.error ?? `Could not save ${key}`, "bad");
        return;
      }
      setDraft(null);
      toast(`Saved ${key}.`);
      await load();
    } catch (cause) {
      toast(`Could not save ${key}: ${errorMessage(cause)}`, "bad");
    }
  };

  const remove = async (entry: SecretEntry) => {
    if (!agentId) return;
    if (!confirm(`Delete secret "${entry.key}"?`)) return;
    try {
      const response = await session.request<{ success?: boolean; error?: string }>(
        "secret_apply",
        { agent_id: agentId, set: {}, unset: [entry.key] },
      );
      if (response?.success === false) {
        toast(response.error ?? `Could not delete ${entry.key}`, "bad");
        return;
      }
      toast(`Deleted ${entry.key}.`);
      await load();
    } catch (cause) {
      toast(`Could not delete ${entry.key}: ${errorMessage(cause)}`, "bad");
    }
  };

  const toggleReveal = (key: string) => {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!agentId) {
    return <p className="muted pad">Select an agent.</p>;
  }

  return (
    <>
      {/* The count line is the list's header; with an empty list the sentence below
          already says the same thing, so one of the two is noise. */}
      {secrets.length > 0 ? (
        <p className="section-note">
          {secrets.length} secret{secrets.length === 1 ? "" : "s"} configured
        </p>
      ) : null}
      {status ? (
        <p className="warning small" role="alert">
          <span>{status}</span>
          <button type="button" className="link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}

      <ul className="list">
        {secrets.map((secret) => (
          <li key={secret.key}>
            <div className="row static">
              <span className="grow-text">
                <strong>{secret.key}</strong>
                {/* Masked as the word "hidden", not dots: a screen reader reads
                    dots out loud. The Reveal button carries the accessible name. */}
                <div className="muted small">
                  <code>{revealed.has(secret.key) ? secret.value : "hidden"}</code>
                </div>
              </span>
              <button
                type="button"
                className="link"
                onClick={() => toggleReveal(secret.key)}
                aria-label={
                  revealed.has(secret.key) ? `Hide ${secret.key}` : `Reveal ${secret.key}`
                }
              >
                {revealed.has(secret.key) ? "Hide" : "Reveal"}
              </button>
              <button
                type="button"
                className="link"
                onClick={() =>
                  setDraft({ original: secret.key, key: secret.key, value: secret.value })
                }
              >
                Edit
              </button>
              <button type="button" className="link danger" onClick={() => void remove(secret)}>
                Delete
              </button>
            </div>
          </li>
        ))}
        {secrets.length === 0 && !loading ? (
          <li className="muted pad">No secrets configured for this agent.</li>
        ) : null}
      </ul>

      <div className="pad-x">
        <button
          type="button"
          className="button"
          onClick={() => setDraft({ original: null, key: "", value: "" })}
        >
          Add secret
        </button>
      </div>

      {draft ? (
        <Sheet
          title={draft.original ? `Edit ${draft.original}` : "Add secret"}
          onClose={() => setDraft(null)}
          actions={
            <>
              <button type="button" className="button ghost" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button"
                disabled={!draft.key.trim()}
                onClick={() => void save()}
              >
                {draft.original ? "Save" : "Add"}
              </button>
            </>
          }
        >
          <label className="field">
            Name
            <input
              value={draft.key}
              placeholder="MY_API_TOKEN"
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, key: event.target.value })}
            />
          </label>
          <label className="field">
            Value
            <input
              type="password"
              value={draft.value}
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, value: event.target.value })}
            />
          </label>
        </Sheet>
      ) : null}

      <p className="muted small pad">
        Values are stored on the agent server-side and reach this page in plaintext — the reveal
        toggle only hides them from the screen.
      </p>
    </>
  );
}
