import { type ReactNode, useCallback, useEffect, useState } from "react";
import { shortDate } from "../lib/conversation-groups.ts";
import { errorMessage } from "../lib/errors.ts";
import {
  fetchGitCommit,
  fetchGitLog,
  GIT_PAGE_SIZE,
  type GitCommitEntry,
  type GitCommitInfo,
} from "../lib/git.ts";
import { Icon } from "./Icon.tsx";
import { Sheet } from "./Sheet.tsx";

interface Props {
  /** The currently open Files tab directory; the log is scoped to it. */
  cwd: string;
  onClose: () => void;
}

type View = { kind: "list" } | { kind: "detail" };

interface RepoMeta {
  root: string;
  branch: string;
}

/**
 * The commit log of the open folder's repository, read by the BFF (see
 * `bff/src/git/`) — the app-server cannot run git and upstream has no log
 * command. Opened per directory like `BranchSheet`; the log is limited to the
 * open folder, so `History` inside `src/` shows only `src/` commits.
 *
 * Two panes, one sheet: the list, and a per-commit detail that swaps the body
 * in place. No patch text in v1 — stats only.
 */
export function GitHistorySheet({ cwd, onClose }: Props) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [commits, setCommits] = useState<GitCommitEntry[]>([]);
  const [meta, setMeta] = useState<RepoMeta | null>(null);
  const [notARepo, setNotARepo] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [skip, setSkip] = useState(0);
  const [status, setStatus] = useState("Loading history…");
  const [loadingMore, setLoadingMore] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [detail, setDetail] = useState<GitCommitInfo | null>(null);
  const [detailStatus, setDetailStatus] = useState("");

  const load = useCallback(
    async (from: number, append: boolean) => {
      if (append) setLoadingMore(true);
      else setStatus("Loading history…");
      try {
        const result = await fetchGitLog(cwd, { limit: GIT_PAGE_SIZE, skip: from });
        if (result.repo === false) {
          setNotARepo(result.reason);
          setStatus("");
          return;
        }
        setNotARepo(null);
        setMeta({ root: result.root, branch: result.branch });
        setCommits((current) => (append ? [...current, ...result.commits] : result.commits));
        setHasMore(result.hasMore);
        setSkip(from + result.commits.length);
        setStatus("");
      } catch (cause) {
        setStatus(errorMessage(cause));
      } finally {
        setLoadingMore(false);
      }
    },
    [cwd],
  );

  useEffect(() => {
    void load(0, false);
  }, [load]);

  const openCommit = async (sha: string) => {
    setView({ kind: "detail" });
    setDetail(null);
    setDetailStatus("Loading commit…");
    try {
      const result = await fetchGitCommit(cwd, sha);
      if (result.repo === false) {
        setDetailStatus("This folder isn't a git repository.");
        return;
      }
      setDetail(result.commit);
      setDetailStatus("");
    } catch (cause) {
      setDetailStatus(errorMessage(cause));
    }
  };

  const strip = (path: string): string => path.replace(/\/+$/, "") || "/";
  const scopedToFolder = meta !== null && strip(cwd) !== meta.root;

  return (
    <Sheet title="History" size="spacious" onClose={onClose}>
      {view.kind === "list" ? (
        <ListView
          meta={meta}
          commits={commits}
          status={status}
          notARepo={notARepo}
          showRaw={showRaw}
          onShowRaw={setShowRaw}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={() => void load(skip, true)}
          onRetry={() => void load(0, false)}
          scopedToFolder={scopedToFolder}
          onOpen={(sha) => void openCommit(sha)}
        />
      ) : (
        <CommitDetail
          detail={detail}
          status={detailStatus}
          onBack={() => setView({ kind: "list" })}
        />
      )}
    </Sheet>
  );
}

function ListView({
  meta,
  commits,
  status,
  notARepo,
  showRaw,
  onShowRaw,
  hasMore,
  loadingMore,
  onLoadMore,
  onRetry,
  scopedToFolder,
  onOpen,
}: {
  meta: RepoMeta | null;
  commits: GitCommitEntry[];
  status: string;
  notARepo: string | null;
  showRaw: boolean;
  onShowRaw: (value: boolean) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  scopedToFolder: boolean;
  onOpen: (sha: string) => void;
}) {
  // Not a failure worth a wall of git stderr: most agent workspaces are plain
  // directories. Say so and keep the raw line one tap away — same treatment
  // BranchSheet gives the very same situation.
  if (notARepo !== null) {
    return (
      <>
        <p className="warning">
          This folder isn&apos;t a git repository, so there is no history to show.
        </p>
        <button type="button" className="tool-head" onClick={() => onShowRaw(!showRaw)}>
          <span className="tag">Details</span>
          <Icon name={showRaw ? "chevron-down" : "chevron-right"} className="chevron" />
        </button>
        {showRaw ? <pre className="tool-args">{notARepo}</pre> : null}
      </>
    );
  }

  if (!meta) {
    return (
      <>
        <p className="muted small">{status || "Loading history…"}</p>
        {status ? (
          <button type="button" className="button ghost" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </>
    );
  }

  return (
    <>
      <p className="muted small git-repo-line">
        <code>{meta.root}</code>
        <span className="tag">{meta.branch === "HEAD" ? "detached HEAD" : meta.branch}</span>
      </p>
      {status ? <p className="muted small">{status}</p> : null}

      <ul className="picker git-commits">
        {commits.map((commit) => (
          <li key={commit.sha} className="git-commit">
            <button type="button" onClick={() => onOpen(commit.sha)}>
              <strong className="git-commit-subject">
                <span className="git-commit-text">{commit.subject}</span>
                {commit.isCurrent ? <span className="tag">current</span> : null}
                {commit.refs.map((ref) => (
                  <span key={ref} className="tag muted">
                    {ref}
                  </span>
                ))}
              </strong>
              <CommitMeta shortSha={commit.shortSha} author={commit.author} date={commit.date} />
            </button>
          </li>
        ))}
        {commits.length === 0 && !status ? (
          <li className="muted">
            {scopedToFolder ? "No commits for this folder." : "No commits yet."}
          </li>
        ) : null}
      </ul>

      {hasMore ? (
        <button type="button" className="button ghost" disabled={loadingMore} onClick={onLoadMore}>
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </>
  );
}

function CommitDetail({
  detail,
  status,
  onBack,
}: {
  detail: GitCommitInfo | null;
  status: string;
  onBack: () => void;
}) {
  if (!detail) {
    // The back control stays the only escape from a failed fetch: the list is
    // still intact and the commit can be re-opened from there.
    return (
      <>
        <button type="button" className="link" onClick={onBack}>
          <Icon name="back" /> Commits
        </button>
        <p className="muted small">{status || "Loading commit…"}</p>
      </>
    );
  }

  return (
    <>
      <button type="button" className="link" onClick={onBack}>
        <Icon name="back" /> Commits
      </button>
      <CommitMeta shortSha={detail.shortSha} author={detail.author} date={detail.date} />
      <pre className="tool-args git-message">{detail.message || "(no message)"}</pre>
      {detail.messageTruncated ? <p className="muted small">Message truncated.</p> : null}
      <p className="muted small">
        {detail.fileCount} {detail.fileCount === 1 ? "file" : "files"} changed
        {detail.filesTruncated ? ` (first ${detail.files.length} shown)` : ""}
      </p>

      {detail.files.length === 0 ? (
        // A merge commit's diff is suppressed by git itself — nothing to show,
        // not an error. (Normal commits always change at least one file.)
        <p className="muted">No file changes — merge commits show none.</p>
      ) : (
        <ul className="picker git-files">
          {detail.files.map((file, index) => (
            // Same path can appear twice (e.g. a rename pair across pages);
            // the index keeps the key unique without pretending paths are keys.
            // biome-ignore lint/suspicious/noArrayIndexKey: a commit's file list is static while shown
            <li key={`${file.path}:${index}`} className="git-file">
              <span className="git-status" title={file.status ?? undefined}>
                {file.status ?? "?"}
              </span>
              <span className="git-file-path">
                {file.oldPath ? `${file.oldPath} → ` : ""}
                {file.path}
              </span>
              <span className="git-file-stats">
                {file.additions === null ? (
                  <span className="tag">binary</span>
                ) : (
                  <>
                    <span className="git-add">+{file.additions}</span>
                    <span className="git-del">−{file.deletions}</span>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The sha · author · date line, shared by the commit rows and the detail head. */
function CommitMeta({
  shortSha,
  author,
  date,
}: {
  shortSha: string;
  author: string;
  date: string;
}): ReactNode {
  return (
    <span className="git-commit-meta muted small">
      <code>{shortSha}</code>
      <span>{author}</span>
      <span>{shortDate(date)}</span>
    </span>
  );
}
