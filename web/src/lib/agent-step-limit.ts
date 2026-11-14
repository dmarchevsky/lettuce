/**
 * One agent's step limit: the most model calls a turn may make, or null for
 * none. Kept and enforced by the BFF (`bff/src/agents/step-limit.ts`,
 * `bff/src/session/step-limit-watchdog.ts`).
 */

function url(agentId: string): string {
  return `/api/agents/step-limit/${encodeURIComponent(agentId)}`;
}

async function readLimit(response: Response): Promise<number | null> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  const { limit } = (await response.json()) as { limit?: unknown };
  return typeof limit === "number" ? limit : null;
}

export async function fetchAgentStepLimit(agentId: string): Promise<number | null> {
  return readLimit(await fetch(url(agentId)));
}

export async function saveAgentStepLimit(
  agentId: string,
  limit: number | null,
): Promise<number | null> {
  return readLimit(
    await fetch(url(agentId), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit }),
    }),
  );
}

/**
 * The field's text as a limit: "" is no limit, a positive whole number is that
 * limit, and anything else is undefined — not a value Save may send.
 */
export function parseStepLimitInput(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
