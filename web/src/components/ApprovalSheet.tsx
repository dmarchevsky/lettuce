import { useState } from "react";
import { useBackToClose } from "../state/use-back-to-close.ts";
import type { PendingApproval } from "../state/use-conversation.ts";

interface Props {
  approval: PendingApproval;
  onRespond: (requestId: string, approve: boolean, reason?: string) => void;
}

interface DiffHunkLine {
  type: "context" | "add" | "remove";
  content: string;
}

function DiffView({ diffs }: { diffs: unknown[] }) {
  return (
    <>
      {diffs.map((raw, index) => {
        const diff = raw as {
          mode?: string;
          fileName?: string;
          hunks?: { lines?: DiffHunkLine[] }[];
          reason?: string;
        };
        return (
          // A diff carries no id, and its position in the list is its identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: no id to key on; the list is never reordered
          <div className="diff" key={`${diff.fileName ?? "diff"}-${index}`}>
            <div className="diff-file">{diff.fileName ?? "(file)"}</div>
            {diff.mode === "advanced" && Array.isArray(diff.hunks) ? (
              <pre>
                {diff.hunks.flatMap((hunk, hunkIndex) =>
                  (hunk.lines ?? []).map((line, lineIndex) => (
                    // The diff body is one fixed sequence of lines; nothing is
                    // inserted into it while it is on screen.
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature, static while rendered
                    <span className={`dl ${line.type}`} key={`${hunkIndex}-${lineIndex}`}>
                      {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                      {line.content}
                      {"\n"}
                    </span>
                  )),
                )}
              </pre>
            ) : (
              <p className="muted">{diff.reason ?? "No preview available"}</p>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * A tool approval — the `control_request` that a mid-approval-mode call raises.
 *
 * Structured questions are NOT here: since letta-code 0.34.1 `AskUserQuestion`
 * is asynchronous (an immediate receipt, answered from the transcript via
 * `QuestionCard`), and upstream no longer classifies it as an interactive
 * approval at all. An `AskUserQuestion` approval frame can therefore no longer
 * reach this sheet.
 */
export function ApprovalSheet({ approval, onRespond }: Props) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  // Undismissable by design — an approval has to be answered. Back is
  // swallowed so it neither hides the prompt nor exits the app beneath it.
  useBackToClose(() => false);

  return (
    <div className="sheet">
      <div className="sheet-panel sheet-spacious" role="dialog" aria-modal="true">
        <header className="sheet-head">
          <h2>Approve {approval.toolName}?</h2>
        </header>
        <div className="sheet-body">
          {approval.blockedPath ? (
            <p className="warning">
              Blocked path: <code>{approval.blockedPath}</code>
            </p>
          ) : null}

          {approval.diffs.length > 0 ? (
            <DiffView diffs={approval.diffs} />
          ) : (
            <pre className="tool-args">{JSON.stringify(approval.input, null, 2)}</pre>
          )}

          {approval.suggestions.length > 0 ? (
            <ul className="suggestions">
              {approval.suggestions.map((suggestion) => (
                <li key={suggestion.id}>{suggestion.text}</li>
              ))}
            </ul>
          ) : null}

          {denying ? (
            <textarea
              className="deny-reason"
              placeholder="Why? (optional — the agent sees this)"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          ) : null}
        </div>

        <div className="sheet-actions">
          {denying ? (
            <>
              <button type="button" className="button ghost" onClick={() => setDenying(false)}>
                Back
              </button>
              <button
                type="button"
                className="button danger"
                onClick={() => onRespond(approval.requestId, false, reason.trim() || undefined)}
              >
                Deny
              </button>
            </>
          ) : (
            <>
              <button type="button" className="button ghost" onClick={() => setDenying(true)}>
                Deny
              </button>
              <button
                type="button"
                className="button"
                onClick={() => onRespond(approval.requestId, true)}
              >
                Approve
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
