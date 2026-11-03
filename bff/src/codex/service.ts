/**
 * Codex settings and runs, over whatever file access the caller provides —
 * in the BFF, `read_file` / `write_file` / `list_in_directory` on the one
 * permanent upstream connection. Kept apart from index.ts so it is testable
 * against an in-memory filesystem.
 */

import { readRenamed, writeRenamed } from "../internal-tools/legacy.ts";
import { scanBudget, splitRunsByAgent } from "../runs/attribution.ts";
import {
  type CodexRun,
  type CodexRunSummary,
  candidateDayDirs,
  parseRollout,
  recentDayDirs,
  summarizeRun,
  threadIdOfRollout,
} from "./rollout.ts";
import {
  applyCodexSettingsUpdate,
  CODEX_AUTH_PATH,
  CODEX_CONFIG_PATH,
  CODEX_HOME,
  CODEX_SETTINGS_LEGACY_PATH,
  CODEX_SETTINGS_PATH,
  type CodexSettings,
  LETTA_PROVIDERS_PATH,
  parseStoredCodexSettings,
  renderCodexAuthJson,
  renderCodexConfigToml,
  renderStoredCodexSettings,
  suggestCodexBaseUrl,
} from "./settings.ts";

export interface CodexFileIo {
  /** File contents, or null when the file does not exist. Throws on any other failure. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  /** File names directly inside `dir`, or null when it does not exist. */
  listFiles(dir: string): Promise<string[] | null>;
}

const SESSIONS_DIR = `${CODEX_HOME}/sessions`;
/** How far back "recent runs" looks. */
const RECENT_DAYS = 7;

export async function loadCodexSettings(io: CodexFileIo): Promise<CodexSettings> {
  return parseStoredCodexSettings(
    await readRenamed(io, CODEX_SETTINGS_PATH, CODEX_SETTINGS_LEGACY_PATH),
  );
}

export async function suggestedCodexBaseUrl(io: CodexFileIo): Promise<string | null> {
  try {
    return suggestCodexBaseUrl(await io.read(LETTA_PROVIDERS_PATH));
  } catch {
    return null;
  }
}

async function writeCodexFiles(io: CodexFileIo, settings: CodexSettings): Promise<void> {
  // Codex's own files first, the switch last: the shim must never see
  // `enabled: true` while config.toml still describes something else.
  await io.write(CODEX_CONFIG_PATH, renderCodexConfigToml(settings));
  await io.write(CODEX_AUTH_PATH, renderCodexAuthJson());
  await writeRenamed(
    io,
    CODEX_SETTINGS_PATH,
    CODEX_SETTINGS_LEGACY_PATH,
    renderStoredCodexSettings(settings),
  );
}

/** Merge a browser update into the saved settings and write every file. Throws on invalid input. */
export async function saveCodexSettings(io: CodexFileIo, body: unknown): Promise<CodexSettings> {
  const next = applyCodexSettingsUpdate(await loadCodexSettings(io), body);
  await writeCodexFiles(io, next);
  return next;
}

/**
 * On every upstream connect: re-render Codex's files from the saved settings,
 * so a BFF upgrade that changes the rendering reaches an existing install.
 * Nothing saved yet means nothing to write — the shim stays disabled.
 *
 * `profileEnabled: false` (the `codex` token is not in COMPOSE_PROFILES) makes
 * the effective settings `enabled: false` regardless of the stored switch,
 * so the shim refuses even if the switch was left on before the profile was
 * dropped. The endpoint and model settings themselves are kept, so re-adding
 * the token restores a working worker after one flip of the switch.
 */
export async function reapplyCodexSettings(
  io: CodexFileIo,
  options: { profileEnabled?: boolean } = {},
): Promise<boolean> {
  const stored = await readRenamed(io, CODEX_SETTINGS_PATH, CODEX_SETTINGS_LEGACY_PATH);
  if (stored === null) return false;
  const settings = parseStoredCodexSettings(stored);
  await writeCodexFiles(
    io,
    options.profileEnabled === false ? { ...settings, enabled: false } : settings,
  );
  return true;
}

async function findRollout(io: CodexFileIo, threadId: string): Promise<string | null> {
  for (const day of candidateDayDirs(threadId)) {
    const dir = `${SESSIONS_DIR}/${day}`;
    const name = (await io.listFiles(dir))?.find((file) => threadIdOfRollout(file) === threadId);
    if (name) return `${dir}/${name}`;
  }
  return null;
}

/** One run, fully parsed. Null when no rollout exists for that thread. */
export async function getCodexRun(io: CodexFileIo, threadId: string): Promise<CodexRun | null> {
  const path = await findRollout(io, threadId);
  if (!path) return null;
  const text = await io.read(path);
  return text === null ? null : parseRollout(threadId, text);
}

/**
 * The most recent runs, newest first.
 *
 * With `agentId` set, only that agent's runs come back, and `other` says how
 * many of what was scanned belonged to someone else — which is what lets the
 * Runs pane say "3 other runs" instead of looking quietly empty. A filtered
 * scan runs past the page it shows (up to `scanBudget`) because it has to read
 * a run to learn whose it is; an unfiltered one stops at `limit` as before.
 */
export async function listCodexRuns(
  io: CodexFileIo,
  limit: number,
  nowMs = Date.now(),
  agentId: string | null = null,
): Promise<{ runs: CodexRunSummary[]; other: number }> {
  const scanned = agentId ? scanBudget(limit) : limit;
  const paths: { path: string; threadId: string }[] = [];
  for (const day of recentDayDirs(nowMs, RECENT_DAYS)) {
    if (paths.length >= scanned) break;
    const dir = `${SESSIONS_DIR}/${day}`;
    // Names start with the local start time, so reverse order is newest first.
    const names = ((await io.listFiles(dir)) ?? []).sort().reverse();
    for (const name of names) {
      const threadId = threadIdOfRollout(name);
      if (threadId) paths.push({ path: `${dir}/${name}`, threadId });
      if (paths.length >= scanned) break;
    }
  }
  const runs: CodexRunSummary[] = [];
  for (const { path, threadId } of paths) {
    const text = await io.read(path);
    if (text !== null) runs.push(summarizeRun(parseRollout(threadId, text)));
  }
  return agentId
    ? splitRunsByAgent(runs, agentId, limit)
    : { runs: runs.slice(0, limit), other: 0 };
}
