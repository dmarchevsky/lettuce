/**
 * Settings → Image generation's status line: is it configured at all, and did
 * the app-server load the mod without errors. The endpoint itself is not probed
 * here — a models listing is unreliable to hang status on, and the *test draw*
 * (`routes.ts`) is the real reachability probe.
 */

import { MOD_DIAGNOSTICS_PATH, modErrorsIn } from "../internal-tools/mod-diagnostics.ts";
import { IMAGES_MOD_PATH } from "./mod.ts";
import { type ImagesSettings, imagesConfigured } from "./settings.ts";

export interface ImagesStatus {
  /** The stored switch (the `images` compose token gates the routes entirely). */
  enabled: boolean;
  /** Enabled *and* complete enough to draw with — i.e. the tool exists. */
  configured: boolean;
  baseUrl: string;
  model: string | null;
  size: string | null;
  hasKey: boolean;
  /** The mod's own load/run errors from the last diagnostics report, newest last. */
  modErrors: string[];
  modInstalled: boolean;
}

/** This mod's entries in letta-code's diagnostics report. Exported for tests. */
export function modErrorsFrom(diagnostics: string | null): string[] {
  return modErrorsIn(diagnostics, IMAGES_MOD_PATH).map((e) => `${e.phase}: ${e.message}`);
}

export async function imagesStatus(options: {
  settings: ImagesSettings;
  /** The app-server file channel: the mod lives there, not in the BFF. */
  read: (path: string) => Promise<string | null>;
}): Promise<ImagesStatus> {
  const { settings } = options;
  const [mod, diagnostics] = await Promise.all([
    options.read(IMAGES_MOD_PATH).catch(() => null),
    options.read(MOD_DIAGNOSTICS_PATH).catch(() => null),
  ]);
  return {
    enabled: settings.enabled,
    configured: imagesConfigured(settings),
    baseUrl: settings.baseUrl,
    model: settings.model,
    size: settings.size,
    hasKey: settings.apiKey !== null,
    modErrors: modErrorsFrom(diagnostics),
    modInstalled: mod !== null,
  };
}
