/**
 * Rendering a letta-code mod that registers native tools which call the BFF.
 *
 * A mod is upstream's supported way to add client tools: a file in the
 * app-server's global mods directory (`~/.letta/mods`, letta-code
 * `src/mods/mod-sources.ts`) whose default export calls
 * `letta.tools.register(...)`. Listener turns get those tools whatever the
 * toolset preference — chats, crons and channel turns alike
 * (`tools/manager.ts` `capturePreparedToolExecutionContext`). Subagents do not
 * (they run a providers-only capability profile).
 *
 * Every mod we render is the same thin shape: each tool POSTs its arguments to
 * `http://127.0.0.1:<port>/internal/tools/<name>` (loopback only, see
 * `http.ts`) and returns what the BFF answers. The work, and every change to
 * it, lives in the BFF; a mod needs a `reload` to change (`install.ts`), and
 * cannot import npm packages, so it holds as little as possible.
 */

import type { ToolSpec } from "./types.ts";

export const MODS_DIR = "/root/.letta/mods";

/** Header carrying the calling agent's id on every call (`ctx.agent.id`). */
export const AGENT_ID_HEADER = "x-letta-agent-id";
/** Header carrying the calling conversation's id (`ctx.sessionId` — upstream
 * stamps the conversation as the mod context's session, AppCoordinator.tsx). */
export const CONVERSATION_ID_HEADER = "x-letta-conversation-id";

export function renderToolsMod(options: {
  /** First comment line — identifies the mod and its render version. */
  title: string;
  tools: readonly ToolSpec[];
  port: number;
  /**
   * Agent id → tool names hidden from that agent's turns (`isEnabled`, see
   * `agents/tool-access.ts`). Omitted or empty: every agent sees every tool.
   */
  hidden?: Readonly<Record<string, readonly string[]>>;
}): string {
  const header = `// ${options.title} — rendered by the lettuce BFF (bff/src/internal-tools/mod.ts).
// Edits here are overwritten on the BFF's next connect.`;
  if (options.tools.length === 0) {
    // The protocol cannot delete a file, so "no tools" is a mod that registers nothing.
    return `${header}
// No tools right now: registers nothing.
export default function activate() {}
`;
  }
  const endpoint = `http://127.0.0.1:${options.port}/internal/tools`;
  const hidden = Object.fromEntries(
    Object.entries(options.hidden ?? {})
      .filter(([, names]) => names.length > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return `${header}
const ENDPOINT = ${JSON.stringify(endpoint)};
const TOOLS = ${JSON.stringify(options.tools, null, 2)};
// Agent id -> tool names that agent does not get (Agent -> Tools).
const HIDDEN = ${JSON.stringify(hidden)};

function enabledFor(tool, ctx) {
  const agentId = ctx?.agent?.id;
  return !(agentId && HIDDEN[agentId]?.includes(tool));
}

async function callBff(tool, ctx) {
  const headers = { "content-type": "application/json" };
  if (ctx.agent?.id) headers[${JSON.stringify(AGENT_ID_HEADER)}] = ctx.agent.id;
  if (ctx.sessionId) headers[${JSON.stringify(CONVERSATION_ID_HEADER)}] = ctx.sessionId;
  let response;
  try {
    response = await fetch(ENDPOINT + "/" + tool, {
      method: "POST",
      headers,
      body: JSON.stringify(ctx.args ?? {}),
      signal: ctx.signal,
    });
  } catch (error) {
    return { status: "error", content: "The " + tool + " tool is unreachable right now (" + (error?.message ?? error) + "). Try again shortly." };
  }
  const body = await response.json().catch(() => null);
  if (!body || typeof body.text !== "string") {
    return { status: "error", content: "The " + tool + " tool answered HTTP " + response.status + " with no result." };
  }
  if (body.isError) return { status: "error", content: body.text };
  if (Array.isArray(body.images) && body.images.length > 0 && ctx.cwd) {
    try {
      return await savePictures(body, ctx);
    } catch (error) {
      return body.text + "\\n(save failed: " + (error?.message ?? error) + ")";
    }
  }
  // pi_fetch {save}: the BFF has no path into /work — the mod runs there, so
  // the bytes travel as base64 and land in this agent's own workspace.
  if (body.content_b64 && typeof body.save_path === "string" && ctx.cwd) {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const root = path.resolve(ctx.cwd);
      const dest = path.resolve(root, body.save_path);
      if (dest === root || !dest.startsWith(root + path.sep)) {
        return body.text + "\\n(save refused: the destination left the workspace)";
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(body.content_b64, "base64"));
      return body.text + "\\nSaved to " + dest;
    } catch (error) {
      return body.text + "\\n(save failed: " + (error?.message ?? error) + ")";
    }
  }
  return body.text;
}

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

function mediaTypeOf(file) {
  const ext = String(file).split(".").pop().toLowerCase();
  return IMAGE_TYPES[ext] || "image/png";
}

// generate_image: the BFF has no path into /work, so the pictures travel as
// base64 and land in this agent's own workspace — and they ALSO go back to
// letta-code as image content, which is what lets the model look at its own
// drawing. A mod return may be a content array (mods/types ModToolRunResult);
// upstream forwards those parts to Letta as real image message parts.
async function savePictures(body, ctx) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(ctx.cwd);
  const saved = [];
  const notes = [];
  for (const image of body.images) {
    if (!image || typeof image.path !== "string" || typeof image.b64 !== "string") continue;
    const dest = path.resolve(root, image.path);
    if (dest === root || !dest.startsWith(root + path.sep)) {
      notes.push("(save refused: the destination left the workspace)");
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(image.b64, "base64"));
    saved.push({ dest: dest, b64: image.b64 });
  }
  const text = notes.length ? body.text + "\\n" + notes.join("\\n") : body.text;
  if (saved.length === 0) return text;
  const parts = [{ type: "text", text: text }];
  for (const one of saved) {
    parts.push({ type: "image", source: { type: "base64", media_type: mediaTypeOf(one.dest), data: one.b64 } });
  }
  return parts;
}

export default function activate(letta) {
  if (!letta.capabilities?.tools) return;
  const disposers = TOOLS.map((tool) =>
    letta.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // "ask" follows the permission mode; "auto" never prompts.
      requiresApproval: tool.approval === "ask",
      ...(tool.approval === "ask" ? { approvalPolicy: "ask" } : {}),
      parallelSafe: tool.approval !== "ask",
      isEnabled: (ctx) => enabledFor(tool.name, ctx),
      run: (ctx) => callBff(tool.name, ctx),
    }),
  );
  return () => {
    for (const dispose of disposers) if (typeof dispose === "function") dispose();
  };
}
`;
}
