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
 * Generation speed, in completion tokens per second, from the usage samples
 * the BFF's per-step refresh produces. Null until two samples are at least
 * 1.5 s and 10 tokens apart — a rate invented from one sample would bounce,
 * and a bouncing rate reads as a bug rather than as a model.
 *
 * Not a hook: it takes a caller-owned store, so the component keeps its
 * `useRef` calls unconditional.
 */
function sampleSpeed(
  store: { samples: { t: number; tok: number }[]; lastTok: number },
  tokens: number,
  generating: boolean,
): number | null {
  if (generating && tokens !== store.lastTok) {
    store.lastTok = tokens;
    store.samples.push({ t: Date.now(), tok: tokens });
    if (store.samples.length > 8) store.samples.shift();
  }
  if (!generating) store.samples = [];
  const first = store.samples[0];
  const last = store.samples[store.samples.length - 1];
  if (!first || !last || store.samples.length < 2) return null;
  const dt = (last.t - first.t) / 1000;
  const dTok = last.tok - first.tok;
  if (dt < 1.5 || dTok < 10) return null;
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
  const speedStoreRef = useRef({ samples: [] as { t: number; tok: number }[], lastTok: -1 });
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
  const speed = sampleSpeed(speedStoreRef.current, usage?.completionTokens ?? 0, generating);
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
