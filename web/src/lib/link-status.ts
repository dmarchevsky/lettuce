import type { ConnectionState } from "./protocol.ts";
import type { LinkState } from "./session-client.ts";

/**
 * The two connections the app knows about, said as one label.
 *
 * `link` is the browser↔BFF socket; `upstream` is the BFF's single connection
 * to the app-server (hello, then every state transition). The socket being
 * live proves nothing about the server — the BFF answers its own WebSocket
 * while its upstream is down — so a green dot over a dead app-server was a
 * lie the top bar told until `upstream` was consumed here.
 */
export type StatusTone = "ok" | "warn" | "bad";

export interface LinkStatus {
  label: string;
  tone: StatusTone;
  /** The favicon's state key for the same truth (`lib/favicon.ts` tints by it). */
  favicon: LinkState;
}

const LINK_LABELS: Record<LinkState, { label: string; tone: StatusTone }> = {
  live: { label: "Live", tone: "ok" },
  connecting: { label: "Connecting…", tone: "warn" },
  reconnecting: { label: "Reconnecting…", tone: "warn" },
  resyncing: { label: "Resyncing…", tone: "warn" },
  offline: { label: "Offline", tone: "bad" },
  "signed-out": { label: "Sign in again", tone: "bad" },
};

/**
 * Which truth the dot and the favicon tell.
 *
 * Precedence, top wins:
 * - `signed-out` outranks everything: a dead session has nothing worth
 *   reporting about servers, and only the user can fix this one.
 * - An app-server the BFF reported gone names the *server*, even while the
 *   browser's own socket is fine — that is the case the old single-axis dot
 *   dressed up as "Live". `offline`/`reconnecting` here is the BFF's own
 *   broadcast on transition (`session-client.ts`), so the label holds for
 *   both the gone-mid-session and the-connected-during-an-outage paths.
 * - Otherwise the device's own link label, unchanged.
 */
export function deriveLinkStatus(link: LinkState, upstream: ConnectionState): LinkStatus {
  if (link === "signed-out") {
    return { label: LINK_LABELS[link].label, tone: "bad", favicon: "signed-out" };
  }
  if (upstream === "disconnected") {
    return { label: "App-server offline", tone: "bad", favicon: "offline" };
  }
  if (upstream === "connecting") {
    return { label: "Connecting to app-server…", tone: "warn", favicon: "reconnecting" };
  }
  const base = LINK_LABELS[link];
  return { label: base.label, tone: base.tone, favicon: link };
}

/**
 * The rising edge of the BFF's upstream state — the app-server came back.
 * One shared rule for the two self-healing refetches (`use-agents` list
 * refetch, `use-conversation` failed-load restart): a returning server must
 * be as loud a signal as a browser reconnect.
 */
export function upstreamReturned(previous: ConnectionState, next: ConnectionState): boolean {
  return previous !== "connected" && next === "connected";
}
