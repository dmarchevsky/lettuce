# Lettuce

A self-hosted personal AI assistant you can actually live in. Agents keep real
memory, run scheduled tasks, use your tools, and work from your phone — with
your model running on your own machine and your data never leaving it.

![Desktop](docs/images/desktop-chat.png)

## What this is

This repo is the web app: a mobile-first progressive web app plus the backend
that drives a [Letta](https://www.letta.com/) agent server. It is self-hosted
end to end — the agent runtime, the model, and every byte of state live on
your host. There is no Letta Cloud account and no requirement for a cloud LLM
provider.

It is not a chat wrapper around a completion endpoint. The agent behind it is
a long-lived process with a persistent memory store, real shell and file
access in a real directory, and a scheduler that keeps working when you are
not looking.

## Why it exists

Most assistant products are the same three things: a chat window, a stateless
API call, and your conversation history on someone else's server. The
consequences are familiar — the assistant forgets you between threads, its
"tools" are simulated, and anything useful you built lives behind an export
button you hope works.

Lettuce inverts all three:

- **Memory is a database, not a prompt.** Each agent has a versioned memory
  store. It remembers you across conversations, and you can read exactly what
  it decided to remember and when it changed it.
- **Tools are real.** An agent can run a shell command, edit files in a
  workspace you can open in your own file manager, search the web, and read
  your Gmail — through your own credentials, not a demo integration.
- **It keeps working without you.** Turns survive a closed tab, cron jobs fire
  on schedule, and a push notification tells you when something finished or
  needs a decision.
- **You own the whole stack.** One directory holds everything durable. Copy
  it, and you have backed up your assistant.

The trade-off is honest and stated up front: you run this infrastructure.
You pick the model, you keep it running, and you read the security section
before exposing anything.

## Features

### Memory and agents

- **Versioned memory store** per agent, browsable in the Memory tab, with the
  history of what changed.
- **Automatic reflection.** Periodically the agent reviews recent conversation
  and folds what matters into memory. Trigger it by step count or on context
  compaction, or turn it off; merging is automatic or instruction-driven.
- **Multiple agents**, each with its own persona, model, tools, secrets and
  workspace. Pin, archive, rename, delete from the sidebar.
- **Per-agent secrets** — key/value pairs the agent can use without them
  appearing in its instructions.

### Working from your phone

- **Installable PWA.** Add it to the home screen; it looks and behaves like a
  native app.
- **Turns outlive the tab.** Closing the browser does not stop a running turn.
  The backend owns the agent connection, so switching apps never aborts work.
- **Push notifications** for three events — a turn completed, a turn failed, a
  tool needs approval — with per-device preferences and a test button.
- **Reconnects and replays.** Come back after an hour away and the transcript
  is intact, including failures that would otherwise have been lost.
- **Image attachments.** Attach from the camera roll, paste a screenshot or
  drag files onto the composer; a vision-capable model actually sees them.
- **Context gauge** showing how full the window is, including what the prompt
  cache absorbed.

### Tools

- **Web search and page reading** as native tools, backed by a self-hosted
  SearXNG with a DuckDuckGo fallback. No API key, no per-search cost.
- **Gmail, Calendar, Tasks and Contacts** through your own Google OAuth grant, with a
  permission level per service (e.g. mail read-only, calendar read-write).
  Turning a level down revokes the token.
- **GitHub pull-request watching** through the GitHub CLI.
- **Any MCP server** you add, in one list shared by every agent.
- **Tool approvals.** A tool call that needs permission surfaces as a sheet you
  can allow or deny, from any device — and sends a push if nobody is watching.
- **Structured questions.** An agent can ask a multiple-choice question that
  appears as a card you answer or skip; the agent keeps working meanwhile, and
  the answer can come from any device.

### Files and workspaces

- Every agent works in a **real directory** on the host, visible in a file
  browser with inline previews for images, PDFs and text.
- **Git branch switcher** for the workspace, including checking out remote
  branches.
- **Git history** in the Files tab: the commit log of the open folder and a
  per-commit view of its changed files with +/− stats.
- Both controls appear only in a folder that is inside a git repository, so a
  plain workspace shows no dead buttons.
- Agents can **serve small web apps** on a published port range and hand you a
  link.

### Automation and delegation

- **Scheduled tasks.** Cron-style jobs that fire into a conversation — "brief
  me every morning at 7" — whether or not anything is open.
- **Subagents.** Fan work out to a parallel agent and watch it report back.
- **Codex workers.** Hand a coding job to a Codex CLI worker and follow its
  run from the transcript.
- **Remote pi worker.** Dispatch a coding task to a [`pi`](https://github.com/earendil-works/pi)
  agent on another host over SSH, iterate on the same session, read the full
  transcript under Tasks.
- **Skills.** Reusable instructions at global, agent and project scope, with
  the ones the stack needs shipped in the image.

### Channels

- **Telegram.** Talk to your agents from a chat app and pair a chat to a
  specific agent and conversation.

## How it fits together

```
browser ──WSS+cookie──> bff (Bun/Hono) ──one ws──> letta app-server
                              │                        ├── your model server (/v1)
                              │                        └── mods (native tools)
                              └── sidecars: searxng, ddg-mcp, google-mcp, cloudflared
```

The BFF is a session multiplexer, not a proxy: exactly one upstream connection
to the app-server is owned by the backend, and browser sessions multiplex over
it. That is what lets a phone background its tab without killing the turn.
`CLAUDE.md` is the internal engineering guide and explains this and the other
load-bearing invariants.

## Requirements

A host with **`git`** and **`docker`**. That is the whole list — no Node, no
Bun, no pre-built images, and no second checkout.

A model server (llama.cpp or anything OpenAI-compatible) needs to be reachable
from the container. The app does not ship a model.

## Quickstart

```bash
git clone https://github.com/dmarchevsky/lettuce.git
cd lettuce

cp docker/.env.example docker/.env
# Then edit docker/.env — at minimum:
#   SESSION_SECRET   -> openssl rand -hex 32
#   LETTA_STATE_DIR  -> an absolute path, e.g. /srv/letta
#   PUBLIC_ORIGIN    -> the URL you will actually open

docker compose -f docker/compose.yml up -d --build
```

Open `http://localhost:8090`.

By default, the stack runs in **local mode**, which has no authentication — read the next section before putting it anywhere other than your own machine.

To configure the model endpoint, go to Settings → Providers & models and configure an OpenAI-compatible endpoint or select a cloud provider.

For details on configuration, see [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

## Two running modes

One setting, `COMPOSE_PROFILES`, decides which mode you are in and which
optional containers exist.

| | Local mode (default) | Cloudflared mode |
|---|---|---|
| Reachable from | Your LAN, directly | Only through the Cloudflare Tunnel |
| Sign-in | `DEV_BYPASS_EMAIL` — no credential check | Cloudflare Access (Google login) |
| Cloudflare account | Not needed | Required |
| `cloudflared` container | Never created | Created |
| Good for | Development, a trusted home network | Anything reachable from the internet |

**Local mode authenticates nobody.** Whoever can reach the port *is* the
configured user, and that user's agent has your shell, your files and your
integrations. The app refuses to start with a bypass on a non-loopback origin
unless you also set `DEV_BYPASS_ALLOW_REMOTE=true`, which is the deliberate
"yes, on this trusted network" switch. Never combine a bypass with a public
deployment.

For real remote access, set `COMPOSE_PROFILES=cloudflared` and put Cloudflare
Access in front of it. The walkthrough is in
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

## Where your data lives

Everything durable is under one directory, `LETTA_STATE_DIR`, and you can back
the whole install up by copying it.

```
$LETTA_STATE_DIR/
  letta-home/     settings, global skills, CLI logins
  letta-data/     conversations and agent memory
  workspaces/     the directories agents work in
```

Back that one directory up and you have everything.

## Documentation

- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) — every environment
  variable, the Compose profiles, deployment walkthroughs (local, Cloudflare
  Tunnel, production), integrations, upgrades, and the security model.
- [`docs/upstream-notes.md`](docs/upstream-notes.md) — the incident stories
  behind the rules in the engineering guide.
- [`AGENTS.md`](AGENTS.md) — the internal engineering guide. `CLAUDE.md` is a
  symlink to it, and the task-scoped detail lives in
  [`.agents/skills/`](.agents/skills).
- [`.pi/`](.pi) — the harness configuration the repo ships with: guardrails,
  runbook prompts, and the size/anchor budget `bun run check-docs` enforces.

## Screenshots

| Chat on desktop | Chat on a phone |
|---|---|
| ![Desktop chat](docs/images/desktop-chat.png) | ![Mobile chat](docs/images/mobile-chat.png) |

| Settings | Scheduled tasks |
|---|---|
| ![Settings](docs/images/desktop-settings.png) | ![Tasks](docs/images/mobile-tasks.png) |

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev          # Vite + BFF
bun run verify       # worktree, version-pin, docs, lint, typecheck, tests, build
bun run check-docs   # AGENTS.md and .agents/skills stay honest
```

Feature work happens in a worktree on a feature branch
(`git worktree add .worktrees/<name> -b <branch>`), and nothing is
"done" until it is running in the container and you have tested it there — `AGENTS.md` holds the
gate and the workflow, and `.pi/extensions/guard.ts` asks you (or refuses outright) before
`git push`, worktree/branch removal, and `docker compose … rm|down|stop`.

## License

lettuce is licensed under the [Apache License 2.0](LICENSE).

It bundles no upstream code: it runs [letta-code](https://github.com/letta-ai/letta-code)
(Apache-2.0, © Letta Inc.) unmodified, as its published npm package and Docker image, and
talks to it over the public app-server protocol. "Letta" is a trademark of Letta, Inc.;
Letta's brand assets (name, logo, wordmark) are not licensed here, and this project is not
affiliated with or endorsed by Letta.

Everything else is a separate sidecar container under its own license: SearXNG (AGPL-3.0),
google_workspace_mcp (MIT), duckduckgo-mcp-server (MIT), cloudflared (Apache-2.0), Codex CLI
(Apache-2.0), GitHub CLI (MIT). Claude Code is installed under Anthropic's commercial terms.
Those CLIs are installed into images from npm at build time — nothing is redistributed from
this repository.
