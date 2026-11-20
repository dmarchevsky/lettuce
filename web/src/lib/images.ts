/**
 * Settings → Image generation: the OpenAI-compatible endpoint every agent's
 * `generate_image` tool draws through (`bff/src/images/`). The settings live on
 * the BFF's own volume and the API key never comes back — `hasKey` says whether
 * one is stored, and saving a blank keeps it (the provider-store rule).
 */

/** What a browser may see of the stored settings: no key, only `hasKey`. */
export interface ImagesSettings {
  enabled: boolean;
  baseUrl: string;
  hasKey: boolean;
  model: string | null;
  size: string | null;
  timeoutMs: number;
}

export interface ImagesSettingsUpdate {
  enabled?: boolean;
  baseUrl?: string;
  model?: string | null;
  size?: string | null;
  /** A non-empty string replaces the key; `clearApiKey` removes it. */
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface ImagesStatus {
  enabled: boolean;
  /** Enabled *and* complete enough to draw with — i.e. the tool exists. */
  configured: boolean;
  baseUrl: string;
  model: string | null;
  size: string | null;
  hasKey: boolean;
  modErrors: string[];
  modInstalled: boolean;
}

/** A successful test draw: the picture inline, plus what it cost in seconds. */
export interface ImagesTestResult {
  ok: boolean;
  mediaType?: string;
  size?: string | null;
  dataUrl?: string;
  error?: string;
  /** Measured in the browser — the BFF keeps no history of test draws. */
  durationSeconds?: number;
}

async function ok(response: Response): Promise<Response> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response;
}

export async function fetchImagesSettings(): Promise<ImagesSettings> {
  const response = await ok(await fetch("/api/images/settings"));
  const body = (await response.json()) as {
    settings: ImagesSettings;
  };
  return body.settings;
}

/** The save also (re)installs the mod, so a "pending" answer means: no agent yet. */
export async function saveImagesSettings(
  update: ImagesSettingsUpdate,
): Promise<{ settings: ImagesSettings; pending: boolean }> {
  const response = await ok(
    await fetch("/api/images/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    }),
  );
  const body = (await response.json()) as { settings: ImagesSettings; mod: string };
  return { settings: body.settings, pending: body.mod === "reload-pending" };
}

export async function fetchImagesStatus(): Promise<ImagesStatus> {
  const response = await ok(await fetch("/api/images/status"));
  return (await response.json()) as ImagesStatus;
}

/**
 * One draw at the configured default size, inline. A blank prompt asks for the
 * BFF's fixed test picture, so the box can be pressed without typing.
 */
export async function testImageDraw(prompt: string): Promise<ImagesTestResult> {
  const started = Date.now();
  const response = await fetch("/api/images/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  // A refused draw is an answer too — the server's own words are the point of
  // the probe — so only a reply with no JSON body at all throws.
  const body: unknown = await response.json().catch(() => null);
  const parsed = parseTestReply(body);
  if (parsed) return { ...parsed, durationSeconds: elapsed(started) };
  throw new Error(
    (typeof body === "string" ? body : "") ||
      (response.ok ? "" : response.statusText) ||
      `HTTP ${response.status}`,
  );
}

/** The test reply's discriminant is `ok`; anything else is not a test answer. */
function parseTestReply(body: unknown): ImagesTestResult | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.ok !== "boolean") return null;
  return {
    ok: record.ok,
    mediaType: typeof record.mediaType === "string" ? record.mediaType : undefined,
    size: typeof record.size === "string" ? record.size : null,
    dataUrl: typeof record.dataUrl === "string" ? record.dataUrl : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

function elapsed(since: number): number {
  return Math.max(0.1, Math.round((Date.now() - since) / 100) / 10);
}

/**
 * The one status line: whether the tool exists for the agents, and — only once
 * a test draw has been run in this page — how long the endpoint took.
 */
export function describeImagesStatus(
  status: ImagesStatus,
  test?: ImagesTestResult | null,
): string | null {
  // "Usable" minus the switch: enough to draw with, so the wording says what
  // the toggle is holding back rather than claiming nothing is set.
  const endpoint = status.baseUrl !== "" && status.model !== null;
  if (!endpoint) return "Not configured yet — an endpoint URL and a model are both required.";
  if (test && !test.ok) return `Last test draw failed: ${test.error ?? "the server refused."}`;
  const ready = test?.ok ? ` — last test draw took ${test.durationSeconds ?? 0} s` : "";
  return status.enabled
    ? `Configured & ready${ready}.`
    : "Configured but switched off — the agents have no generate_image yet.";
}
