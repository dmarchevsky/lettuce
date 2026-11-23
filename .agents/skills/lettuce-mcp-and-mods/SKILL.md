---
name: lettuce-mcp-and-mods
description: 'lettuce MCP and mod mechanics: the one shared MCP list under /root/.letta/mcp-home (why per-agent settings entries do not stick), where http/sse MCP tokens and headers live (bff-data, never the shared list) and the write-only /api/mcp contract, the mcp-servers skill wrapper, the mcp_search/mcp_describe/mcp_call/mcp_call_write bridge and its readOnlyHint write rule, how a letta-code mod is rendered and reloaded (resyncMods, one reload), and the native web_search/fetch_webpage tools, searxng/ddg-mcp sidecars and /internal/tools loopback-only route. Read before touching bff/src/mcp/, bff/src/mcp-bridge/, bff/src/internal-tools/, Settings → MCP servers or Settings → Web search, or the search/google sidecars.'
---

# Shared MCP list, the MCP bridge, and mods

Loaded from `AGENTS.md`. Mods are thin and the BFF does the work; MCP is one shared list that upstream never loads.

- **MCP is one shared list, kept out of upstream's `settings.json`, and agents learn it from a
  skill.** Upstream MCP is per-agent only (`settings.json` → `agents[].mcpServers`), and in
  app-server mode it is not native tools: agents run `letta mcp search|tools|schema|call`
  through Bash, a fresh process that reads settings and connects per call. Writing the
  per-agent entry **does not stick** — the app-server rewrites the whole `agents` array from
  its in-memory copy on any agent-setting change (`upsertAgentSettings` → `markDirty("agents")`
  → `persistSettings`), and `reload` never re-reads the file. Full story:
  docs/upstream-notes.md#mcp-shared-list-story.
  - So `bff/src/mcp/` keeps the list in `/root/.letta/mcp-home/.letta/settings.json`, a file
    the app-server never loads, under the synthetic agent `agent-local-mcp-global`. The
    `mcp-servers` skill's wrapper runs `HOME=/root/.letta/mcp-home letta mcp "$@" --agent
    agent-local-mcp-global`, which is what makes the list global. The file sets
    `autoConversationTitlesRollbackApplied: true` — load-bearing: without it
    `settingsManager.initialize()` persists on every CLI call and races our writes. The skill
    (SKILL.md with the server names in its description, plus the wrapper) is rendered into
    `mcp-home/skill/` and linked with `skill_enable` (the protocol cannot delete files, so an
    empty list is `skill_disable`), on every save and every upstream connect. No reload is
    needed: skills and the file are read from disk per turn and per call. Both traps (the
    "MCP servers with available tools: None" reminder and plain `letta mcp list` returning `[]`)
    are named in the skill's description, not just its body. A fresh install's list starts
    empty; nothing is seeded. Codex's `mcp: {inherit: true}` forwards that same empty list, so
    the Tasks form no longer offers it and `delegating-to-codex` tells agents to hand workers
    the wrapper instead.
  - **Most turns reach these servers through native tools, not the skill: the MCP bridge**
    (`bff/src/mcp-bridge/`, the `lettuce-mcp-bridge.mjs` mod). Four tools with small static
    schemas — `mcp_search` (keyword-ranked, marks each hit read-only or writes), `mcp_describe`,
    `mcp_call` (auto; **refuses** any tool the server does not mark `readOnlyHint` — unmarked
    counts as a write) and `mcp_call_write` (`approval: "ask"`). Search-then-call rather than
    one native tool per MCP tool keeps the per-turn prefill constant. The BFF is the MCP client
    (SDK, one session per call) for **http and sse servers only** — a stdio server's command is
    written for the app-server container, so it stays on the skill wrapper, as do subagents
    (no mod tools). `McpCatalog` caches `tools/list` per server (connect, MCP save, Google
    change, 10-min TTL); names are upstream's `mcp__<server>__<tool>`. The skill's description
    now says so. Browsers reach none of these files: `/api/mcp` reads and writes the list (an
    entry is a command line agent shells exec), and `settings.json` is no longer a readable
    exception.
  - **An http/sse server's bearer token and custom headers are not in that list — they are on
    `bff-data`** (`bff/src/mcp/credentials.ts`, `MCP_CREDENTIALS_FILE`, 0600), because every agent
    shell mounts letta-home read-write as uid 0 and could read (or be talked into sending away) a
    token there. They meet a server object in exactly one place: the `McpCatalog`'s `servers` port in
    `index.ts` runs `withCredentials`, and every bridge and Google tool call takes its server from the
    catalog. Each saved entry is tied to the **origin** it was entered for: a URL now pointing at
    another host gets no headers at connect, and the editor must re-enter them. The price is the skill
    wrapper — `letta mcp` reads only the shared file, so subagents get a 401 from such a server; the
    skill renders those names as `<name> (mcp_* tools only)`. A stdio server's `env` cannot move (the
    process runs in the app-server), so it stays in the shared file, write-only in the API only.
  - **`/api/mcp` is write-only for secrets.** GET answers `bearer` / `headerNames` / `envNames`
    (`publicMcpServers`), never a value; PUT takes per secret a blank = keep, a value = replace, left
    out = remove, with `was` carrying a rename (`resolveMcpUpdate`, run inside `service.ts`'s
    `queued` chain with the list it belongs to). The editor therefore sends every untouched server
    back as "keep everything" (`web/src/lib/mcp.ts` `keepAll`) — a PUT that omitted them would delete
    their secrets. Headers hand-written into the shared file are moved to `bff-data` on connect
    (`migrateFileHeaders`, logged by name only). A header holding upstream's `${VAR}` placeholder
    stays in the shared file — a reference `letta mcp` expands from the app-server env, not a
    secret — and the editor keeps or removes it like a saved header.

- **Web search and page reading are native tools, `web_search` and `fetch_webpage`, installed
  as a letta-code mod.** Upstream's own tools of those names are Letta-*server* tools, which our
  local backend (`serverSideToolManagement: false`) cannot have. A **mod** is upstream's
  supported way to add a client tool: a file in the app-server's global mods directory
  `/root/.letta/mods/` whose default export calls `letta.tools.register(...)`
  (`src/mods/mod-sources.ts`, `mod-engine.ts`). Listener turns get mod tools whatever the
  toolset preference (`tools/manager.ts` `capturePreparedToolExecutionContext`) — chats, crons
  and channel turns alike. **Subagents do not** (they run a providers-only capability profile),
  nor do Codex workers.
  - **Mods are thin; the BFF does the work** (`bff/src/internal-tools/`, shared by every mod we
    ship). `renderToolsMod` emits plain ESM (mods cannot import npm packages) whose tools POST
    their args to `http://127.0.0.1:8080/internal/tools/<name>`. That route is handled in
    `Bun.serve` before Hono and answers **only loopback clients** (`internal-tools/http.ts`) —
    i.e. the app-server namespace (mods, agent shells, the gateway), which can reach every
    sidecar and the internet anyway; a browser (published port, cloudflared) gets a 404. The
    first web-tools mod's `/internal/web-tools/{search,fetch}` paths stay as aliases. Each tool
    is `approval: "auto"` (never prompts) or `"ask"` (`requiresApproval` + `approvalPolicy:
    "ask"`: Standard/Strict prompt, Unrestricted runs — `permissions/checker.ts`). Reads are
    `auto`; an `ask` tool in an unattended cron turn under Standard mode waits for an approval.
    Three mods: `lettuce-web-tools.mjs`, `lettuce-google-tools.mjs`, `lettuce-mcp-bridge.mjs`.
  - **A renamed mod file is stubbed, not deleted** — the protocol has no delete verb, so
    `syncMods` overwrites a path in `RETIRED_MOD_PATHS` (`bff/src/index.ts`) with
    `RETIRED_MOD_SOURCE`, a module that registers nothing, and reloads once. The mods that used
    to be `letta-ui-*.mjs` are the current entries; leave the list until every install's
    `/root/.letta/mods` has been through a sync, then delete both it and the stub writer.
  - **Search:** the `searxng` sidecar (`docker/searxng`, pinned `SEARXNG_VERSION`, settings
    baked into the image *outside* `/etc/searxng` — that path is a declared VOLUME and compose
    carries an anonymous volume across recreates, so a settings change there would never land).
    Engines probed from a residential IP: bing, brave and yahoo answer; duckduckgo and qwant
    return CAPTCHA; mojeek is inactive upstream (proof-of-work CAPTCHA); google needs
    JavaScript. When SearXNG is down or every engine failed, the BFF falls back to ddg-mcp's
    `search`, whose browser-TLS fallback SearXNG's duckduckgo engine lacks.
  - **Pages:** ddg-mcp's `fetch_content` in markdown mode (`web-tools/ddg.ts`, MCP SDK, one
    session per call). The sidecar keeps the rate limiter (30 searches / 20 fetches a minute)
    and page cache, and fetches from its own container, not the BFF's.
    `DDG_REF_URL_THRESHOLD: "0"` so fallback results carry real URLs, not `ref://` tokens. The
    Host header must stay `ddg-mcp:8000` (its `--allowed-hosts` DNS-rebinding guard).
  - **Loading: no file watch.** Global mods load on the first client connection (the BFF's,
    `app-server.ts` `getStartupReady`) and again only on `execute_command reload`, which needs
    an agent runtime (`listener/commands.ts`). So `resyncMods` (index.ts) renders all three
    mods, writes only those that differ (`internal-tools/install.ts` `syncMods`) and sends
    **one** `reload` in the first agent's `default` conversation — retried every 30 s while no
    agent exists. It runs on connect, on a Settings → Web search or → MCP servers save, and
    4/12/30 s after any Google change. An app-server restart needs no reload: the files are
    already there.
  - **Settings → Web search** (`/api/web-tools/*`, `/root/.letta/web-tools/lettuce.json`): a
    switch (off renders a mod that registers nothing — the protocol cannot delete a file),
    backend status, a test search, and mod load errors from letta-code's
    `/root/.letta/mods/diagnostics/latest.json` (errors only — a clean load writes nothing).
    The `search` token gates it: with the token off the stored switch is treated as off when
    the mod is rendered and the settings save route 404s.
  - **duckduckgo left the shared MCP list** in a one-time migration (`retireSeededDdgMcp`,
    recorded as `mcpDdgRetired`), so a user who adds it back keeps it.
