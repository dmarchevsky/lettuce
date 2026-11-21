import { describe, expect, test } from "bun:test";
import {
  collectFileTokens,
  LINKABLE_EXTENSIONS,
  markdownImageTarget,
  remarkFilePaths,
  resolveWorkspacePath,
  wholeToken,
} from "./file-links.ts";

const CWD = "/work/agent-abc";

/** Minimal mdast node, matching what the plugin walks. */
interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

const text = (value: string): Node => ({ type: "text", value });
const para = (...children: Node[]): Node => ({
  type: "root",
  children: [{ type: "paragraph", children }],
});

/**
 * A resolver that "finds" exactly the tokens listed, at `<cwd>/<token>`.
 * Absolute `/work` tokens never reach it — the plugin clamps those itself.
 */
const finds =
  (...existing: string[]) =>
  (token: string): string | null =>
    existing.includes(token) ? resolveWorkspacePath(token, CWD) : null;

/** Run the plugin and flatten the paragraph back to `[type:value|url, …]`. */
function run(tree: Node, resolve = finds(), cwd: string | null = CWD): string[] {
  remarkFilePaths({ cwd, resolve })(tree);
  const paragraph = tree.children?.[0];
  return (paragraph?.children ?? []).map((node) => {
    if (node.type === "link") {
      const inner = node.children?.[0];
      return `link:${node.url}:${inner?.value ?? ""}`;
    }
    return `text:${node.value ?? ""}`;
  });
}

describe("resolveWorkspacePath", () => {
  test("a relative path joins onto cwd", () => {
    expect(resolveWorkspacePath("tailored/x.pdf", CWD)).toBe("/work/agent-abc/tailored/x.pdf");
    expect(resolveWorkspacePath("./notes.md", CWD)).toBe("/work/agent-abc/notes.md");
  });

  test("an absolute /work path passes through, normalised", () => {
    expect(resolveWorkspacePath("/work/agent-abc/a//b.pdf", CWD)).toBe("/work/agent-abc/a/b.pdf");
  });

  test("no cwd means a relative path cannot resolve", () => {
    expect(resolveWorkspacePath("tailored/x.pdf", null)).toBeNull();
  });

  test("nothing outside /work resolves", () => {
    expect(resolveWorkspacePath("/etc/passwd", CWD)).toBeNull();
    expect(resolveWorkspacePath("/work", CWD)).toBeNull();
    expect(resolveWorkspacePath("/workshop/notes.md", CWD)).toBeNull();
  });

  test("a path that climbs out of /work is rejected", () => {
    expect(resolveWorkspacePath("../../etc/passwd.txt", CWD)).toBeNull();
    expect(resolveWorkspacePath("../../../root.md", CWD)).toBeNull();
  });
});

describe("markdownImageTarget", () => {
  test("the path `generate_image` reports renders as a picture", () => {
    // The tool says "Saved to generated/x.png" and the model quotes it, so this
    // is the shape prose arrives in — it used to be a broken-image box.
    expect(markdownImageTarget("generated/a-panda-1.png", CWD)).toBe(
      "/work/agent-abc/generated/a-panda-1.png",
    );
  });

  test("an absolute /work path passes through", () => {
    expect(markdownImageTarget("/work/agent-abc/generated/a-panda-1.png", CWD)).toBe(
      "/work/agent-abc/generated/a-panda-1.png",
    );
  });

  test("a src that names somewhere real is left as written", () => {
    expect(markdownImageTarget("https://example.com/a.png", CWD)).toBe("https://example.com/a.png");
    expect(markdownImageTarget("data:image/png;base64,AAA", CWD)).toBe("data:image/png;base64,AAA");
    expect(markdownImageTarget("//example.com/a.png", CWD)).toBe("//example.com/a.png");
  });

  test("with no workspace to resolve against, a relative src stays as written", () => {
    expect(markdownImageTarget("generated/a-panda-1.png", null)).toBe("generated/a-panda-1.png");
  });

  test("a src that climbs out of /work is not rewritten", () => {
    expect(markdownImageTarget("../../etc/passwd.png", CWD)).toBe("../../etc/passwd.png");
    expect(markdownImageTarget("/etc/passwd.png", CWD)).toBe("/etc/passwd.png");
  });
});

describe("remarkFilePaths", () => {
  test("links a bare workspace-relative path the resolver finds", () => {
    expect(
      run(
        para(text("waiting on your review of tailored/Dima_20260910-0454.pdf (lululemon)")),
        finds("tailored/Dima_20260910-0454.pdf"),
      ),
    ).toEqual([
      "text:waiting on your review of ",
      "link:/work/agent-abc/tailored/Dima_20260910-0454.pdf:tailored/Dima_20260910-0454.pdf",
      "text: (lululemon)",
    ]);
  });

  test("links a bare filename the resolver finds", () => {
    expect(run(para(text("see report.pdf for details")), finds("report.pdf"))).toEqual([
      "text:see ",
      "link:/work/agent-abc/report.pdf:report.pdf",
      "text: for details",
    ]);
  });

  test("a path-shaped token the resolver does not find stays text", () => {
    expect(run(para(text("see report.pdf for details")))).toEqual([
      "text:see report.pdf for details",
    ]);
  });

  test("trailing sentence punctuation stays out of the link", () => {
    expect(run(para(text("it is in output/summary.md.")), finds("output/summary.md"))).toEqual([
      "text:it is in ",
      "link:/work/agent-abc/output/summary.md:output/summary.md",
      "text:.",
    ]);
  });

  test("an inline code span that is exactly one found path becomes a link", () => {
    const tree = para({ type: "inlineCode", value: "EVAL.md" });
    remarkFilePaths({ cwd: CWD, resolve: finds("EVAL.md") })(tree);
    const link = tree.children?.[0]?.children?.[0];
    expect(link?.type).toBe("link");
    expect(link?.url).toBe("/work/agent-abc/EVAL.md");
    // Keeps its monospace rendering.
    expect(link?.children?.[0]).toEqual({ type: "inlineCode", value: "EVAL.md" });
  });

  test("a code span holding more than a bare path is left as code", () => {
    for (const value of ["git add EVAL.md", "cat foo.md", "npm run build"]) {
      const tree = para({ type: "inlineCode", value });
      remarkFilePaths({ cwd: CWD, resolve: finds("EVAL.md", "foo.md") })(tree);
      expect(tree.children?.[0]?.children?.[0]).toEqual({ type: "inlineCode", value });
    }
  });

  test("a code span whose path the resolver does not find is left as code", () => {
    const tree = para({ type: "inlineCode", value: "EVAL.md" });
    remarkFilePaths({ cwd: CWD, resolve: finds() })(tree);
    expect(tree.children?.[0]?.children?.[0]).toEqual({ type: "inlineCode", value: "EVAL.md" });
  });

  test("links a non-document extension when the resolver finds it", () => {
    expect(
      run(
        para(text("the scanner is scripts/monitor_linkedin.py now")),
        finds("scripts/monitor_linkedin.py"),
      ),
    ).toEqual([
      "text:the scanner is ",
      "link:/work/agent-abc/scripts/monitor_linkedin.py:scripts/monitor_linkedin.py",
      "text: now",
    ]);
  });

  test("leaves non-path slashes and dotted prose alone", () => {
    for (const prose of ["choose one and/or the other", "e.g. this or that", "ready. go now"]) {
      expect(run(para(text(prose)), finds())).toEqual([`text:${prose}`]);
    }
  });

  test("does not fire inside an email address", () => {
    expect(run(para(text("mail dima@host.com/report.pdf nobody")), finds("report.pdf"))).toEqual([
      "text:mail dima@host.com/report.pdf nobody",
    ]);
  });

  test("does not touch an already-parsed link node pointing at a real URL", () => {
    const tree: Node = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "link", url: "https://x.test/a.pdf", children: [text("a.pdf")] }],
        },
      ],
    };
    remarkFilePaths({ cwd: CWD, resolve: finds("a.pdf") })(tree);
    const link = tree.children?.[0]?.children?.[0];
    expect(link?.url).toBe("https://x.test/a.pdf");
    expect(link?.children?.[0]?.value).toBe("a.pdf");
  });

  test("leaves a mailto: or #anchor link node untouched", () => {
    for (const url of ["mailto:dima@host.com", "#section"]) {
      const tree: Node = {
        type: "root",
        children: [
          { type: "paragraph", children: [{ type: "link", url, children: [text("here")] }] },
        ],
      };
      remarkFilePaths({ cwd: CWD, resolve: finds() })(tree);
      expect(tree.children?.[0]?.children?.[0]?.url).toBe(url);
    }
  });

  test("resolves an explicit link's relative href, the same as a bare mention", () => {
    const tree: Node = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "link", url: "tailored/report.pdf", children: [text("Download")] }],
        },
      ],
    };
    remarkFilePaths({ cwd: CWD, resolve: finds("tailored/report.pdf") })(tree);
    const link = tree.children?.[0]?.children?.[0];
    expect(link?.url).toBe("/work/agent-abc/tailored/report.pdf");
    expect(link?.children?.[0]?.value).toBe("Download");
  });

  test("resolves an explicit link's non-/work absolute href via the search fallback", () => {
    const tree: Node = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "link", url: "/tailored/report.pdf", children: [text("Download")] }],
        },
      ],
    };
    // A real resolver (`useFileLinks`) returns the file's actual absolute
    // path regardless of what shape the original token was — `finds()`
    // above assumes a relative token, so this one is built by hand.
    const resolveTailored = (token: string): string | null =>
      token === "/tailored/report.pdf" ? "/work/agent-abc/tailored/report.pdf" : null;
    remarkFilePaths({ cwd: CWD, resolve: resolveTailored })(tree);
    const link = tree.children?.[0]?.children?.[0];
    expect(link?.url).toBe("/work/agent-abc/tailored/report.pdf");
  });

  test("leaves an explicit link's href alone when the resolver can't find it", () => {
    const tree: Node = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "link", url: "/tailored/missing.pdf", children: [text("Download")] }],
        },
      ],
    };
    remarkFilePaths({ cwd: CWD, resolve: finds() })(tree);
    expect(tree.children?.[0]?.children?.[0]?.url).toBe("/tailored/missing.pdf");
  });

  test("resolves an explicit link's already-/work absolute href via the clamp, no resolver needed", () => {
    const tree: Node = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "/work/agent-abc/out//final.pdf",
              children: [text("Download")],
            },
          ],
        },
      ],
    };
    remarkFilePaths({ cwd: CWD, resolve: finds() })(tree);
    expect(tree.children?.[0]?.children?.[0]?.url).toBe("/work/agent-abc/out/final.pdf");
  });

  test("does not touch fenced code", () => {
    const fenced: Node = {
      type: "root",
      children: [{ type: "code", value: "cat tailored/x.pdf" }],
    };
    remarkFilePaths({ cwd: CWD, resolve: finds("tailored/x.pdf") })(fenced);
    expect(fenced.children?.[0]).toEqual({ type: "code", value: "cat tailored/x.pdf" });
  });

  test("an absolute /work path in prose links without cwd or resolver", () => {
    expect(run(para(text("at /work/agent-abc/out/final.pdf now")), finds(), null)).toEqual([
      "text:at ",
      "link:/work/agent-abc/out/final.pdf:/work/agent-abc/out/final.pdf",
      "text: now",
    ]);
  });

  test("a coincidental /work-prefixed path outside the workspace stays text", () => {
    expect(run(para(text("not /workshop/plan.md really")), finds())).toEqual([
      "text:not /workshop/plan.md really",
    ]);
  });

  test("two found paths in one line both link", () => {
    expect(run(para(text("compare a/one.md and b/two.md")), finds("a/one.md", "b/two.md"))).toEqual(
      [
        "text:compare ",
        "link:/work/agent-abc/a/one.md:a/one.md",
        "text: and ",
        "link:/work/agent-abc/b/two.md:b/two.md",
      ],
    );
  });
});

describe("wholeToken", () => {
  test("accepts a bare path with a known extension", () => {
    expect(wholeToken("EVAL.md")).toBe("EVAL.md");
    expect(wholeToken("  references/monitor.md  ")).toBe("references/monitor.md");
  });

  test("rejects a span that is not exactly one token", () => {
    expect(wholeToken("git add EVAL.md")).toBeNull();
    expect(wholeToken("EVAL.md and LOG.md")).toBeNull();
    expect(wholeToken("plain words")).toBeNull();
  });
});

describe("collectFileTokens", () => {
  test("pulls every relative path-shaped token, deduped", () => {
    expect(collectFileTokens("compare EVAL.md with EVAL.md and scripts/x.py")).toEqual([
      "EVAL.md",
      "scripts/x.py",
    ]);
  });

  test("skips already-clamped /work tokens and email-embedded paths", () => {
    expect(collectFileTokens("see /work/a/b.pdf and dima@host.com/c.pdf")).toEqual([]);
  });

  test("still collects a leading-slash token that isn't under /work", () => {
    expect(collectFileTokens("see /tailored/report.pdf")).toEqual(["/tailored/report.pdf"]);
  });

  test("still returns a token that appears inside a fence", () => {
    // A superset of what renders — the lookup is wasted, never a wrong link.
    expect(collectFileTokens("```\ncat notes.md\n```")).toEqual(["notes.md"]);
  });
});

describe("LINKABLE_EXTENSIONS", () => {
  test("is non-empty, lower-case, and covers docs and code", () => {
    for (const ext of ["pdf", "docx", "md", "py", "ts", "sh"]) {
      expect(LINKABLE_EXTENSIONS.has(ext)).toBe(true);
    }
    for (const ext of LINKABLE_EXTENSIONS) expect(ext).toBe(ext.toLowerCase());
  });
});
