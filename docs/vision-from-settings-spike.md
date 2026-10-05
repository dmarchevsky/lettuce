# Spike: publishing capabilities under a connected endpoint's own provider id

Run 2026-10-02 against the local dev stack (letta-code 0.34.1, one connected
`openai-compatible` connection to Olla serving 7 models, plus the env-seeded
`halogen` mod provider). Scripts drove the running BFF's `/ws` as a browser
session; a hand-written mod was installed into `/root/.letta/mods` and loaded
with `execute_command reload`.

## The four questions the plan asked

1. **Shadowing a connected BYOK endpoint in place works.** A
   `letta.providers.register("openai-compatible", …)` mod replaced the
   auto-discovered provider for that id without changing any model handle: the
   7 `openai-compatible/…` handles were identical before and after, and
   `list_models` entries reflected the mod as truth (the declared model showed
   `updateArgs.context_window: 262144` / `max_output_tokens: 32768` where
   auto-discovery had clamped both to 128000 / 32000). Turns kept working, and
   an image attached to a turn **reached the endpoint** — the fresh-conversation
   test answered "Red" for a red pixel through the shadowed handle, where the
   same handle answered "no image reached me" without the shadow and the
   vision-declared `halogen/…` handle answered "Red".
   ⚠ A turn run in a conversation whose *earlier* turns had their image elided
   confuses the model ("(image omitted)" is in its history) — always evaluate
   vision per fresh conversation.
2. **Prefix/alias shape.** The connected connection serves plain
   `openai-compatible/…` handles; `byok_provider_aliases` statically maps every
   known BYOK alias to its base (`lc-openai-compatible → openai-compatible`,
   `llama-cpp → llama.cpp`, …) whether connected or not — so the alias map
   identifies the *family* of a handle prefix, but a second concurrent
   openai-compatible connection was not tested (the dev stack has one slot per
   provider name; `connect_provider` keyed on the same name *edits* rather than
   adds). The alias-based rule covers the `lc-` shape regardless.
3. **`execute_command reload` swaps a changed providers mod with no restart**,
   and the very next turn used the new capabilities. Same path the web-tools
   mods already use. (Once `execute_command` timed out >60 s right after a
   completed turn; a plain retry succeeded.)
4. **Id validation matches**: upstream's provider-name regex
   (`pi-provider-mod-validation.ts`) is `^[a-z0-9][a-z0-9._-]*$` — exactly the
   store's `PROVIDER_ID_RE`, so BYOK alias prefixes (hyphens, and dots for the
   `llama.cpp` spelling) pass.

## The finding the plan did not have: removing a shadow does not restore discovery

Deleting the shadowing mod file and reloading leaves the endpoint serving
**no models at all** — `available_handles` drops every `openai-compatible/…`
entry and a forced `list_models` does not bring them back, minutes later or
ever. Re-issuing `connect_provider` for that provider (same `baseUrl`,
`models_may_have_changed: true`) restores auto-discovery after a few seconds.
So upstream hands a shadowed id back only when something re-triggers endpoint
discovery.

Consequences for the design:

- **Once a prefix is shadowed, keep shadowing it.** Dropping the last
  capability from the store must re-render the mirror (models text-only at
  their discovered windows), not render nothing — removing the registration is
  what loses the models. The render set is therefore *declared prefixes ∪
  prefixes already registered by the current mod file*, minus prefixes whose
  connection is gone (then nothing is served under them anyway). A
  never-shadowed prefix is never shadowed unless it declares something.
- The fallback repair (re-issue `connect_provider`) is **destructive for a
  keyed connection**: `resolveProviderConnectionFields` resolves the omitted
  `apiKey` to "" and `createOrUpdateProvider` overwrites the record, so a key
  the BFF does not hold would be cleared. It also *validates* against the
  endpoint. Do not use it as a routine path; rely on keep-shadowing.
- The mirror keeps a prefix's auto-discovered windows exactly by copying each
  served model's `updateArgs.context_window` / `max_output_tokens` from the
  BFF's model snapshot — undeclared models get precisely what auto-discovery
  gave them; only declared models deviate.
