/**
 * Claude Code settings and runs, over whatever file access the caller provides
 * — in the BFF, the same `CodexFileIo` the Codex routes use (`read_file` /
 * `write_file` / `list_in_directory` on the one permanent upstream
 * connection). Kept apart from index.ts so it is testable against an
 * in-memory filesystem.
 */

import type { CodexFileIo } from "../codex/service.ts";
import { readRenamed, writeRenamed } from "../internal-tools/legacy.ts";
import { agentIdFromWorkspaceSlug, splitRunsByAgent } from "../runs/attribution.ts";
import {
  applyClaudeSettingsUpdate,
  CLAUDE_PROJECTS_DIR,
  CLAUDE_SETTINGS_LEGACY_PATH,
  CLAUDE_SETTINGS_PATH,
  type ClaudeSettings,
  parseStoredClaudeSettings,
  renderStoredClaudeSettings,
} from "./settings.ts";
import {
  type ClaudeRun,
  type ClaudeRunSummary,
  isClaudeSessionId,
  parseTranscript,
  summarizeRun,
} from "./transcript.ts";

/**
 * `CodexFileIo` plus one thing Codex never needed: the project directories
 * themselves. `list_in_directory` separates folders from files, so listing
 * `projects/` for its cwd slugs needs the folder half.
 */
export interface ClaudeFileIo extends CodexFileIo {
  /** Directory names directly inside `dir`, or null when it does not exist. */
  listDirs(dir: string): Promise<string[] | null>;
}

/** How many transcripts a "recent runs" listing reads before sorting. */
const MAX_SCANNED_FILES = 30;

export async function loadClaudeSettings(io: CodexFileIo): Promise<ClaudeSettings> {
  return parseStoredClaudeSettings(
    await readRenamed(io, CLAUDE_SETTINGS_PATH, CLAUDE_SETTINGS_LEGACY_PATH),
  );
}

/** Merge a browser update into the saved settings and write the switch file. */
export async function saveClaudeSettings(io: CodexFileIo, body: unknown): Promise<ClaudeSettings> {
  const next = applyClaudeSettingsUpdate(await loadClaudeSettings(io), body);
  await writeRenamed(
    io,
    CLAUDE_SETTINGS_PATH,
    CLAUDE_SETTINGS_LEGACY_PATH,
    renderStoredClaudeSettings(next),
  );
  return next;
}

/**
 * On every upstream connect: re-render the switch file from the saved
 * settings, so a BFF upgrade that changes the rendering reaches an existing
 * install. Nothing saved yet means nothing to write — the shim stays disabled.
 *
 * `profileEnabled: false` (the `claude` token is not in COMPOSE_PROFILES)
 * makes the effective settings `enabled: false` regardless of the stored
 * switch, so the shim refuses even if the switch was left on before the
 * profile was dropped. The endpoint and model settings themselves are kept,
 * so re-adding the token restores a working worker after one flip of the
 * switch.
 */
export async function reapplyClaudeSettings(
  io: CodexFileIo,
  options: { profileEnabled?: boolean } = {},
): Promise<boolean> {
  const stored = await readRenamed(io, CLAUDE_SETTINGS_PATH, CLAUDE_SETTINGS_LEGACY_PATH);
  if (stored === null) return false;
  const settings = parseStoredClaudeSettings(stored);
  await writeRenamed(
    io,
    CLAUDE_SETTINGS_PATH,
    CLAUDE_SETTINGS_LEGACY_PATH,
    renderStoredClaudeSettings(
      options.profileEnabled === false ? { ...settings, enabled: false } : settings,
    ),
  );
  return true;
}

/** `<session id>.jsonl` under any project dir, or null. */
async function findTranscript(io: ClaudeFileIo, sessionId: string): Promise<string | null> {
  if (!isClaudeSessionId(sessionId)) return null;
  const dirs = (await io.listDirs(CLAUDE_PROJECTS_DIR)) ?? [];
  for (const dir of dirs) {
    const files = (await io.listFiles(`${CLAUDE_PROJECTS_DIR}/${dir}`)) ?? [];
    if (files.includes(`${sessionId}.jsonl`))
      return `${CLAUDE_PROJECTS_DIR}/${dir}/${sessionId}.jsonl`;
  }
  return null;
}

/** One run, fully parsed. Null when no transcript exists for that session. */
export async function getClaudeRun(io: ClaudeFileIo, sessionId: string): Promise<ClaudeRun | null> {
  const path = await findTranscript(io, sessionId);
  if (!path) return null;
  const text = await io.read(path);
  return text === null ? null : parseTranscript(sessionId, text);
}

/**
 * The most recent runs, newest first.
 *
 * With `agentId` set, only that agent's runs come back and `other` counts what
 * the filter dropped. Unlike Codex, every candidate is read here whatever the
 * caller asked for (recency comes from inside the file), so filtering costs
 * nothing extra. A transcript that never recorded its cwd is still placed by the
 * project directory it was found in, which is the cwd slug.
 */
export async function listClaudeRuns(
  io: ClaudeFileIo,
  limit: number,
  nowMs = Date.now(),
  agentId: string | null = null,
): Promise<{ runs: ClaudeRunSummary[]; other: number }> {
  // The protocol's listings carry no mtimes, so recency comes from the newest
  // entry inside each file: every candidate must be read before they can sort.
  const paths: string[] = [];
  const dirs = (await io.listDirs(CLAUDE_PROJECTS_DIR)) ?? [];
  for (const dir of dirs) {
    if (paths.length >= MAX_SCANNED_FILES) break;
    const files = (await io.listFiles(`${CLAUDE_PROJECTS_DIR}/${dir}`)) ?? [];
    for (const name of files) {
      const sessionId = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
      if (isClaudeSessionId(sessionId)) paths.push(`${CLAUDE_PROJECTS_DIR}/${dir}/${name}`);
      if (paths.length >= MAX_SCANNED_FILES) break;
    }
  }
  const runs: ClaudeRun[] = [];
  const slugs = new Map<string, string>();
  for (const path of paths) {
    const text = await io.read(path);
    if (text === null) continue;
    const sessionId = path.slice(path.lastIndexOf("/") + 1, -".jsonl".length);
    runs.push(parseTranscript(sessionId, text, nowMs));
    slugs.set(sessionId, path.slice(0, -`/${sessionId}.jsonl`.length).split("/").pop() ?? "");
  }
  runs.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
  const summaries = runs.map((run) => {
    const summary = summarizeRun(run);
    return {
      ...summary,
      // The transcript's own cwd wins; the directory it lives in is the same fact
      // from the filesystem, for the runs whose first entry never carried it.
      agentId: summary.agentId ?? agentIdFromWorkspaceSlug(slugs.get(run.sessionId) ?? null),
    };
  });
  return agentId
    ? splitRunsByAgent(summaries, agentId, limit)
    : { runs: summaries.slice(0, limit), other: 0 };
}
