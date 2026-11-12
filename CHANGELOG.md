# Changelog

All notable user-facing changes to lettuce, newest first. Version tags and
`VERSION` are defined in `AGENTS.md` and the `lettuce-releasing` skill.

## [Unreleased]

## [v0.43.0-letta_0.34.38] - 2026-11-11

### Changed
- **The composer on desktop now reads like an input field.** The message box used to be a textarea with a toolbar bolted under it: a strip of buttons across the whole width, costing a line of height while most of that width sat empty. The box is now a single bordered line — your text, with the send/stop button (a rounded square with a soft drop shadow) riding at its inner right, staying at the bottom edge as the box grows — and the per-conversation switches (attach, transcript filters, permission mode, JSON output, model) dropped below it into a plain compact row: tools on the left, the model on the right. The phone keeps the box it has: the same controls stay inside it, sized for thumbs.

## [v0.42.5-letta_0.34.38] - 2026-11-11

### Fixed
- **Every agent now wears the same face at the same size, everywhere you look for it.** The rail that lists your agents drew each face smaller than every other place that shows the same agent — 22px against 28px folded up and 32px in the switcher — so a photo or an emoji face lost all its detail in exactly the column you scan to pick one, and a plain letter was a speck. One size now, 28px, across the rail in both states, the band above the conversation, the phone's header, the switcher and the avatar picker's preview of what a header will show; only the picker's big preview stays larger, since its job is judging a face rather than marking one. Agent rows grew 2px so the face has air, and the rail folds to its old roomy strip exactly as before.
- **A pinned agent says so with a pushpin you can read.** The gold mark on the corner of its face was a 10px outline sitting on a coloured disc, which read as a smudge; it is a filled 16px pushpin now. Wherever the pin is a button or a mark on the page's own background — the rail's fold control, the switcher's marker beside a pinned name, the pin verb in an agent's menu — it stays an outline like every other icon.

## [v0.42.4-letta_0.34.38] - 2026-11-11

### Changed
- **Nine open reflections folded into the dev playbook**, two of them into a single rule: a mid-flow recheck runs on the shared stack (a second stack cannot coexist — the published port range proves it) and by hand is always scoped, the only unscoped deploy being the one that asks before replacing; a failed deploy can leave the stack up but serving the old build, so the served build is proven before re-running; a `yolo` now expires at the release gate and the tag push always takes its own yes; the sign-in password is never printed or typed into argv, and an ad-hoc signed-in call has a written recipe; a patch plan that stands in for upstream behaviour must name the upstream path it short-circuits; a new *skill* settles dev-harness vs shipped before the flow starts; folds rewrite literal addresses before committing; and an unversioned flow still writes its changelog line, with no gate to catch a missing one.

### Fixed
- **The nightly live check no longer dies installing a browser it never uses.** A runner that lost
  DNS mid-install reddened the check before the stack was even started; the browser is now fetched
  only when the UI check is on, and a run that fails before the stack boots reports once, not three
  times.

## [v0.42.3-letta_0.34.38] - 2026-11-10

### Added
- **Your agent now knows how to hand work to the Remote Pi worker.** It ships as a global skill (Settings → Global skills), so every agent gets it: what kind of job belongs on that other machine, how to write an instruction for a worker that sees none of the conversation, that a dispatched job ends the agent's turn and reports back on its own instead of being polled, what each way a run can end actually means (a detached run may have edited files in the moment before it died; a failed one now carries a reason), and why "stop the run" and "stop watching the run" are different actions with different consequences. Before this, every session worked those rules out from scratch, and a few told the user a run was stopped when it was only unwatched.


## [v0.42.2-letta_0.34.38] - 2026-11-10

### Fixed
- **Stopping a Remote Pi run stops the run.** `pi_stop` closed only the BFF's view of it while saying the remote kept working — it did not: a detached pi dies at its next write to a stream nobody is reading, which is seconds into any real task, so the button offered a detach that never happened and left everyone guessing. Stop now ends the run on the worker. Watching without stopping is still there — `detach` in the tool, **Stop watching** on the card — and both now say plainly that the run ends shortly after anyway.
- **A crashed Remote Pi run reads as a crash.** A pi that died mid-task — out of memory, killed by the kernel, an unhandled error — came back as `detached` with no reason at all, so the agent reading it blamed the network and usually retried the whole job. The runner now carries the remote exit code (a run killed by a signal reports `pi exited 137` with the last words from its own stderr), the conversation that dispatched it is told, and only a connection that genuinely dropped is still called `detached` — and says that is what it is.
- **A quiet Remote Pi run is not called a hung one.** Its status used to assert "ssh still alive" without checking and read as a hint to stop watching. It now says whether this BFF still holds the stream, asks the worker what that process is doing when it can, and states that a silent stream while the model generates or one long tool runs is normal.
- **Remote Pi runs appear in the BFF log.** Every run now logs its dispatch (worker, working directory, prompt length, how it was started) and its outcome with the same reason the run reports, so "did it even start?" is answerable from the log.

## [v0.42.1-letta_0.34.38] - 2026-11-10

### Fixed
- **Reopening a conversation is instant again.** Once a conversation is running, the BFF answers the re-open itself from the live state it has been routing anyway — processing, the queue, running subagents — instead of asking the app-server to replay everything, which on a slow disk took seconds and stopped every other conversation while it ran. Anything the BFF cannot be sure of still goes to the app-server: a different working directory, an approval waiting to be clicked, a turn that has just ended, or a minute of silence on a turn that claimed to be running.

## [v0.42.0-letta_0.34.38] - 2026-11-10

### Added
- **The BFF can now drive an app-server on another machine.** Point `LETTA_APP_SERVER_URL` at it and set `LETTA_APP_SERVER_TOKEN` to the contents of the token file it was started with (`--ws-auth capability-token`); without the token the handshake is refused, and the BFF now says so at boot instead of leaving the app quietly stuck at "App-server offline". A remote app-server is a reduced one whatever the token says — the agent tools that call back into the BFF, the search and Google sidecars, the agent workspaces and the coding-worker CLIs all live in this stack — and `docs/CONFIGURATION.md` ("Remote app-server") lists what is missing and why.

### Fixed
- **A restart no longer freezes the app for minutes.** The BFF now catches up with conversations one at a time instead of eight at once, so opening a conversation or running a tool while it catches up stops waiting.
- **Opening a conversation shows its messages at once.** The transcript no longer waits for the runtime to answer first, which on a slow disk meant seconds of a blank conversation every time you opened one.

## [v0.41.1-letta_0.34.38] - 2026-11-10

### Changed
- **The Runs tab lists remote-pi sessions, not runs.** One row per session, led by its newest run with `session … · N runs` beside it; inside a session, the dropdown lands on the start of the run you pick.

### Fixed
- **The remote-pi session pane reads at conversation width again.** A width cap stacked on the conversation's own measure rule collapsed the text column to a few hundred pixels on a wide pane.

## [v0.41.0-letta_0.34.38] - 2026-11-09

### Added
- **Hover a rail agent and its ⋯ appears.** The same menu right-click gives you — Edit, Pin, Archive, Delete — at the row's right end; the folded strip keeps right-click alone.

### Changed
- **The phone bar is the whole navigation.** Chat · Files · Tasks · Runs · Agent · Settings sit side by side, and the agent's own pane is a slot among them with Settings last, where the rail ends too.
- **Chat answers twice.** While the chat is what you are reading, tapping Chat opens the conversation list and tapping it again puts it away; from any other pane it simply opens the chat.
- **Runs has a bar slot where a worker is deployed**, and it wears the running count that used to hide inside a sheet; the bar is five slots where no worker runs.
- **Tools is a section of the Agent tab now**, the sixth chip beside General, Secrets, Reflection, Skills and Memory — the same per-agent narrowing, one press closer to the agent it belongs to.
- **The Tools section repeats itself less.** One control per family instead of two for the same decision, one line saying what it narrows, and no reload verb.

### Removed
- **The phone's More sheet.** Every pane it opened has a slot of its own now.

## [v0.40.1-letta_0.34.38] - 2026-11-09

### Fixed
- **The visual suite now fails when the page says something is wrong.** A component that re-set its own state on every paint shipped with every check green: a clipped tab bar and an off-screen sheet are things the suite can see, a render loop is not, and the only thing that said so — a browser console error — landed where nobody was reading. Every page the suite opens is watched now, so an uncaught exception or an unexpected console error fails the run, counted per page and reported with where it came from; the forgiven lines are only the harness's own noise (an icon or manifest that cannot load, a service worker a local stack cannot register, a socket closing on teardown, a layout observer, an aborted request) and one request a section breaks on purpose by name. What it still cannot see is a loop that stays silent — that needs a render budget probe, not a listener. Two smaller things from the same sweep: the agent-avatar assertion now says which field it landed on instead of timing out thirty seconds later, and five folds landed in the dev-flow playbook (prove a model exists before driving a turn; the local test password is asked once and always exported from its gitignored file, including into a stage worker's brief; scratch browser scripts live in the worktree; the release tail runs from `main` before the closing gate; feature-gated assertions read the running stack's feature flags).
- **The visual suite runs to the end of itself on a small stack.** A stack with one model left the model sheet waiting for a second row that does not exist, and the open sheet swallowed every click that followed, so two assertions failed and the rest of the suite never ran; a section that asks for a request that must fail (testing an endpoint that is not there, and reading the toast back) was counted against the app by the new console gate. Both are handled now — the first says what it owes instead of blocking the run, the second forgives that one request — and a failed load names its URL, which is how the second was found.

## [v0.40.0-letta_0.34.38] - 2026-11-09

### Added
- **The transcript filters down to what you came to read.** The composer's funnel keeps its five groups and gains a collapsed **Details** section: **Thinking** hides reasoning wherever it sits, on its own or inside a run; **Tool runs** hides the steps folded inside a run and leaves the question you still owe an answer; **Channel messages** hides what the agent posted to Telegram, since that is content, not step noise. Untick a group and its switches dim and ride along — tick the group back and they are exactly as you left them. The whole filter is remembered on the device, so a reload keeps a transcript as plain as you left it, and the funnel's badge counts the switches that are off.

### Fixed
- **A turn with nothing left to fold no longer draws an empty fold.** Hiding every step of a turn used to leave a line headed "0 steps"; what remains of such a turn is the agent's own text, and it reads as messages now.

## [v0.39.0-letta_0.34.38] - 2026-11-09

### Added
- **One sheet gives an agent its face.** Agent → General → **Avatar** opens a single picker with the colour, the glyph and the upload in it, and the face previewed twice — at the picker's size and at the 22px it will actually be drawn in the conversation header. The New agent form offers the same sheet, so a new agent can wear its face from the first message.
- **144 searchable glyphs.** Typing `fox` surfaces 🦊 🐈 🐺, `mail` surfaces ✉️ 📬 📮; six category chips browse the whole library, a **Recent** row puts what you last picked first, and typing any emoji into the box works too. The colour, the search and the grid all stay open while you compare — a pick stages and shows itself in the preview, `Done` is what closes.
- **Upload a face.** A png, jpeg or webp is cropped to a square and shrunk in the browser, so a 4000px photo becomes a 128px face; a png or webp keeps its transparency and wears the chosen colour behind it instead of a white box. Faces are shared — upload once and every agent can wear it — and the picker shows who is wearing one before you delete it.

### Changed
- **The colour belongs to the face, not the form.** The tint row left Agent → General for the sheet, where it sits above both tabs and applies to whichever kind of face you picked; `Auto` gives the agent back the colour its id hashes to.
- **An agent whose face cannot be drawn wears its letter.** An empty circle used to be what a lost upload looked like; now the initial or glyph it would have worn is kept behind the picture and drawn when the picture cannot be fetched.

## [v0.38.0-letta_0.34.38] - 2026-11-09

### Changed
- **The folded rail is led by the faces.** Unpin the rail to its glyph strip and each agent's face grows to 28px while the pane icons drop to 24px — before, the Chat and Files marks wore bigger than the agents themselves.
- **A pinned agent wears a pushpin.** The rail now draws the same gold pushpin the switcher's rows use at the face's top-right corner, in place of the tiny gold dot, and keeps it crisp on every tint.

## [v0.37.1-letta_0.34.38] - 2026-11-08

### Fixed
- **Sending to an idle chat no longer flickers a queue.** The Steer pill and queue chip that flashed for a moment under a fresh message are gone: the strip now appears only when a queue really waits behind a running turn, and a message moving into it swaps places with its bubble in one paint.

## [v0.37.0-letta_0.34.38] - 2026-11-08

### Changed
- **A remote pi run opens as a session, not a popup.** Clicking a run — its card in a conversation, its row in the Runs list, or a completion push's link — opens the whole pi conversation in the pane: every run you asked of that session in one transcript, in the conversation's own rows on a tinted surface, with a dropdown that jumps between runs and lands on what each one last said. Closing it gives back the screen you opened it from — a conversation keeps its draft, the Runs list keeps its place.
- **A remote run reports itself, so nothing waits.** `pi_wait` is out of the tool menu: every terminal state — finished, failed, cancelled, or detached — now posts its own line into the conversation that dispatched it, including the two that used to be silent. A clean exit counts as finished even when pi never sent its idle signal, and a detached run says so plainly: capture stopped, the remote pi may still be working, `pi_send` resumes its session. That is what was putting sleep-and-poll loops in your chats.

## [v0.36.0-letta_0.34.38] - 2026-11-08

### Added
- **Remote Pi runs the program you name.** Settings → Remote Pi gained a **Command** — the remote program with its fixed arguments, `pi-bolt` or `/srv/pi/bin/pi --thinking high` — instead of the hard-coded `pi`, and **Tools → Remote Pi** carries the same field per agent, empty meaning "use the global one". Checking the host asks that command too, so a host that calls the program something else stops being reported as "`pi` is not on the PATH", and the answer now names the program you configured. The run adds its own flags (`--mode json --approve …`) after yours, so a typo in this field cannot turn a run into something Lettuce cannot read.

## [v0.35.0-letta_0.34.38] - 2026-11-06

### Added
- **Files can delete.** Every row carries a trash now, file or folder, and one confirm prints the full path and says plainly that there is no trash to restore from. An agent's own directory refuses — clear its contents instead.

### Changed
- **Escape closes the open pane**, the same step the corner ✕ and a phone's Back already took — with a keyboard on any width, not just the desktop one. The thing closest to you still answers first: a sheet, the agent switcher or a ⋯ menu takes the press and the pane stays.
- **Chat no longer lifts the conversation panel on its way past.** Arriving at Chat from Files or any other pane leaves a hidden panel hidden; the Chat button is the only thing that toggles it, and it still toggles when you press it while already in Chat.
- **The desktop band wears the agent's face**, inside the same click that shows or hides the conversation list, and **Settings no longer shows an agent name over it** — what every agent shares shouldn't be wearing one agent's name.
- **The composer types at 14px on desktop.** It was 16px everywhere so iOS would not zoom on focus, and that only matters under a finger.

## [v0.34.1-letta_0.34.38] - 2026-11-05

### Fixed
- CI and the shipped image can no longer disagree about which bun minor runs the tests, and a UI assertion
  whose CSS class was deleted now fails at the commit that deleted it instead of passing forever.

## [v0.34.0-letta_0.34.38] - 2026-11-05

### Changed
- **The main rail folds away.** AGENTS moved to the top of the rail and its row carries the pin in its right corner: unpinned, the rail folds to a 56px strip of 28px glyphs and the transcript takes the width; the choice is remembered per device, and the Settings rail never folds — a list of words needs a column that can hold one.
- **The conversation drawer's pin moved to its head row and sits on the rail pin's exact metrics** — same corner, same line, one control language for both columns.
- **⋯ and right-click menus speak the rail's compact scale at the mouse** (30px rows, 12.5px words); touch devices keep fingertip rows.
- **Settings is a slot of its own in the phone's bottom bar** — Chat · Files · Tasks · Tools · Settings · More — and More now holds only this agent's Agent and Runs rows.
- **The phone's Back closes the open pane.** With Files, Tasks, Settings or any secondary pane up, Back steps back to Chat instead of leaving the app; a sheet or menu opened over a pane still closes first.

## [v0.33.0-letta_0.34.38] - 2026-11-05

### Added
- **A message the agent sent you on Telegram now appears in the conversation, with its delivery.** A send was one line inside a collapsed run (`MessageChannel · Message sent to telegram (message_id: 13)`), so the digest a cron posted at 7am left no trace in the very transcript that holds it, and the agent's closing `Sent.` was a claim rather than a fact. A sent message gets a card of its own under the run now: destination, time, the text itself, a check when the channel took it and a warning when it refused — and nothing at all while the send is still out, because no answer is not a success. It is styled as the agent's own message instead of a tool panel (`✈ Telegram · 10:42 AM · ✓`), because that is what you read it as.

### Changed
- **The transcript takes the colour of the agent you are talking to.** The answer rail, the name in a turn header and the agent's narration rendered in one default tint whatever the agent's configured colour was, so five agents with five colours still produced one transcript — only the rail's face and the top bar knew who you were talking to. They follow the selected agent's colour now, and the channel-send card takes it too.
- The agent-facing playbook and skills now say the things that cost a session to learn: prove the stack is
  up before asking for a human check, report a failed dev deploy as the outage it is, treat mockup sizes as
  provisional, and re-ask for release authorization at the tag.

## [v0.32.1-letta_0.34.38] - 2026-11-05

### Fixed
- A reboot no longer leaves the app dead: the BFF quit when it started before the app-server was
  listening, and nothing brought it back.

## [v0.32.0-letta_0.34.38] - 2026-11-05

### Added
- **Settings → Telegram.** Connect a BotFather bot without any container steps: a switch to turn it off, a write-only token, who may DM, and a list of chats whose pairing codes you approve to a chosen agent and conversation.
- A paired Telegram chat is told its outcome: the bot messages that chat which agent and conversation it now drives.

### Changed
- The Telegram gateway watches its bot's settings and restarts itself when they change, and installs its own runtime — the `docker exec` pairing steps are gone.

## [v0.31.0-letta_0.34.38] - 2026-11-04

### Changed
- **The rail is the agent list, and the conversation list became a drawer that starts closed.** The rail was a 56-pixel strip of icon-only squares, and because a square cannot hold a word the agents' names lived in a second copy of the same list inside the conversation panel — the same agents twice, in two shapes, with a shared height, a shared scroll and a shared hover to pass for one control. It is a 184-pixel column of 30-pixel rows now: glyph then word for the panes, a face then the name under an `AGENTS` word for each agent, `＋ New agent` at the end of that list, and a foot cell of its own. What is left for the panel to carry is conversations, so it carries those: it says whose list it is at its head, it comes as a **peek** floating over the transcript when you ask for it, and it goes away when you choose a conversation or press anywhere else. **Pin** makes it a standing column again; it used to be pinned by default, and now the transcript gets the width unless you ask. Opening it and pressing the same thing again puts it away, and a pinned drawer gives up its pin in the same click.
- **Settings is a pane now, not a dialog over everything, and its door is a row of the rail.** Opening Settings replaces the rail's pane list with the sections and a `Back` cell at the head, so the app has one navigation column again; on a phone the sections stay the wrapping chips above the section, and Settings was and is the More sheet's row there. The desktop door is the rail's foot cell — **⚙ Settings** — because the column that names the panes should name this one too, and it is where you would look for it: the top bar keeps no Settings glyph at all, which is also what the connection light is for. A `?settings=google` link still lands on that section, and since it is a pane like the others, a phone's Back leaves it the way it leaves Files — Escape is no longer special. While Settings is the open pane, its own column's foot cell says **Conversations**, which is what it has always opened.
- **The connection light is back in the top bar, and clicking it shows what is answering.** A passive dot is a status you have to trust: it said "Live" in a colour nobody could name and answered no click. Now the dot is there at every width (with its words where there is room for them) and the whole thing opens the **Responding now** list: every conversation with a turn in progress, across agents, each row jumping straight to that conversation. While turns are running the `N responding` slot takes the light's place rather than sitting beside it, so one corner shows one status, the busier of the two.
- **Every pane but Chat carries a close ✕ in the window's top-right corner**, and the band names the pane you are looking at. Before, a secondary pane left the title reading "Lettuce" over a screen of MCP servers, and the only way out was finding the right word in the rail.
- **Toasts arrive at the top**, under the band's line. They used to land bottom-right, which on a phone is the composer's Send button — and they announce exactly the kind of thing (a reply came while you were away) that shows up while a message is being written.
- Sharpened the flow rules an agent follows: a green live-CI run no longer counts as a `ui-check`
  pass, redesign rounds re-prove layout and re-sweep stale claims about what they changed, and the
  pre-release review step names the verb that exists.

### Fixed
- **A slow load no longer looks like an empty one in Settings either.** The providers list kept the old habit the conversation list was fixed of: while the registry was still on its way the pane said "Loading providers…" and, in the same frame, **"No providers yet — an agent has no model to answer with until you add one"**, so a fetch that takes a second or two read as lost configuration. The empty state now waits for the load.

## [v0.30.0-letta_0.34.38] - 2026-11-03

### Changed
- **The status dot and favicon now watch the app-server.** It read "Live" with a green dot even while the app-server itself was down, because it only ever watched the browser's own connection. It now says **App-server offline**, then **Connecting to app-server…**, and finds its way back to Live by itself when the server returns — no reload, no stale green dot.
- **"App-server is offline — retrying automatically."** The row that sat there reading "App-server is not connected" after an outage, until a manual reload, now really does recover: the sidebar, the switcher's conversation list, and a conversation whose load failed all retry themselves when the app-server returns.
- **A slow load no longer looks like an empty one.** A conversation list still arriving said "No conversations" and a transcript being fetched said "No messages yet"; they now say **Loading conversations…** and **Loading conversation…** while they wait. A just-created conversation, which is empty by definition, still opens straight to "No messages yet".

## [v0.29.0-letta_0.34.38] - 2026-11-03

### Added
- **Open a running subagent's event log.** A Running now row in Tasks, and the **live transcript** link on a Task line in chat, open live: a plain subagent shows its task, its own tool calls and outputs, and its narration with clocks; a Codex or Claude worker opens its run page, which follows along while it runs. The link only appears when the worker's run is unambiguous — when several workers of a kind run at once the row shows no link rather than a guessed one, and the Runs tab lists them all.

### Fixed
- **Expanded tool output is full width again.** Since the navigation-rail restyle every expanded tool call in a transcript rendered as a 74-pixel column — one word per line.

## [v0.28.0-letta_0.34.38] - 2026-11-03

### Added
- **Runs per agent.** The Runs tab shows the open agent's Codex, Claude and remote-pi runs — a run belongs to whoever's workspace it ran in — and **show all** at its top right widens it to every agent on the machine, counting what it hides.

## [v0.27.1-letta_0.34.38] - 2026-11-02

### Fixed
- **The app-server is letta-code 0.34.38, from 0.34.21.** What that buys you: a resumed Codex or Claude run starts with the same environment it launched with instead of a different one, a Claude session stays killable while its background tasks are still running, and a subagent that stopped being steerable the moment its task row aged out can be steered again.
- **Local models now get the settings you set.** Temperature and verbosity were dropped on the way to an OpenAI-family endpoint, so a tuned model was not actually tuned; a request to compact history is also now labelled as one, which lets an endpoint treat it differently.
- **A folder whose name merely starts like your workspace is no longer inside it.** `…/project2` used to pass the allowed-directory check for a workspace at `…/project`; the comparison now walks whole path segments. Setting an environment variable in front of a command needs approval like the command does.

## [v0.27.0-letta_0.34.21] - 2026-11-02

### Changed
- **The desktop rail and the conversation panel are one grid now.** The rail is faces-only: the named panes and Settings up top, and below them a compact column of agent faces riding the foot, beside the conversation panel's new foot block of agent names — resting on or selecting an agent lights its face and its name as one row across the seam between the two columns. The panel grew that names-only agent list with a fixed **＋ New agent**, and the rail grew a fixed ☰ cell that opens the panel with the full agent list.
- **The header's agent name is the panel's show/hide verb.** The dropdown caret is gone — the name itself hides the conversation panel (giving up its pin in the same click if it was pinned) and shows it again.

## [v0.26.0-letta_0.34.21] - 2026-10-30

### Added
- **Filter the model list by name.** Once more than ten models are served (an OpenRouter connection lists hundreds), the **Model** sheet, in the chat and in an agent's settings, opens with a **Filter models by name…** box that stays in view as the list scrolls. Every word you type has to match, in any order, so `opus 4.5` finds *Anthropic: Claude Opus 4.5*.
- **See the cron jobs agents set up in Tasks.** Each shows its schedule and command, read-only; "Ask agent to change" starts the request in chat.
- **Allowed recipients for Gmail and Calendar.** Settings → Google Workspace takes a list of addresses and `@domain`s; when it is set, agents can send mail and calendar invitations only to those. The Google sidecar enforces it on the requests it sends to Google, so an agent cannot get around it by calling the sidecar directly, and reply-all, forwards, filters and attendee notifications are checked too. `calendar_event` gains `notify_attendees` for changing an event without emailing everyone on it.

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
