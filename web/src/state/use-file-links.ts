/**
 * Resolve a filename the agent mentions in prose to a real file in the current
 * workspace, so `file-links.ts` links it — and links it at the path it is
 * actually at, wherever under `cwd` that is.
 *
 * The old rule linked anything path-shaped and pointed it at `<cwd>/<token>`.
 * That produced links to files that do not exist (the agent writes `monitor.md`;
 * the file is `.claude/skills/<pkg>/references/monitor.md`) and left the many
 * filenames the agent writes in backticks unlinked. This replaces the guess
 * with a lookup against `search_files` — already in the BFF browser allowlist
 * and clamped to `/work`.
 *
 * `search_files` (see the fork's `searchFilesDirect`) is recursive from `cwd`,
 * substring-matches the relative path case-insensitively, caps at 200 hits and
 * skips `.git`/`node_modules`/`dist`/`build`/`.letta` — but NOT `.claude`, which
 * is why a bundled-skill file resolves to exactly one hit here.
 *
 *   resolve(token)  sync, cache-only — drives the render, returns an absolute
 *                   path for a hit or null for "not a link"
 *   note(tokens)    queue tokens the cache has not seen; a debounced flush does
 *                   one lookup per token and re-renders once when they land
 *
 * A name that resolves to zero files, or to more than one, is cached as a miss
 * and stays plain text — a broken link is never drawn. Misses carry a short TTL
 * so a file the agent creates mid-conversation links once it exists; hits are
 * permanent. The whole cache is dropped when `cwd` changes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionApi } from "./use-session.ts";

const NEGATIVE_TTL_MS = 60_000;
const MAX_ENTRIES = 500;
const FLUSH_DELAY_MS = 400;
const SEARCH_MAX_RESULTS = 200;

interface SearchFile {
  path: string;
  type?: string;
}

/**
 * The single file a bare token names, or null when zero or several match.
 *
 * `search_files` substring-matches, so a query for `LOG.md` also returns
 * `CHANGELOG.md`; the tail match (`=== token` or `endsWith("/" + token)`)
 * discards those. A token that already carries directories (`scripts/x.py`)
 * must match that whole tail.
 */
export function pickResolvedFile(token: string, files: SearchFile[]): string | null {
  const wanted = token.replace(/^\.\//, "").replace(/^\/+/, "");
  const hits = files.filter((file) => {
    if (file.type && file.type !== "file") return false;
    const path = file.path.replace(/^\.\//, "");
    return path === wanted || path.endsWith(`/${wanted}`);
  });
  return hits.length === 1 ? (hits[0]?.path ?? null) : null;
}

function joinPath(cwd: string, relative: string): string {
  return `${cwd.replace(/\/+$/, "")}/${relative.replace(/^\.?\/+/, "")}`;
}

/**
 * Token → resolved path (or a TTL'd miss). Pure and framework-free so its
 * dedupe / eviction / expiry can be tested without a renderer; the hook only
 * adds the debounce and the re-render.
 */
export class FileLinkCache {
  private entries = new Map<string, { path: string | null; expires: number }>();

  constructor(
    private readonly max = MAX_ENTRIES,
    private readonly negativeTtlMs = NEGATIVE_TTL_MS,
  ) {}

  /** A hit's path, null for a live miss, undefined for "not looked up". */
  get(token: string, now: number = Date.now()): string | null | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (entry.path === null && entry.expires <= now) {
      this.entries.delete(token);
      return undefined;
    }
    return entry.path;
  }

  set(token: string, path: string | null, now: number = Date.now()): void {
    // Re-insert at the tail so eviction is oldest-first (Map keeps order).
    this.entries.delete(token);
    this.entries.set(token, {
      path,
      expires: path === null ? now + this.negativeTtlMs : Number.POSITIVE_INFINITY,
    });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Of `tokens`, the ones not currently known (never looked up or miss expired). */
  unknown(tokens: Iterable<string>, now: number = Date.now()): string[] {
    const out: string[] = [];
    for (const token of tokens) {
      if (this.get(token, now) === undefined) out.push(token);
    }
    return out;
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface FileLinks {
  /** Sync, cache-only. Absolute path for a hit, null otherwise. */
  resolve: (token: string) => string | null;
  /** Queue tokens for a background lookup; safe to call every render. */
  note: (tokens: string[]) => void;
}

export function useFileLinks(session: SessionApi, cwd: string | null): FileLinks {
  const cacheRef = useRef(new FileLinkCache());
  const pendingRef = useRef(new Set<string>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, bump] = useState(0);

  // A new workspace invalidates every resolution. `cwd` is the trigger, not an
  // input — what it clears lives in refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clearing caches on a workspace change, not deriving from cwd
  useEffect(() => {
    cacheRef.current.clear();
    pendingRef.current.clear();
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    bump((n) => n + 1);
  }, [cwd]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const flush = useCallback(() => {
    timerRef.current = null;
    if (!cwd) return;
    const batch = [...pendingRef.current];
    pendingRef.current.clear();
    if (batch.length === 0) return;

    void Promise.all(
      batch.map(async (token) => {
        const basename = token.split("/").pop() ?? token;
        try {
          const response = await session.request<{ files?: SearchFile[] }>("search_files", {
            query: basename,
            cwd,
            max_results: SEARCH_MAX_RESULTS,
          });
          const relative = pickResolvedFile(token, response?.files ?? []);
          cacheRef.current.set(token, relative ? joinPath(cwd, relative) : null);
        } catch {
          cacheRef.current.set(token, null);
        }
      }),
    ).then(() => bump((n) => n + 1));
  }, [session, cwd]);

  const note = useCallback(
    (tokens: string[]) => {
      if (!cwd || tokens.length === 0) return;
      let added = false;
      for (const token of cacheRef.current.unknown(tokens)) {
        if (!pendingRef.current.has(token)) {
          pendingRef.current.add(token);
          added = true;
        }
      }
      if (!added) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, FLUSH_DELAY_MS);
    },
    [cwd, flush],
  );

  const resolve = useCallback((token: string): string | null => {
    return cacheRef.current.get(token) ?? null;
  }, []);

  return { resolve, note };
}
