/**
 * `POST /internal/tools/<name>` — what the BFF's mods call (see `mod.ts`).
 *
 * Served only to loopback clients. The BFF shares the app-server's network
 * namespace, so loopback means exactly: the app-server process (where mods
 * run), agent shells, and the channel gateway — all of which can already reach
 * every sidecar and the internet directly, so this route adds no capability.
 * Browsers never arrive on loopback: the published port and the cloudflared
 * tunnel both connect from another address, and they get a 404 as if the
 * route did not exist.
 *
 * Handled before Hono (see index.ts), outside the session middleware and the
 * per-user throttle: a mod has no session, and its own cap is below.
 */

import { isAgentId } from "../agents/id-list.ts";
import { AGENT_ID_HEADER, CONVERSATION_ID_HEADER } from "./mod.ts";
import type { ToolAnswer, ToolHandler } from "./types.ts";

export const INTERNAL_PREFIX = "/internal/tools/";
/**
 * `GET /internal/agent-access/<agentId>` — what the agent-policy mod asks about
 * an agent it has never seen (a subagent of one the UI blocked, which carries its
 * own id: `agents/ancestry.ts`). Answered from the BFF because only the BFF can
 * walk letta-code's `parent:` tags over the upstream connection.
 */
export const ACCESS_PREFIX = "/internal/agent-access/";

/** The worker families an agent may start, ancestors included. */
export interface WorkerAccess {
  codex: boolean;
  claude: boolean;
}
/**
 * The first web-tools mod (v1) called these paths; a v1 file stays on disk
 * until the BFF's next connect re-renders it, so they keep answering.
 */
const LEGACY_PATHS: Record<string, string> = {
  "/internal/web-tools/search": "web_search",
  "/internal/web-tools/fetch": "fetch_webpage",
};
/** Parallel tool calls from several agents at once are fine; a runaway loop is not. */
const MAX_IN_FLIGHT = 8;

export function isLoopback(address: string | null | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function json(answer: ToolAnswer, status = 200): Response {
  return new Response(JSON.stringify(answer), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function toolNameOf(pathname: string): string | null {
  if (pathname in LEGACY_PATHS) return LEGACY_PATHS[pathname] ?? null;
  if (pathname.startsWith(INTERNAL_PREFIX)) return pathname.slice(INTERNAL_PREFIX.length);
  return null;
}

let inFlight = 0;

/**
 * The response for an internal tool request, or null when `request` is not
 * one (the caller then routes it normally).
 */
export async function handleInternalTools(
  request: Request,
  clientAddress: string | null | undefined,
  handlers: () => ReadonlyMap<string, ToolHandler>,
  workerAccess?: (agentId: string) => Promise<WorkerAccess>,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/internal/")) return null;
  if (!isLoopback(clientAddress)) return new Response("Not found", { status: 404 });
  if (pathname.startsWith(ACCESS_PREFIX)) {
    const agentId = decodeURIComponent(pathname.slice(ACCESS_PREFIX.length));
    if (!workerAccess || !isAgentId(agentId)) return new Response("Not found", { status: 404 });
    const access = await workerAccess(agentId);
    return new Response(JSON.stringify({ codex: access.codex, claude: access.claude }), {
      headers: { "content-type": "application/json" },
    });
  }
  const name = toolNameOf(pathname);
  const handler = name ? handlers().get(name) : undefined;
  if (request.method !== "POST" || !handler) return new Response("Not found", { status: 404 });
  if (inFlight >= MAX_IN_FLIGHT) {
    return json(
      { text: "Too many tool calls at once — try again in a moment.", isError: true },
      429,
    );
  }
  let args: Record<string, unknown>;
  try {
    const body: unknown = await request.json();
    args = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return json({ text: "The tool arguments were not valid JSON.", isError: true }, 400);
  }
  inFlight += 1;
  try {
    const agentId = request.headers.get(AGENT_ID_HEADER);
    const conversationId = request.headers.get(CONVERSATION_ID_HEADER);
    return json(
      await handler(args, {
        agentId: isAgentId(agentId) ? agentId : null,
        conversationId:
          conversationId && /^[A-Za-z0-9_-]{1,128}$/.test(conversationId) ? conversationId : null,
      }),
    );
  } catch (error) {
    // Handlers are written not to throw; this is the backstop.
    return json({
      text: `The ${name} tool failed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    });
  } finally {
    inFlight -= 1;
  }
}
