/**
 * The render claim a flow could only prove by reading source: a picture in a message renders as an `<img>`, and
 * the workspace path the agent named becomes a URL the browser can actually load. The pure test of
 * `markdownImageTarget` proves the path maths and nothing about the tree — the defect it stands guard against is
 * a picture reaching a renderer that returns a row which ignores it (disclosure, text, or nothing).
 */
import { expect, test } from "bun:test";
import { downloadUrl } from "../lib/download.ts";
import { mount } from "../test/harness.tsx";
import { Markdown } from "./Markdown.tsx";

test("a workspace picture renders as an img the browser can load", async () => {
  const handle = await mount(<Markdown text={"Here you go:\n\n![chart](/work/a1/chart.png)\n"} />);

  const img = handle.find("img");
  expect(img).not.toBeNull();
  expect(img?.getAttribute("alt")).toBe("chart");
  // Not the raw /work path the agent named: the SPA has no route there, so an unresolved src is a broken
  // image. The exact route is the contract — a src aimed at the wrong endpoint is as broken as the raw path,
  // and a substring check on the filename would let it through.
  expect(img?.getAttribute("src")).toBe(downloadUrl("/work/a1/chart.png", { inline: true }));
  handle.unmount();
});

test("a path relative to the agent's own directory is resolved before it renders", async () => {
  const handle = await mount(<Markdown text={"![shot](shot.png)"} cwd="/work/a1" />);
  expect(handle.find("img")?.getAttribute("src")).toBe(
    downloadUrl("/work/a1/shot.png", { inline: true }),
  );
  handle.unmount();
});

test("a plain paragraph still renders as text (the guard against a row that swallows content)", async () => {
  const handle = await mount(<Markdown text={"Just words."} />);
  expect(handle.text(".md")).toBe("Just words.");
  expect(handle.find("img")).toBeNull();
  handle.unmount();
});
