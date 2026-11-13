/**
 * The pure half of the Files-tab git history: how a read-only git command is
 * built, and how its stdout is parsed. No spawning here — `service.ts` runs
 * these argvs; everything in this file is unit-testable without git.
 *
 * Two decisions that shape the formats:
 *
 * - Records are delimited with ASCII control characters (`%x1f` between
 *   fields, `%x1e` between records) because commit subjects and bodies are
 *   arbitrary text — newlines, colons, `---` lines — and no printable
 *   separator survives that.
 * - The log requests `limit + 1` commits so the caller learns `hasMore`
 *   without a second call, and the commit detail passes `--raw --numstat`
 *   together: git emits one `--raw` line and one `--numstat` line per file,
 *   in the same order, so status letters (which numstat does not carry) are
 *   zipped onto stats by index.
 */

/** Git binary invoked for every command; the BFF image installs it (bff.Dockerfile). */
export const GIT_BINARY = "git";

/** Requested page sizes: `limit` is clamped to 1..MAX_LIMIT, default DEFAULT_LIMIT. */
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

/** Commit messages are capped at 8 KB and the response says so. */
export const MAX_MESSAGE_BYTES = 8192;

/** Cap on the changed-files list of one commit; `fileCount` counts before the cap. */
export const MAX_FILES = 200;

// ── failures ─────────────────────────────────────────────────────────────────

/** Why a git call did not produce output. Routes map each kind to a status. */
export type GitFailureKind =
  | "not-a-repository"
  | "bad-object"
  | "git-unavailable"
  | "timed-out"
  | "output-too-large"
  | "busy"
  | "unreadable"
  | "failed";

export interface GitFailure {
  kind: GitFailureKind;
  /** A short human line — git's own first stderr line where there is one. */
  detail: string;
}

export type GitResult = { ok: true; stdout: string } | { ok: false; error: GitFailure };

/** git's exact wording when a directory has no repository at or above it. */
export const NOT_A_REPOSITORY_STDERR =
  "fatal: not a git repository (or any of the parent directories): .git";

/**
 * Map a failed git run onto a classification. A stack is never the answer:
 * the caller decides between a friendly sheet state (`not-a-repository`), a
 * 404 (`bad-object`) and a 5xx with one line of git's own words.
 */
export function classifyGitFailure(stderr: string, exitCode: number | null): GitFailure {
  const firstLine = firstLineOf(stderr);
  if (/not a git repository/i.test(stderr)) {
    return { kind: "not-a-repository", detail: firstLine || NOT_A_REPOSITORY_STDERR };
  }
  if (/unknown revision|bad object|bad revision|ambiguous argument|unknown commit/i.test(stderr)) {
    return { kind: "bad-object", detail: firstLine || `Unknown object (exit ${exitCode}).` };
  }
  // git runs unprivileged (`service.ts`), so a folder only its owner may read is
  // a fact about that folder, not a failure of ours.
  if (/permission denied/i.test(stderr)) {
    return { kind: "unreadable", detail: "History cannot read this folder (permission denied)." };
  }
  return { kind: "failed", detail: firstLine ? `failed:${firstLine}` : `failed:exit ${exitCode}` };
}

function firstLineOf(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

// ── argv ─────────────────────────────────────────────────────────────────────

/**
 * The full argv for one read-only git call in `dir`.
 *
 * - `--no-optional-locks`: never write a commit-graph etc. into an agent's
 *   repository while reading it.
 * - `safe.directory=*`: the workspace is a host bind mount, so its files are
 *   typically owned by a different uid than this process. The workspace clamp
 *   is applied by us in code; this only silences git's own ownership check.
 * - `core.quotepath=false`: paths come back as raw UTF-8, not octal escapes.
 * - `HARDENING`: the repository's own `.git/config` is written by an agent and
 *   git honours it, so every key that names a program git may run is pinned
 *   here — a command-line `-c` beats the repository file. Without them
 *   `log.showSignature=true` plus `gpg.program=<script>` and one commit with a
 *   `gpgsig` header ran that script in this container on a plain History open.
 *   `service.ts` also drops the child's privileges, because this list can only
 *   name the keys known today.
 *
 * `--end-of-options` is deliberately NOT here: it is a per-subcommand token
 * (git ≥ 2.24), not a global option — in the global position every git from
 * 2.39 to 2.47 answers "unknown option". The log/show builders place it
 * after their options, before the user-controlled rev/pathspec.
 */
export function gitArgv(dir: string, args: string[]): string[] {
  return [
    GIT_BINARY,
    "--no-optional-locks",
    "-c",
    "safe.directory=*",
    "-c",
    "core.quotepath=false",
    ...HARDENING.flatMap((setting) => ["-c", setting]),
    "-C",
    dir,
    ...args,
  ];
}

/** Config keys that could make git execute something a repository names; see `gitArgv`. */
export const HARDENING: readonly string[] = [
  "log.showSignature=false",
  "gpg.program=/bin/false",
  "gpg.ssh.program=/bin/false",
  "gpg.x509.program=/bin/false",
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "core.pager=cat",
  "core.sshCommand=/bin/false",
  "protocol.allow=never",
];

/** The three probe calls that answer "is this a repository, where is its root, what is checked out". */
export const PROBE_GIT_DIR = ["rev-parse", "--git-dir"];
export const PROBE_TOPLEVEL = ["rev-parse", "--show-toplevel"];
export const PROBE_BRANCH = ["rev-parse", "--abbrev-ref", "HEAD"];

/** `%H %h %an %aI %D %s` — full sha, short sha, author, strict-ISO date, refs, subject. */
export const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%aI%x1f%D%x1f%s%x1e";

/** `%H %an %aI %B` — then the raw/numstat blocks follow the record separator. */
export const SHOW_FORMAT = "%H%x1f%an%x1f%aI%x1f%B%x1e";

export interface LogArgs {
  limit: number;
  skip: number;
  /** Path relative to the repo root; empty or null logs the whole repository. */
  pathspec: string | null;
}

/** `git log` subcommand argv; requests limit+1 so `hasMore` costs nothing. */
export function logArgs({ limit, skip, pathspec }: LogArgs): string[] {
  const args = [
    "log",
    "--no-color",
    // Belt to `log.showSignature=false` in `gitArgv`: never hand a commit to gpg.
    "--no-show-signature",
    `--pretty=format:${LOG_FORMAT}`,
    "-n",
    String(limit + 1),
    "--skip",
    String(skip),
    // Everything after this token is a rev/pathspec, never an option — a
    // pathspec like `--upload` must not become a git option.
    "--end-of-options",
  ];
  if (pathspec) args.push("--", pathspec);
  return args;
}

/** `git show` subcommand argv for one commit's header + raw + numstat. */
export function showArgs(sha: string): string[] {
  return [
    "show",
    "--no-patch",
    "--raw",
    "--numstat",
    // No signature check, no external diff driver, no textconv filter: each is
    // a program the repository's config gets to name.
    "--no-show-signature",
    "--no-ext-diff",
    "--no-textconv",
    `--format=${SHOW_FORMAT}`,
    // The sha only ever travels after this token.
    "--end-of-options",
    sha,
  ];
}

/** A commit id is only ever something git itself printed: 4–40 lowercase hex. */
export function validSha(sha: string): boolean {
  return /^[0-9a-f]{4,40}$/.test(sha);
}

/** Requested page limit, clamped to 1..MAX_LIMIT; null when the input is not a usable number. */
export function clampLimit(
  raw: string | undefined | null,
  fallback = DEFAULT_LIMIT,
): number | null {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return null;
  return Math.min(value, MAX_LIMIT);
}

/** Requested page offset, clamped to >= 0; null when the input is not a usable number. */
export function clampSkip(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === "") return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

// ── parsing ──────────────────────────────────────────────────────────────────

/** The answer to the three probe calls. */
export type RepoProbe =
  | { ok: true; root: string; branch: string }
  | { ok: false; failure: GitFailure };

/**
 * Fold the probe results into one answer. The `--git-dir` probe decides the
 * classification when the directory is not a repository (its stderr is
 * git's canonical refusal); the others only contribute their stdout.
 *
 * `branch` is git's own answer: the branch name, or `HEAD` when detached.
 */
export function parseRepoProbe(probes: {
  gitDir: GitResult;
  toplevel: GitResult;
  branch: GitResult;
}): RepoProbe {
  if (!probes.gitDir.ok) return { ok: false, failure: probes.gitDir.error };
  if (!probes.toplevel.ok) return { ok: false, failure: probes.toplevel.error };
  if (!probes.branch.ok) return { ok: false, failure: probes.branch.error };
  const root = probes.toplevel.stdout.trim();
  const branch = probes.branch.stdout.trim();
  if (!root || !branch) {
    return {
      ok: false,
      failure: { kind: "failed", detail: "failed:git rev-parse returned nothing" },
    };
  }
  return { ok: true, root, branch };
}

export interface GitCommitEntry {
  sha: string;
  shortSha: string;
  author: string;
  /** Strict ISO 8601 with offset (`%aI`). */
  date: string;
  /** Branch/tag names pointing at this commit, git's decoration order. */
  refs: string[];
  /** True when the decoration mentions HEAD — this is the checked-out tip. */
  isCurrent: boolean;
  subject: string;
}

/**
 * Parse `git log` stdout in LOG_FORMAT. Records may or may not carry a
 * trailing separator, and every record after the first begins with the
 * newline git joins records with — both are trimmed before splitting.
 */
export function parseLog(stdout: string): GitCommitEntry[] {
  const commits: GitCommitEntry[] = [];
  for (const record of stdout.split("\x1e")) {
    const trimmed = record.replace(/^\n+/, "");
    if (trimmed === "") continue;
    const fields = trimmed.split("\x1f");
    if (fields.length < 6) continue;
    const [sha, shortSha, author, date, refsRaw, subject] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const refs = parseRefs(refsRaw);
    commits.push({
      sha,
      shortSha,
      author,
      date,
      refs: refs.refs,
      isCurrent: refs.isCurrent,
      // A subject cannot contain control characters, but defend the invariant
      // anyway: keep only the part before any stray separator.
      subject: subject.split("\x1e")[0] ?? "",
    });
  }
  return commits;
}

/**
 * Turn `%D` (`HEAD -> main, origin/main, tag: v1.2.3`) into badges.
 *
 * `HEAD -> main` becomes the badge `main` plus `isCurrent`; a bare `HEAD`
 * (a detached tip) becomes the badge `HEAD` plus `isCurrent`. `tag: ` is
 * git's prefix, not part of the name. `%d`'s surrounding parentheses are
 * stripped defensively even though `%D` does not print them.
 */
export function parseRefs(decoration: string): { refs: string[]; isCurrent: boolean } {
  let text = decoration.trim();
  if (text.startsWith("(") && text.endsWith(")")) text = text.slice(1, -1);
  const refs: string[] = [];
  let isCurrent = false;
  for (const token of text.split(",")) {
    const part = token.trim();
    if (!part) continue;
    if (part === "HEAD") {
      isCurrent = true;
      refs.push("HEAD");
      continue;
    }
    if (part.startsWith("HEAD -> ")) {
      isCurrent = true;
      refs.push(part.slice("HEAD -> ".length).trim());
      continue;
    }
    refs.push(part.startsWith("tag: ") ? part.slice("tag: ".length).trim() : part);
  }
  return { refs: refs.filter(Boolean), isCurrent };
}

/**
 * The `git log` pathspec (relative to the repo root) scoping a log to
 * `folder`, or null when `folder` is not inside `repoRoot` at all.
 */
export function pathspecFor(repoRoot: string, folder: string): string | null {
  const strip = (path: string): string => path.replace(/\/+$/, "") || "/";
  const root = strip(repoRoot);
  const dir = strip(folder);
  if (dir === root) return "";
  if (dir.startsWith(`${root}/`)) return dir.slice(root.length + 1);
  return null;
}

export interface GitChangedFile {
  /** A/M/D/R/T/C/U from `--raw`, or null when it could not be paired. */
  status: string | null;
  /** The new path. */
  path: string;
  /** The old path for a rename/copy, else null. */
  oldPath: string | null;
  /** null means binary (`-` in numstat). */
  additions: number | null;
  deletions: number | null;
}

export interface GitCommitDetail {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  message: string;
  messageTruncated: boolean;
  files: GitChangedFile[];
  /** Total changed files before the MAX_FILES cap. */
  fileCount: number;
  filesTruncated: boolean;
}

/**
 * Parse `git show --no-patch --raw --numstat --format=<SHOW_FORMAT>` stdout:
 * one header record, then git's raw block and numstat block — one line each
 * per changed file, in the same order (both iterate the same change list),
 * both empty for the suppressed diff of a merge commit.
 */
export function parseShow(stdout: string): GitCommitDetail {
  const separator = stdout.indexOf("\x1e");
  const headerText = separator === -1 ? stdout : stdout.slice(0, separator);
  const rest = separator === -1 ? "" : stdout.slice(separator + 1);

  const fields = headerText.split("\x1f");
  const sha = (fields[0] ?? "").trim();
  const author = fields[1] ?? "";
  const date = (fields[2] ?? "").trim();
  // %B is the raw body: it may itself contain \x1f in theory and always ends
  // with a newline. Everything after field 2 belongs to the message.
  const body = (fields.slice(3).join("\x1f") ?? "").replace(/\n+$/, "");
  const message = capToBytes(body, MAX_MESSAGE_BYTES);

  const lines = rest.split("\n").filter((line) => line.trim() !== "");
  const rawLines = lines.filter((line) => line.startsWith(":"));
  const numLines = lines.filter((line) => !line.startsWith(":") && line.includes("\t"));

  // Zip only when the counts agree; otherwise trust numstat and leave status
  // null rather than pairing a line onto the wrong file.
  const pairable = rawLines.length === numLines.length;

  const all: GitChangedFile[] = [];
  for (const [index, line] of numLines.entries()) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parts[0] === "-" ? null : Number(parts[0]);
    const deletions = parts[1] === "-" ? null : Number(parts[1]);
    const { path, oldPath } = parseNumstatPath(parts.slice(2).join("\t"));
    const status = pairable ? rawStatus(rawLines[index] ?? "") : null;
    all.push({
      status: status || null,
      path,
      oldPath,
      additions: Number.isFinite(additions as number) ? additions : null,
      deletions: Number.isFinite(deletions as number) ? deletions : null,
    });
  }

  return {
    sha,
    shortSha: sha.slice(0, 7),
    author,
    date,
    message: message.text,
    messageTruncated: message.truncated,
    files: all.slice(0, MAX_FILES),
    fileCount: all.length,
    filesTruncated: all.length > MAX_FILES,
  };
}

/**
 * numstat renders a rename as `old => new`, or `pre{old => new}post` when the
 * directories match. Both collapse into (oldPath, path).
 */
function parseNumstatPath(raw: string): { path: string; oldPath: string | null } {
  const arrow = raw.indexOf(" => ");
  if (arrow === -1) return { path: raw, oldPath: null };
  const braceOpen = raw.indexOf("{");
  const braceClose = raw.indexOf("}", arrow);
  if (braceOpen !== -1 && braceClose !== -1 && braceOpen < arrow) {
    const prefix = raw.slice(0, braceOpen);
    const suffix = raw.slice(braceClose + 1);
    const inner = raw.slice(braceOpen + 1, braceClose);
    const [oldName, newName = ""] = inner.split(" => ");
    return { path: `${prefix}${newName}${suffix}`, oldPath: `${prefix}${oldName}${suffix}` };
  }
  return { path: raw.slice(arrow + 4), oldPath: raw.slice(0, arrow) };
}

/** The status letter of one `--raw` line: `:m1 m2 o1 o2 M\tnew` (`R100` → `R`). */
function rawStatus(line: string): string {
  const meta = line.slice(1).split("\t")[0]?.trim();
  if (!meta) return "";
  const fields = meta.split(/\s+/);
  return fields[fields.length - 1]?.[0] ?? "";
}

/** Cap a string at `maxBytes` UTF-8 bytes without splitting a character. */
export function capToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return { text, truncated: false };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return { text: text.slice(0, lo), truncated: true };
}
