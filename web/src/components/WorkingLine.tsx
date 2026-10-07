import { useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "../lib/messages.ts";
import type { QueuedItem } from "../lib/queue-actions.ts";
import { formatTokens, type TurnUsage } from "../lib/usage.ts";
import { deriveWorking, drainingQueueCount, formatElapsed } from "../lib/working.ts";
import { Icon, type IconName } from "./Icon.tsx";

interface Props {
  entries: readonly TranscriptEntry[];
  queue: readonly QueuedItem[];
  cwd: string | null;
  stopping: boolean;
  turnStartedAt: number | null;
  lastActivityAt: number | null;
  usage: TurnUsage | null;
  onAbort: () => void;
}

/** Names this component can draw; the working map stays free of Icon imports. */
const KNOWN_ICONS = new Set<string>([
  "file",
  "edit",
  "terminal",
  "search",
  "globe",
  "folder",
  "task",
  "model",
  "memory",
  "history",
  "chats",
  "branch",
  "warning",
]);

/** One parameter in the right-hand cluster; `wide` survives only ≥701px. */
interface Metric {
  key: string;
  text: string;
  wide?: boolean;
}

/**
 * Generation speed, in tokens per second, estimated from the streamed text.
 *
 * The usage the BFF folds arrives once per model step — so mid-step, which is
 * the whole of a `Writing` phase, `completionTokens` is frozen at the last
 * boundary and two usage samples cannot be taken while the rate is real.
 * What does arrive per token is the stream itself, so the estimate is
 * characters-of-streamed-output over time, divided by the usual rule of four.
 * Null until two samples are at least 0.5 s and ~10 tokens apart — from a
 * shorter window the chunk-delivery jitter dominates and the number bounces
 * hard before the rolling window steadies it.
 *
 * Not a hook: it takes a caller-owned store, so the component keeps its
 * `useRef` calls unconditional.
 */
const CHARS_PER_TOKEN = 4;

/** Total length of this turn's still-streaming text; subagents excluded. */
function streamingChars(entries: readonly TranscriptEntry[]): number {
  let chars = 0;
  for (const entry of entries) {
    if (!entry.streaming || entry.subagentId) continue;
    if (entry.kind === "assistant" || entry.kind === "reasoning") chars += entry.text.length;
  }
  return chars;
}

function sampleSpeed(
  store: { samples: { t: number; chars: number }[]; lastChars: number },
  chars: number,
  generating: boolean,
): number | null {
  if (!generating) {
    store.samples = [];
    store.lastChars = -1;
    return null;
  }
  // A drop means the streamed message ended or switched (reasoning → answer);
  // the old samples measure a rate that no longer exists.
  if (chars < store.lastChars) store.samples = [];
  if (chars !== store.lastChars) {
    store.lastChars = chars;
    const t = Date.now();
    const last = store.samples[store.samples.length - 1];
    // The stream re-renders every frame, so one sample per render would cap
    // the window at ~8 frames — far under the minimum below and the rate
    // would never appear. Keep one sample per half second: the newest count
    // lives on the last row, the window holds the last few seconds.
    if (!last || t - last.t >= 500) store.samples.push({ t, chars });
    else last.chars = chars;
    while (store.samples.length > 2 && t - store.samples[0]!.t > 4000) store.samples.shift();
  }
  const first = store.samples[0];
  const last = store.samples[store.samples.length - 1];
  if (!first || !last || store.samples.length < 2) return null;
  const dt = (last.t - first.t) / 1000;
  const dTok = (last.chars - first.chars) / CHARS_PER_TOKEN;
  if (dt < 0.5 || dTok < 10) return null;
  return dTok / dt;
}

/** The phone/desktop split, as one media query — see the wide-metric note. */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 700px)");
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/**
 * The composer's working line: what the agent is doing, how long it has been
 * at it, and how fast it is going. One grammar for every phase —
 * `lib/working.ts` derives the state and words it; this only renders the
 * slots and ticks the clock once a second so the elapsed moves even when no
 * frame arrives.
 *
 * The right-hand cluster rides the right edge at every width; a metric is
 * dropped narrow→wide in a fixed order (step count and the queue echo are
 * desktop-only) so the phone line stays `activity · tok/s · elapsed`.
 */
export function WorkingLine({
  entries,
  queue,
  cwd,
  stopping,
  turnStartedAt,
  lastActivityAt,
  usage,
  onAbort,
}: Props) {
  const [now, setNow] = useState(() => Date.now());
  const speedStoreRef = useRef({ samples: [] as { t: number; chars: number }[], lastChars: -1 });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const narrow = useIsNarrow();

  const snap = deriveWorking({
    processing: true,
    stopping,
    entries,
    queue,
    cwd,
    now,
    turnStartedAt,
    lastActivityAt,
  });
  if (!snap) return null;

  const generating = snap.state === "thinking" || snap.state === "writing";
  const speed = generating
    ? sampleSpeed(speedStoreRef.current, streamingChars(entries), true)
    : null;
  const elapsed = formatElapsed(now - (turnStartedAt ?? now));
  const queued = drainingQueueCount(queue);

  const metrics: Metric[] = [];
  if (generating && speed !== null)
    metrics.push({ key: "rate", text: `${Math.round(speed)} tok/s` });
  if (generating && usage && usage.completionTokens >= 100) {
    metrics.push({ key: "tok", text: `+${formatTokens(usage.completionTokens)} tok`, wide: true });
  }
  if (snap.state !== "thinking" && usage && usage.steps > 1) {
    metrics.push({ key: "step", text: `step ${usage.steps}`, wide: true });
  }
  if (queued > 0) metrics.push({ key: "queue", text: `queue +${queued}`, wide: true });
  const visible = narrow ? metrics.filter((m) => !m.wide) : metrics;

  return (
    <div
      className={`working-line state-${snap.state}${snap.state === "stall" ? " warn" : ""}`}
      role="status"
    >
      {snap.state === "stall" ? (
        <span className="wl-glyph" aria-hidden="true">
          <Icon name="warning" />
        </span>
      ) : (
        <span
          className={`working-dots${snap.state === "stopping" ? " still" : ""}`}
          aria-hidden="true"
        >
          <i />
          <i />
          <i />
        </span>
      )}
      {/* Fixed slot: the text starts in the same place with or without an icon. */}
      <span className="wl-ico" aria-hidden="true">
        {snap.icon && KNOWN_ICONS.has(snap.icon) ? <Icon name={snap.icon as IconName} /> : null}
      </span>
      {snap.state === "stall" ? (
        <span className="wl-act">
          No activity {formatElapsed(now - (lastActivityAt ?? turnStartedAt ?? now))}
          <span className="wl-sep"> · </span>last: {snap.lastSeen}
        </span>
      ) : (
        <span className="wl-act">
          {snap.verb}
          {snap.object ? (
            <>
              {" "}
              <span className={`wl-obj${snap.mono ? " mono" : ""}`}>{snap.object}</span>
            </>
          ) : null}
        </span>
      )}
      {snap.state === "stall" ? (
        <button type="button" className="wl-stop" onClick={onAbort}>
          Stop
        </button>
      ) : (
        <span className="wl-right">
          {visible.map((m) => (
            <span key={m.key} className="wl-stat">
              <span className="wl-sep">· </span>
              {m.text}
            </span>
          ))}
          {snap.state !== "stopping" ? (
            <span className="wl-stat">
              <span className="wl-sep">· </span>
              {elapsed}
            </span>
          ) : null}
        </span>
      )}
    </div>
  );
}
