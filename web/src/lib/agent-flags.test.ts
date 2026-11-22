import { describe, expect, test } from "bun:test";
import {
  drawFace,
  fetchDrawCapability,
  MAX_FACE_PROMPT_CHARS,
  orderByPins,
} from "./agent-flags.ts";

const a = (id: string) => ({ id });

describe("orderByPins", () => {
  test("pinned first in pin order, the rest as listed", () => {
    const listed = [a("x"), a("y"), a("z"), a("w")];
    expect(orderByPins(listed, ["z", "x"]).map((agent) => agent.id)).toEqual(["z", "x", "y", "w"]);
  });

  test("a pin for an agent that no longer exists is ignored", () => {
    expect(orderByPins([a("x")], ["gone", "x"]).map((agent) => agent.id)).toEqual(["x"]);
  });

  test("nothing pinned keeps the list as it is", () => {
    const listed = [a("x"), a("y")];
    expect(orderByPins(listed, [])).toEqual(listed);
  });
});

/** The smallest thing `dataUrlToBlob` can decode, and the shape the route answers in. */
const PNG_B64 = "iVBORw0KGgo=";

function reply(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  } as unknown as Response;
}

describe("drawing a face from the browser", () => {
  test("the answer's picture comes back as bytes, and the request carries the description", async () => {
    const seen: { url: string; body?: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), body: init?.body as string | undefined });
      return reply(
        200,
        JSON.stringify({
          ok: true,
          mediaType: "image/png",
          size: "512x512",
          dataUrl: `data:image/png;base64,${PNG_B64}`,
        }),
      );
    }) as unknown as typeof fetch;

    const drawn = await drawFace("an owl in a scarf", { fetchImpl });
    expect(seen[0]?.url).toBe("/api/images/draw-face");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ prompt: "an owl in a scarf" });
    expect(drawn.size).toBe("512x512");
    expect(drawn.blob.type).toBe("image/png");
    expect(drawn.blob.size).toBe(8);
  });

  test("a 502 whose body is the server's sentence shows that sentence, not `HTTP 502`", async () => {
    const fetchImpl = (async () =>
      reply(
        502,
        JSON.stringify({ ok: false, error: "the image queue is full" }),
      )) as unknown as typeof fetch;
    await expect(drawFace("an owl", { fetchImpl })).rejects.toThrow("the image queue is full");
  });

  test("a body that is not JSON is shown as it came", async () => {
    const fetchImpl = (async () => reply(502, "Bad gateway")) as unknown as typeof fetch;
    await expect(drawFace("an owl", { fetchImpl })).rejects.toThrow("Bad gateway");
  });

  test("a refusal with nothing to say still says what failed", async () => {
    const fetchImpl = (async () =>
      reply(500, JSON.stringify({ ok: false }))) as unknown as typeof fetch;
    await expect(drawFace("an owl", { fetchImpl })).rejects.toThrow("HTTP 500");
  });
});

describe("whether a face can be drawn here", () => {
  test("a configured endpoint, with the ceiling and the style line to show", async () => {
    const fetchImpl = (async () =>
      reply(
        200,
        JSON.stringify({
          settings: { baseUrl: "http://192.0.2.10:8731/v1", model: "flux", timeoutMs: 60_000 },
          faceStylePrefix: "pixel art avatar: ",
        }),
      )) as unknown as typeof fetch;
    expect(await fetchDrawCapability(fetchImpl)).toEqual({
      drawable: true,
      timeoutMs: 60_000,
      prefix: "pixel art avatar: ",
    });
  });

  test("a half-configured endpoint is not drawable, and no timeout is invented", async () => {
    const fetchImpl = (async () =>
      reply(
        200,
        JSON.stringify({ settings: { baseUrl: "", model: null } }),
      )) as unknown as typeof fetch;
    const capability = await fetchDrawCapability(fetchImpl);
    expect(capability.drawable).toBe(false);
    expect(capability.timeoutMs).toBeGreaterThan(MAX_FACE_PROMPT_CHARS);
  });

  test("the token off (404), and a server that will not answer at all", async () => {
    expect((await fetchDrawCapability((async () => reply(404, "off")) as never)).drawable).toBe(
      false,
    );
    const broken = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect((await fetchDrawCapability(broken)).drawable).toBe(false);
  });
});
