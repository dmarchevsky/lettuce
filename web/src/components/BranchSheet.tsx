import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import { FilterField } from "./FilterField.tsx";
import { Icon } from "./Icon.tsx";
import { Sheet } from "./Sheet.tsx";
import { toast } from "./Toast.tsx";

interface GitBranchInfo {
  name: string;
  is_current: boolean;
  is_remote: string | boolean;
}

interface Props {
  session: {
    request: <T = unknown>(type: string, body?: Record<string, unknown>) => Promise<T>;
  };
  /** Directory to run git in — the conversation's working directory. */
  cwd: string;
  onClose: () => void;
}

const MAX_RESULTS = 20;
const DEBOUNCE_MS = 200;

function isRemote(branch: GitBranchInfo): boolean {
  return branch.is_remote === true || branch.is_remote === "true";
}

/** git's own wording when the directory has no repository above it. */
export function isNotARepository(message: string): boolean {
  return /not a git repository/i.test(message);
}

/**
 * Git branch switcher.
 *
 * `search_branches` takes a substring filter and an optional `cwd`. The `cwd`
 * is sent explicitly rather than left to the app-server: the server's own cwd
 * is not something this screen can reason about, and the BFF clamps the field
 * to the workspace anyway (see `bff/src/session/protocol.ts`
 * `FILE_PATH_FIELDS`).
 *
 * A remote branch is offered with `create: true`, which is how upstream
 * materialises a local tracking branch on checkout.
 */
export function BranchSheet({ session, cwd, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(
    async (term: string) => {
      setStatus("Loading branches…");
      try {
        const response = await session.request<{
          branches?: GitBranchInfo[];
          success?: boolean;
          error?: string;
        }>("search_branches", { query: term, cwd, max_results: MAX_RESULTS });
        if (response?.success === false) {
          setStatus(response.error ?? "Failed to list branches");
          return;
        }
        const found = response?.branches ?? [];
        setBranches(found);
        setCurrent(found.find((branch) => branch.is_current)?.name ?? null);
        setStatus("");
      } catch (cause) {
        setStatus(errorMessage(cause));
      }
    },
    [session, cwd],
  );

  useEffect(() => {
    void search("");
  }, [search]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const trimmedQuery = query.trim();

  const onQuery = (next: string) => {
    setQuery(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void search(next.trim()), DEBOUNCE_MS);
  };

  const runCheckout = async (branch: string, create: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await session.request<{
        branch?: string;
        success?: boolean;
        error?: string;
      }>("checkout_branch", { branch, ...(create ? { create: true } : {}), cwd });
      if (response?.success === false) {
        setStatus(response.error ?? `Could not check out ${branch}`);
        return;
      }
      setCurrent(response?.branch ?? branch);
      toast(`Checked out ${response?.branch ?? branch}.`);
      onClose();
    } catch (cause) {
      setStatus(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const checkout = (branch: GitBranchInfo) =>
    // A remote branch has no local counterpart yet; `create` is what makes the
    // checkout produce a local tracking branch instead of failing.
    void runCheckout(branch.name, isRemote(branch));

  // Not a failure worth a stack of git stderr: most agent workspaces are plain
  // directories. Say so, keep the raw text one tap away, and drop the search —
  // there is nothing to search.
  if (isNotARepository(status)) {
    return (
      <Sheet title="Branch" onClose={onClose}>
        <p className="warning">
          This folder isn&apos;t a git repository, so there are no branches to switch.
        </p>
        <button type="button" className="tool-head" onClick={() => setShowDetail((v) => !v)}>
          <span className="tag">Details</span>
          <Icon name={showDetail ? "chevron-down" : "chevron-right"} className="chevron" />
        </button>
        {showDetail ? <pre className="tool-args">{status}</pre> : null}
      </Sheet>
    );
  }

  return (
    <Sheet title="Branch" onClose={onClose}>
      {current ? (
        <p className="muted small">
          Current: <code>{current}</code>
        </p>
      ) : null}
      {status ? <p className="muted small">{status}</p> : null}

      <FilterField
        label="Find a branch"
        placeholder="Filter by name…"
        value={query}
        onChange={onQuery}
      />

      <ul className="picker">
        {branches.map((branch) => {
          const active = branch.is_current;
          return (
            <li key={`${isRemote(branch) ? "remote" : "local"}:${branch.name}`}>
              <button
                type="button"
                className={active ? "active" : ""}
                disabled={active || busy}
                onClick={() => checkout(branch)}
              >
                <strong>
                  {branch.name}
                  {active ? <span className="tag">current</span> : null}
                  {isRemote(branch) ? <span className="tag muted">remote</span> : null}
                </strong>
              </button>
            </li>
          );
        })}
        {branches.length === 0 && !status ? <li className="muted">No branches match.</li> : null}
      </ul>

      {trimmedQuery && !branches.some((branch) => branch.name === trimmedQuery) ? (
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void runCheckout(trimmedQuery, true)}
        >
          Create branch &ldquo;{trimmedQuery}&rdquo;
        </button>
      ) : null}
    </Sheet>
  );
}
