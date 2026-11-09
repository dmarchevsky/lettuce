import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ago,
  fetchPiRun,
  fetchPiRunFacts,
  fetchPiSessionRuns,
  LIVE_POLL_MS,
  type PiRun,
  type PiRunSummary,
  piRunNumber,
  piRunOptions,
  piRunWave,
  STATUS_LABELS,
} from "../lib/pi.ts";
import { msSinceLastPiFrame, stalenessWatchdogMs, usePiLiveRuns } from "../lib/pi-live.ts";
import { formatEntryTime, formatEntryTimeFull } from "../lib/timestamps.ts";
import { PiRunStepRow } from "./PiRunSteps.tsx";

interface Props {
  /** The run to land on. */
  runId: string;
  /** Its session, when the caller knows it; null means "learn it from the run". */
  session: string | null;
}

/** How close to the bottom counts as "reading the end", so a live run can follow. */
const STUCK_PX = 80;
/** How many neighbours of the focused run load unasked. Each read is a whole
 * capture tail, so a session with sixty runs must not mean sixty reads at open. */
const NEARBY = 3;

const TONES: Record<PiRunSummary["status"], string> = {
  running: " running",
  completed: " ok-tag",
  detached: " muted",
  cancelled: " muted",
  failed: " bad",
};

function oneLine(text: string): string {
  return (text || "").split("\n")[0]?.trim() ?? "";
}

function last(runs: readonly PiRunSummary[]): PiRunSummary | null {
  return runs.length > 0 ? (runs[runs.length - 1] as PiRunSummary) : null;
}

function stepKey(step: PiRun["steps"][number], index: number): string {
  return step.kind === "command" ? step.callId : `${step.kind}-${index}`;
}

/**
 * One remote-pi **session** as a pane: every run the agent asked of that pi
 * conversation, in one transcript, in the conversation's own visual language on
 * a different background — the same `.messages` container, the same `.entry`
 * rails, so a worker's thread reads as a thread and not as a new species of
 * screen.
 *
 * It replaces the floating sheet, and it replaces the pane rather than covering
 * it: whoever opened it (a conversation's run card, a row in the Runs list, a
 * completion push's deep link) gets the same screen back when it closes, because
 * nothing underneath it changed — this is only what is rendered in its place
 * while it is open. It borrows a pane's exits too and asks for none of them: the
 * corner close, the phone's Back and Escape all live in `App`, which owns the
 * decision to close it.
 *
 * The runs come from the BFF's own captures: one run is one ssh invocation, so a
 * session is N files stitched in the order they started. Each run's body is
 * fetched on its own (the capture tail is capped per run) and the focused one
 * first, so opening a long session reads one run rather than all of them.
 */
export function PiSessionPanel({ runId, session }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(session);
  const [runs, setRuns] = useState<PiRunSummary[]>([]);
  const [bodies, setBodies] = useState<Record<string, PiRun>>({});
  const [focus, setFocus] = useState(runId);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveFrames = usePiLiveRuns();

  // The scroller is `.messages` itself: the transcript scrolls, the bar does not.
  const scroller = useRef<HTMLDivElement | null>(null);
  // One marker per run, at the end of its segment — the place "go to run N" aims.
  const ends = useRef(new Map<string, HTMLDivElement | null>());
  const stuck = useRef(true);
  const pendingScroll = useRef(false);
  const lastReadMs = useRef(0);
  // What this panel has already asked the BFF for: the window loader and the
  // dropdown both consult it, so one run is never read twice by accident.
  const asked = useRef(new Set<string>());

  const loadBody = useCallback(async (id: string) => {
    try {
      const next = await fetchPiRun(id);
      setBodies((previous) => ({ ...previous, [id]: next.run }));
      setError(null);
      return next;
    } catch (cause) {
      // A capture may not exist yet (a deep link beaten by its own run); say so
      // once and let the retry land, rather than blanking the panel.
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, []);

  /** The session's run list, oldest first, with the focus kept where it was. */
  const loadList = useCallback(async (sid: string) => {
    const listed = await fetchPiSessionRuns(sid);
    setRuns(listed.runs);
    setCapped(listed.capped);
    return listed.runs;
  }, []);

  // Open: resolve the session when the caller only had a run, then the run list,
  // then the focused run's body. A run whose session never became visible (it
  // died before its header line) is shown alone rather than as an error.
  useEffect(() => {
    let cancelled = false;
    const open = async () => {
      let sid = session;
      if (!sid) {
        const facts = await fetchPiRunFacts(runId).catch(() => null);
        if (cancelled) return;
        sid = facts?.session ?? null;
        setSessionId(sid);
      }
      if (sid) {
        const list = await loadList(sid).catch(() => [] as PiRunSummary[]);
        if (cancelled) return;
        if (list.length > 0) {
          // A link to a run that is not in the session (swept away?) still
          // deserves a transcript, so fall back to the newest run it does have.
          const wanted = list.some((run) => run.runId === runId)
            ? runId
            : (last(list)?.runId ?? runId);
          setFocus(wanted);
          void loadBody(wanted);
          return;
        }
      }
      const single = await loadBody(runId);
      if (cancelled || !single) return;
      setRuns([{ ...single.run }]);
    };
    void open();
    return () => {
      cancelled = true;
    };
  }, [runId, session, loadBody, loadList]);

  // The neighbours of the focused run load behind it, inside a window of NEARBY
  // positions. `seen` is read through a ref on purpose: a wave that re-ran on every
  // arrival would cancel its own remaining loads while having already marked them
  // asked-for, and strand those segments at "Loading…" for the rest of the session.
  const focusedLoaded = Boolean(bodies[focus]);
  const seen = useRef(bodies);
  seen.current = bodies;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!focusedLoaded) return;
    const wave = piRunWave(
      runs,
      focus,
      (id) => Boolean(seen.current[id]) || asked.current.has(id),
      NEARBY,
    );
    if (wave.length === 0) return;
    for (const id of wave) asked.current.add(id);
    const fill = async () => {
      for (const id of wave) {
        if (!mounted.current) return;
        await loadBody(id);
      }
    };
    void fill();
  }, [focusedLoaded, runs, focus, loadBody]);

  // A pushed frame is the freshest fact we hold about a run: the listing was read
  // when the panel opened, and a run that settles while you watch it changes in
  // the frame a moment later. Every status the panel prints goes through here, or
  // the screen that exists to watch a run would keep saying `Running` after it
  // stopped — the failure this whole feature is meant to end.
  const statusOf = useCallback(
    (run: PiRunSummary): PiRunSummary["status"] => liveFrames[run.runId]?.state ?? run.status,
    [liveFrames],
  );
  const isLive = useCallback((run: PiRunSummary) => statusOf(run) === "running", [statusOf]);
  const running = runs.some(isLive);
  const liveSignal = runs
    .map((run) => `${run.runId}:${liveFrames[run.runId]?.eventCount ?? 0}`)
    .join(",");
  // liveSignal is the trigger, not an input: it moves when any run's captured line
  // count did, and what to read is taken from the run list at that moment.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps say when to read, not what to read
  useEffect(() => {
    if (!running) return;
    const wait = Math.max(0, LIVE_POLL_MS - (Date.now() - lastReadMs.current));
    const timer = setTimeout(() => {
      lastReadMs.current = Date.now();
      for (const run of runs) if (isLive(run)) void loadBody(run.runId);
    }, wait);
    return () => clearTimeout(timer);
  }, [liveSignal, running, runs, isLive, loadBody]);

  // The safety net for a frame lost to a reconnect or a BFF restart mid-run: once
  // the frame stream has been quiet past the watchdog, the working runs are
  // re-read by fetch — but only if frames had been flowing at all. Silence from
  // the first load means there was never a stream to lose.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const since = msSinceLastPiFrame();
      if (!Number.isFinite(since) || since <= stalenessWatchdogMs) return;
      for (const run of runs) if (isLive(run)) void loadBody(run.runId);
    }, 5_000);
    return () => clearInterval(timer);
  }, [running, runs, isLive, loadBody]);

  // The listing is re-asked when a frame says something the list cannot already
  // show: a run dispatched while you watch (so it appears at all), or a run that
  // settled (so its end time and counters stop being a guess). Frames alone flip
  // the status chips; this makes the row's facts agree with them.
  const settledSeen = useRef(new Set<string>());
  useEffect(() => {
    if (!sessionId) return;
    const byId = new Map(runs.map((run) => [run.runId, run]));
    for (const frame of Object.values(liveFrames)) {
      if (frame.session !== sessionId) continue;
      const known = byId.get(frame.runId);
      if (!known) {
        void loadList(sessionId).catch(() => []);
        return;
      }
      if (frame.state !== "running" && !settledSeen.current.has(frame.runId)) {
        settledSeen.current.add(frame.runId);
        void loadList(sessionId).catch(() => []);
        return;
      }
    }
  }, [sessionId, runs, liveFrames, loadList]);

  // "Go to run N" means the end of that run: what it last said, which is where
  // its attention was when it finished — or where it is now, live.
  const scrollToFocus = useCallback(() => {
    const box = scroller.current;
    const marker = ends.current.get(focus);
    if (!box || !marker) return;
    const delta = marker.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom;
    box.scrollTop += delta + 24;
    stuck.current = true;
  }, [focus]);

  // Jump when the focus changes (the dropdown, a row clicked elsewhere), and
  // follow the tail while a live run grows and the reader is at its end. `bodies`
  // is the trigger for the follow: new steps are what should pull the view down.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps say when to scroll, not what to read
  useLayoutEffect(() => {
    if (pendingScroll.current) {
      pendingScroll.current = false;
      scrollToFocus();
      return;
    }
    if (stuck.current) scrollToFocus();
  }, [focus, bodies, scrollToFocus]);

  const choose = (id: string) => {
    setFocus(id);
    pendingScroll.current = true;
    asked.current.add(id);
    if (!bodies[id]) void loadBody(id);
  };

  const focused = runs.find((run) => run.runId === focus) ?? last(runs);
  const facts: string[] = [];
  if (focused) {
    if (focused.target) facts.push(focused.target);
    facts.push(
      capped ? `${runs.length}+ runs` : `${runs.length} run${runs.length === 1 ? "" : "s"}`,
    );
  }
  const usage = bodies[focus]?.usage;
  const options = piRunOptions(runs);

  return (
    <>
      <div className="pane-bar wrap pi-session-bar">
        <span className={`tag${TONES[focused ? statusOf(focused) : "running"]}`}>
          {STATUS_LABELS[focused ? statusOf(focused) : "running"]}
        </span>
        <strong>{sessionId ? `session ${sessionId.slice(0, 8)}` : "Remote pi run"}</strong>
        <span className="pi-facts muted small">
          {facts.join(" · ")}
          {/* The token counts are the first thing to go on a narrow bar: where you
              are (host, how many runs) outranks what the run cost. */}
          {usage ? (
            <span className="pi-usage">
              {` · ${usage.inputTokens.toLocaleString()} in · ${usage.outputTokens.toLocaleString()} out`}
            </span>
          ) : null}
        </span>
        <span className="spacer" />
        {options.length > 1 ? (
          <select
            className="pi-run-select"
            aria-label="Jump to a run of this session"
            value={focus}
            onChange={(event) => choose(event.target.value)}
          >
            {options.map((option) => (
              <option key={option.runId} value={option.runId}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <div className="pi-session">
        <div
          className="messages"
          ref={scroller}
          onScroll={() => {
            const box = scroller.current;
            if (!box) return;
            stuck.current = box.scrollHeight - box.scrollTop - box.clientHeight < STUCK_PX;
          }}
        >
          {error && runs.length === 0 ? (
            <p className="warning small" role="alert">
              {error}
            </p>
          ) : null}
          {runs.length === 0 && !error ? <p className="muted">Loading…</p> : null}
          {runs.map((run) => {
            const body = bodies[run.runId];
            const frame = liveFrames[run.runId];
            const live = isLive(run);
            return (
              <section key={run.runId} className="pi-run-group">
                <div className="pi-run-boundary">
                  <strong>
                    Run {piRunNumber(runs, run.runId)} · {run.kind}
                  </strong>
                  <span className="what one-line">{oneLine(run.prompt)}</span>
                  <span className="spacer" />
                  <span className={`tag${TONES[statusOf(run)]}`}>
                    {STATUS_LABELS[statusOf(run)]}
                  </span>
                  <span title={run.startedAt ? formatEntryTimeFull(run.startedAt) : undefined}>
                    {run.startedAt ? formatEntryTime(run.startedAt) : ""}
                    {` · ${(frame?.eventCount ?? run.eventCount).toLocaleString()} events`}
                    {run.lastEventAt ? ` · ${ago(run.lastEventAt)}` : ""}
                  </span>
                </div>
                {body
                  ? body.steps.map((step, index) => (
                      <PiRunStepRow key={stepKey(step, index)} step={step} />
                    ))
                  : null}
                {!body ? (
                  <p className="muted small">
                    {asked.current.has(run.runId) ? "Loading this run…" : null}
                    {!asked.current.has(run.runId) ? (
                      <button type="button" className="link" onClick={() => choose(run.runId)}>
                        Load this run
                      </button>
                    ) : null}
                  </p>
                ) : null}
                {live ? <p className="muted small">Working…</p> : null}
                {statusOf(run) === "detached" ? (
                  <p className="muted small">
                    Lettuce stopped capturing this run; the remote pi may still be working, and
                    pi_send resumes its session when it is done.
                  </p>
                ) : null}
                <div
                  className="pi-run-end"
                  ref={(node) => {
                    ends.current.set(run.runId, node);
                  }}
                />
              </section>
            );
          })}
          {capped ? (
            <p className="muted small">
              This session has older runs than these; the listing keeps the newest ones.
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}
