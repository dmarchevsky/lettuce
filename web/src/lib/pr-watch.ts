/**
 * The GitHub destination a `WatchPR` row links to.
 *
 * Upstream puts no URL on the wire for a monitor: `MonitorBackgroundProcessSummary`
 * (letta-code `src/types/background-process-protocol.ts`) carries `description`,
 * `source` and `started_at_ms` only, and the process's `command` — which is the URL
 * — is not in the snapshot builder's output. What upstream *does* write is a
 * description generated from the ref (`src/tools/impl/watch-pr.ts`, just before
 * `withMonitorState`): `PR <owner>/<repo>#<n> checks, reviews, and mergeability`
 * for a pull request, `Workflow run <owner>/<repo>#<n>` for an Actions run URL.
 *
 * So the link is rebuilt from that string, which makes it a derived fact: it fails
 * closed, and a description that does not match upstream's own shape yields no link
 * rather than a guessed one. `github.com` is the only host upstream watches
 * (`parseGitHubPullRequestUrl`), so nothing here tries to infer a host.
 */

export interface WatchTarget {
  /** Rebuilt destination: `…/pull/<n>` for a PR, `…/actions/runs/<n>` for a run. */
  url: string;
  /** The row's label: `owner/repo#142`, or `Workflow run owner/repo#1207`. */
  label: string;
  /** The verb's words: "Open PR" or "Open run". */
  title: string;
}

/** Owner and repo as GitHub allows them, then the number upstream appends. */
const WATCH_TARGET = /^(?:PR|Workflow run) ([\w.-]+\/[\w.-]+)#(\d+)\b/;

/** The watch's GitHub destination off its upstream description, or null. */
export function readWatchTarget(description: unknown): WatchTarget | null {
  if (typeof description !== "string") return null;
  const match = WATCH_TARGET.exec(description);
  const repo = match?.[1];
  const number = match?.[2];
  if (!repo || !number) return null;
  const run = description.startsWith("Workflow run ");
  return {
    url: `https://github.com/${repo}/${run ? "actions/runs/" : "pull/"}${number}`,
    label: run ? `Workflow run ${repo}#${number}` : `${repo}#${number}`,
    title: run ? "Open run" : "Open PR",
  };
}
