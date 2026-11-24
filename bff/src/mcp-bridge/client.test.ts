import { describe, expect, test } from "bun:test";
import { decodedBytes, MAX_IMAGES_PER_CALL, textOfResult } from "./client.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUg==";
const SVG = "PHN2Zy8+";

/** What a caller that can take pictures gets. */
function result(...content: unknown[]) {
  return textOfResult({ content }, { keepImages: true });
}

describe("textOfResult: text and the blocks it does not carry", () => {
  test("joins the text blocks", () => {
    expect(
      textOfResult({
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      }),
    ).toEqual({ text: "one\ntwo", isError: false });
  });

  test("names every block kind the bridge does not carry", () => {
    const flat = result(
      { type: "text", text: "hi" },
      { type: "audio", data: PNG, mimeType: "audio/wav" },
      { type: "resource", resource: {} },
      { type: "resource_link", uri: "file:///x" },
    );
    expect(flat.text).toBe(
      [
        "hi",
        "[audio content omitted]",
        "[resource content omitted]",
        "[resource_link content omitted]",
      ].join("\n"),
    );
    expect(flat.images).toBeUndefined();
  });

  test("names a picture for a caller that cannot take one", () => {
    // The curated Google tools answer in text, so for them nothing is silently
    // lost: a picture is named exactly as it was before the bridge carried any.
    const flat = textOfResult({ content: [{ type: "image", data: PNG, mimeType: "image/png" }] });
    expect(flat).toEqual({ text: "[image content omitted]", isError: false });
  });

  test("falls back to structured content only when nothing was said", () => {
    expect(textOfResult({ structuredContent: { a: 1 } }).text).toContain('"a": 1');
    expect(textOfResult({ content: [{ type: "text", text: "x" }] }).text).toBe("x");
  });

  test("keeps structured content even when the only words are a dropped picture", () => {
    const flat = textOfResult(
      {
        content: [{ type: "image", data: SVG, mimeType: "image/svg+xml" }],
        structuredContent: { a: 1 },
      },
      { keepImages: true },
    );
    expect(flat.text).toContain('"a": 1');
    expect(flat.text).toContain("image/svg+xml is not a picture");
  });

  test("survives a result that is not a result", () => {
    expect(textOfResult(undefined)).toEqual({ text: "", isError: false });
    expect(textOfResult("nonsense")).toEqual({ text: "", isError: false });
    expect(textOfResult({ isError: true, content: [{ type: "text", text: "boom" }] })).toEqual({
      text: "boom",
      isError: true,
    });
  });
});

describe("textOfResult: pictures", () => {
  test("carries a raster picture with its MIME type", () => {
    const flat = result(
      { type: "text", text: "the page" },
      { type: "image", data: PNG, mimeType: "Image/PNG" },
    );
    expect(flat.images).toEqual([{ base64: PNG, mimeType: "image/png" }]);
    // The picture travelled, so the text says nothing about omitting one.
    expect(flat.text).toBe("the page");
  });

  test("carries a picture even when the server said nothing", () => {
    const flat = result({ type: "image", data: PNG, mimeType: "image/png" });
    expect(flat.images).toHaveLength(1);
    expect(flat.text).toBe("");
  });

  test("reads a MIME type past its parameters", () => {
    const flat = result({ type: "image", data: PNG, mimeType: "image/png; charset=x" });
    expect(flat.images).toEqual([{ base64: PNG, mimeType: "image/png" }]);
  });

  test("names a MIME type the agent cannot be shown a picture of", () => {
    const flat = result({ type: "image", data: SVG, mimeType: "image/svg+xml" });
    expect(flat.images).toBeUndefined();
    expect(flat.text).toBe(
      "[image content omitted — image/svg+xml is not a picture the agent can see]",
    );
  });

  test("names a picture with no MIME type or no bytes", () => {
    expect(result({ type: "image", data: PNG }).text).toContain("no MIME type");
    expect(result({ type: "image", mimeType: "image/png" }).text).toContain("no picture data");
    expect(result({ type: "image", data: "   ", mimeType: "image/png" }).text).toContain(
      "no picture data",
    );
  });

  test("names a picture over the size cap and says how big it was", () => {
    const big = "A".repeat(8_000_000); // 6 MB decoded
    const flat = result({ type: "image", data: big, mimeType: "image/png" });
    expect(flat.images).toBeUndefined();
    expect(flat.text).toBe("[image content omitted — 5.7 MB is over the 5 MB limit]");
  });

  test("keeps the first few pictures and counts the rest into one line", () => {
    const many = Array.from({ length: MAX_IMAGES_PER_CALL + 2 }, () => ({
      type: "image",
      data: PNG,
      mimeType: "image/png",
    }));
    const flat = result(...many);
    expect(flat.images).toHaveLength(MAX_IMAGES_PER_CALL);
    expect(flat.text).toBe(
      `[image content omitted — one call carries at most ${MAX_IMAGES_PER_CALL} pictures (x2)]`,
    );
  });
});

describe("decodedBytes", () => {
  test("is the decoded length, not the string length", () => {
    expect(decodedBytes("")).toBe(0);
    expect(decodedBytes("QQ==")).toBe(1);
    expect(decodedBytes("QUJD")).toBe(3);
    expect(decodedBytes("QU\r\nJD")).toBe(3);
  });
});
