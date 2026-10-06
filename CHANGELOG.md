# Changelog

All notable user-facing changes to lettuce, newest first. Version tags and
`VERSION` are defined in `AGENTS.md` and the `lettuce-releasing` skill.

## [Unreleased]

### Fixed
- Fix a deploy aborting before a single container was created: the image build demanded git metadata in its build context, and a deploy manager (Dockhand) builds from its own copy of the tree, which has none. Such a build now succeeds and Settings → About says `+unknown` rather than a commit — which commit was deployed is in the deploy manager's record, and `bun run deploy-check <origin> --allow-unstamped` checks it.

### Added
- **Remote pi worker** (`pi` compose profile token): agents dispatch coding tasks to a [`pi`](https://github.com/earendil-works/pi) install on another host over SSH — `pi_run` starts a background run, `pi_send` iterates on the same pi session, `pi_status`/`pi_stop` follow it; Settings → Remote pi worker holds the host and the host-key pin and **generates its own deploy key** — Settings shows the public half to paste into the remote's `authorized_keys`, with one-click rotation (pasting an existing PEM also works); Tasks lists every run with its full captured transcript. Nothing is installed on the remote host beyond pi. Design and spike evidence: `docs/remote-pi-plan.md`.
- Settings → About names the exact commit the running build came from (`v0.6.1-letta_0.34.1+9400080`), so a build between releases is no longer indistinguishable from the last release.

## [v0.6.1-letta_0.34.1] - 2026-10-04

### Fixed
- Fix image attachments failing at random with "the image processing worker is missing": letta-code can no longer update itself inside the app-server container, so it also stays on the pinned version.

## [v0.6.0-letta_0.34.1] - 2026-10-02

### Added
- Browse the git history of any workspace folder from the Files tab: the commit log scoped to the open folder, and per-commit details with changed files and +/− stats.

### Changed
- The stack's own images and containers are named `lettuce-*` now (`docker ps` shows `lettuce-bff-1`); no host folders, env vars or volumes move.

### Fixed
- Show Branch and History in the Files tab only for folders inside a git repository — a plain workspace no longer offers two buttons that can only say "isn't a git repository".
- Escape inside a Settings section's own sheet (e.g. a model's capability edit) closes just that sheet — it no longer takes the whole Settings screen with it.

## [v0.5.0-letta_0.34.1] - 2026-10-02

### Added
- Mark a served model **Vision** / **Thinking** from Settings → Providers & models (Edit on the model's row) so it receives images and its real context window instead of the 128k default — applies from the agents' next turn, no restart, no server config.
- `VISION_PROVIDERS` env still works, as a first-boot seed for those declarations; after that everything is edited in the UI.

### Fixed
- Tapping an image you sent shows it full-size in the app; it used to open a new tab the browser refuses to navigate to.
- A declared provider (e.g. one seeded from `VISION_PROVIDERS`) lists its models under "Models served" with their tags — they no longer hide under "Cloud models".

## [v0.4.0-letta_0.34.1] - 2026-10-02

### Added
- Attach images to a message from the camera roll, clipboard or drag-drop — the model sees them when the model supports vision.
- Ask the agent structured mid-conversation questions that don't block the reply: answers and skips come back as ordinary messages, from any device or Telegram, and the question card shows the outcome.

### Changed
- Synced letta-code to 0.34.1 (async AskUserQuestion, Cloud-only Memory Palace skills, reworked turn recovery).

## [v0.3.1-letta_0.33.7] - 2026-10-01

### Fixed
- The context gauge shows the real limit on first load (no more transient 128k default) and appears before the first turn as "— / 256k".

## [v0.3.0-letta_0.33.7] - 2026-10-01

### Added
- COMPOSE_PROFILES now gates features as well as containers: `codex` and `claude` install their CLI into the app-server image, and the `search`/`google`/`codex`/`claude` tokens decide which Settings sections, run lists and Agent → Tools rows exist. Changing a coding token requires an app-server rebuild.

### Changed
- Slash-command popup rows fit one line each: the description sits beside the command name and truncates instead of wrapping.

### Fixed
- The slash-command popup scrolls to keep the highlighted command visible when you arrow through it.

### Removed
- The composer's slash-command button and Commands sheet; type `/` in the input to run a command.

## [v0.2.0-letta_0.33.7] - 2026-10-01

### Added
- Claude Code coding workers: enable in Settings → Claude Code against any Anthropic-compatible endpoint; full run viewer under Tasks → Claude runs, per-agent allow/block in Agent → Tools.

## [v0.1.5-letta_0.33.7] - 2026-09-30

### Added
- Pulsing status dot lists responding conversations and jumps to any of them.

## [v0.1.4-letta_0.33.7] - 2026-09-30

### Added
- Queue-aware send button: while the agent works, press queues your message and the red corner of the split button stops it.
- Queued messages show as chips above the composer with remove and force-send; a green "Agent is working" line sits above the input.

### Fixed
- The working indicator stays lit across queued turns and the force-send seam.

## [v0.1.3-letta_0.33.7] - 2026-09-29

### Added
- Run every container in a configurable timezone.

## [v0.1.2-letta_0.33.7] - 2026-09-29

### Added
- Edit text and markdown files, and create new files, from the Files tab.

## [v0.1.1-letta_0.33.7] - 2026-09-29

### Changed
- The app is now Lettuce: rebranded UI, BFF strings and docs; About no longer shows a letta-code version row.

## [v0.1.0-letta_0.33.7] - 2026-09-29

### Added
- Mobile-first web UI for a self-hosted local Letta agent: chat with transcript grouping, tool approvals, message queue and task-notification cards.
- Manage agents from the UI: create, edit, pin, archive and delete, on phone and desktop.
- Files, Memory and Tasks tabs: browse the agent workspace, download files, preview markdown, read agent memory and background runs.
- Global Settings screen: providers, web search, MCP servers, Google, Codex workers, global skills, notifications and About.
- Sign in through Cloudflare Access, or a local dev bypass when running without it.
- Installable PWA with web push notifications when a finished turn is not being watched.
- Google integration (Gmail, Calendar, Tasks, Contacts) at access levels only the user can set, with reconnect links when access is lost.
- Native `web_search` and `fetch_webpage` tools for every agent, with a SearXNG sidecar and DuckDuckGo fallback.
- Per-agent tool access (Agent → Tools): cut Google down to read-only or off, and allow or block Codex workers per agent.
- One shared MCP list managed from Settings, reachable by agents through `mcp_search` / `mcp_call` native tools.
- Codex workers: delegate a task to a Codex CLI worker and watch its run from the Tasks tab.
- Telegram channel support, opt-in behind the `telegram` compose profile.
- Shared MCP list plus DuckDuckGo search as its first server.
- Give the local LLM up to 30 minutes to start responding, configurable per provider.
- Come back to the agent and conversation you left; conversations are auto-titled.

### Fixed
- Reconnecting Google no longer revokes the token it just obtained.
- A Google API switched off in its Cloud project is reported as such, not as a lost sign-in.
- Stop reports honestly, and each tool call shows one result row.
- The context gauge shows one usage per conversation, counting the prompt cache.
