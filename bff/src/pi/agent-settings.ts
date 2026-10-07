/**
 * Per-agent Remote Pi settings.
 *
 * The global record (`pi/settings.ts`) says *whether* there is a remote pi and
 * which deploy key reaches it; this says what one agent does differently —
 * usually its own Workdir, occasionally a whole different host. Every field
 * here is optional: an empty field inherits the global one, so "this agent uses
 * pi-host but works in /home/worker/research" is one field, and the default
 * record says nothing at all.
 *
 * Two things are deliberately *not* overridable:
 * - **the switch**. Whether an agent gets the pi tools at all is tool access,
 *   and tool access has one home (`bff/src/agents/tool-access.ts`), so the
 *   Tools tab's checkbox and this record cannot disagree.
 * - **the deploy key**. One lettuce-held key whose public half is authorized on
 *   every host; forking custody per agent would add secrets to the volume and a
 *   manual step to every host for no access gain — any agent that can call
 *   `pi_run` can use whatever host it resolves to.
 *
 * Resolved at tool-call time from the `x-letta-agent-id` the mods already send,
 * so nothing upstream knows about this: the tools are the same four tools.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAgentId } from "../agents/id-list.ts";
import { normalizePathPrepend, type PiSettings } from "./settings.ts";

export interface PiAgentSettings {
  /** "global" inherits everything; "own" fills the fields below over it. */
  mode: "global" | "own";
  /** "" inherits. */
  host: string;
  /** null inherits. */
  port: number | null;
  user: string;
  pathPrepend: string;
  workdir: string;
  /** null inherits (and "" means "use the remote pi's own default"). */
  model: string | null;
}

export const DEFAULT_PI_AGENT_SETTINGS: PiAgentSettings = Object.freeze({
  mode: "global",
  host: "",
  port: null,
  user: "",
  pathPrepend: "",
  workdir: "",
  model: null,
});

export function parsePiAgentSettings(value: unknown): PiAgentSettings | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  // Wrong types are refused rather than quietly blanked: a form that sends a
  // number where a string belongs is a bug, and inheriting the global host
  // because of it would look like the operator had typed nothing.
  const text = (name: keyof PiAgentSettings): string | null => {
    const raw = r[name as string];
    if (raw === undefined || raw === null || raw === "") return "";
    return typeof raw === "string" ? raw.trim() : null;
  };
  const host = text("host");
  const user = text("user");
  const prepend = text("pathPrepend");
  // A typed PATH prefix loses its trailing slashes here too — see settings.ts.
  const pathPrepend = prepend === null ? null : normalizePathPrepend(prepend);
  const workdir = text("workdir");
  if (host === null || user === null || pathPrepend === null || workdir === null) return null;
  const rawPort = r.port;
  let port: number | null = null;
  if (typeof rawPort === "number" && Number.isFinite(rawPort)) {
    port = Math.trunc(rawPort);
    if (port < 1 || port > 65535) return null;
  } else if (rawPort !== undefined && rawPort !== null && rawPort !== "") {
    return null;
  }
  const rawModel = r.model;
  if (rawModel !== undefined && rawModel !== null && typeof rawModel !== "string") return null;
  return {
    mode: r.mode === "own" ? "own" : "global",
    host,
    port,
    user,
    pathPrepend,
    workdir,
    model: typeof rawModel === "string" ? rawModel.trim() : null,
  };
}

/** Only differences from "inherit everything" are stored. */
export function isDefaultPiAgentSettings(s: PiAgentSettings): boolean {
  return (
    s.mode === "global" &&
    s.host === "" &&
    s.port === null &&
    s.user === "" &&
    s.pathPrepend === "" &&
    s.workdir === "" &&
    s.model === null
  );
}

export class InvalidPiAgentSettingsError extends Error {}

/**
 * The effective connection for one agent: the global record with this agent's
 * fields laid over it. `source` says which won, so the UI and the tool answers
 * can be honest about where a run is going.
 */
export function effectivePiSettings(
  global: PiSettings,
  override: PiAgentSettings,
): PiSettings & { source: "global" | "agent" } {
  if (override.mode === "global") return { ...global, source: "global" as const };
  return {
    ...global,
    host: override.host || global.host,
    port: override.port ?? global.port,
    user: override.user || global.user,
    pathPrepend: override.pathPrepend || global.pathPrepend,
    workdir: override.workdir || global.workdir,
    model: override.model !== null ? override.model : global.model,
    source: "agent" as const,
  };
}

/** What an "own" record must still satisfy to be saveable. */
export function assertEffectiveUsable(effective: PiSettings & { source: string }): void {
  if (!effective.host) {
    throw new InvalidPiAgentSettingsError(
      "this host has no name — set one, or use global settings",
    );
  }
  if (!effective.user) {
    throw new InvalidPiAgentSettingsError("no ssh user — set one, or use global settings");
  }
  if (!effective.workdir.startsWith("/")) {
    throw new InvalidPiAgentSettingsError("Workdir must be an absolute path on the remote host");
  }
  if (!effective.privateKey) {
    throw new InvalidPiAgentSettingsError(
      "there is no deploy key yet — set one up in Settings → Remote Pi first",
    );
  }
}

/**
 * One JSON file next to the pi settings: `{ "<agent id>": {…} }`, holding only
 * the agents that differ from the default. Written 0600 like the rest of the pi
 * directory — it is not secret, but it is not for other processes either.
 */
export class PiAgentSettingsStore {
  private entries = new Map<string, PiAgentSettings>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly onWriteError: (error: unknown) => void,
  ) {
    if (!existsSync(filePath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [agentId, raw] of Object.entries(parsed)) {
        const settings = parsePiAgentSettings(raw);
        if (isAgentId(agentId) && settings && !isDefaultPiAgentSettings(settings)) {
          this.entries.set(agentId, settings);
        }
      }
    } catch {
      // Unreadable: everyone inherits rather than the BFF failing to boot.
    }
  }

  get(agentId: string): PiAgentSettings {
    return this.entries.get(agentId) ?? { ...DEFAULT_PI_AGENT_SETTINGS };
  }

  all(): Record<string, PiAgentSettings> {
    return Object.fromEntries(this.entries);
  }

  set(agentId: string, settings: PiAgentSettings): void {
    if (!isAgentId(agentId)) throw new Error("Not an agent id");
    if (isDefaultPiAgentSettings(settings)) this.entries.delete(agentId);
    else this.entries.set(agentId, settings);
    this.persist();
  }

  remove(agentId: string): void {
    if (this.entries.delete(agentId)) this.persist();
  }

  drain(): Promise<void> {
    return this.writeQueue;
  }

  private persist(): void {
    const snapshot = JSON.stringify(this.all(), null, 2);
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => {
        try {
          const temp = `${this.filePath}.tmp`;
          writeFileSync(temp, snapshot);
          renameSync(temp, this.filePath);
        } catch (error) {
          this.onWriteError(error);
        }
      });
  }
}
