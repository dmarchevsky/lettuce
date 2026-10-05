/**
 * The profile-gated integrations, as the BFF reports them from
 * COMPOSE_PROFILES (`/api/status`). `web` rides on the `search` token, the
 * rest match their token names; `codex` and `claude` are virtual tokens that
 * also decide what the app-server image installed.
 */
export interface FeatureFlags {
  web: boolean;
  google: boolean;
  codex: boolean;
  claude: boolean;
  /** Virtual token like codex/claude; the transport lives in the BFF itself. */
  pi: boolean;
}

export type FeatureName = keyof FeatureFlags;

/**
 * Whether a feature is on. Absent flags — an older BFF, or a status payload
 * without the field — mean everything is on, never everything off: hiding UI
 * the server actually supports is the worse failure.
 */
export function featureEnabled(features: FeatureFlags | undefined, name: FeatureName): boolean {
  return features ? features[name] : true;
}
