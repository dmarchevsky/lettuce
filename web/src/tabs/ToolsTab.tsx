/**
 * Tools: which shared tool families this agent may use, and where each one
 * points for it.
 *
 * This was a section inside the Agent tab, which hid two things: that these are
 * per-agent *narrowings* of globally configured capabilities, and that a family
 * can have per-agent settings of its own (Remote Pi's working folder). So each
 * family is a chip here and the chip carries the on/off checkbox — the checkbox
 * writes at once, because an access toggle has no other fields to wait for.
 * Clicking the name opens the family's pane, where anything with several fields
 * (Remote Pi's connection) saves on its own.
 *
 * Two stores, no overlap: enable/disable lives only in `agent-tool-access.json`
 * (so a checkbox and a pane can never disagree) and the pi connection lives only
 * in the pi store. Both are BFF-side; upstream sees four pi tools either way.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { PiCheckBanner, PiStatusLine } from "../components/PiStatus.tsx";
import { toast } from "../components/Toast.tsx";
import {
  type AgentToolAccess,
  fetchAgentToolAccess,
  type GoogleAccess,
  type ModsResult,
  saveAgentToolAccess,
} from "../lib/agent-tool-access.ts";
import { errorMessage } from "../lib/errors.ts";
import { type FeatureFlags, featureEnabled } from "../lib/features.ts";
import {
  checkPiHost,
  fetchPiAgent,
  fetchPiSettings,
  type PiAgentOverride,
  type PiCheck,
  type PiSettings,
  pinPiHostKey,
  resetPiAgent,
  savePiAgent,
} from "../lib/pi.ts";
import type { AgentsApi } from "../state/use-agents.ts";

type Family = "google" | "codex" | "claude" | "pi";

const FAMILY_LABEL: Record<Family, string> = {
  google: "Google",
  codex: "Codex",
  claude: "Claude",
  pi: "Remote Pi",
};

/**
 * What a write to this agent's tool access reports, appended to what was just
 * decided. Each mods outcome is a toast, not a line that sits on the page until
 * something else overwrites it; `warn` is the one where the record saved and the
 * second half did not happen.
 */
const SAVED_RESULT: Record<ModsResult, { tail: string; kind: "ok" | "warn" }> = {
  unchanged: { tail: "", kind: "ok" },
  reloaded: { tail: "it applies from this agent's next turn", kind: "ok" },
  "reload-pending": { tail: "it applies once the app-server reloads its mods", kind: "ok" },
  failed: {
    tail: "the tools could not be updated yet: they catch up on the next reconnect",
    kind: "warn",
  },
};

interface Props {
  agents: AgentsApi;
  features?: FeatureFlags;
  onOpenGlobalSettings: (section?: string) => void;
}

export function ToolsTab({ agents, features, onOpenGlobalSettings }: Props) {
  const agentId = agents.agentId;
  const agentName = agents.agents.find((agent) => agent.id === agentId)?.name ?? null;
  const [access, setAccess] = useState<AgentToolAccess | null>(null);
  const [family, setFamily] = useState<Family | null>(null);
  /** Only a failed read of this agent's access — a save result is a toast. */
  const [status, setStatus] = useState("");
  const [accessKey, setAccessKey] = useState(0);
  const [piVersion, setPiVersion] = useState(0);

  const families = useMemo<Family[]>(
    () =>
      (["google", "codex", "claude", "pi"] as Family[]).filter((id) =>
        featureEnabled(features, id),
      ),
    [features],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: accessKey is the retry trigger itself.
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setAccess(null);
    setStatus("");
    fetchAgentToolAccess(agentId)
      .then((loaded) => {
        if (!cancelled) setAccess(loaded);
      })
      .catch((cause) => {
        if (!cancelled) setStatus(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, accessKey]);

  useEffect(() => {
    const first = families[0];
    if (first && (!family || !families.includes(family))) setFamily(first);
  }, [families, family]);

  if (!agentId) {
    return (
      <div className="pane">
        <p className="muted pad">No agent selected. Pick one from the agent list.</p>
      </div>
    );
  }

  /** Allowed right now for this agent — what the chip's box shows. */
  const on = (id: Family): boolean =>
    !access || (id === "google" ? access.google !== "off" : access[id]);

  const toggle = (id: Family) => {
    if (!access) return;
    void writeAccess(
      { agentId, access, onAccess: setAccess, onStatus: setStatus, onOpenGlobalSettings },
      id === "google"
        ? { google: access.google === "off" ? "full" : "off" }
        : ({ [id]: !access[id] } as Partial<AgentToolAccess>),
      `${FAMILY_LABEL[id]} ${on(id) ? "blocked" : "allowed"}`,
    );
  };

  if (!families.length) {
    return (
      <div className="pane">
        <p className="muted pad">
          No shared tool family is enabled on this instance, so there is nothing to narrow here.
          They are switched on by whoever runs this install, in{" "}
          <button type="button" className="link inline" onClick={() => onOpenGlobalSettings()}>
            Settings
          </button>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="pane-bar section-tabs tool-chips">
        {families.map((id) => (
          <span className="chip-pair" key={id}>
            <button
              type="button"
              aria-pressed={on(id)}
              aria-label={`${on(id) ? "Block" : "Allow"} ${FAMILY_LABEL[id]} for this agent`}
              className={`chip-check${on(id) ? " on" : ""}`}
              disabled={!access}
              onClick={() => toggle(id)}
            >
              {access && on(id) ? <Icon name="check" /> : null}
            </button>
            <button
              type="button"
              className={family === id ? "active" : undefined}
              onClick={() => setFamily(id)}
            >
              {FAMILY_LABEL[id]}
            </button>
          </span>
        ))}
      </div>
      <p className="scope-line small">
        <strong>{agentName ?? "This agent"}</strong> only — other agents keep their own. Each box
        allows or blocks that family; these narrow what is set up for every agent in{" "}
        <button type="button" className="link inline" onClick={() => onOpenGlobalSettings()}>
          Settings
        </button>
        , and apply from this agent&apos;s next turn. They decide which tools the agent is offered,
        not what its shell can reach — every agent runs in the same container.
      </p>
      {status ? (
        <p className="warning small" role="alert">
          <span>{status}</span>
          <button type="button" className="link" onClick={() => setAccessKey((n) => n + 1)}>
            Try again
          </button>
        </p>
      ) : null}
      {!access ? <p className="muted pad">Loading tool access…</p> : null}

      {access && family === "google" ? (
        <GooglePane
          agentId={agentId}
          access={access}
          onAccess={setAccess}
          onStatus={setStatus}
          onOpenGlobalSettings={onOpenGlobalSettings}
        />
      ) : null}
      {access && (family === "codex" || family === "claude") ? (
        <WorkerPane
          agentId={agentId}
          family={family}
          access={access}
          onAccess={setAccess}
          onStatus={setStatus}
          onOpenGlobalSettings={onOpenGlobalSettings}
        />
      ) : null}
      {access && family === "pi" ? (
        <PiPane
          key={`${agentId}-${piVersion}`}
          agentId={agentId}
          access={access}
          onStatus={setStatus}
          onReload={() => setPiVersion((n) => n + 1)}
          onOpenGlobalSettings={onOpenGlobalSettings}
        />
      ) : null}
    </div>
  );
}

interface PaneProps {
  agentId: string;
  access: AgentToolAccess;
  onAccess: (next: AgentToolAccess) => void;
  onStatus: (text: string) => void;
  onOpenGlobalSettings: (section?: string) => void;
}

/**
 * Write one field of the access record at once — a select or a checkbox is a
 * whole decision, so there is no Save button waiting for a second one.
 */
async function writeAccess(
  { agentId, access, onAccess }: PaneProps,
  patch: Partial<AgentToolAccess>,
  label: string,
): Promise<void> {
  try {
    const { mods, ...saved } = await saveAgentToolAccess(agentId, { ...access, ...patch });
    onAccess(saved);
    const result = SAVED_RESULT[mods];
    toast(result.tail ? `${label} — ${result.tail}` : `${label}.`, result.kind);
  } catch (cause) {
    // `label` reads as a result ("Remote Pi allowed"), so the failure does not use
    // it — "Could not save Remote Pi allowed: …" is not a sentence.
    toast(`Could not change this agent's tools: ${errorMessage(cause)}`, "bad");
  }
}

function GooglePane(props: PaneProps) {
  const { access, onOpenGlobalSettings } = props;
  const pick = (google: GoogleAccess) => void writeAccess(props, { google }, `Google: ${google}`);
  return (
    <div className="pad-x">
      <label className="field">
        Google (Gmail, Calendar, Tasks, Contacts)
        <select
          value={access.google}
          onChange={(event) => void pick(event.target.value as GoogleAccess)}
        >
          <option value="full">Full — read and write</option>
          <option value="read">Read-only — nothing sent or edited</option>
          <option value="off">Off for this agent</option>
        </select>
        <span className="muted small">
          The connected account and its scopes are global — what is chosen here only narrows them
          for this agent.
        </span>
      </label>
      <p className="muted small">
        <button
          type="button"
          className="link inline"
          onClick={() => onOpenGlobalSettings("google")}
        >
          Google settings for every agent
        </button>
      </p>
    </div>
  );
}

/** Codex and Claude Code work the same way: allowed or not, configured globally. */
function WorkerPane(props: PaneProps & { family: "codex" | "claude" }) {
  const { family, access, onOpenGlobalSettings } = props;
  const label = family === "codex" ? "Codex" : "Claude Code";
  const pick = (allowed: boolean) =>
    void writeAccess(
      props,
      { [family]: allowed } as Partial<AgentToolAccess>,
      `${label} ${allowed ? "allowed" : "blocked"}`,
    );
  return (
    <div className="pad-x">
      <label className="field">
        {label} workers
        <select
          value={access[family] ? "on" : "off"}
          onChange={(event) => void pick(event.target.value === "on")}
        >
          <option value="on">Allowed — subagents may run it</option>
          <option value="off">Blocked — refused in every permission mode</option>
        </select>
        <span className="muted small">
          Endpoint, model and key are global; runs are listed under Tasks.
        </span>
      </label>
      <p className="muted small">
        <button type="button" className="link inline" onClick={() => onOpenGlobalSettings(family)}>
          {label} settings for every agent
        </button>
      </p>
    </div>
  );
}

/**
 * Remote Pi for this agent: whether it may use pi at all (the chip), and where
 * its work runs. "Own settings" fills field by field over the global record,
 * which is what makes "another working folder" one field instead of a second
 * machine to configure. The ssh key is never per-agent — one lettuce key is
 * authorized on every host.
 */
function PiPane({
  agentId,
  access,
  onStatus,
  onReload,
  onOpenGlobalSettings,
}: {
  agentId: string;
  access: AgentToolAccess;
  onStatus: (text: string) => void;
  onReload: () => void;
  onOpenGlobalSettings: (section?: string) => void;
}) {
  const [override, setOverride] = useState<PiAgentOverride | null>(null);
  const [form, setForm] = useState<PiAgentOverride | null>(null);
  const [global, setGlobal] = useState<PiSettings | null>(null);
  const [globalConfigured, setGlobalConfigured] = useState(true);
  const [globalTarget, setGlobalTarget] = useState<string | null>(null);
  const [check, setCheck] = useState<PiCheck | null>(null);
  /** The two fields a failed check can point the operator straight at. */
  const workdirRef = useRef<HTMLInputElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const [agent, settings] = await Promise.all([fetchPiAgent(agentId), fetchPiSettings()]);
      setOverride(agent.override);
      setForm(agent.override);
      setCheck(agent.check);
      setGlobalConfigured(agent.globalConfigured);
      setGlobalTarget(agent.globalTarget);
      setGlobal(settings.settings);
    } catch (cause) {
      onStatus(errorMessage(cause));
    }
  }, [agentId, onStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!form || !global) return <p className="muted pad">Loading Remote Pi settings…</p>;

  const own = form.mode === "own";
  const dirty = JSON.stringify(form) !== JSON.stringify(override);
  const target = {
    host: own && form.host ? form.host : global.host,
    port: (own && form.port ? form.port : global.port) || 22,
    user: own && form.user ? form.user : global.user,
    pathPrepend: own && form.pathPrepend ? form.pathPrepend : global.pathPrepend,
    workdir: own && form.workdir ? form.workdir : global.workdir,
  };
  const stale = check !== null && check.target !== `${target.user}@${target.host}:${target.port}`;
  const set = (patch: Partial<PiAgentOverride>) => setForm({ ...form, ...patch });

  const save = async () => {
    setBusy("save");
    try {
      const saved = await savePiAgent(agentId, form);
      setOverride(saved.override);
      setForm(saved.override);
      setCheck(saved.check);
      toast("Saved — it applies from this agent's next turn");
    } catch (cause) {
      toast(`Could not save: ${errorMessage(cause)}`, "bad");
    } finally {
      setBusy("");
    }
  };

  const inherit = async () => {
    setBusy("save");
    try {
      const back = await resetPiAgent(agentId);
      setOverride(back.override);
      setForm(back.override);
      setCheck(back.check);
      toast("This agent follows the global Remote Pi settings again.");
    } catch (cause) {
      toast(`Could not reset to the global settings: ${errorMessage(cause)}`, "bad");
    } finally {
      setBusy("");
    }
  };

  const runCheck = async (pinFirst: boolean) => {
    setBusy("check");
    try {
      if (pinFirst) await pinPiHostKey({ host: target.host, port: target.port, agentId });
      const result = await checkPiHost(target, agentId);
      setCheck(result);
      // A pass is a receipt; a failure is a state of this pane and stays on it as
      // a banner, where ssh's own words can be read at leisure.
      if (result.ok) toast(`Checked — ${result.detail} on ${result.target}`);
    } catch (cause) {
      toast(errorMessage(cause), "bad");
    } finally {
      setBusy("");
    }
  };

  const needsPin = !check || check.state === "unpinned";

  return (
    <div className="pad-x">
      {!access.pi ? (
        <p className="muted small">
          Remote Pi is blocked for this agent, so none of this is used yet — tick its box to allow
          it.
        </p>
      ) : null}
      {/* Off and unset are different problems, and only one of them is fixable
          from this pane: an override saved while the global switch is off is
          inert, so say that instead of letting a saved form imply it runs. */}
      {!global.enabled ? (
        <p className="muted small">
          Remote Pi is switched off for every agent, so nothing here runs yet — whatever is saved
          waits for the switch.{" "}
          <button type="button" className="link inline" onClick={() => onOpenGlobalSettings("pi")}>
            Settings → Remote Pi
          </button>
          .
        </p>
      ) : !globalConfigured ? (
        <p className="muted small">
          There is no global host or deploy key to inherit yet.{" "}
          <button type="button" className="link inline" onClick={() => onOpenGlobalSettings("pi")}>
            Set it up in Settings → Remote Pi
          </button>
          .
        </p>
      ) : null}

      <label className="field">
        Where this agent runs pi work
        <select
          value={form.mode}
          onChange={(event) => set({ mode: event.target.value as PiAgentOverride["mode"] })}
        >
          <option value="global">
            The global Remote Pi settings{globalTarget ? ` (${globalTarget})` : ""}
          </option>
          <option value="own">This agent has its own settings</option>
        </select>
        <span className="muted small">
          Own settings fill in field by field: anything left empty keeps the global value, so a
          different working folder is one field and nothing else. The ssh key and the on/off switch
          are never per-agent.
        </span>
      </label>

      {!own ? (
        <>
          <p className="muted small">
            This agent uses {globalTarget ?? "no host yet"}
            {global.workdir ? ` and works in ${global.workdir}` : ""}. Choose “own settings” to
            point it at a different folder or host.
          </p>
          <p className="muted small">
            <button
              type="button"
              className="link inline"
              onClick={() => onOpenGlobalSettings("pi")}
            >
              Global Remote Pi settings
            </button>
          </p>
        </>
      ) : (
        <>
          <label className="field">
            Host
            <input
              value={form.host}
              placeholder={globalTarget ?? "other.example.com"}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set({ host: event.target.value })}
            />
          </label>
          <label className="field">
            User
            <input
              value={form.user}
              placeholder={global.user || "worker"}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set({ user: event.target.value })}
            />
          </label>
          <label className="field">
            Port
            <input
              value={form.port === null ? "" : String(form.port)}
              placeholder={String(global.port || 22)}
              inputMode="numeric"
              onChange={(event) =>
                set({ port: event.target.value === "" ? null : Number(event.target.value) })
              }
            />
          </label>
          <label className="field">
            Workdir
            <input
              value={form.workdir}
              ref={workdirRef}
              placeholder="/home/worker/research"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set({ workdir: event.target.value })}
            />
            <span className="muted small">
              Required. Every task this agent dispatches starts in this folder on that host.
            </span>
          </label>
          <label className="field">
            PATH prefix
            <input
              value={form.pathPrepend}
              ref={pathRef}
              placeholder={global.pathPrepend || "/opt/node/bin:/opt/pi/bin"}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set({ pathPrepend: event.target.value })}
            />
          </label>
          <label className="field">
            Model
            <input
              value={form.model ?? ""}
              placeholder={global.model ?? "the remote pi default"}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set({ model: event.target.value })}
            />
            <span className="muted small">
              Empty keeps the global model; a model here is used only by this agent.
            </span>
          </label>

          <PiStatusLine
            check={check}
            stale={dirty || stale}
            checking={busy === "check"}
            targetNote={override?.mode === "own" ? null : "inherited from Settings"}
          />
          <PiCheckBanner
            check={check}
            stale={dirty || stale}
            checking={busy === "check"}
            onFocusPath={() => pathRef.current?.focus()}
            onFocusWorkdir={() => workdirRef.current?.focus()}
            onRetry={() => void runCheck(needsPin)}
          />
          <div className="button-row">
            <button
              type="button"
              className="button"
              disabled={busy !== "" || !dirty}
              onClick={() => void save()}
            >
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="button ghost"
              disabled={busy !== "" || !target.host}
              onClick={() => void runCheck(needsPin)}
            >
              {busy === "check" ? "Checking…" : needsPin ? "Check & pin host key" : "Check host"}
            </button>
            {override?.mode === "own" ? (
              <button
                type="button"
                className="button ghost"
                disabled={busy !== ""}
                onClick={() => void inherit()}
              >
                Use global settings
              </button>
            ) : null}
            {dirty && !busy ? <span className="muted small">Unsaved changes</span> : null}
          </div>
          <p className="muted small">
            Checks {target.user ? `${target.user}@${target.host}` : "the host"}
            {target.port !== 22 ? `:${target.port}` : ""} with the key from the global settings.
            Saving checks it too.
          </p>
        </>
      )}
      <p className="muted small">
        Wrong here?{" "}
        <button type="button" className="link inline" onClick={onReload}>
          Reload this pane
        </button>
      </p>
    </div>
  );
}
