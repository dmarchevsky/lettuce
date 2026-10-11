import { useState } from "react";
import type { ContextAccounting } from "../lib/context-size.ts";
import { contextGauge, formatTokens, percentOf, type TurnUsage } from "../lib/usage.ts";
import type { ContextLimit } from "../state/use-context-limit.ts";
import { MIN_CONTEXT_LIMIT, parseContextLimit } from "../state/use-context-limit.ts";
import { Icon } from "./Icon.tsx";
import { Sheet } from "./Sheet.tsx";

/**
 * How full the conversation's context is, in the top bar: "25k / 225k" over a
 * thin bar, amber from 80%. The denominator is the point the conversation
 * compacts at, not the window letta-code is given: the gauge answers "how close
 * am I to compacting", and the space above that point belongs to the summary and
 * to the reply in flight. With no usage reported yet (a fresh load, or a bff
 * restart before any turn) it shows the denominator alone — "— / 225k" over an
 * empty bar — because the gauge is also the way into the Context sheet.
 */
export function ContextGauge({
  usage,
  limit,
  accounting,
  onOpen,
}: {
  usage: TurnUsage | null;
  limit: ContextLimit | null;
  accounting: ContextAccounting | null;
  onOpen: () => void;
}) {
  if (!limit) return null;
  const full = accounting?.compactAt || limit.tokens;
  const used = usage?.contextTokens;
  const gauge = used !== undefined ? contextGauge(used, full) : null;
  return (
    <button
      type="button"
      className={`ctx-gauge${gauge?.warn ? " warn" : ""}`}
      onClick={onOpen}
      aria-label={
        gauge && used !== undefined
          ? `Context: ${used.toLocaleString()} of ${full.toLocaleString()} tokens before this conversation compacts, ${gauge.percent}% full`
          : `This conversation compacts at ${full.toLocaleString()} tokens — no usage reported yet`
      }
      title={
        gauge
          ? `${gauge.percent}% of the room before the conversation compacts`
          : "No usage reported yet"
      }
    >
      <span className="ctx-gauge-label">{gauge ? gauge.label : `— / ${formatTokens(full)}`}</span>
      <span className="ctx-bar" aria-hidden="true">
        <i style={{ width: `${gauge?.percent ?? 0}%` }} />
      </span>
    </button>
  );
}

const PRESETS = [
  { label: "256k", tokens: 262_144 },
  { label: "128k", tokens: 131_072 },
  { label: "64k", tokens: 65_536 },
];

const SOURCE_LABEL: Record<ContextAccounting["source"], string> = {
  typed: "set by you",
  declared: "automatic",
  default: "letta-code default",
};

/**
 * The gauge's details: how full the context is, what the last turn cost, and the
 * one number that decides when the conversation compacts — the size of the
 * context the model server gives a request. Tap it to set your own; leave it
 * alone and the declaration in Settings → Models decides it.
 */
export function ContextSheet({
  usage,
  limit,
  accounting,
  processing,
  onSetSize,
  onSaved,
  onClose,
}: {
  usage: TurnUsage | null;
  limit: ContextLimit | null;
  accounting: ContextAccounting | null;
  processing: boolean;
  onSetSize: (tokens: number | null, scope: "agent" | "conversation") => Promise<string>;
  /** Re-reads the limit and the accounting after a save. */
  onSaved: () => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [reset, setReset] = useState(false);
  const [scope, setScope] = useState<"conversation" | "agent">("agent");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const full = accounting?.compactAt || limit?.tokens || 0;
  const used = usage?.contextTokens;
  const gauge = used !== undefined && full ? contextGauge(used, full) : null;

  const startEditing = () => {
    setText(accounting ? accounting.context.toLocaleString() : "");
    setReset(false);
    setScope(accounting?.typed.conversation !== null ? "conversation" : "agent");
    setMessage(null);
    setEditing(true);
  };

  const parsed = reset ? null : parseContextLimit(text);
  const invalid =
    !reset &&
    (parsed === null
      ? "Enter a number of tokens, e.g. 262144 or 256k"
      : parsed < MIN_CONTEXT_LIMIT
        ? `At least ${MIN_CONTEXT_LIMIT.toLocaleString()} tokens`
        : null);

  const save = async () => {
    if (invalid) return;
    setBusy(true);
    setMessage(null);
    try {
      const output = await onSetSize(reset ? null : parsed, scope);
      onSaved();
      setMessage({ tone: "ok", text: output || "Context size updated" });
      setEditing(false);
    } catch (error) {
      setMessage({ tone: "bad", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  /** The scope "Use automatic" would clear: a conversation's own override wins. */
  const typedScope: "agent" | "conversation" =
    accounting && accounting.typed.conversation !== null ? "conversation" : "agent";

  return (
    <Sheet title="Context" onClose={onClose}>
      {gauge && used !== undefined ? (
        <>
          <div className="ctx-big">
            <span>
              <b>{used.toLocaleString()}</b> of {full.toLocaleString()}
            </span>
            <span className={gauge.warn ? "warn" : ""}>{gauge.percent}% to compacting</span>
          </div>
          <div className={`ctx-bar big${gauge.warn ? " warn" : ""}`} aria-hidden="true">
            <i style={{ width: `${gauge.percent}%` }} />
          </div>
        </>
      ) : null}
      <p className="menu-intro">
        The conversation compacts itself when it fills up. The gauge measures that much room.
      </p>

      {usage ? (
        <>
          <p className="menu-section">{processing ? "This turn so far" : "Last turn"}</p>
          <ul className="kv-list">
            <li>
              <span>Prompt</span>
              <span>
                {usage.lastPromptTokens.toLocaleString()} <small>· last call</small>
              </span>
            </li>
            {usage.cacheReported ? (
              <li>
                <span>Cache hit</span>
                <span>
                  {usage.lastCachedTokens.toLocaleString()}{" "}
                  <small>
                    · {percentOf(usage.lastCachedTokens, usage.lastPromptTokens)}% of prompt
                  </small>
                </span>
              </li>
            ) : null}
            <li>
              <span>Generated</span>
              <span>
                {usage.completionTokens.toLocaleString()}
                {usage.reasoningTokens > 0 ? (
                  <small> · {usage.reasoningTokens.toLocaleString()} thinking</small>
                ) : null}
              </span>
            </li>
            <li>
              <span>Model calls (steps)</span>
              <span>{usage.steps}</span>
            </li>
            <li>
              <span>Input processed</span>
              <span>
                {usage.promptTokens.toLocaleString()}{" "}
                <small>· {usage.cacheReported ? "evaluated, all calls" : "all calls"}</small>
              </span>
            </li>
            {usage.cacheReported ? (
              <li>
                <span>From cache</span>
                <span>
                  {usage.cachedTokens.toLocaleString()} <small>· all calls</small>
                </span>
              </li>
            ) : null}
          </ul>
        </>
      ) : null}

      {accounting ? (
        <p className="menu-section">{editing ? "Context size" : "Compaction"}</p>
      ) : null}

      {accounting && !editing ? (
        <>
          <ul className="kv-list">
            <li>
              <button type="button" className="kv-tap" onClick={startEditing}>
                <span>
                  Context size <b>{accounting.context.toLocaleString()}</b>
                </span>
                <span>
                  <small>{SOURCE_LABEL[accounting.source]}</small>
                  <Icon name="chevron-right" />
                </span>
              </button>
            </li>
            {accounting.maxOutput ? (
              <li>
                <span>Max output</span>
                <span>
                  {accounting.maxOutput.toLocaleString()} <small>· promised per request</small>
                </span>
              </li>
            ) : null}
            <li>
              <span>Compacts at</span>
              <span>
                {accounting.compactAt.toLocaleString()}{" "}
                <small>
                  · context − {(accounting.context - accounting.compactAt).toLocaleString()}
                </small>
              </span>
            </li>
          </ul>
          {accounting.source === "typed" && accounting.automatic ? (
            <p className="ctx-hint">
              You set this; Settings → Models declares{" "}
              {accounting.automatic.context.toLocaleString()}:{" "}
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onSetSize(null, typedScope)
                    .then(() => {
                      onSaved();
                      setMessage({ tone: "ok", text: "Back to the declared size" });
                    })
                    .catch((error: unknown) =>
                      setMessage({
                        tone: "bad",
                        text: error instanceof Error ? error.message : String(error),
                      }),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Use automatic
              </button>
            </p>
          ) : accounting.source === "declared" ? (
            <p className="ctx-hint">
              Tap the size to tell Lettuce what your server gives each request instead (llama.cpp:
              n_ctx per slot) — compacting stays ahead of the refusal either way.
            </p>
          ) : (
            <p className="ctx-hint">
              Nothing is declared for this model, so the window is letta-code&apos;s default and the
              reserve is its own. Declaring the size in Settings → Models would let Lettuce take the
              output budget into account.
            </p>
          )}
        </>
      ) : null}

      {accounting && editing ? (
        <div className="limit-edit">
          <input
            type="text"
            inputMode="numeric"
            value={
              reset && accounting.automatic
                ? `${accounting.automatic.context.toLocaleString()} (automatic)`
                : text
            }
            onChange={(event) => {
              setReset(false);
              setText(event.target.value);
            }}
            aria-label="Context size in tokens"
          />
          <div className="limit-presets">
            {accounting.automatic ? (
              <button
                key="automatic"
                type="button"
                className={`limit-preset${reset ? " on" : ""}`}
                onClick={() => setReset(true)}
              >
                Automatic ({formatTokens(accounting.automatic.context)})
              </button>
            ) : null}
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={`limit-preset${!reset && parsed === preset.tokens ? " on" : ""}`}
                onClick={() => {
                  setReset(false);
                  setText(preset.tokens.toLocaleString());
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <ul className="menu-list">
            <li>
              <button
                type="button"
                className={`menu-row${scope === "conversation" ? " selected" : ""}`}
                onClick={() => setScope("conversation")}
                aria-pressed={scope === "conversation"}
              >
                <span className="menu-row-text">
                  <span className="menu-row-title">This conversation only</span>
                </span>
                {scope === "conversation" ? <Icon name="check" className="menu-row-check" /> : null}
              </button>
            </li>
            <li>
              <button
                type="button"
                className={`menu-row${scope === "agent" ? " selected" : ""}`}
                onClick={() => setScope("agent")}
                aria-pressed={scope === "agent"}
              >
                <span className="menu-row-text">
                  <span className="menu-row-title">All of this agent&apos;s conversations</span>
                </span>
                {scope === "agent" ? <Icon name="check" className="menu-row-check" /> : null}
              </button>
            </li>
          </ul>
          <p className="limit-warning">
            Set this to the context your server actually gives one request (llama.cpp: n_ctx per
            slot). Too high and requests fail instead of compacting.
          </p>
          {invalid ? <p className="small bad">{invalid}</p> : null}
          {message?.tone === "bad" ? <p className="small bad">{message.text}</p> : null}
          <div className="limit-actions">
            <button
              type="button"
              className="button ghost"
              onClick={() => setEditing(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button"
              onClick={() => void save()}
              disabled={busy || invalid !== null}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}

      {message && (!editing || message.tone === "ok") && !invalid ? (
        <p className={`small ${message.tone === "ok" ? "ok" : "bad"} ctx-message`}>
          {message.text}
        </p>
      ) : null}
    </Sheet>
  );
}
