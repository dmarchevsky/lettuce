# Changelog

All notable user-facing changes to lettuce, newest first. Version tags and
`VERSION` are defined in `AGENTS.md` and the `lettuce-releasing` skill.

## [Unreleased]

### Added
- **Filter the model list by name.** Once more than ten models are served (an OpenRouter connection lists hundreds), the **Model** sheet, in the chat and in an agent's settings, opens with a **Filter models by name…** box that stays in view as the list scrolls. Every word you type has to match, in any order, so `opus 4.5` finds *Anthropic: Claude Opus 4.5*.
- **See the cron jobs agents set up in Tasks.** Each shows its schedule and command, read-only; "Ask agent to change" starts the request in chat.
- **Allowed recipients for Gmail and Calendar.** Settings → Google Workspace takes a list of
  addresses and `@domain`s; when it is set, agents can send mail and calendar invitations only
  to those. The Google sidecar enforces it on the requests it sends to Google, so an agent
  cannot get around it by calling the sidecar directly, and reply-all, forwards, filters and
  attendee notifications are checked too. `calendar_event` gains `notify_attendees` for changing
  an event without emailing everyone on it.

## [v0.25.0-letta_0.34.21] - 2026-10-30

### Changed
- **OpenRouter, Together AI, Fireworks, Hugging Face, NVIDIA NIM, Vercel AI Gateway, Baseten and Groq serve their models.** They name models `vendor/model`, which a provider you name cannot carry, so an OpenRouter provider saved fine and then served nothing. **Add provider** now connects these hosts through the app-server as `openrouter/<vendor>/<model>`, one connection per host, with an optional base URL and a picker of which models to show, read as **Models (N of M)** on the row.

### Fixed
- **Editing a hosted provider no longer asks for the key again.** Leaving the API key blank on **Edit** failed with "needs an API key", although the field said a blank key keeps the stored one; it now does.
- **No more "an endpoint returned a different set of models" warning.** Settings → Providers & models compared each model list with the one before and blamed a load-balanced `/models` whenever they differed, so connecting, disconnecting or picking models raised it too, and it said nothing you could act on. The warning is gone.
- **A provider the app-server refuses says so.** A save that the app-server would not load used to close the sheet as if it had worked; the sheet now stays open on the reason, and the provider's row carries it too. One refused provider no longer takes every provider listed after it down with it, and Settings → Web search's error line, which read letta-code's report in the wrong shape and stayed empty, now shows the web tools' load errors.
- **Test no longer pre-ticks models that cannot be saved.** OpenRouter's `~…-latest` aliases, and any id with a `/`, are left out of the list with a count of what was skipped, instead of failing the save with "is not a model id".

## [v0.24.0-letta_0.34.21] - 2026-10-29

### Added
- **Give an agent a face.** Each agent can carry a glyph of its own — picked from a grid of common emoji or typed in, one character or two — and a colour of your choosing, both in **Agent → General**. It shows everywhere that agent appears: the rail, the switcher, the conversation panel's head and the header's corner. An agent you leave alone keeps the initial and hashed colour it always had, and the switcher draws that face round like every other surface now.

## [v0.23.1-letta_0.34.21] - 2026-10-29

### Fixed
- **Custom headers per provider.** An endpoint behind Cloudflare Access or a corporate proxy can be a provider now: declare each extra request header once in the provider form and it is sent with every call to that endpoint, model probe included.

## [v0.23.0-letta_0.34.21] - 2026-10-28

### Changed
- **Desktop navigation is a rail plus a conversation panel.** Agents and panes live in a narrow
  rail on the left; conversations sit beside it, pinned as a column or peeking on demand.
- **Rest on an agent's face to see its conversations** in that same panel, and pick one to
  switch — a hover no longer costs you the conversation you were reading.
- **Picking another agent keeps the tab you were on** — Files stays Files, with the new agent's
  files — and the agent names are spelled out under their faces.
- **A phone's bar is five slots, and the open agent's face moved to the header**, where it names
  the agent and opens the switcher.

### Removed
- **The top tab strip and the slide-out agent drawer.** The rail answers "which agent" and
  "which section" in one column; the phone bar does it at the bottom.

### Fixed
- **The remote-Pi status card stops going red on a loaded CI runner.** The card's test read the run record a fixed moment after the line that owed a flush, so on a busy runner it saw the previous flush and failed with `Expected: >= 3, Received: 1` — green on a re-run, red again later. It waits for the runner's own write confirmation now, and a deliberately slow test disk keeps a fixed-timer wait from creeping back. A change to tests or fixtures alone no longer owes a changelog entry of its own.

## [v0.22.0-letta_0.34.21] - 2026-10-26

### Added
- **Tools an agent installs survive updates and restarts.** `npm install -g`, `go install`, `uv tool install` and checked binary downloads land in a new `tools/` folder under the state directory, and plain cron jobs an agent sets up come back after a recreate too. Agents also pick the right scheduler for a job: an "every day at 7" schedule no longer shifts an hour with daylight saving time, and a cron script can wake the agent only when it finds something. Tools installed before this release need reinstalling once.

## [v0.21.2-letta_0.34.21] - 2026-10-26

### Fixed
- **The browser tab names the open agent.** With a chat open with Alfred the tab reads "Alfred | Lettuce", so a row of tabs — or a backgrounded one on a phone — says which agent it belongs to.

## [v0.21.1-letta_0.34.21] - 2026-10-26

### Fixed
- cloudflared 2026.10.1 → 2026.10.4 — Cloudflare asks every tunnel to run 2026.10.2 or later. The tunnel container only. Recreating it drops the tunnel for a few seconds, so the app is briefly unreachable while everything else keeps running.

## [v0.21.0-letta_0.34.21] - 2026-10-24

### Changed
- **The desktop app is denser, the phone is not.** Rows, tabs, menus and the composer take a compact desktop scale and message panels are rails instead of filled panels; a touch screen gets the 44px targets back and two lines of composer, while the desktop keeps one.
- **Archive a conversation from its row.** On desktop the row you point at grows a one-click Archive (the undo is one more click) and archived rows come back behind a centred "Show archived (n)" link instead of a checkbox; a phone keeps the ⋯ menu as the only route.
- **An agent's model is picked in the model sheet.** Agent → General opens the same provider-grouped sheet the conversation uses rather than a native dropdown, the pick is staged and saved with the agent instead of applied on tap, and the Model sheet's toolset list sits behind a header naming the toolset in force.

### Fixed
- **The release gates say what actually happens.** The release stage now states plainly that a versioned release's tag bump recreates `app-server` (so every in-flight turn dies, no drain) and to use `--no-deps` when a turn matters; it names the one command pair that makes `deploy-check` green on a build-locally machine after a release cut in a worktree; and when the stack signs in with a password, an agent that cannot run `smoke` or `ui-check` records what it probed in the container instead, and says out loud that a human pass is still owed.

### Fixed
- **A flow starts from a current `main`.** The playbook now checks both directions before `flow approve`: local commits ahead of `origin/main`, and — the one nothing caught — a local `main` *behind* it. The worktree's branch is cut from local `main`'s tip, so a stale one put a whole feature, its diff and every check it ran, on an old base, and the cost only showed up at pre-release as a merge plus a full CI re-run.

### Security
- **The secret scanner is a gate now.** CI's gitleaks job was advisory, so a commit carrying a live session secret could merge under a green `ci` — which is exactly what happened on this history. It is part of the required check now, and the one committed fake (the fixed string the config unit tests use to clear the minimum secret length) is allowlisted by value rather than by file, so a real secret pasted into that test tomorrow still stops the merge.

## [v0.20.2-letta_0.34.21] - 2026-10-24

### Fixed
- **Stopping a turn stops the work it started.** A `web_search`, a page fetch or a Google call that was still running when you hit Stop used to run to its end for a result nobody wanted — up to 15 seconds of search or a minute of page reading, with the sidecar still doing it. A cancelled turn now cancels the call underneath it and answers `cancelled` instead of blaming a service that is fine.
- **The agent runs a newer Letta Code.** 0.34.16 → 0.34.21, seven releases of upstream fixes, the one that shows being a tool that stops replying no longer holds the whole turn hostage. Also: the connection keepalive now tracks each socket on its own, a coding worker inherits a pointer to the agent that dispatched it, and Codex (0.164.0), Claude Code (2.1.310) and SearXNG moved with it.
- **A bundled skill that needs Letta Cloud stays hidden.** Music generation is now hidden from local agents like image and speech generation already were, and the memory-palace skill upstream deleted is no longer on our hidden list — an agent's own copy of it is listed again, as it should be.

- **`bun run check-pin-upstream` tells you how far behind you are** without anyone sweeping four registries by hand, and what a bump costs (Google's recorded tool list, a worker re-check). For Letta Code it reports the newest release with a Docker image, which is not the newest npm one — those two disagree most weeks.

## [v0.20.1-letta_0.34.16] - 2026-10-21

### Changed
- **The release checklist builds the bundle before it checks it.** After a release cut in a worktree, `deploy-check` compared the running container against this host's stale `web/dist` and only named `build:bff`, which fixes the image and never the host's copy — the checklist runs `bun run build` first now, and says what to record when a merge ships nothing an image carries.
- **A look at the running stack never touches your data.** The playbook now forbids a session from moving anything under the state directory or the sign-in store, from claiming an instance it was not handed, and from leaving anything durable in a container path — a recreate deletes it, and one session's screenshot routine cost an operator their password.
- **The playbook says what a guard rule cannot guard.** `protect` names a path and its subtree, never a glob, so a `docker/.env.bak-*` left beside the protected `.env` was never inside its reach — flip a variable in place and let `.gitignore`'s `.env.*` be what stops a secret backup from being committed.

### Fixed
- **A proxy on your own machine can no longer let a web page use the agent's tools.** The BFF trusted anything arriving from loopback on its internal tool endpoints, and a reverse proxy on the same host makes every browser request look like that — a forged cross-origin request could have run `pi_exec` on a remote worker or acted as you in Gmail without signing in. A call that names a browser origin is now refused as if the endpoint did not exist, and the agent's own tools answer exactly as before.
- **Coming back after an app-server restart stops being deaf.** The BFF re-subscribed to conversations one at a time, so a long-lived install spent minutes on it — and a cron or Telegram turn finishing in that window produced no notification at all, because nothing was listening for its conversation. It is eight at a time now.
- **Several large downloads at once stop risking the whole app.** Four concurrent 25 MB workspace downloads could hold about 240 MB in the one process whose death stops every running turn without warning; the cap is two now, the same ceiling uploads already used, and a third file simply waits.
- **A remote-pi follow-up stopped re-reading history.** Finding which worker made a session consulted an index instead of parsing every stored run record on every dispatch, and a run card's "bytes captured" now counts bytes rather than characters.
- **Opening a conversation no longer writes to the agent's folder.** The marker file that makes a workspace exist is created once per agent per page load, not on every conversation switch.
- **A route can no longer be added outside the sign-in gate.** The session check covers only routes registered after it, so an endpoint added above it would answer anonymous visitors; a build check now fails the branch when that happens, and reads its list of deliberately-public paths out of the same file.

## [v0.20.0-letta_0.34.16] - 2026-10-21

### Added
- **A password you choose in the browser.** A fresh instance asks you to pick one (ten characters or more) and signs you in from the same page — nothing is generated into a log and nothing goes in `.env`, and Settings → Sign-in changes it later, asking for the current one.
- **Sign in with Google.** `SIGNIN=google` puts a Google button on the sign-in screen and lets in only the addresses in `ALLOWED_USERS`, on the same OAuth client as Settings → Google Workspace.

### Changed
- **How you are reached and how you prove who you are are now two settings.** `ACCESS=lan|cloudflared` picks the route and `SIGNIN=none|password|cf-access|google` the method, they are independent of each other, and Settings reports both — including where the port is actually listening.
- **The UI port binds `127.0.0.1` by default.** An install that was reachable from the LAN through the old open port needs `BFF_BIND=0.0.0.0` to stay that way, and any install with a wide port now has to name a sign-in method.
- **Settings → Google is Settings → Google Workspace**, and Settings gained Access and Sign-in under a new Deployment group.

### Removed
- **`DEV_BYPASS_EMAIL` and `DEV_BYPASS_ALLOW_REMOTE` are gone** — having them in `docker/.env` now stops the BFF at boot and names the replacement: `SIGNIN=none` for an instance that only ever answers this machine, `SIGNIN=password` everywhere else.

## [v0.19.0-letta_0.34.16] - 2026-10-20

### Changed
- **Remote Pi progress arrives on its own.** The run card, the Runs list and the topbar `pi` chip now follow a run as it streams instead of re-reading the server every few seconds, so a tab left open asks nothing at all while nothing is running — and a finished run flips to its verdict without a reload.

## [v0.18.0-letta_0.34.16] - 2026-10-20

### Added
- **Upload puts a file where an agent can read it.** Files gained an Upload button: pick a photo or a PDF on your phone and it lands in the folder you are browsing (up to 25 MB), and a name that already exists there is refused until you type another.

## [v0.17.0-letta_0.34.16] - 2026-10-20

### Added
- **Running children show live progress.** Tasks → Running names what each subagent or coding worker is doing right now (its last tool call, tokens, elapsed), and a workflow row gained its agent counts and per-phase progress. While a turn waits on a delegated subagent, the working line carries the child's activity instead of just "Thinking".

## [v0.16.0-letta_0.34.16] - 2026-10-19

### Added
- **Tasks shows a Monitor's backup wake.** A running watch with an armed fallback now says when a silent one wakes the agent, so a quiet watch is visibly watched.

## [v0.15.2-letta_0.34.16] - 2026-10-19

### Fixed
- **A typed `/clear` starts a new conversation** instead of sending the word to the agent, which is what the CLI habit now hits since the app-server removed the command. Nothing is deleted: the old conversation stays in the list with its messages.

## [v0.15.1-letta_0.34.16] - 2026-10-19

### Fixed
- **A subagent that went the wrong way could not be interrupted.** Tasks → Running now offers **Stop** on a subagent row and the app-server aborts that worker; a shell job still has no stop — that one is an agent tool.

## [v0.15.0-letta_0.34.16] - 2026-10-18

### Changed
- Synced letta-code 0.34.9 → 0.34.16. A running Codex or Claude Code worker can now be steered, resumed or stopped by the agent that spawned it; a workflow worker gets the same mod tools the parent agent has, so a workflow step can read Gmail or search the web; a `Monitor` watch can arm a backup wake, so a watch that goes silent brings the agent back instead of leaving you waiting; and a long conversation's transcript is streamed rather than read whole, so an old conversation cannot outgrow the string limit on open. The app-server image is rebuilt, so the deploy recreates `app-server` and drops any turn in flight.
- **Two more bundled skills are hidden from local agents.** `managing-agent-webhooks` and `speech-generation` arrived upstream in 0.34.13 and are Letta Cloud features — inbound webhooks and cloud speech — so a local agent could only fail with them. Settings → Skills no longer lists them, matching what the app-server hides on its own.
- Codex CLI 0.162.0 → 0.163.0 and Claude Code CLI 2.1.295 → 2.1.302 — both are built into the app-server image, and letta-code drives each over its own protocol, so a worker run is the thing to re-check after the deploy.
- SearXNG 2026.10.9 → 2026.10.17 — the search sidecar the BFF asks for JSON results; newer engine definitions are what keep `web_search` returning things.
- cloudflared 2026.10.0 → 2026.10.1 — the tunnel container only. Recreating it drops the tunnel for a few seconds, so the app is briefly unreachable while everything else keeps running.

### Removed
- **`/clear` is gone, because the app-server took it away.** letta-code 0.34.15 removed the remote clear: it re-pointed a runtime at a new conversation while its own key still named the old one, which corrupted the durable record of what had been accepted. The slash palette no longer offers it (it lists what the app-server advertises, and that no longer includes it) and the BFF refuses the command id outright. Starting a fresh conversation is the **+** in the sidebar or the switcher, which is the path the app has always had.

## [v0.14.0-letta_0.34.9] - 2026-10-17

### Added
- **Production deploys pull our images instead of building them.** Each release publishes the five images we build to GHCR under its tag (and as `latest`), and one setting on the host points at them — no build on deploy, no registry login, and Settings → About names the commit CI built.

## [v0.13.3-letta_0.34.9] - 2026-10-15

### Removed
- **The batched release command, the guard extension, and the `/release`, `/finish` and `/verify` runbooks.** The harness is dev-flow now: every shipping feature's flow bumps `VERSION` and tags its own merge, and the safety rules the extension enforced are a `flow-guard` block in the tracked playbook.

## [v0.13.2-letta_0.34.9] - 2026-10-12

### Fixed
- **A failed save is a failure everywhere.** The same fact — "that did not save" — was grey text in Secrets, Tasks, Files, Memory, MCP and Providers, red text in Reflection, Codex, Claude and Remote Pi, and an amber box in Web search, the model picker and the agent lists. Nothing said it to a screen reader either: no save failure in the app had a live region, so the message that matters most was the one a keyboard user never heard. A result of something you pressed is now a **toast** (which announces itself), a state the screen is about stays a box on the page, and every banner that can be retried has a **Try again** on it.
- **The failure toast was not red.** It asked for a colour token that no rule defines, so an invalid property made its border and text fall back to whatever the page was already using — a failure looked exactly like a success.
- **Saved said one thing, not nine.** "Saved. Agents see the change on their next turn", "Saved. Applies from this agent's next turn", "Saved. It applies once an agent exists to carry the reload", "Saved, but the app-server could not be reloaded…" and five more are now four phrases, each meaning exactly one thing, in one file: what applies on the next turn, what applies on reconnect, what waits for an agent to exist, and what the next worker picks up. When the record saved but the reload did not, the message is amber, not the same grey as a clean save.
- **Rows stopped jumping when you pressed them.** "Saving…", "Creating…", "Deleting agent…" were paragraphs under the button, so saving changed the height of the page three times per press — progress, then "Saved.", then nothing. The button carries that now.
- **A result no longer waits for a click to disappear.** The Tools tab's "Saved." sat on the page until some unrelated action overwrote it, and the app's only session-wide error had a dismiss button nobody found because nothing else surfaced it, so it never went away. They dismiss themselves now.

### Changed
* **The Agent tab no longer implies its settings are shared.** A line above every
  agent section read *Settings for every agent* — a link to the global Settings,
  but standing alone above a per-agent section it read as a heading saying the
  section below was shared, which is the opposite of what it holds. It is gone;
  the gear in the top bar is the way there, and the Tools tab keeps its own line
  because that one says which agent the boxes belong to.

* **Remote Pi states a failure, not a pill.** The status line said one long thing
  — pi version, host, pinned fingerprint and age on a single unwrapping line — so
  on a phone it ran off the right edge and what got cut was the age that says
  whether the state is still true. It is now a row: a word of state first (*Ready*,
  *Not pinned*, *Sign-in refused*, *Pi not on PATH*, *Working folder missing*,
  *Unreachable*), the host and the age wrapped underneath, and the pinned
  fingerprint on its own line with a **Copy** that copies it whole. A failed check
  keeps ssh's own sentence in a banner next to the one thing that fixes it — copy
  the public key, focus the PATH prefix or the working folder, or try again — and a
  passed check says so as a toast, because pressing **Check host** and seeing
  nothing move is how people press it twice. The per-agent pane now says whose host
  it checked (`inherited from Settings`) and no longer lets a check made against a
  different target borrow a green dot.

- **Settings says less.** The line above every global section — "What one agent may use is under Tools; what it is named and told is under Agent." — is gone, along with the toggle descriptions that restated the toggle ("Allow Codex workers" / "Agents may hand coding work to a Codex subagent"), the hint under a field that repeated the value already typed in it, and "Settings for *Olla* only.", which named the tab you are in. The one cross-tab pointer that sentence was protecting for — that per-agent Remote Pi lives under Tools while its default lives here — is now said in Remote Pi settings, where it changes what you do.
- **Two empty states, one sentence.** The Tools tab and the Agent tab each had their own wording for "no agent selected".
- **Text that repeats is one constant.** "Leave blank to keep the stored value" was written three times, once as "stored key"; the JSON-output button's tooltip and its screen-reader name had drifted into "is required" and "required".

### Fixed
- **The Files tab stops breaking into three lines on a phone.** Its toolbar holds the folder, **Up** and **New file** on one row; a long conversation folder squeezed them until the buttons wrapped — "Up" over "Up", "New file" over three lines, the bar 70 px tall instead of 40. A text link is one line now, so the path is the only thing that gives up characters.
- **The Agent tab's five sections share one row at phone width.** *Memory* wrapped onto a row of its own and took 40 px off the tallest form in the app; the chips now squeeze the way the six tab names already do at 390 px.
- **An agent with no secrets is told once.** Agent → Secrets printed "0 secrets configured" and then "No secrets configured for this agent." The count line appears only when there is something to count.

### Changed
- **One blue.** The composer's round send and stop carried their own blue and red (`#2e7df6`, `#f0463c`) with white ink while every other filled control uses the accent with a dark ink; they take the accent now, and the ink that sits on a saturated fill is a token (`--on-accent`) instead of five different hexes.
- **Send is a target, not a dot.** Send and stop were 26 px — the smallest controls in the app, for its main verb — and keep the 40 px every other control keeps. Text links (Up, New file, Find, Reveal, Edit, Delete) are untouched under a mouse and get a fingertip's padding under a finger.
- **The top bar says what it means where there is room.** The amber triangle and the green dot stay the whole state on a phone; from 640 px they are joined by their words — **Dev bypass**, **Live**, **Reconnecting…**, **2 responding** — so a state is never colour alone.
- **Shapes and states are tokens.** `--radius` is used at its call sites at last, joined by `--radius-pill`, `--radius-round` and one `--disabled` for every control that cannot be used; the Remote Pi card — the app's only rounded card — is square like everything else; and the half-step sizes (11.5, 12.5, 14.5 px) folded into the sizes around them.

## [v0.13.1-letta_0.34.9] - 2026-10-11

### Fixed
- **A saved MCP server is no longer silently lost.** Saving Settings → MCP servers and turning Google on read the same shared list, changed their own copy of it and wrote it back, so whichever of the two finished last overwrote the other — the screen then showed a server that was never stored, until the next save. Saves now queue one behind the other, and a change that turns out to change nothing touches the file at all.
- **Cron turns are not invisible after a restart any more.** When the BFF reconnects to the app-server it re-watches every conversation it is responsible for, but it asked for one page of the hundred most recently active per agent and stopped there. A conversation outside that page — or beyond the first hundred — got no notification, no unread badge and no working indicator for up to half an hour, and nothing in the UI said why. The first sweep after a connect now walks the app-server's whole list and subscribes to all of it; the periodic sweep keeps its smaller, cheaper shape.
- **Memory no longer grows without bound on a long-running BFF.** Three caches remembered everything they had ever seen — per-conversation context limits, subagent ancestry, and in-flight request bookkeeping — and only dropped entries when something fresher replaced them. An abandoned conversation, a subagent that never came back, or one app-server command that never answers (a `grep_in_files` with the wrong key is known to do this) each kept their entries for the life of the process. Each now has a ceiling, and the oldest entry goes first.
- **The end of a turn stops echoing.** When a browser tab goes away mid-turn the BFF tells the app-server to run whatever the queue holds. It sent that nudge as if it were a browser, so the acknowledgement came back down the shared wire, was counted, buffered for replay and handed to every open tab, none of which wanted it. It goes out on the BFF's own channel now, where nothing echoes it back.
- **A file that is too large to download says so.** Chat links and the Files tab read a workspace file through the app-server, which holds the whole thing twice in the BFF's memory — the encoded text and the decoded bytes. One 25 MB file is about 60 MB of heap, and nothing bounded how many could be in flight at once; since the BFF is also the app-server's only subscriber, a BFF killed by memory cancels every turn that was running. A file over 25 MB now comes back as "too large" instead of being read at all, and no more than four downloads run at a time.
- **The Context sheet stops asking the app-server the same question twice.** Reading it fetched the agent and the conversation, then fetched both again to work out which model was in force, and listed every agent to size the one it was already holding. Opening a conversation now costs two requests instead of five; the agent is read a second time only in the one case that just wrote a new window, which is once in an agent's life.
- **A wrong API path is a 404, not the web app.** Every unmatched `GET` fell through to the single-page fallback, so `/api/typo` answered 200 with HTML: the app reported "Unexpected token '<'" instead of a missing endpoint, and a script checking for a 200 was told the path existed.

### Changed
- **The retry loops that wait for the app-server now give up.** Reloading the native tools after a settings save, and mirroring your providers to the file the coding workers read, retried every thirty seconds until one succeeded — which, if the thing that failed was the settings themselves rather than the moment, was never. After twenty attempts either loop stops and says so in the log; the next connection retries it anyway.
- **The app's own files are cached properly.** Vite names every build file with a hash of its contents, so `/assets/index-BKZK0mza.js` is the same bytes for as long as that release exists — and it was being served with no cache header at all, which means a phone refetched the whole bundle. Hashed files now say "immutable for a year", and the shell, the service worker and the manifest say "always revalidate", so an update still lands on the next open.
- **Every agent is looked up once, not twice.** The name in a push title and the parent tags behind per-agent tool access each asked the app-server about the same agent. They share one lookup now.
- **Reconnecting no longer rewrites the skills it just wrote.** The skills this app ships to every agent were written over the connection on every single connect, so an app-server that restarted five times in the night was given the same files five more times.

## [v0.13.0-letta_0.34.9] - 2026-10-11

### Added
- **You add providers now; nothing is pre-listed.** Settings → Providers & models used to show the whole catalog of provider types, one endpoint per type at most. It is your list now: **Add provider** takes a type (llama.cpp, Ollama, LM Studio, any OpenAI-compatible endpoint, Anthropic, OpenAI, Gemini, Mistral, OpenRouter, DeepSeek, Groq and a dozen more hosts — each prefills the API it speaks and its base URL), a name, a base URL, a key, and either the endpoint's own model list or ids you type. A **Test** button in the sheet's footer reaches the endpoint and reads its model list before you commit to a provider, so a wrong URL or key is caught there rather than in a conversation — and it answers in a **toast** over the sheet, in the endpoint's own words when the endpoint has words. The name becomes the model handle prefix — `llama 3b` serves `llama-3b/<model>` — so any number of providers may share a type and only their names have to differ: that is what makes several OpenAI-compatible endpoints, or two keys for the same host, usable at once. Each row expands to its models, and **Edit** on one of them declares what it can do — vision, reasoning, its real context window — because that is a fact about a model, not about the endpoint it came from. What the app-server already had stays listed, tagged `app-server`, keeping its own fields and Disconnect. Bedrock, Vertex, Azure OpenAI, GitHub Copilot and the ChatGPT / Claude subscription plans are not offered — they need vendor or OAuth sign-in, which is `letta connect` on the app-server host.

### Removed
- The **"Shared by every agent."** line in Settings. The half of it that said where the per-agent settings live (Tools, Agent) stays.

## [v0.12.0-letta_0.34.9] - 2026-10-10

### Added
- **The context gauge now measures how close the conversation is to compacting, and keeps that point ahead of the server.** **Context** gives one editable number — the **context size**, what the model server gives one request (llama.cpp's `n_ctx` per slot) — beside what the model in Settings → Providers & models declares, the output every request promises, and the point the conversation therefore compacts at. By default the size comes from the declaration and Lettuce applies it to every agent on that model, which is the failure that has been killing long conversations: a model declared at 262 144 tokens while the agent was limited to 128 000 meant the declaration did nothing, and a model whose declared output (32 768 is common) is bigger than letta-code's 16 384-token compaction reserve meant the server refused the request at `context − max output` before the summariser ever got a turn. What letta-code is given is now derived — the window whose own threshold lands exactly on that compact point — so upstream's compaction does the work, slightly earlier than it would have. Tap the size to set it per conversation or per agent, and **Use automatic** hands it back to the declaration.
- **The BFF compacts a conversation that filled its window.** After a turn ends, if the last step sat at 90 % or more of the window — or the turn died on what reads like a full context (`the request exceeds the available context size`, `n_ctx`, `prompt is too long`, …, worded as llama.cpp and Ollama write it, which is not how letta-code's own classifier is written) — the BFF compacts the conversation itself through the same verb `/compact` uses, once a minute at most per conversation. `CONTEXT_WATCHDOG_RATIO=0` switches it off; `docs/CONFIGURATION.md` has the details.

### Fixed
- **`/compact` now shows that it started.** Its first act is a start marker and its answer arrives a minute or more later, and the transcript threw the marker away — so a compaction looked like nothing had happened until the summary landed. A running compaction now draws a pulsing **Compacting** line in the composer's working line — the same place `Thinking` and `Writing` live, counting from the moment it began — and a "Compacting the conversation…" line in the transcript that its result replaces, so one compaction is one line.
- **The context gauge stops reporting a stale fullness after a compaction.** Compaction shortens the history but reports nothing the gauge can use — the before/after numbers upstream sends count the message history alone, with no system prompt or tool schemas — so the bar kept drawing the pre-compaction number, or the one from before a BFF restart. It now reads "— / compact point" until the next step reports real occupancy, which is the honest answer, and the last finished turn survives a BFF restart instead of being forgotten (`CONTEXT_USAGE_FILE`).

## [v0.11.0-letta_0.34.9] - 2026-10-10

### Added
- **Settings → About now lists what this deployment runs.** The Connection and Backend rows are gone (the connection state has its own indicator, and the backend has always been local), and in their place a **Components** list gives the version of each piece this install switched on: letta-code, the coding CLIs, the search and Google sidecars, the Cloudflare tunnel. Each number comes from wherever it can actually be read — the app-server answers for itself, the Codex/Claude/GitHub CLIs report theirs from inside the image at build time, and a sidecar's is the pin its image tag was built from — and a component this install does not have is simply absent.

### Changed
- **workspace-mcp 1.29.0 → 2.1.0** — the Google sidecar. Its level → scope table, credential file format and command-line flags are unchanged, so nothing to re-grant: an existing connection keeps working across this deploy. What moved is the tool schemas underneath — `draft_gmail_message` gained forwarding parameters and stopped requiring a subject and body up front — and the curated `gmail_*` / `calendar_*` / `tasks_*` / `contacts_*` tools the agents use were re-recorded against the new release.
- Synced letta-code 0.34.1 → 0.34.9: agents with the new memfs memory layout get a read-only **Memory** tool for browsing their own memory tree, workflow runs report per-phase progress and token counts, subagents can nest one layer and report back to the parent that spawned them, tool returns and user messages are scanned and redacted for anything matching a stored secret, a scheduled (cron) turn now runs even when no client is attached, and a queued message carrying a photo over 1 MiB is no longer silently dropped. The app-server image is rebuilt, so the deploy recreates `app-server` and drops any turn in flight.
- SearXNG 2026.9.23 → 2026.10.9 — the search sidecar the BFF asks for JSON results; newer engine definitions are what keep `web_search` returning things.
- cloudflared 2026.8.3 → 2026.10.0 — the tunnel container only. Recreating it drops the tunnel for a few seconds, so the app is briefly unreachable while everything else keeps running.
- GitHub CLI 2.101.0 → 2.102.0 — only the `WatchPR` tool's `gh api` calls touch it; built into the app-server image.
- Codex CLI 0.157.1 → 0.162.0 — five releases, and letta-code drives it over its app-server protocol, so a worker run is the thing to re-check after the deploy. The app-server image is rebuilt, so the deploy recreates `app-server`.
- Claude Code CLI 2.1.285 → 2.1.295. The app-server image is rebuilt, so the deploy recreates `app-server`.

### Fixed
- **A Codex or Claude Code block now reaches what an agent spawns.** To the app-server a subagent is
  an agent of its own, so the block the Tools tab set on a parent agent said nothing about it: an
  agent with workers switched off could ask a general-purpose subagent to start one for it, and
  since letta-code 0.34.4 a subagent can nest one layer further and start one itself. The block now
  follows the parent chain — the policy asks the BFF about any agent it has never seen, and the BFF
  answers for every ancestor it has.
- **The `Memory` tool finally has a name in the UI.** A memfs-v2 agent browsing its own memory
  showed as "Use Memory" with nothing beside it in the working line and the transcript.

## [v0.10.0-letta_0.34.1] - 2026-10-09

### Added
- **A finished remote pi run reports itself back.** The conversation that dispatched a `pi_run` (or `pi_send`) gets a task notification the moment it settles — state, exit, what pi last said — as a real message, so the agent no longer walks the turn through `pi_wait` and `pi_status` polling to find out. `pi_status` stays for progress when you ask, `pi_wait` for when a turn must hold; the run-start ack now says so.
- **Agents can wait on the remote pi instead of poking it.** `pi_wait {run}` blocks until a run settles (up to 2 minutes) and answers with the same report `pi_status` gives — the sleep-60-then-poll loops and self-scheduled wake-ups a dispatched task used to require are gone. And when a run settles, your browser gets a **push** ("Remote pi completed · <task>"), the same channel turn notifications use — you no longer need the agent to be mid-turn to find out.
- **A runaway remote pi can really be stopped.** `pi_stop {run, force: true}` kills the pi process on the remote host too and records the run as *cancelled*; the default stays detach-only, which only closes Lettuce's capture and leaves the remote working.
- **The remote pi now has a place on screen.** When an agent dispatches one, a **live run card** appears in the transcript where it was started: the step in flight, the last thing pi said, event and byte counters that tick as the stream flows, and **Stop** / **Force stop** beside them — no asking the agent to relay `pi_status`. The new **Runs** tab is where worker runs live — Codex threads, Claude Code sessions and remote-pi runs with their full live viewers (Tasks is honestly scheduled runs now); a **pi · N** chip in the top bar appears while runs stream and opens it, and the completion push lands on the run it is about.
- **Artifacts come back into the chat.** `pi_fetch` pulls a file a remote-pi run produced — screenshot, report, patch (up to 25 MB, confined to the configured workdir) — and `pi_ls` looks around first; fetched files appear on the run card as an **Artifacts** row with image thumbnails, so agents stop serving PNGs through an ad-hoc http server. A remote run's prompt also no longer appears in the worker's process list.
- Claude Code workers can run on your Claude subscription: Settings → Claude Code → Sign in with **Claude subscription**, then paste the token `claude setup-token` prints on any computer with a browser. Endpoint mode is unchanged and keeps its own settings.
- **The remote-pi toolset grew up around the worker.** `pi_result {run}` answers what a run actually said at the end — its final message, read from the whole captured stream instead of its last kilobytes — or the entire run with `transcript: true`; `pi_log {run}` tails the live stream so "working", "stuck" and "looping" are distinguishable from inside a turn; `pi_exec {command}` runs one raw command in the remote workdir **after the command is approved** — it is a worker shell, so it never runs unheard — for the ops a whole pi turn would waste (`git log -1`, `mv`, `cat`). Settle notifications now name the **files the run touched in the workdir**, and `pi_fetch`'s new `save` lands a fetched file straight into the agent's own workspace, ready to read and edit. Runs also cannot outrun their leash: every run carries an **event budget — 200,000 by default**, the net that would have caught the 8.2 M-event incident (0 switches it off), and an optional runtime cap; either cancels a runaway remotely and records the reason.

### Changed
- **Memory lives under the agent now.** The Memory tab is off the tab strip — persona.md and the rest are per-agent through and through, so they sit as the fifth section of the Agent pane (General · Secrets · Reflection · Skills · Memory), next to everything else that belongs to the selected agent.
- **A fresh remote-pi run no longer stops to ask whether it may trust the folder.** Runs are dispatched with pi's `--approve`: a session resumed onto a different project directory used to block on a yes/no nobody can answer in json mode.
- **Remote pi Runs at a glance, and the transcripts finally scroll.** The **Runs** tab carries a blue pulse while any remote-pi run is live (the `pi · N` chip keeps the count — blue pill and pulse now, grey made `Running` look disabled), list rows show one-line prompts with running ones carrying live `events · just now` counters and the run card in the conversation now ticks its **running time** (`running 12:04`), a run viewer now reads like the main conversation — Task and replies as the usual bubbles, Thinking and tool calls as the same collapsed disclosures with real In/Out rails — and everything wraps so no transcript scrolls sideways (the `tool-args` panes in chat got the same fix). Run viewers (remote pi, Codex, Claude) scroll inside their sheet again — they were clipped with no scroll region on long transcripts.
- **Remote pi progress is now the truth.** `pi_status` used to freeze at `events 0` for the whole run — prod watched a healthy 18 MB planning run "stall" for 26 minutes on that counter, and the agent (reasonably) killed it and paid for a duplicate. While a run is live, `pi_status` now keeps counting events and bytes within two seconds, names the tool in flight (`now: Bash: playwright screenshot …`) with the last thing pi said, and marks a silent-but-alive run `quiet 7m` from the stream itself. A follow-up sent onto a session that is still busy is announced as queueing behind the live run.
- Claude Code CLI 2.1.285 → 2.1.289. The app-server image is rebuilt, so the deploy recreates `app-server`.

### Fixed
- **Sending to a conversation that sat idle no longer flashes `No activity`.** The stall watch counted from the previous turn's last frame — so on a tab that had been quiet for over a minute, a fresh message lit `No activity 1:16` immediately, only for `Thinking` to replace it as soon as the model answered. Silence is now measured from the newer of the last event and the turn's start, so the amber line only lights when the live turn itself goes quiet.

## [v0.9.0-letta_0.34.1] - 2026-10-08

### Added
- **The composer's one button follows the box.** A blue circle with an up-arrow sends whenever the box holds something: with the agent idle it sends now, and mid-turn it queues what was typed — the message waits in the queue strip and says so. With the box empty while the agent works, the same circle is red and **stops** the turn; while a stop unwinds it pulses instead of offering a second abort. The split square send/stop is gone — one button, a size smaller than the squares it replaces, and what you typed is what decides which it is.
- **The queue strip runs on pills and one yellow Steer.** Queued messages are rounded pills that take only the width their text needs (capped, truncated, whole message on hover), each carrying **edit** — pull the text back into the input box to change and resend — and **delete**. Steering is one amber **Steer** pill at the strip's left edge: it stops the current turn and starts the queue from its head, the rest following in order. A waiting message lives *only* in its pill: no transcript bubble until it is actually routed into the conversation.
- **Drag the input box taller.** The composer box's top border is a resize grip: drag it up to pin the box to any height up to half the screen — remembered on the device — and double-click it to hand the box back to the auto-grow that follows the text.

### Fixed
- **No more phantom “No activity” after a clean finish.** Steering a queued message raced with a turn that ended on its own: the steer armed the seam that holds the working indicator open for the replacement turn even when there was nothing left to stop, so the indicator was left waiting for a turn end that had already passed — and a minute later the amber `No activity` line lit up beside an answer that had completed fine. The seam is now armed only when the stop actually interrupts a running turn. The stall line also dropped a duplicate warning triangle it drew on its left.
- **A phone that slept through a turn no longer stalls on its finished answer.** Coming back after the replay buffer had rolled over reloaded the transcript but kept the optimistic working state across the gap, so a completed answer stayed “working” and the amber warning lit minutes later. A resync reload now also has the app-server re-emit live state (a forced status sync, observer only), so the working line, queue and status say what actually happened while the device was away.

## [v0.8.0-letta_0.34.1] - 2026-10-07

### Added
- **The composer's working line says what the agent is doing.** In place of "Agent is working": the action in flight, in whole and without truncation — `Read docker/compose.yml`, `Run docker compose build`, `Codex worker: fix flaky test` — `Thinking` and `Writing` when no tool is running, and an elapsed since the turn started pinned to the right edge at every width so it never moves. The generation rate (`24 tok/s`) appears only while the model is generating and never while a tool runs, so a frozen counter cannot read as a hang; `step N`, `+Nk tok` and `queue +N` join on desktop. A full minute of silence with nothing running turns the line amber — `No activity 1:30 · last: web_search` — with **Stop** beside it, so "is it hung?" finally has a visible answer.

## [v0.7.0-letta_0.34.1] - 2026-10-07

### Added
- **Each agent can work in its own folder on the remote pi.** Tools → Remote Pi gives an agent **its own settings**, filled in field by field over the global ones: leave a field empty and it keeps the global value, so "this agent works in `/home/worker/research`" is one field, and a completely different host is a few. Follow-ups stay on the host that started the session however, and one lettuce deploy key still reaches every host — the key and the on/off switch are never per-agent. Settings → Remote Pi says how many agents point somewhere of their own.
- **Settings → Remote Pi checks the host.** Pressing **Check & pin host key** pins the host key and probes the machine in one action, **Save** re-checks on its way by, and a line under the buttons says what a run would find: `pi v0.9.1 · worker@host:22 · pinned SHA256:ab12… · checked 4 min ago` — or exactly what is broken: host not pinned, deploy key refused, `pi` not on the PATH a run gets, workdir missing. Checks are remembered per `user@host:port` on the server, so the phone shows what the laptop just checked; editing a field marks the answer stale instead of deleting it, and a *different* host key than the pinned one needs a second deliberate click naming both fingerprints.

### Changed
- **Tools is a tab of its own**, next to Agent, instead of a section inside it. Every shared tool family (Google, Codex, Claude, Remote Pi) is a chip carrying its own on/off box — tick it and the change is saved at once, no **Save** waiting for the rest of a form — and clicking the name opens that family's per-agent settings, which is where an agent's own Remote Pi folder lives.
- **Settings → Remote Pi** (was "Remote pi worker"): with the switch off every field is read-only instead of waiting to be filled in wrongly, the two ways of getting a deploy key are now one choice — a lettuce-generated pair *or* a private key you paste — instead of a paste box appearing under a key you already generated, the public key copies from a small button inside its own field, and **Save** waits until something actually changed.

### Fixed
- A Remote Pi **PATH prefix** that actually replaces a missing `pi`. A prefix typed with a trailing slash (`/home/worker/.pi/agent/bin/`) reached the remote as `bin//pi`, and pi's own launcher, which walks path elements off the name it was called by to find its install directory, then looked for `bin/install/current-version` and failed naming a file nobody asked for. Prefix entries are normalized on save and on dispatch.
- A Remote Pi **run or check that died with `env: 'sh': No such file or directory`**, whatever the remote had. The PATH prefix was passed as one quoted value, so the `$PATH` inside it was never expanded by the remote shell: the command ran with a PATH of one directory plus five literal characters, and the program could not be found. The inherited PATH is kept, and the probe names `/bin/sh` outright.
- A Remote Pi **check now says what is actually wrong** when `pi` is installed but refuses to start — the usual cause being a `node` on PATH too old for it. It used to report "pi not on PATH" or a bare first line of a module stack; now it reads `pi is installed but cannot run: SyntaxError: … enableCompileCache · node v20.19.2`, and a pi that answers with a plain `1.0.4` counts as ready (it always used to be reported as missing).
- The **Remote pi** row in Agent → Tools takes effect, and can be turned back on. Flipping it alone was discarded — so an agent that had once been blocked from pi kept not seeing the `pi_*` tools while the switch showed it allowed, and no amount of toggling from the UI fixed it.
- The BFF's startup line `Features:` can name `pi`. It listed from a hand-written set of feature names that never grew the newest one, so a `COMPOSE_PROFILES` that contained `pi` logged as if the token had not landed.
- Fix a deploy aborting before a single container was created: the image build demanded git metadata in its build context, and a deploy manager builds from its own copy of the tree, which has none. Such a build now succeeds and Settings → About says `+unknown` rather than a commit — which commit was deployed is in the deploy manager's record, and `bun run deploy-check <origin> --allow-unstamped` checks it.

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
