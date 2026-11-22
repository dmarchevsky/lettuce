/**
 * Drawing an agent's face from a description — the Draw tab of the avatar sheet.
 *
 * The browser cannot call the image endpoint itself: the key lives on the BFF and
 * no payload here may carry it (the same rule every route in this folder obeys).
 * So this is the thin BFF half of "type a description, get a face": prefix the
 * fixed style line, keep the prompt inside the budget the servers cut at, choose
 * a size, and hand the picture back as a data URL. It does **not** resize, crop
 * or store anything — the browser runs the picture through the path an uploaded
 * file already runs, so there stays one crop implementation and one face library.
 *
 * Everything hard here is a fact about the endpoints, not a preference:
 *
 * - **The size ladder.** Which square a server serves is not discoverable from
 *   any documented field, and servers disagree completely — this proxy serves
 *   twenty named sizes and refuses anything else *by name*, OpenAI's current
 *   family serves only `1024x1024`/`1024x1536`/`1536x1024` plus `auto`, DALL·E 2
 *   serves 256/512/1024 squares, and stable-diffusion.cpp-style servers take
 *   almost anything. So the ask is a preference tried in order: `512x512` first
 *   because it is this proxy's own default and the cheapest square most servers
 *   agree on; `256x256` for the small-only servers; `1024x1024` for the new
 *   OpenAI family; and finally **no `size` at all**, which every server answers
 *   with its own default. The tail of the ladder is strictly more permissive than
 *   its head, which is what makes starting mid-ladder safe.
 * - **One rung per press.** The proxy runs a single image request at a time on
 *   the NPU behind the other models' work, so a press draws exactly one picture
 *   and never fans out.
 * - **The prompt budget.** This proxy writes the prompt into the model's chat
 *   template and cuts it at 512 tokens, so the *user's own words* are capped at
 *   400 characters and the style prefix is short — the part that gets cut must
 *   never be the description. (The `generate_image` tool's 2 000-char limit is a
 *   different, larger budget and does not apply here.)
 */

import { type DrawResult, drawImages, type ImageEndpoint, type ImageFetch } from "./client.ts";

/**
 * What every face is drawn as, and the sheet says so under the box rather than
 * hiding it as magic. Pixel art because a face renders at 34px in the rail and
 * chunky shapes are what survive there: the flat-vector alternative is the
 * prettier picture and the worse avatar — thin shapes and a pale background go
 * to mush inside a small disc.
 */
export const FACE_STYLE_PREFIX =
  "pixel art avatar, thick pixels, limited palette, centered on a plain background: ";

/**
 * And the background every face is asked for: one flat colour the browser can key out,
 * so the subject ends up on alpha and the agent's own colour shows through it (see
 * `web/src/lib/face-key.ts`). Magenta because it is the colour a drawn subject is least
 * likely to contain, and asking for a *transparent* background instead gets a drawn
 * checkerboard — a model has no alpha channel to draw with. Measured on the real
 * endpoint: the border comes back within a few points of one colour, which is keyable.
 */
export const FACE_BACKGROUND_SUFFIX = ", on a solid flat magenta background, no shadow";

/** See the header: this protects the user's own words from the server's cut. */
export const MAX_FACE_PROMPT_CHARS = 400;

/**
 * The rungs, cheapest square first (see the header). `null` is "omit `size`
 * entirely and let the server draw its own default", and it is last because it
 * is the only rung no server can refuse.
 */
const SIZE_LADDER: (string | null)[] = ["512x512", "256x256", "1024x1024", null];

export type FaceResult =
  | { ok: true; mediaType: string; size: string | null; b64: string }
  | { ok: false; error: string };

/**
 * What worked last, per `{baseUrl, model}` — so the steady state is one request
 * and the ladder costs at most one fast 400 after the operator swaps models.
 *
 * Deliberately **in-process only**: a persisted guess is one more stored setting
 * that can go stale (and stale silently), while re-learning after a restart is a
 * ~50 ms refusal. `null` is a real remembered answer: the server took the
 * omitted size.
 */
const rememberedSizes = new Map<string, string | null>();

function cacheKey(endpoint: ImageEndpoint): string {
  return `${endpoint.baseUrl}\u0000${endpoint.model ?? ""}`;
}

/**
 * The size memory as a seam: a test (or a future Settings affordance) can clear
 * or prime what a `{baseUrl, model}` starts at. `undefined` means "never drawn
 * with this endpoint since the BFF started".
 */
export const faceSizes = {
  remembered: (endpoint: ImageEndpoint): string | null | undefined =>
    rememberedSizes.get(cacheKey(endpoint)),
  remember: (endpoint: ImageEndpoint, size: string | null): void => {
    rememberedSizes.set(cacheKey(endpoint), size);
  },
  clear: (): void => {
    rememberedSizes.clear();
  },
};

/** The rung to start at: the remembered one if the ladder knows it, else the first. */
function ladderStart(endpoint: ImageEndpoint): number {
  const remembered = faceSizes.remembered(endpoint);
  const index = remembered === undefined ? -1 : SIZE_LADDER.indexOf(remembered);
  return index < 0 ? 0 : index;
}

/**
 * A refusal that is about the **size** and so worth answering with another size.
 *
 * Both shapes real servers use must land here: one names the field and the value it
 * could not take (`size: '333x333' is not served by flux2-klein-4b (sizes: auto,
 * 256x256, …)`), the other quotes only the value
 * (`Invalid value: '512x512'. Supported values are: 'auto', '1024x1024'`). So the
 * tells are: **the value we asked for appears in it**, or **it lists sizes of its
 * own** — which always read as `WxH`. Saying the word "size" is deliberately *not*
 * enough: a prompt-length refusal (`the size of your prompt exceeds the model's
 * context`) is the same answer at every size, and walking the ladder on it would
 * spend four real draws on the operator's hardware to repeat one sentence. Auth, a
 * bad model, a dead queue and a timeout stop for the same reason.
 */
export function sizeShapedRefusal(
  status: number | null,
  message: string,
  requested: string | null,
): boolean {
  if (status !== 400) return false;
  if (requested !== null && message.includes(requested)) return true;
  return SIZES_LISTED.test(message);
}

/** A server listing what it serves says it in `WxH` form. */
const SIZES_LISTED = /\d{2,4}x\d{2,4}/;

/**
 * Why a description cannot be drawn, or null when it can. The route answers this
 * as a 400 before a request is spent, so an over-long prompt is caught locally
 * instead of being cut by the server with no explanation.
 */
export function facePromptRefusal(input: unknown): string | null {
  if (typeof input !== "string" || !input.trim())
    return "Describe a face first — the box is empty.";
  if (input.trim().length > MAX_FACE_PROMPT_CHARS) {
    return `Keep the description to ${MAX_FACE_PROMPT_CHARS} characters or fewer — this one is ${input.trim().length}.`;
  }
  return null;
}

/** A server that echoes the bearer value it just refused must not leak it onward. */
function redact(message: string, apiKey: string | null): string {
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}

/**
 * What the face library will take: `agents/avatar-library.ts` reads its type from the
 * magic bytes and knows png, jpeg and webp. Catching it here rather than there is the
 * difference between a refusal before the wait and one after a paid draw.
 */
const FACE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * One face: the typed description with the style prefix, at the first size the
 * server will take. Never throws for anything the server did; the answer's
 * `error` is the server's own wording, key redacted, because the sheet shows it
 * verbatim and the server's words are the actionable ones.
 *
 * One draw per endpoint at a time, whoever asks: the servers behind this run a single
 * image request and queue the rest, so a second press would sit behind the first and
 * then draw the same nothing. Saying so immediately is kinder than a longer wait.
 */
export async function drawFace(
  endpoint: ImageEndpoint,
  input: unknown,
  options: { fetchImpl?: ImageFetch; signal?: AbortSignal } = {},
): Promise<FaceResult> {
  const refusal = facePromptRefusal(input);
  if (refusal) return { ok: false, error: refusal };
  if (!endpoint.baseUrl || !endpoint.model) {
    return {
      ok: false,
      error: "Set an endpoint URL and a model first — there is nothing to draw with yet.",
    };
  }
  const key = cacheKey(endpoint);
  if (drawsInFlight.has(key)) {
    return { ok: false, error: "one face at a time — the last one is still being drawn." };
  }
  drawsInFlight.add(key);
  try {
    return await drawAtFirstServedSize(endpoint, input, options);
  } finally {
    drawsInFlight.delete(key);
  }
}

/** The draws currently walking a ladder, keyed the same way the size memory is. */
const drawsInFlight = new Set<string>();

async function drawAtFirstServedSize(
  endpoint: ImageEndpoint,
  input: unknown,
  options: { fetchImpl?: ImageFetch; signal?: AbortSignal },
): Promise<FaceResult> {
  const prompt = `${FACE_STYLE_PREFIX}${String(input).trim()}${FACE_BACKGROUND_SUFFIX}`;

  let lastError = "the image server refused every size we know how to ask for.";
  for (const size of SIZE_LADDER.slice(ladderStart(endpoint))) {
    // The `null` rung means the *server's* default, so the operator's configured
    // default must not leak in through the client's own fallback.
    const target = size === null ? { ...endpoint, size: null } : endpoint;
    const result: DrawResult = await drawImages(
      target,
      { prompt, size: size ?? undefined },
      options,
    );
    if (result.ok) {
      faceSizes.remember(endpoint, size);
      const first = result.images[0];
      if (!first) return { ok: false, error: "the image server answered with no picture." };
      if (!FACE_MEDIA_TYPES.has(first.mediaType)) {
        return {
          ok: false,
          error: `the server drew a ${first.mediaType}, which cannot be a face — try again.`,
        };
      }
      return {
        ok: true,
        mediaType: first.mediaType,
        size: result.size ?? size,
        b64: first.b64,
      };
    }
    lastError = redact(result.error, endpoint.apiKey);
    if (!sizeShapedRefusal(result.status, result.error, size))
      return { ok: false, error: lastError };
  }
  // An exhausted ladder learned something too: every size we can name was refused, so
  // the next press starts at the one rung left — the server's own default — instead of
  // paying four draws all over again to find that out.
  faceSizes.remember(endpoint, null);
  return { ok: false, error: lastError };
}
