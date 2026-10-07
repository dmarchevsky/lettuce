/**
 * Checking a Remote Pi host, and remembering what the last check said.
 *
 * The reason this exists is the shape of the failure: every run uses
 * `StrictHostKeyChecking=yes` with a pinned `known_hosts`, so saving a host you
 * have never pinned, or pointing at a machine where pi is not on the
 * non-interactive PATH, looks exactly like a working setup until an agent's run
 * dies. So the settings form asks the question out loud, and the answer is kept
 * per `user@host:port` on the BFF's own volume: Settings is device-independent,
 * and the phone must not say "never checked" a minute after the laptop checked.
 *
 * Nothing here decides policy — `pi/runner.ts` builds the ssh argv. This is the
 * read-only side: is the host pinned, is the key accepted, is pi reachable.
 */

import { normalizePathPrepend, type PiSettings } from "./settings.ts";

/** What a check concluded. Every state is something the form can act on. */
export type PiCheckState =
  | "ready"
  /** Reachable and the key works, but nothing is pinned for this host: runs fail. */
  | "unpinned"
  /** No deploy key yet — the check could not even try. */
  | "no_key"
  /** The remote refused our key (`authorized_keys` missing the public line). */
  | "auth_failed"
  /** Logged in, but `pi` is not on the PATH the run will get. */
  | "no_pi"
  /** Logged in, but the workdir does not exist. */
  | "no_workdir"
  /** No route, timeout, refused, host key changed… the ssh text says which. */
  | "unreachable";

export interface PiCheck {
  /** `user@host:port` — what `piTarget` says, port included when not 22. */
  target: string;
  state: PiCheckState;
  ok: boolean;
  /** One line for the UI, never a secret: no key material, no PEM, no paths outside the remote. */
  detail: string;
  at: string;
  /** What `pi --version` answered, when it answered. */
  piVersion: string | null;
  /** `SHA256:…` of the pinned host key, so a rotation is visible. */
  pinnedFingerprint: string | null;
}

/** What a check is about, whether it came from the saved settings or a draft. */
export type PiCheckTarget = Pick<PiSettings, "host" | "port" | "user">;

export function checkTargetKey(target: PiCheckTarget & { pathPrepend?: string }): string {
  return `${target.user}@${target.host}:${target.port}`;
}

/** The known_hosts pattern ssh itself would look for at this port. */
export function knownHostsPattern(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** The pinned key line for a host, or null when it is not pinned. */
export function pinnedHostKey(knownHosts: string, host: string, port: number): string | null {
  const pattern = knownHostsPattern(host, port);
  for (const line of knownHosts.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [first] = trimmed.split(/\s+/);
    // One line may list several patterns separated by commas or spaces.
    if (first && first.split(/[,\s]/).includes(pattern)) return trimmed;
  }
  return null;
}

export function hostIsPinned(knownHosts: string, host: string, port: number): boolean {
  return pinnedHostKey(knownHosts, host, port) !== null;
}

// ── the checks file ──────────────────────────────────────────────────────────

export type PiCheckRecord = Record<string, PiCheck>;

/** Lenient like the settings file: a damaged record is an empty record. */
export function parseChecks(text: string | null): PiCheckRecord {
  if (!text) return {};
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: PiCheckRecord = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const r = value as Record<string, unknown>;
      if (typeof r.state !== "string" || typeof r.detail !== "string") continue;
      out[key] = {
        target: typeof r.target === "string" ? r.target : key,
        state: r.state as PiCheckState,
        ok: r.ok === true,
        detail: r.detail,
        at: typeof r.at === "string" ? r.at : "",
        piVersion: typeof r.piVersion === "string" ? r.piVersion : null,
        pinnedFingerprint: typeof r.pinnedFingerprint === "string" ? r.pinnedFingerprint : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function renderChecks(record: PiCheckRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Classify what ssh said, so the UI can offer the right action instead of a
 * wall of ssh text. Order matters: the specific answers are matched before the
 * generic ssh failure (exit 255 covers everything).
 */
export function classifyCheckOutput(args: {
  code: number | null;
  stdout: string;
  stderr: string;
}): { state: PiCheckState; detail: string; piVersion: string | null } {
  const text = `${args.stdout}\n${args.stderr}`;
  const oneLine = (fallback: string) => {
    const line = text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return line ?? fallback;
  };
  if (/lettuce: pi not on PATH/.test(text)) {
    return {
      state: "no_pi",
      detail: "Signed in, but `pi` is not on the PATH a run gets — set PATH prefix.",
      piVersion: null,
    };
  }
  if (/lettuce: no such workdir/.test(text)) {
    return {
      state: "no_workdir",
      detail: "Signed in, but that Workdir does not exist.",
      piVersion: null,
    };
  }
  if (/lettuce: pi failed/.test(text)) {
    // Installed, wrong environment. The first line that reads like a reason beats
    // the first line of a stack, and the node version is the thing to change.
    const lines = text.split("\n").map((l) => l.trim());
    const reason =
      lines.find(
        (l) => /Error|error|Cannot|not provide|No such file/.test(l) && !l.startsWith("lettuce:"),
      ) ??
      lines[lines.indexOf("lettuce: pi failed") + 1] ??
      "it refused to run";
    const node = /lettuce: node (.+)/.exec(text);
    return {
      state: "no_pi",
      detail: `pi is installed but cannot run: ${reason.slice(0, 160)}${node ? ` · node ${node[1]}` : ""}`,
      piVersion: null,
    };
  }
  const marked = /^lettuce: pi (.+)$/m.exec(text);
  if (marked && args.code === 0) {
    const value = (marked[1] ?? "").trim().replace(/^v/, "");
    return { state: "ready", detail: `pi v${value}`, piVersion: value || null };
  }
  const version = /^pi v?([0-9][^\s]*)/m.exec(args.stdout);
  if (args.code === 0 && version) {
    return {
      state: "ready",
      detail: `pi v${version[1] ?? version[0]}`,
      piVersion: version[1] ?? null,
    };
  }
  if (/Permission denied \((publickey|password)/i.test(text)) {
    return {
      state: "auth_failed",
      detail:
        "The remote refused our deploy key — add its public line to the remote's ~/.ssh/authorized_keys.",
      piVersion: null,
    };
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(text)) {
    return {
      state: "unreachable",
      detail:
        "The host key no longer matches the pinned one — pin it again only if the host really changed.",
      piVersion: null,
    };
  }
  if (
    /Name or service not known|Could not resolve host|No route to host|Connection refused|timed out|Timeout/i.test(
      text,
    )
  ) {
    return {
      state: "unreachable",
      detail: oneLine("The host did not answer ssh."),
      piVersion: null,
    };
  }
  return {
    state: args.code === 0 ? "no_pi" : "unreachable",
    detail: oneLine(
      args.code === 0 ? "ssh answered but not pi." : `ssh failed (exit ${args.code}).`,
    ),
    piVersion: null,
  };
}

/** The remote side of a check: workdir, PATH, and pi's version, in one ssh. */
export function buildProbeRemoteCommand(settings: {
  workdir: string;
  pathPrepend: string;
}): string {
  const parts: string[] = [];
  if (settings.workdir) {
    parts.push(`[ -d ${quote(settings.workdir)} ] || echo 'lettuce: no such workdir';`);
  }
  const prepend = normalizePathPrepend(settings.pathPrepend);
  // The probe speaks its own markers, because pi's own output cannot be trusted
  // to be readable: `pi --version` prints a bare `1.0.4`, and a pi that is
  // installed but cannot start (the usual cause being a `node` on PATH too old
  // for it) prints a module stack that says nothing to an operator. So: ask, and
  // name the answer. On failure the raw output and the node version come back too,
  // because "pi is there and broken · node v20.19.2" is actionable and a stack
  // line is not.
  const inner = [
    "command -v pi >/dev/null 2>&1 || { echo 'lettuce: pi not on PATH'; exit 0; };",
    "pi_out=$(pi --version 2>&1); pi_rc=$?;",
    'if [ "$pi_rc" -eq 0 ]; then',
    "  printf 'lettuce: pi %s\\n' \"$(printf '%s\\n' \"$pi_out\" | head -1)\";",
    "else",
    "  echo 'lettuce: pi failed';",
    "  printf '%s\\n' \"$pi_out\" | head -4;",
    "  printf 'lettuce: node %s\\n' \"$(node -v 2>&1 | head -1)\";",
    "fi",
  ].join(" ");
  // PATH='<prepend>':"$PATH" for the reason spelled out in runner.ts — the
  // `$PATH` belongs to the remote shell, not to us. And the shell is named by
  // absolute path, so even a PATH that turns out to be broken cannot make the
  // probe fail with something the operator reads as "the server is broken".
  parts.push(
    prepend
      ? `env PATH=${quote(prepend)}:"$PATH" /bin/sh -c ${quote(inner)}`
      : `/bin/sh -c ${quote(inner)}`,
  );
  return parts.join(" ");
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** "just now" / "4 min ago" / "3 h ago" — the pill is not a timestamp dump. */
export function ago(at: string, now = new Date()): string {
  const then = new Date(at).getTime();
  if (!Number.isFinite(then) || !at) return "never";
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
