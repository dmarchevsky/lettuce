/**
 * Turn a workspace file the agent names in prose into a link.
 *
 * The agent writes filenames constantly — `EVAL.md`, `tailored/Dima.pdf`,
 * `scripts/monitor.py` — sometimes as prose, more often in backticks. This
 * remark plugin runs after `remark-gfm` and rewrites a path-shaped token into a
 * `link` node when, and only when, a resolver says it is a real file in the
 * current workspace. `Markdown.tsx`'s `a` component then opens it.
 *
 * Eligibility is the resolver's call, not this file's:
 *  - a RELATIVE token (`monitor.md`, `scripts/x.py`) links only if
 *    `options.resolve(token)` returns a path — see `use-file-links.ts`, which
 *    looks it up with `search_files`. No resolver (the Files tab's own preview)
 *    means relative tokens stay text.
 *  - an ABSOLUTE `/work/...` token links if it survives the `WORKSPACE_ROOT`
 *    clamp in `resolveWorkspacePath`; it is explicit, so it is not verified and
 *    the viewer reports a missing file honestly.
 *
 * The regex still narrows first, to keep `resolve` off obvious prose:
 *  - only tokens ending in a known extension (`LINKABLE_EXTENSIONS`) — a
 *    prefilter now, not the gate, so it is generous;
 *  - an explicit `[label](path)` the model already wrote gets its href resolved
 *    the same way, but never split or nested into; `linkReference` and fenced
 *    `code` are left alone entirely;
 *  - an `inlineCode` span links only when its WHOLE trimmed content is one such
 *    token — `git add EVAL.md` and `cat foo.md` are left as code;
 *  - a token butting up against a word char, `@`, `.` or `-` is mid-word /
 *    mid-email and skipped; bare URLs are already `link` nodes by now.
 *
 * No lookbehind in the regex on purpose: older Safari throws a SyntaxError
 * parsing one. The leading-boundary check is done in code instead.
 */
import { WORKSPACE_ROOT } from "./workspace.ts";

/**
 * Extensions worth a lookup — doc/text/image/archive types agents produce, plus
 * the code/config types they keep in a workspace. A PREFILTER, not the rule:
 * something here still only links if the resolver finds the file.
 */
export const LINKABLE_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "rtf",
  "md",
  "markdown",
  "txt",
  "text",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "html",
  "css",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "svg",
  "tif",
  "tiff",
  "heic",
  "zip",
  "gz",
  "tgz",
  "tar",
  "py",
  "ipynb",
  "js",
  "ts",
  "tsx",
  "jsx",
  "sh",
  "bash",
  "rb",
  "go",
  "rs",
  "sql",
]);

/** The mdast shape this plugin touches — structural, to avoid an mdast dep. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

type Resolver = (token: string) => string | null;

export interface FilePathOptions {
  /** The conversation's cwd (`/work/<agent-id>`), or `null` when unknown. */
  cwd: string | null;
  /** Resolve a relative token to an absolute path, or null to leave as text. */
  resolve?: Resolver;
}

/**
 * A path token: optional leading `/`, then any number of `./` or `../`, then
 * `dir/`-segments, then `name.ext`. `(?![\w/])` keeps a trailing `.` or `)`
 * out of the token. Group 1 is the token, group 2 the extension.
 */
const PATH_RE = /(\/?(?:\.\.?\/)*[\w.-]+(?:\/[\w.-]+)*\.([A-Za-z0-9]+))(?![\w/])/g;

/** A char that means the match started mid-word / mid-email, not at a boundary. */
const NOT_A_BOUNDARY = /[\w@.-]/;

/**
 * An href that already points somewhere real — a scheme (`https:`, `mailto:`,
 * …), an in-page anchor, or a protocol-relative URL — and so must never be
 * treated as a workspace path.
 */
function isExternalHref(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#") || url.startsWith("//");
}

/**
 * A markdown image's `src` as a workspace path, so a picture the agent names
 * renders instead of breaking.
 *
 * `generate_image` reports "Saved to generated/x.png" — relative to the agent's
 * own directory — and the model quotes what it was given, so `![dog](generated/x.png)`
 * is the shape prose arrives in. The SPA has no route under the workspace, so a
 * relative src went to the browser and came back a broken-image box. Anything
 * already real (a scheme, an anchor, a protocol-relative URL) is left exactly as
 * written, and so is a relative path with no workspace to resolve it against.
 */
export function markdownImageTarget(src: string, cwd: string | null): string {
  return isExternalHref(src) ? src : (resolveWorkspacePath(src, cwd) ?? src);
}

/** Resolve a token to an absolute path inside `/work/`, or `null` to leave as text. */
export function resolveWorkspacePath(token: string, cwd: string | null): string | null {
  let raw: string;
  if (token.startsWith("/")) {
    raw = token;
  } else {
    if (!cwd) return null;
    raw = `${cwd}/${token}`;
  }

  const parts: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }

  const normalized = `/${parts.join("/")}`;
  const prefix = `${WORKSPACE_ROOT}/`;
  if (!normalized.startsWith(prefix) || normalized.length <= prefix.length) return null;
  return normalized;
}

/**
 * An absolute `/work` token is clamped; anything else absolute (a stray
 * leading slash that was never a real `/work/...` path — there is no other
 * legitimate same-origin absolute route in this app) falls back to the same
 * lookup a relative token gets. A relative one is the resolver's call.
 */
function linkUrl(token: string, cwd: string | null, resolve: Resolver | undefined): string | null {
  if (token.startsWith("/")) {
    return resolveWorkspacePath(token, cwd) ?? (resolve ? resolve(token) : null);
  }
  return resolve ? resolve(token) : null;
}

/** If a code span's whole trimmed content is one linkable token, return it. */
export function wholeToken(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  PATH_RE.lastIndex = 0;
  const match = PATH_RE.exec(trimmed);
  if (!match) return null;
  const token = match[1] ?? "";
  const ext = (match[2] ?? "").toLowerCase();
  if (match.index !== 0 || token.length !== trimmed.length) return null;
  return LINKABLE_EXTENSIONS.has(ext) ? token : null;
}

/** Split one text value into text/link nodes, or `null` if nothing matched. */
function splitText(
  value: string,
  cwd: string | null,
  resolve: Resolver | undefined,
): MdNode[] | null {
  PATH_RE.lastIndex = 0;
  const nodes: MdNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null = PATH_RE.exec(value);
  while (match !== null) {
    const token = match[1] ?? "";
    const ext = (match[2] ?? "").toLowerCase();
    const before = match.index === 0 ? "" : value.charAt(match.index - 1);
    const url =
      !NOT_A_BOUNDARY.test(before) && LINKABLE_EXTENSIONS.has(ext)
        ? linkUrl(token, cwd, resolve)
        : null;
    if (url) {
      if (match.index > last) {
        nodes.push({ type: "text", value: value.slice(last, match.index) });
      }
      nodes.push({ type: "link", url, children: [{ type: "text", value: token }] });
      last = match.index + token.length;
    }
    match = PATH_RE.exec(value);
  }

  if (nodes.length === 0) return null;
  if (last < value.length) nodes.push({ type: "text", value: value.slice(last) });
  return nodes;
}

function transform(node: MdNode, cwd: string | null, resolve: Resolver | undefined): void {
  if (node.type === "link") {
    // The model wrote this link itself — never split or nest into it, but its
    // href gets the same resolution a bare token would, so `[label](path)`
    // isn't left dangling just because it already had link syntax. An href
    // that already points somewhere real is left alone.
    if (typeof node.url === "string" && !isExternalHref(node.url)) {
      const resolved = linkUrl(node.url, cwd, resolve);
      if (resolved) node.url = resolved;
    }
    return;
  }
  if (!node.children || node.type === "linkReference") return;

  const next: MdNode[] = [];
  let changed = false;
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const pieces = splitText(child.value, cwd, resolve);
      if (pieces) {
        next.push(...pieces);
        changed = true;
        continue;
      }
      next.push(child);
    } else if (child.type === "inlineCode" && typeof child.value === "string") {
      // Whole-span only: never split a code span mid-content.
      const token = wholeToken(child.value);
      const url = token ? linkUrl(token, cwd, resolve) : null;
      if (url) {
        next.push({ type: "link", url, children: [{ type: "inlineCode", value: child.value }] });
        changed = true;
      } else {
        next.push(child);
      }
    } else {
      transform(child, cwd, resolve);
      next.push(child);
    }
  }
  if (changed) node.children = next;
}

/**
 * Every path-shaped token in raw text worth a resolver lookup, for feeding
 * `useFileLinks.note()`. A superset of what renders as a link — a token
 * inside a fenced block or an explicit `[label](path)` href is included, and
 * simply never matched (or matched and then discarded) during the walk.
 *
 * A token already prefixed `/work/` is skipped: `resolveWorkspacePath` clamps
 * those directly, so a lookup would be wasted. Any other leading-slash token
 * IS collected — see `linkUrl`'s fallback for why.
 */
export function collectFileTokens(text: string): string[] {
  PATH_RE.lastIndex = 0;
  const out = new Set<string>();
  const clampedPrefix = `${WORKSPACE_ROOT}/`;
  let match: RegExpExecArray | null = PATH_RE.exec(text);
  while (match !== null) {
    const token = match[1] ?? "";
    const ext = (match[2] ?? "").toLowerCase();
    const before = match.index === 0 ? "" : text.charAt(match.index - 1);
    if (
      !token.startsWith(clampedPrefix) &&
      !NOT_A_BOUNDARY.test(before) &&
      LINKABLE_EXTENSIONS.has(ext)
    ) {
      out.add(token);
    }
    match = PATH_RE.exec(text);
  }
  return [...out];
}

/** remark plugin: `[remarkFilePaths, { cwd, resolve }]`. */
export function remarkFilePaths(options: FilePathOptions): (tree: unknown) => void {
  const cwd = options?.cwd ?? null;
  const resolve = options?.resolve;
  return (tree: unknown) => {
    transform(tree as MdNode, cwd, resolve);
  };
}
