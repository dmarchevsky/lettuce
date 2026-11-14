import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { downloadUrl } from "../lib/download.ts";
import { remarkFilePaths } from "../lib/file-links.ts";
import { settledPrefixLength } from "../lib/markdown-stream.ts";
import { WORKSPACE_ROOT } from "../lib/workspace.ts";

/**
 * A link to a file the agent produced (always an absolute
 * /work/<agent-id>/... path — that's the only path form the file protocol
 * and cwd ever give it, and the one `remarkFilePaths` resolves bare paths to)
 * is rewritten to the BFF's download route: the SPA has no route at that path,
 * so left alone the click just landed on a blank tab. `inline` so a PDF or
 * image opens in the tab to be read rather than downloading. Every other href
 * passes through untouched.
 */
export function resolveMarkdownHref(href: string | undefined): string | undefined {
  if (typeof href === "string" && href.startsWith(`${WORKSPACE_ROOT}/`)) {
    return downloadUrl(href, { inline: true });
  }
  return href;
}

/**
 * Where a workspace file link should open. PDFs go to a browser tab — its
 * built-in viewer is the right tool and the BFF serves them `inline`. Anything
 * else (markdown, text, images, and the many types the BFF will only ever hand
 * over as an attachment) opens in the app's own `FileViewer`, when the caller
 * wired one up.
 */
export function fileLinkTarget(path: string): "browser" | "viewer" {
  return /\.pdf$/i.test(path) ? "browser" : "viewer";
}

interface MarkdownProps {
  text: string;
  cwd?: string | null;
  /** Relative-token → absolute path, from `useFileLinks`. */
  resolve?: (token: string) => string | null;
  /** Open a workspace file in the app instead of the browser. */
  onOpenFile?: (path: string) => void;
  /**
   * The text is still arriving. Everything above the last finished block is
   * then parsed once and kept, and only the part still changing is parsed per
   * frame — see `settledPrefixLength`.
   */
  streaming?: boolean;
}

export function Markdown({ text, streaming = false, ...rest }: MarkdownProps) {
  const cut = streaming ? settledPrefixLength(text) : 0;
  return (
    <div className="md">
      {cut > 0 ? <MarkdownBlocks text={text.slice(0, cut)} {...rest} /> : null}
      <MarkdownBlocks text={cut > 0 ? text.slice(cut) : text} {...rest} />
    </div>
  );
}

/**
 * One run of markdown as elements, with no wrapper of its own — so two runs in
 * one `.md` are siblings in the same flow, exactly as one parse would leave
 * them. Memoised: the settled half of a streaming message gets the same string
 * every frame until the cut moves.
 */
const MarkdownBlocks = memo(function MarkdownBlocks({
  text,
  cwd,
  resolve,
  onOpenFile,
}: Omit<MarkdownProps, "streaming">) {
  /**
   * Model output is markdown, so render it as such.
   *
   * Deliberately no `rehype-raw`: react-markdown builds React elements and
   * ignores raw HTML by default, so nothing the model (or a tool result quoted
   * back by it) emits can inject markup. No `dangerouslySetInnerHTML` anywhere,
   * so no sanitiser is needed.
   */
  const components = useMemo<Components>(
    () => ({
      // Links leave the app, so they open in a new tab and cannot leak the
      // referrer or hand the opened page a handle on this window. A workspace
      // file link keeps that href (middle-click, copy-link still work) but a
      // plain left click opens it in-app when `onOpenFile` is wired.
      a: ({ children, href, ...props }) => {
        const workspacePath =
          typeof href === "string" && href.startsWith(`${WORKSPACE_ROOT}/`) ? href : null;
        const openInApp =
          workspacePath && onOpenFile && fileLinkTarget(workspacePath) === "viewer"
            ? workspacePath
            : null;
        return (
          <a
            {...props}
            href={resolveMarkdownHref(href)}
            target="_blank"
            rel="noreferrer noopener"
            onClick={
              openInApp
                ? (event) => {
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    ) {
                      return;
                    }
                    event.preventDefault();
                    onOpenFile?.(openInApp);
                  }
                : undefined
            }
          >
            {children}
          </a>
        );
      },
      // Wide content scrolls inside the bubble instead of widening the page.
      pre: ({ children, ...props }) => (
        <pre {...props} className="md-pre">
          {children}
        </pre>
      ),
      table: ({ children, ...props }) => (
        <div className="md-table-wrap">
          <table {...props}>{children}</table>
        </div>
      ),
    }),
    [onOpenFile],
  );

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [remarkFilePaths, { cwd: cwd ?? null, resolve }]]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
});
