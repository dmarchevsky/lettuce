/**
 * The agents' native `generate_image` tool: a mod rendered by
 * `internal-tools/mod.ts` whose work happens in the BFF (`client.ts`), so the
 * endpoint, the model and the key stay Settings configuration and nothing
 * image-server-specific is baked into an image.
 *
 * Off or unconfigured renders a mod that registers nothing — the protocol has no
 * delete, so that is the switch, exactly as in `web-tools/mod.ts`.
 */

import { MODS_DIR, renderToolsMod } from "../internal-tools/mod.ts";
import type { ToolSpec } from "../internal-tools/types.ts";

export const IMAGES_MOD_PATH = `${MODS_DIR}/lettuce-images.mjs`;
/** v1: one `generate_image`, whose return carries image content. */
export const IMAGES_MOD_VERSION = 1;

const GENERATE_DESCRIPTION =
  "Draw an image from a text description and get the picture back, so you can look at what it made. " +
  "Describe the subject, style, framing and any text that should appear. " +
  "Sizes are up to the configured server, not to this tool: 512x512 and 1024x1024 are near-universal, " +
  "1024x768, 768x1024 and 1536x1024 are common on OpenAI-compatible servers; if one is refused the error " +
  "says what that server takes, so change `size` and try again. " +
  "You can see the result — look at it and refine the prompt instead of guessing whether it worked. " +
  "Each picture is also saved under `generated/` in your workspace, so it survives in Files and you can " +
  "link it from prose with a markdown image link.";

const GENERATE_PARAMETERS = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "What to draw, in as much detail as you can." },
    size: {
      type: "string",
      description:
        "WIDTHxHEIGHT, e.g. 1024x1024. Omit to use the configured default. The server decides what is valid.",
    },
    n: {
      type: "integer",
      minimum: 1,
      maximum: 4,
      description:
        "How many pictures to draw (default 1). Each one travels back into the conversation, so ask for more only when you want alternatives.",
    },
    seed: {
      type: "integer",
      minimum: 0,
      description:
        "Fix the randomiser to draw the same picture again. Only servers that support seeds honour it, and one that does not refuses the call and says so.",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
};

export const IMAGE_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "generate_image",
    description: GENERATE_DESCRIPTION,
    parameters: GENERATE_PARAMETERS,
    // Harmless output, like web_search: drawing a picture is not an action the
    // operator has to confirm, and a prompt on every draw would make the tool
    // unusable in a cron or a channel turn.
    approval: "auto",
  },
];

export function renderImagesMod(options: { enabled: boolean; port: number }): string {
  return renderToolsMod({
    title: `lettuce-images v${IMAGES_MOD_VERSION}`,
    tools: options.enabled ? IMAGE_TOOL_SPECS : [],
    port: options.port,
  });
}
