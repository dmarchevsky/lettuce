/**
 * The `generate_image` tool's handler, plus the store its settings live in.
 *
 * Everything here is BFF-local: the endpoint and its key are read from
 * `bff-data` (0600 — agent shells must not read a key they could use), the draw
 * is the BFF's own fetch to whatever OpenAI-compatible endpoint the operator
 * configured, and the pictures come back in the tool answer so the mod can both
 * save them into the agent's workspace and show them to the model
 * (`internal-tools/mod.ts`, `ToolAnswer.images`).
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolAnswer, ToolCallContext } from "../internal-tools/types.ts";
import { type DrawedImage, drawImages, endpointFromSettings, type ImageFetch } from "./client.ts";
import {
  applyImagesSettingsUpdate,
  type ImagesSettings,
  imagesConfigured,
  parseStoredImagesSettings,
  renderStoredImagesSettings,
} from "./settings.ts";

/** The settings file is written 0600: it holds an API key. */
export class ImagesSettingsStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly onWriteError: (error: unknown) => void = () => {},
  ) {}

  async load(): Promise<ImagesSettings> {
    let text: string | null = null;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      text = null;
    }
    return parseStoredImagesSettings(text);
  }

  /** Save a browser update, then hand back what is now stored. Throws on a bad body. */
  async save(body: unknown): Promise<ImagesSettings> {
    // The whole read-modify-write rides the queue, not just the write: two tabs
    // saving at once must not merge against a stale base (one restoring a key
    // the other just cleared is the visible form of that).
    const run = this.queue.then(async () => {
      const next = applyImagesSettingsUpdate(await this.load(), body);
      await this.write(renderStoredImagesSettings(next));
      return next;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async write(snapshot: string): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      // 0600 because this file holds a credential the agents must not have.
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, this.file);
    } catch (error) {
      this.onWriteError(error);
      throw error;
    }
  }

  drain(): Promise<void> {
    return this.queue.then(() => undefined);
  }
}

/** What the handler may borrow from `index.ts`. */
export interface ImagesDeps {
  /** Fresh settings every call, so a Settings save takes effect without a reload. */
  settings: () => Promise<ImagesSettings>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: ImageFetch;
}

/** The pictures live here, relative to whatever workspace the turn runs in. */
const SAVE_DIR = "generated";
const MAX_PROMPT_CHARS = 2_000;
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** `A red fox, on snow` → `a-red-fox-on-snow`; never empty, never longer than 48. */
export function slugifyPrompt(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "image";
}

function invalid(why: string): ToolAnswer {
  return { text: `generate_image: ${why}`, isError: true };
}

/** Validate the tool arguments, or return the refusal the model should read. */
function readArgs(
  args: Record<string, unknown>,
):
  | { ok: true; prompt: string; size?: string; n?: number; seed?: number }
  | { ok: false; answer: ToolAnswer } {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) return { ok: false, answer: invalid("`prompt` is required.") };
  if (prompt.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      answer: invalid(`\`prompt\` must be at most ${MAX_PROMPT_CHARS} characters.`),
    };
  }
  const out: { ok: true; prompt: string; size?: string; n?: number; seed?: number } = {
    ok: true,
    prompt,
  };
  if (args.size !== undefined && args.size !== null) {
    const size = typeof args.size === "string" ? args.size.trim() : "";
    if (!/^\d{2,5}x\d{2,5}$/.test(size)) {
      return { ok: false, answer: invalid("`size` must be WIDTHxHEIGHT, like 1024x1024.") };
    }
    out.size = size;
  }
  if (args.n !== undefined && args.n !== null) {
    const n = Number(args.n);
    if (!Number.isInteger(n) || n < 1 || n > 4) {
      return { ok: false, answer: invalid("`n` must be an integer from 1 to 4.") };
    }
    out.n = n;
  }
  if (args.seed !== undefined && args.seed !== null) {
    const seed = Number(args.seed);
    if (!Number.isInteger(seed) || seed < 0) {
      return { ok: false, answer: invalid("`seed` must be a non-negative integer.") };
    }
    out.seed = seed;
  }
  return out;
}

function describe(drawn: DrawedImage[], size: string | null, seed: number | undefined): string {
  const count = `${drawn.length} picture${drawn.length === 1 ? "" : "s"}`;
  const bits = [`Drew ${count}`];
  if (size) bits.push(`at ${size}`);
  if (seed !== undefined) bits.push(`with seed ${seed}`);
  return bits.join(" ");
}

/**
 * The tool: validate, draw, and hand back pictures plus a text line naming the
 * size, the seed when one was used, and where each file was saved.
 *
 * The answer carries `images` (b64 + workspace-relative path) rather than the
 * bytes inline: the mod runs inside the agent's workspace and is the only one
 * who can write there, and it also turns them into image content for letta-code.
 */
export async function generateImageTool(
  args: Record<string, unknown>,
  deps: ImagesDeps,
  context?: ToolCallContext,
): Promise<ToolAnswer> {
  const parsed = readArgs(args);
  if (!parsed.ok) return parsed.answer;

  const settings = await deps.settings();
  if (!imagesConfigured(settings)) {
    return invalid(
      "image generation is not configured — the operator has to set an endpoint and a model in Settings → Image generation.",
    );
  }
  const size = parsed.size ?? settings.size ?? null;
  const result = await drawImages(
    endpointFromSettings(settings),
    { prompt: parsed.prompt, size: size ?? undefined, n: parsed.n, seed: parsed.seed },
    { fetchImpl: deps.fetchImpl, signal: context?.signal },
  );
  if (!result.ok) {
    // The server's own words, because the agent's next move (drop `n`, change
    // the size) depends on them — but a server or proxy that echoes the bearer
    // value it just refused must not smuggle our key into the persisted tool
    // return, where the agents can read it back out of the conversation.
    const error = settings.apiKey
      ? result.error.split(settings.apiKey).join("[redacted]")
      : result.error;
    return { text: `generate_image failed: ${error}`, isError: true };
  }

  const slug = slugifyPrompt(parsed.prompt);
  const images = result.images.map((image, index) => ({
    b64: image.b64,
    path: `${SAVE_DIR}/${slug}-${index + 1}.${IMAGE_EXTENSIONS[image.mediaType] ?? "png"}`,
  }));
  const text = [
    `${describe(result.images, size, parsed.seed)}.`,
    `Saved to ${images.map((image) => image.path).join(", ")}.`,
    // Facts only. Telling the model to look at the pictures it can see, or that
    // they are saved where Files can reach them, is the tool description's job
    // (`mod.ts`); here the same sentence is what a person reads in the transcript.
  ].join(" ");
  return { text, isError: false, images };
}
