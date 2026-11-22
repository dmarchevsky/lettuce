/**
 * Pinned agents come first in every agent list, in the order they were
 * pinned; the rest keep the order `agent_list` gave. Archived agents are
 * hidden until asked for. Both are kept by the BFF
 * (`bff/src/agents/id-list.ts`) so every device agrees.
 */

import type { AvatarPref } from "./agent-tint.ts";

export interface AgentFlags {
  pinned: string[];
  archived: string[];
  /**
   * Per-agent avatar choices, keyed by agent id, present only for agents that
   * chose something (`bff/src/agents/avatar-prefs.ts`). Optional because a BFF
   * from before it answers without the field, which is the same as nothing
   * chosen.
   */
  avatars?: Record<string, AvatarPref>;
}

export function orderByPins<T extends { id: string }>(
  agents: readonly T[],
  pinned: readonly string[],
): T[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const first = pinned.flatMap((id) => {
    const agent = byId.get(id);
    return agent ? [agent] : [];
  });
  const pinnedSet = new Set(pinned);
  return [...first, ...agents.filter((agent) => !pinnedSet.has(agent.id))];
}

export async function fetchAgentFlags(): Promise<AgentFlags> {
  const response = await fetch("/api/agents/flags");
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return (await response.json()) as AgentFlags;
}

/** Archiving also unpins, server-side; both lists come back. */
export async function saveArchivedAgent(agentId: string, archived: boolean): Promise<AgentFlags> {
  const response = await fetch(`/api/agents/archived/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return (await response.json()) as AgentFlags;
}

export async function savePinnedAgent(agentId: string, pinned: boolean): Promise<string[]> {
  const response = await fetch(`/api/agents/pins/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned }),
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return ((await response.json()) as { pinned: string[] }).pinned;
}

/**
 * Writes one agent's avatar choice and returns the whole map, so one write can
 * refresh every list that shows an avatar. An empty pref resets that agent to the
 * tint and initial it derives on its own.
 */
export async function saveAgentAvatar(
  agentId: string,
  pref: { tint?: string | null; glyph?: string | null; image?: string | null },
): Promise<Record<string, AvatarPref>> {
  const response = await fetch(`/api/agents/avatar/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pref),
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return ((await response.json()) as { avatars: Record<string, AvatarPref> }).avatars;
}

/** One uploaded face, and which agents are wearing it (`bff/src/agents/avatar-library.ts`). */
export interface FaceEntry {
  id: string;
  bytes: number;
  mtime: number;
  usedBy: string[];
}

export interface FaceLibrary {
  images: FaceEntry[];
  /** The glyphs saved most recently, most recent first. */
  recents: string[];
}

/**
 * The whole face library in one call: the sheet lists it, so it would otherwise
 * fetch the list and the recents separately for the same four tiles.
 */
export async function fetchFaceLibrary(): Promise<FaceLibrary> {
  const response = await fetch("/api/avatars");
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return (await response.json()) as FaceLibrary;
}

/**
 * Uploads one already-resized face (the caller did the resize — see
 * `resizeToFace`), raw bytes rather than multipart, and answers with the fresh
 * list so the strip redraws without a second round trip.
 */
export async function uploadFace(blob: Blob): Promise<FaceLibrary & { id: string }> {
  const response = await fetch("/api/avatars", {
    method: "POST",
    headers: { "content-type": blob.type || "application/octet-stream" },
    body: blob,
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return (await response.json()) as FaceLibrary & { id: string };
}

/**
 * Deletes a face. The BFF also clears it from every agent that was wearing it and
 * returns the refreshed avatar map with `cleared` naming them, so no surface is
 * left pointing at bytes that are gone.
 */
export async function removeFace(
  id: string,
): Promise<FaceLibrary & { avatars: Record<string, AvatarPref>; cleared: string[] }> {
  const response = await fetch(`/api/avatars/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return (await response.json()) as FaceLibrary & {
    avatars: Record<string, AvatarPref>;
    cleared: string[];
  };
}

// ── Drawing a face from a description ──────────────────────────────────────
// The picture is drawn by the BFF (`bff/src/images/face.ts`) because the image
// endpoint's key lives there and never reaches a browser. What comes back is a
// picture, nothing more: the sheet puts it through the same crop-resize-upload
// path a chosen file takes, so the face library stays the only place faces live.

/** What the sheet may keep of a long draw: the bytes and the size drawn. */
export interface DrawnFace {
  blob: Blob;
  size: string | null;
}

/** Whether the Draw tab has anything to draw with, and how long to wait for it. */
export interface FaceDrawCapability {
  drawable: boolean;
  /** The per-draw ceiling the BFF enforces, so the browser's bound matches it. */
  timeoutMs: number;
  /** The style line the BFF puts in front of every prompt, for the sheet to show. */
  prefix: string;
}

/** Mirrors `MAX_FACE_PROMPT_CHARS` in `bff/src/images/face.ts`. */
export const MAX_FACE_PROMPT_CHARS = 400;

/** What the browser falls back to when it never learned the configured ceiling. */
const DEFAULT_DRAW_TIMEOUT_MS = 180_000;

/** Room past the configured ceiling for the ladder's fast refusals and the round trips. */
const DRAW_SLACK_MS = 45_000;

/**
 * Whether a face can be drawn here. `GET /api/images/settings` answers 404 while the
 * `images` compose token is off, which is the same practical answer as an endpoint
 * nobody has configured: there is nothing to draw with, so the Draw tab is not shown
 * rather than shown and broken.
 */
export async function fetchDrawCapability(
  fetchImpl: typeof fetch = fetch,
): Promise<FaceDrawCapability> {
  const absent: FaceDrawCapability = {
    drawable: false,
    timeoutMs: DEFAULT_DRAW_TIMEOUT_MS,
    prefix: "",
  };
  let response: Response;
  try {
    response = await fetchImpl("/api/images/settings");
  } catch {
    return absent;
  }
  if (!response.ok) return absent;
  const answer = (await response.json().catch(() => null)) as {
    settings?: { baseUrl?: string; model?: string | null; timeoutMs?: number };
    faceStylePrefix?: string;
  } | null;
  const settings = answer?.settings;
  return {
    drawable: Boolean(settings?.baseUrl && settings?.model),
    timeoutMs: settings?.timeoutMs ?? DEFAULT_DRAW_TIMEOUT_MS,
    prefix: answer?.faceStylePrefix ?? "",
  };
}

/**
 * Draws one face. The refusal a user needs is the server's own sentence, and the
 * route sends it as JSON on a 502, so the body is parsed before its status decides
 * what the sheet shows — `HTTP 502` on its own tells nobody anything.
 *
 * The bound is the configured `timeoutMs` plus `DRAW_SLACK_MS`. The slack is what the
 * size ladder costs beyond one draw: it only walks on a refusal that came back
 * immediately (a rung that *timed out* ends the ladder), so the worst normal case is
 * one ceiling plus three round trips — and a server that answers each rung slowly gets
 * cut here rather than hanging the button. The timer covers reading the body too, not
 * just the headers: a server that sends a status and then stalls is the same broken
 * server. `signal` is how closing the sheet stops the wait, and it reaches the BFF, so
 * the draw is stopped rather than merely ignored.
 */
export async function drawFace(
  prompt: string,
  options: { timeoutMs?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<DrawnFace> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const bound = (options.timeoutMs ?? DEFAULT_DRAW_TIMEOUT_MS) + DRAW_SLACK_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), bound);
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const response = await fetchImpl("/api/images/draw-face", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
    const text = await response.text();
    let answer: { ok?: boolean; error?: string; dataUrl?: string; size?: string | null } | null =
      null;
    try {
      answer = JSON.parse(text);
    } catch {
      answer = null;
    }
    if (!answer) throw new Error(text || `HTTP ${response.status}`);
    if (answer.ok !== true || !answer.dataUrl) {
      throw new Error(answer.error || `HTTP ${response.status}`);
    }
    return { blob: dataUrlToBlob(answer.dataUrl), size: answer.size ?? null };
  } catch (error) {
    if (options.signal?.aborted) throw new Error("Cancelled.");
    if (controller.signal.aborted) {
      throw new Error(
        `Nothing came back within ${Math.round(bound / 1000)}s — its queue may be busy.`,
      );
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

/** The bytes behind a `data:` URL, without paying a second fetch for them. */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const meta = comma < 0 ? "" : dataUrl.slice(5, comma);
  const payload = comma < 0 ? "" : dataUrl.slice(comma + 1);
  const mediaType = meta.split(";")[0] || "image/png";
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mediaType });
}
