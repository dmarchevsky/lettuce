import type { ModState } from "./model-caps.ts";

/**
 * Settings → Providers & models: the providers the operator added.
 *
 * Each is a named endpoint with a handle prefix of its own, registered by the BFF
 * (`bff/src/providers/registry.ts`). The name is the identity — `llama 3b`
 * becomes `llama-3b/<model>` — so two providers may share a type but never a
 * name. A key is write-only: it is sent on save and never read back, so an edit
 * that leaves the field blank keeps the stored one.
 */

export interface ProviderType {
  id: string;
  label: string;
  scope: "local" | "cloud";
  /** The pi-ai api the endpoint speaks; shown so a type is more than a name. */
  api: string;
  /** Prefilled base URL, still editable. */
  baseUrl: string;
  keyOptional: boolean;
}

export interface Provider {
  prefix: string;
  name: string;
  /** Catalog type id; empty for a provider declared model-by-model. */
  type: string;
  api: string;
  scope: "local" | "cloud";
  baseUrl: string;
  models: string[];
  hasKey: boolean;
}

export interface ProviderDraft {
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

async function ok(response: Response): Promise<Response> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response;
}

export async function fetchProviders(): Promise<{
  types: ProviderType[];
  providers: Provider[];
}> {
  const body = (await (await ok(await fetch("/api/providers"))).json()) as Partial<{
    types: ProviderType[];
    providers: Provider[];
  }>;
  return { types: body.types ?? [], providers: body.providers ?? [] };
}

export async function saveProvider(
  draft: ProviderDraft,
): Promise<{ provider: Provider; mod: ModState }> {
  const response = await ok(
    await fetch("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    }),
  );
  return (await response.json()) as { provider: Provider; mod: ModState };
}

export async function removeProvider(prefix: string): Promise<{ removed: boolean; mod: ModState }> {
  const response = await ok(
    await fetch(`/api/providers?prefix=${encodeURIComponent(prefix)}`, { method: "DELETE" }),
  );
  return (await response.json()) as { removed: boolean; mod: ModState };
}

/**
 * What an endpoint says it serves. The key goes in the body, never the URL, and
 * `prefix` lets the BFF use a stored key when the field was left blank.
 */
export async function probeModels(input: {
  api: string;
  baseUrl: string;
  apiKey: string;
  prefix?: string;
}): Promise<string[]> {
  const response = await ok(
    await fetch("/api/providers/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  const body = (await response.json()) as { models?: string[] };
  return body.models ?? [];
}
