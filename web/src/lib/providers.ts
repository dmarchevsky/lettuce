/**
 * Handle arithmetic shared by the model picker and Settings → Providers & models.
 *
 * The one trick worth its salt here: separators must not matter, because the
 * provider a row reports and the handle it stamps are not spelled the same way.
 * llama.cpp reports `provider_names: ["llama-cpp", "lc-llama-cpp"]` (hyphen) but
 * stamps every handle `llama.cpp/…` (dot), because upstream's `handlePrefixes[0]`
 * is the dotted spelling. A literal comparison misses every model it serves —
 * which is how "Models served" once came up empty with everything filed elsewhere.
 */

/**
 * Fold a provider key to something comparable: lowercase, separators removed,
 * and the `lc-` BYOK alias marker stripped.
 *
 * llama.cpp -> llamacpp ; llama-cpp -> llamacpp ; lc-llama-cpp -> llamacpp
 */
export function normalizeProviderKey(value: string): string {
  const lower = value.toLowerCase();
  const withoutAlias = lower.startsWith("lc-") ? lower.slice(3) : lower;
  return withoutAlias.replace(/[.\-_]/g, "");
}

/** The provider segment of a handle, e.g. "llama.cpp/Gemma-4" -> "llama.cpp". */
export function handleProvider(handle: string): string {
  return handle.split("/")[0] ?? "";
}
