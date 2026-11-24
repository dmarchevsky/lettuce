# lettuce — dev-flow playbook

<!-- Operator-owned and tracked: a change rides a flow and a PR like any other file. `flow init --write`
     writes the live copy on the operator's word; `flow init` alone runs the doctor. -->

## global

```flow
defaultBranch = main
branchPattern = feat/{slug}
worktreeDir = .dev-flow/{slug}/worktree
```

```flow-guard
confirm \bdocker\s+(?:container\s+)?(?:restart|stop|kill|rm)\b[^\n]*(?:lettuce|app-server|channel-gateway) :: a bare docker command on a compose container tears the namespace holding bff and channel-gateway
confirm \bdocker\b[^\n]*\bcompose\b[^\n]*\bup\b(?!.*--no-deps)                                    :: an unscoped `up` recreates app-server and every turn in flight — scope it (`up -d --no-deps bff`), or route it through flow verify
confirm \bdocker\b[^\n]*\bcompose\b(?:(?!\bexec\b)[^\n])*?\b(?:rm|down|stop|kill)\b        :: stops running containers — a command `exec`ed INSIDE the owning container is exempt (removing root-owned residue there is the sanctioned cleanup shape), so keep the word `exec` out of the rest of the command
confirm \bdocker\b[^\n]*\bcompose\b[^\n]*\brestart\b                                              :: drops the permanent upstream connection and any turn in flight
confirm \bdocker\b[^\n]*\bcompose\b[^\n]*\bup\b[^\n]*(?:^|\s)app-server(?=\s|$)                    :: that service shares a network namespace with two others
protect docker/.env*                                                                               :: gitignored live secrets and their backups — never echo the values
forbid  docker/secrets                                                                             :: gitignored secret storage
```

Feature work lives in the worktree dev-flow creates at `.dev-flow/<slug>/worktree`; the main checkout
stays on `main` with a clean tree and only takes merged PRs. Area mechanics live in `.agents/skills/lettuce-*/SKILL.md` —
read the one AGENTS.md's table names before planning. Upstream `letta-code/` is read-only and is never
patched. A plan document rides its own feature's branch and PR, never a PR of its own.

**Production deploy is the operator's alone:** the agent publishes — branch, PR, merge on the operator's
word for that PR, annotated tag — and stops there. It never deploys prod and never asks whether a deploy
happened.

A `flow-guard` rule matches shell text, not intent: a `gh pr create --body "…docker compose down…"` trips
the confirm rule, so a body that quotes a command goes in a file and comes in with `--body-file`.

The lifecycle confirms are not only about `compose`. A bare `docker restart lettuce-app-server-1` tears down
the same namespace that holds `bff` and `channel-gateway`, so `bff` loses its upstream route and every turn in
flight with no drain, and an unscoped `up -d` from a worktree silently recreates `app-server` on the shared
stack — which is why both confirm. They are a seatbelt, not a seal (a variable or a script that stops things for
you walks past them), so the rule that actually governs is the implement one: *never unscoped by hand*. Scope to
`--no-deps bff`, or route it through `flow verify`, which owns the question of who is being displaced.

A force push needs no rule of its own: dev-flow asks the operator before any `git push --force` /
`--force-with-lease`, and their word is the `DEV_FLOW_ALLOW_REWRITE=1` prefix. A pushed branch is still
updated by merging `main` into it — that includes a contributor's fork-PR branch, pushed to under
maintainerCanModify with a PR comment saying so — never by rebasing it.

**What a `yolo` word does.** dev-flow takes yolo literally: every later checkpoint is pre-answered and
the plugin runs the remaining gates back to back without asking — the merge and the tag push included.
AGENTS.md hard rule 5 is satisfied by that answer: a yolo, or a Release? answer, is the ask for
*that flow's* tag, so the release stage pushes it without a second question — **except** Release? itself,
which this playbook withholds from a standing yolo (the `release.yolo` knob in `## release` says exactly how
far it reaches and what still overrides it).
What a yolo does not buy is
anything outside its own flow (another flow's tag, a prod deploy), and it does not cover a version that
changed after it was given — if the derived version differs from the one stated when the yolo or
Release? was answered, state the new one back and wait.

`protect` and `forbid` name a path and its subtree; a glob works in the **last segment only**, as a
sibling set: `protect docker/.env*` covers `.env` and every `docker/.env.bak-20261021` a variable flip
leaves beside it. Flip a variable **in place** anyway instead of copying `.env` aside, and never `-f` add
an ignored dotfile — `git add -f docker/.env.bak` is a public secret, not a shortcut.

**A probe never prints a credential file.** `protect` and `forbid` keep secrets out of git; the session
transcript is the other leak, and reviews and reflections read it back. To learn what a credential-bearing
file holds, grep for key names (`grep -o '"apiKey"' file`, `jq keys file`), never `cat` it; a per-machine
password is read into a variable or a file descriptor, never printed — `head -c` on the file is a leak
too. A plan-stage environment survey that `cat`-ed a live models.json dumped a provider apiKey into the
transcript this way. Committing the
playbook itself is the one `-f` add that is right (`.dev-flow/` is ignored, `project.md` is tracked):
`git add -f .dev-flow/project.md` on its own line — a plain `git add` exits 1 and silently drops the
`&& git commit` chained after it.

## plan

- [ ] (ui) mockups of every changed surface, rendered at 390 and 1280 by `bun scripts/mockup.ts` and embedded in plan.md

A mockup rendered **at plan** has no worktree to link — `flow approve` is what creates it — so link the
**main checkout's** `web/src/styles.css` (`../../../../web/src/styles.css` from `plan/mockups/`), and
never another feature's worktree, which drifts and is removed at its finish. **After** approve, re-link
and re-render every mockup you keep using at **this feature's** worktree stylesheet
(`../../worktree/web/src/styles.css`) — the main checkout lacks every class the branch adds until it
merges, so a re-render against it silently loses the new styling. Check the link resolved before
trusting a shot.

**Render with `scripts/mockup.ts`, never a hand-typed chromium call**: `bun scripts/mockup.ts
<screen>.html --width 1280 --height 900 --out <screen>-desktop.png`. It passes the
`--blink-settings=primaryPointerType=…` flags `chrome-headless-shell` needs to report
`(pointer: fine)` / `(hover: hover)` — a plausible `--primaryPointerType=4` is accepted and ignored — and it
fails the render when the stylesheet `<link>` does not resolve. Two flows since that script landed have
typed the incantation by hand, dropped those flags, and approved 1280px shots of a page that was never
styled as the desktop it claimed to be. `lettuce-ui-verification` holds the recipe.

Write the plan to `plan/` **as the discussion goes**, not when it ends: pi has auto-compacted at the
`release` stage twice now, and a plan that lived only in the transcript was gone with it — the gates read
the file, so the file is the work's memory. Pace the gates the same way: land each one's output on disk
before moving on.

A one-line `--patch` plan is not enough when the change **stands in for upstream letta-code behaviour**: name the upstream command path (`file:line`) it short-circuits in the plan line, before Approve?, so the ordering assumption is on disk and checkable before code is written — a patch flow has no plan file, so that line is the only place a wrong assumption can surface. A cache once keyed its fill on `runtime_start_response`, but upstream replays state *before* that response (`src/websocket/listener/commands/runtime-start.ts`): the design could never fill, and the cache and its tests were rewritten after implementation through a second review round. The same applies to **any claim about an upstream change**: the plan must name the local file, route or tool the claim reaches, or mark it **unadjudicated** — a quoted local anchor is the artifact, not prose asking for care. A plan asserted an upstream guard was local-relevant; ~25 implement calls later it turned out the guard wraps only the cloud client's stream path (the local path goes through a different SDK) and the probe's whole premise was gone.

**A plan states the bump *class*, never a literal version tag** — MINOR or PATCH, nothing more. The tag is
cut at pre-release and a parallel flow can release while this one is open: a plan that guessed the next tag
was stale on arrival (the real tag landed one minute before the plan was written) and the correction had to
be paid at pre-release. And **a step or measurement the plan names as a gate must be closed explicitly, not
outlived**: a step plan.md names ("capture a real `tool_return_message` with an image part before trusting the
shape") survives approve, both implement workers and the first Verified? unless the Verified? message lists
every such step as done or waived — the tier-2 counter carries playbook items only, so nothing else notices.
The duty reads the same for a plan line's *work* items (one beat later than the steps above, at pre-release):
a `--patch`/`--docs` flow whose approved line
promises a slice ("last one: the render-test env") lists every named item as landed or dropped at
pre-release — PR-body prose is not a checkpoint, and one promised slice once rode into a merged PR as a
Notes disclosure nobody was asked about.
When the operator waives a named precondition verbally, write the waiver into plan.md (in a
`--patch`/`--docs` flow, which has no plan file, into the plan line) and the PR body — what was measured, or that the work proceeded unmeasured and what would change if the number
comes back low — so a precondition cannot die silently behind a proceed-anyway. **And a promised ordering proof must be schedulable: a run that has to go red *before* something is green must be placed before the commit that would make it green** — if that order cannot be kept, drop the promise at Approve?, where it is a decision, not in implement, where it silently becomes unperformable (a plan carried both orders, the pin landed first, the red run never happened, and the probe was iterated against a stack serving the previous pin).

**A plan proves the feature's own runtime precondition, not just that a model exists.** "Prove there is a
model before driving a turn" is the special case of a wider duty: name what the feature needs to be
*testable* — a login in the container, a compose profile up, an OAuth scope granted, a file under
`$LETTA_STATE_DIR` — and prove it in the running stack with one read-only probe, quoting that probe's
output in plan.md. A roadmap brief's claim that "the image carries `gh` plus a persisted login" went into
an approved plan unproven and died at implement, where `gh auth status` in the container answered *not
logged into any GitHub hosts* and the feature could not be exercised at all. A brief's assertion is not
evidence. The same probe settles a bullet that needs a compose profile token: quote `/api/status`'s
`features` for the token, or write the bullet as **waived at plan time** — a bullet that needs `codex` or
`claude` (or `images`, or `telegram`) on a stack that does not carry it is discovered unwalkable at the
checkpoint, where the only close left is a verbal gap. **A trigger this one-stack machine cannot force defines
its own container pass at plan time**: a feature woken by an app-server reconnect cannot be driven here —
restarting `app-server` takes the network namespace holding `bff`, and the in-process state with it — so the plan
says in words what the container pass is (a unit-level proof plus a probe, with the live reconnect named as
unreachable here) instead of assuming it can be staged and leaving the feature to ship on unit tests alone.

An asked-for *skill* settles its harness **before the flow starts**: `.agents/skills/` is this repo's dev harness — pi reads it in the checkout, and nothing mounts this checkout into a container, so it reaches no agent — while `docker/agent-skills/` is what ships: the bff image carries it and `bff/src/agent-skills.ts` installs it into `/root/.letta/skills` on every connect, global to every agent (Settings → Global skills). Ask which one is meant when it is ambiguous; guessing wrong once cost a whole extra unversioned flow for a skill that could never reach the app, plus a modify/delete rebase conflict when the harness copy was deleted.

**An Approve? answer carries more than a yes.** When it names a class — "Approve patch" — on a flow that was
started without `--patch`, it names the **bump class**, not the mode: a mode is proposed at `flow start` and
cannot be bolted onto a started feature (the refusal only hints at `--ui`). Record the class in plan.md — on a
versioned flow Approve? now records the release call itself (`flow approve --confirmed --version=<class>`), and
any later change is `flow bump <class> --confirmed`, never a number carried to a later gate. Same for `--ui`: turning it on for a plan-stage flow is
`flow start <slug> --ui` **in place**, never abort-and-restart, which throws away the flow identity for nothing.

**A `--ui` plan answers direction before it paints.** Open direction questions go in a chat beat *before*
`plan.md` and the mockups: an Approve? that arrives with questions *and* finished renders means every render
may have to be redone — six mockups were rendered, the operator then said "make configuration universal",
and all six were redone.

Anything user-visible starts with `flow start <slug> --ui`. A docs-only change (nothing under `bff/`,
`web/` or `docker/`) still needs a flow: `flow start <slug> --docs` — and `--patch` / `--docs` are the
operator's grant in chat, never self-selected. `flow approve` cuts the branch from
`origin/main` as this clone last fetched it, so `git fetch` right before approving — an unfetched
`origin/main` puts the whole feature, its diff and every `flow check`, on a stale base that pre-release
pays for with a merge and a full CI re-run. Local-only commits on `main`
(`git log origin/main..main --oneline`) never reach the branch at all.

**A fold is not done until a repo-wide grep says so.** When a reflection names one stale string or verb,
`git grep` the whole tree, not the file the note names: a rename that left `ponytail-review` printing in
`scripts/verify.ts`'s epilogue cost an extra commit, and the note itself pointed nowhere near it.

A fold **rewrites addresses before committing**: a reflection records what it really saw — one carried a docker
bridge-gateway address verbatim — and `check-prod-info` fails any tracked file holding a private IPv4, so a fold
that copies a literal LAN or bridge address out of a reflection is doomed to fail its own gate. Reword it to the
mechanism ("the bridge-gateway address of the compose network"), or to RFC 5737's documentation range where a
literal example is the point.

A fold **re-proves each reflection's claim against the thing it describes** before committing, not just greps for
stale strings: in one fold three of nine folded claims were false as written, and a wrong rule in a rule doc is
worse than the missing rule it replaced. **When the claim is about dev-flow behaviour, the thing it describes is
the installed plugin** — read the version out of `~/.pi/agent/npm/node_modules/pi-dev-flow/package.json`, find
which of its releases touched the symptom, and read that release's own text before the row enters the playbook.
Do not guess the version, and do not fold a rule the installed build already enforces or already replaced: two
folds shipped exactly that, in one case charging the newest releases with fixes that had landed two versions
earlier, and each false row was caught only by a fresh read of `node_modules` — after Verified?, so it cost a
refused Release? and a correction commit.

Closing a fold takes **one** `flow reflect done` call with every id listed (`done r58,r59,… <note>`): since the
ids became stable the gate validates the whole list up front and checks off nothing on a bad one, so a row-per-call
loop is ceremony.

And a fold touching `AGENTS.md` **buys room first** — `bun run check-docs --print-size` shows the bytes left, and
the file ships within a hair of its budget, so a two-line addition costs several byte-shaving runs; move
task-scoped prose into a skill in the same commit.

## implement

```flow
setup = cp -n "$(git rev-parse --git-common-dir)/../docker/.env" docker/.env && bun install
test = bun run verify
run = docker compose -f docker/compose.yml up -d
dev = bun run build:bff && BFF_PORT=${DEV_FLOW_PORT:-8090} COMPOSE_PROJECT_NAME=lettuce$DEV_FLOW_SUFFIX docker compose -f docker/compose.yml up -d
health = curl -fsS http://127.0.0.1:${DEV_FLOW_PORT:-${BFF_PORT:-8090}}/readyz
healthWait = 60
port = 8090
parallelDev = no
servedBuild = COMPOSE_PROJECT_NAME=lettuce$DEV_FLOW_SUFFIX docker compose -f docker/compose.yml exec -T bff cat BUILD_INFO
```

**One stack per machine: `parallelDev = no`.** Two lettuce instances cannot run side by side here. Both
would mount the same `$LETTA_STATE_DIR`, and `build:bff` tags its images by `VERSION`, so a second build
retags the image the first instance runs. So when `flow verify` finds the stack deployed by another live
flow that is still under review, it offers only **replace** or **wait** — put both to the operator with the
holder it names (slug, stage, commit) and never pick for them. A holder already past its Verified? is
replaced by verify itself (dev-flow releases after 0.90.1): nobody is reviewing that deploy. `servedBuild` reads the `sha=` line the image bakes into
`BUILD_INFO`; verify refuses when it is not the worktree's HEAD, which is the "still serving the previous
bundle" failure `deploy-check` exists for, caught before the operator is asked. **A dev-port choice a long
unattended stretch will eventually hit is a first-beat question, not a last one:** if `flow status` already
names another flow's deploy as the holder and you are about to launch a worker chain that cannot answer, ask
replace-or-wait then — verify re-checks the holder at deploy and keeps the final say anyway, so the early ask
is free, while the late one ends an overnight chain on an operator word (one asked at 02:52 was answered at
20:13).

A **mid-flow recheck** runs against the shared stack, because there is no second stack to build: compose publishes the agents' web-app range `3000-3099` wide and only its bind address is configurable, so a hand-built parallel project — even one namespaced with `COMPOSE_PROJECT_NAME=lettuce$DEV_FLOW_SUFFIX` — dies with `port 3000 already allocated` and leaves its containers in `Created`. Route a recheck through `flow verify`, or scope it by hand to the one service that changed: `bun run build:bff` then `docker compose -f docker/compose.yml up -d --no-deps bff`. A hand-scoped recheck **runs from the worktree whose deploy you are refreshing**, never from the main checkout while a flow's branch deploy is live: build:bff's image tag is the checkout's release literal (the compose image-tag default, kept equal to `VERSION`), so both checkouts build to the *same* tag with different content — building from main retags and recreates the shared `bff` onto main's bundle and the review target silently changes under the operator, with nothing warning. The `--no-deps` rule is not only for the release tail — a hand-run unscoped `up -d` from a worktree silently recreates `app-server` on the shared stack and kills every in-flight turn a parallel flow has open, with no drain. The playbook's own unscoped `dev` run is not the forbidden case: `flow verify` is sanctioned because it enforces port ownership, names the holder and asks **replace or wait** before anything is recreated — the rule is *never unscoped by hand*, not *never unscoped*.

`bun run verify` is the whole offline half (worktree, version pins, prod-info, release hygiene, docs,
lint, typecheck, tests, build), so no separate `build` key. The commands assume `bun` on PATH, which the
harness env does not guarantee: `bun: command not found` means pi was started without `~/.bun/bin`, and
the fix is a symlink into a directory already on PATH (`ln -s ~/.bun/bin/bun ~/.local/bin/bun`) — a
machine fix, not a playbook edit. A tier-1 test must not bound wall-clock time: `verify` runs the whole
suite, so a test that asserts milliseconds loses on a loaded machine and costs a full verify cycle — one
perf test failed inside `flow verify` and was rewritten to assert the deterministic work count with a
loose ceiling that only catches deleting the bound. Assert the count the code enforces, not a tight
millisecond budget under full-suite load — the one allowed elapsed-time form is exactly that loose ceiling,
whose only job is to go red when the bound gets deleted. `bun run ui-check` can fail the same way from a fresh worktree: its
`bun install` resolves a Playwright whose pinned Chromium build is not the one this machine caches, so
either `npx playwright install chromium` once, or set `PLAYWRIGHT_CHROMIUM` to the cached
`~/.cache/ms-playwright/chromium_headless_shell-<build>/chrome-headless-shell-linux64/chrome-headless-shell`.
A fresh worktree has no `docker/.env` (gitignored) — `setup` copies it in when `flow approve` creates
the worktree, or the state-dir default lands inside `.dev-flow/<slug>/`. It reads the file from the
**main** checkout through `git rev-parse --git-common-dir`, because a linked worktree has no
`docker/.env` of its own and a
relative `../../` breaks the moment `worktreeDir` changes depth. A scratch browser script is a worktree file too:
it lives **and runs** inside the worktree (`…/worktree/scripts/scratch.ts`), because that is what makes `bun`
resolve *this* worktree's Playwright *and* the sibling `./harness.ts` helpers. Anywhere else it cannot resolve
one of the two, and which import fails first decides the message — `ERR_MODULE_NOT_FOUND: playwright` from a
temp dir, `Cannot find module './harness.ts'` unless you import the worktree path by hand
(`../worktree/scripts/harness.ts`), or `Executable doesn't exist at
~/.cache/ms-playwright/chromium_headless_shell-<other>/…` from the flow dir or the main checkout, which reads
like a machine problem and is the same cwd problem. `PLAYWRIGHT_CHROMIUM` is the override for the last one only. **This rule beats dev-flow's generic one**
(its implement reference puts scratch in `$TMPDIR` / `mktemp`), and the failure it prevents is quiet, not
loud: run from the flow's tmp dir, `bun` resolves Playwright from the **main checkout's** `node_modules`;
from a true temp dir it resolves bun's global cache — at a *different version*. Either way the probe drives
a browser build the worktree does not use, and its result is about that. A relative `./harness.ts` import is
the only part that fails loudly, and a scratch stays invisible until it is *committed*, at which point
`bun run lint` and `bun run verify` go red over it. So: worktree, deleted before `flow check`, never
committed. Resolve sibling paths from the same place — the
upstream clone is `../letta-code` **from the main checkout** (AGENTS.md's `~/work/letta-code`), a path that
does not exist from inside a worktree, so a probe that assumes `$repo/letta-code` reads nothing and reports
upstream unchanged.

**A new script that wraps an incantation a repo skill already documents copies it verbatim and re-proves
it.** A flow rewrote the chromium flags from memory into `scripts/mockup.ts` as `--primaryPointerType=4`
— silently ignored by the headless shell — while `lettuce-ui-verification` already carried the working
`--blink-settings=…` form, so the tool rendered unstyled desktop mocks and looked healthy; the independent
review's only must-fix. The skill is the source of truth, and wrapping its recipe needs one empirical proof
that the wrapped form actually applies (there: a `matchMedia('(pointer: fine)')` probe printed from the
render).

**Use the harness instead of re-deriving it.** `scripts/harness.ts` exports `devSignIn` / `signInPage` /
`requireTestPassword` (sign-in), `openPane` (rail and phone bottom-bar navigation), `servedBuild` /
`assertServedBuild` / `requireServedBuild` (which bundle a stack actually serves), `cookieJarLine` and
`headlessRenderArgs`; `scripts/dev-login.ts` prints a cookie jar (0600) and the agent ids from a shell.
Four flows have hand-rolled a sign-in driver anyway. Four more re-ran the whole `ui-check` suite (~2 min
each) to land three assertions: `bun scripts/ui-check.ts --list` names the sections and `--section <name>`
runs one, and `scripts/screenshots.ts --shot <name>` renders one image. And a probe of the shared stack
calls `assertServedBuild()` immediately before it measures — a parallel `build:bff` retags the image under
you mid-pass.
A failed `setup` fails `flow approve`
and runs again on the next one; a `--docs` flow skips it — **so nothing is installed there**: a docs flow
whose task runs a project tool (`bun run screenshots`, a Playwright render) must `bun install` in its own
worktree first, and `bun run build` when the tool needs `web/dist`, or the tool fails confusingly (`No
build at web/dist`, a Playwright that cannot resolve); when a screenshot is the artifact (the README generator), the render-size rule in `lettuce-ui-verification` applies too. **A `--docs` flow stops being docs-only the moment
its branch touches anything that is not documentation** — and **`scripts/` is gate code, not prose**: dev-flow
decides the mode by path, so a `--docs` branch that edits `scripts/*.ts` gets the tier-1 checks back at the gate
and `verify`/`release` require them green. Two things follow. Nothing is installed in that worktree, so run
`bun install` before the gate does (PR #149 shipped `scripts/harness.ts` and `scripts/verify.ts` edits through a
docs flow that ran nothing over the thing that runs every other check). And say in the PR body which checks ran
and which the mode skipped, so the next reader knows what was never executed — and name plainly that the
container pass was skipped and why, since no mode runs it for you.

**A compose-profile token lives in as many copies as there are worktrees.** `setup` copies `docker/.env` into
each worktree and every flow deploys from **its own** copy, so a token added to the main checkout alone silently
drops on the next parallel `up -d` — and the app then tells the operator the feature is off. The persistent flip
is therefore exactly **two files: the main checkout's `docker/.env`** (every future worktree copies from it) and
**your own worktree's copy**. Every *other* live worktree is that session's, and its `docker/.env` is gitignored
state it may be mid-`Verified?` over: list those copies, never write them. So the listing
(`for f in docker/.env .dev-flow/*/worktree/docker/.env; do echo "$f"; grep COMPOSE_PROFILES "$f"; done`, run
from the main checkout so the glob reaches them all) is a **read-only survey** — it tells you a parallel deploy
reverted your token or another flow's stack is missing one; name that in the handoff and let that flow's own
session raise it. If a parallel deploy reverted yours before you did, say that instead of letting the operator
rediscover it.

**Commit, then build, then measure.** The bff image bakes the git sha into `BUILD_INFO`, so a commit made
after `build:bff` leaves the stack serving the previous sha and the served-build gate refuses with what reads
like someone else's redeploy ("serving …+58046b8d, this checkout is 01849ccb") — one flow paid two full image
builds and a full `ui-check` pass, and first concluded another session had redeployed over it, before finding
its own sha had moved after the build.

**Verify is two steps, and the first one is the deploy.** `flow verify` (no `--confirmed`) rebases the
branch onto `origin/main` when it is behind, then runs `dev` itself — `build:bff`, then `up -d` — proves
`health` and `servedBuild`, and returns `deployed for review`. Its `dev ran (…)` line is the record of that
deploy; do not run the step by hand first, and do not write "no container was rebuilt" into a PR whose
verify printed it. **That deploy is the one the operator clicks**: sign in, look at the change, then ask
Verified? in chat and record it with `flow verify --confirmed`. That second run re-checks the same stack
(the image build is cached and compose converges where nothing changed), and it refuses if `origin/main`
moved since — run `flow verify` again rather than asking over a tree that is no longer what ships. When a
parallel flow released while this one was open, merge `origin/main` into the worktree **before** asking
Verified?: the collision is `CHANGELOG.md`, which verify's own auto-rebase cannot resolve, and a question
discarded by the moved gate has to be re-asked after a hand rebase plus a full verify re-run. A
rebase that stops on conflicts is aborted and handed back: resolve it in the worktree, then re-run — and
after any hand-resolved rebase or merge, sweep for conflict markers before the next commit:
`git grep -nE '^(<<<<<<<|\|\|\|\|\|\|\||>>>>>>>)'` — let it stand alone, since `git grep` exits 1 when the tree
is clean and would silently take your `&& git commit` down with it. The release gate refuses branch-added
markers, but it fires only at release and a `--docs` flow skips the tier-1 hygiene scan that would otherwise
catch them — the window is exactly the hand-resolved rebase, and one such marker rode several commits in a
tracked doc before the next worker's `verify` found it. When
the operator asks you to "deploy this branch", `flow verify` is that command. `health` is a single `/readyz` probe; dev-flow
retries it within `healthWait`.

**Prove there is a model before driving a turn.** A fresh state dir can hold no provider and no agent, so
every message answers `llm_error` — `Provider is not configured: openai` — and a conversation-driven check
fails for a reason that has nothing to do with the change. Read `GET /api/status` and `/api/model-caps`
first. A stand-in provider stands up in one request (`POST /api/providers` with `{name, type:
"llama-cpp", baseUrl: http://host.docker.internal:8080/v1, models:[…]}` against any OpenAI-compatible
endpoint — with no `host.docker.internal`, the bridge-gateway address of the compose network is the host) and
comes down with `DELETE /api/providers?prefix=…`, so leave the stack as you found it. The same symmetry
holds for an agent a check had to create: it *can* be deleted (`agent_delete`, behind Agent → General's
destructive row) and the rule above still applies — clean up what you made, never what you were handed.

A look at the running stack never mutates operator state on its own. Move nothing under
`$LETTA_STATE_DIR` or `/app/auth`, never claim an instance you were not handed, and keep nothing durable in
a container path — the next recreate deletes it. A session that moved the sign-in hash aside to photograph a
locked screen, keeping its only backup inside `bff`, cost the operator their password when the container was
rebuilt. Copy state **out** to the host to photograph it, or add data instead of moving it. And a seed on the
shared stack is not cleaned up until a re-listing shows it gone: after deleting seeded files, list the path
again (`ls`, `list_memory`, whatever fits) and quote the listing in the checkpoint. Whatever a **turn**
created under the bind mount is root-owned, so the host cannot delete any of it — not a leftover directory
(`rmdir` fails) and not a file an agent wrote (`rm` fails with EACCES). Remove it in the owning container
(`docker compose -f docker/compose.yml exec app-server rm -r …`), never from the host. Never report residue
as removed.

**Never ask Verified? of a stack that is not up.** Prove it before the question: every service running
(`docker ps`, or `docker compose -f docker/compose.yml ps` run from the **main** checkout — a worktree
without `docker/.env` cannot interpolate the compose file), the `health` probe green, and where the stack
signs in with a password (`SIGNIN=password`) sign in to the UI yourself and look at the change — an operator
should click a working app, not discover a dead one. This machine's password lives in
`.pi/local-secrets/test-password.md` in the main checkout (gitignored, per-machine, never committed and
never pasted into a tracked file). **Where the file is missing, ask the operator to create it
themselves** and say out loud that the agent must never receive the value as a message: `mkdir -p
.pi/local-secrets` in the main checkout, then write the value into `test-password.md` and `chmod 600` it,
and the agent reads it from there. The file is the point, not the value: an answer that stays in chat is in
the session transcript forever, and a value re-typed into the argv of every `ui-check` / `smoke` call is a
secret in the process list and in the shell history. So the rule is *ask them to write the file, always
export from the file*, never accept the value as a message — and if they insist on sending it anyway, write
it, then say plainly that it reached the transcript and should be rotated. When a look needs raw curl instead of the harness, sign-in is a **JSON** endpoint: `POST /auth/login` with `{"password": …}` — a `--data-urlencode` form post is refused with 400 — so load the value from the **main checkout** (`PW=$(tr -d '\n' < <main-checkout>/.pi/local-secrets/test-password.md)`) and post it as `-d "{\"password\":\"$PW\"}"` with a cookie jar; never `cat` / `head` / `od` the file in a command that prints its value, and never paste the password into argv.
**A stage worker needs the same line in its brief**: hand a worker `bun run ui-check` or `smoke` without
`export LETTUCE_TEST_PASSWORD=$(cat <main checkout>/.pi/local-secrets/test-password.md)` and it concludes the
check cannot be run, so the assertions rest on the plan's claim instead of on a run. Because the stack is
shared, check `docker ps` again just before asking: if another session recreated a service mid-pass, or the
served `assets/index-*.js` changed under you, **stop and tell the operator** instead of competing for the
environment or reporting a result you cannot stand behind.

**A failed `dev` run can leave the app down with no hint.** When `flow verify`'s deploy fails, the first
command is `docker compose -f docker/compose.yml ps -a`, before anything else: compose gates `bff` on
`depends_on: app-server: condition: service_healthy`, so a transient unhealthy `/healthz` (busy under load)
fails the dependency and leaves `bff` in `Created` — never started — while the gate prints only "dependency
failed to start". The operator's app is silently down. The miss is usually transient (app-server was healthy
seconds later): say plainly that the stack is down, then re-run `flow verify`. The same deploy has a **second failure shape: up, but serving the old build.** Compose can half-recreate `bff`, `/readyz` answers ok, and the container keeps running the previous flow's bundle under the same `lettuce-bff:<VERSION>` tag — `build:bff` retags the image, a running container never swaps. So after any failed dev, run `servedBuild` and compare it to the worktree HEAD before re-running; when the served sha is the old bundle, recovery is `docker compose -f docker/compose.yml up -d --no-deps --force-recreate bff` — a retag alone changes nothing.

**Stale-UI triage has a client half, and it is the cheap one.** When the served build identity (the `servedBuild`
sha, or the `assets/index-*.js` hash) already matches the code the operator was told shipped, but their browser
still shows the old UI, the container is exonerated — what they are looking at is the PWA service worker's
precache. Ask for a hard reload, or an SW unregister from devtools (expect a second reload before the new
bundle shows), **before** touching the stack: one session burned three round trips and an unneeded
`--force-recreate bff` on exactly this. Prove server identity first, then blame the client.

`smoke` and `ui-check` both stop at `LETTUCE_TEST_PASSWORD` when the stack signs in with a password
(`scripts/harness.ts`), and an agent never stores that password: **it is not a repo file**, and exporting it
into a shell is the operator's per-machine choice. The one exception is the machine-local file above: where
`.pi/local-secrets/test-password.md` exists, that *is* the operator having made the choice — read it, export
`LETTUCE_TEST_PASSWORD`, and run `smoke` / `ui-check` yourself. Where it does not exist, an agent that cannot
run them records **what it probed in the container** instead — in the PR's *What was clicked* — and says
plainly that a human pass on the sign-in path is still owed. `flow verify` deploying and probing `/readyz`
is not that pass and never counts as one.

**A `flow_stage` worker gets seven more lines in its brief, because it has no operator to ask.**
- **Plan artifacts belong to the driver.** `plan/plan.md` and `plan/mockups/` sit outside the worktree, so a
  worker asked to re-link or re-render a mockup is asked to write where its guard forbids writes — and it will
  spend calls patching `../../` paths through bash instead of saying so. Brief it to render into the worktree,
  or do the re-render in the driving session.
- **Never type a compose lifecycle command — `down`, `stop`, `kill`, `rm`, `restart`** on the stack — compose's
  own verbs; removing root-owned residue *exec'ed inside* the owning container is the exception the guard block
  names. The compose file pins
  `name: lettuce`, so a `down -v` typed in a copy of the file still tears down the real one-per-machine stack
  and its named volumes. Prove compose interpolation with `docker compose config` in a scratch directory and
  nothing else. (A review worker told to "run any probe that proves a claim" reached for exactly this; the
  `confirm` guard was the only thing between it and an empty stack. The driver deploys; the worker does not —
  these rules bind workers, not the sanctioned `flow verify` path.)
- **Stack ownership belongs to the driver.** A read-only reviewer runs static probes and, for UI work,
  renders mockups — it does not deploy, rebuild or `up -d` while a deploy is under review. Say it in the
  brief: a worker that infers the rule mid-run is one bad guess away from competing for the environment.
- **Keep guarded commands out of chains.** A refusal takes the whole command down with it, so a blocked
  `docker …` also kills the read-only `grep` chained after it, and the worker reports a probe it never
  ran. One guarded command per call, or none.
- **A `--patch` flow has no plan file, so the brief must carry the facts, not just the branch.** Hand a
  review worker the upstream `file:line` and the frame order the change leans on — the ones the driver
  already established — or it spends half its budget re-deriving them from `letta-code/` and needs a
  steer to file a report at all.
- **Scratch lives and runs in the worktree, under `bun`.** A probe or browser driver goes in
  `…/worktree/scripts/` and runs with `bun` — never `/tmp`, never `node`. From outside the worktree it does
  not fail loudly: bun resolves Playwright from the main checkout or from bun's global cache, at another
  version, so the probe drives a browser build this worktree never installed and its result is about that.
  A relative `./harness.ts` import is the part that *does* fail, and a worker with nobody to ask re-derives
  it for several calls. Delete the scratch before `flow check`; never commit it.
- **Sibling paths belong to the main checkout.** `letta-code/` sits beside the repo (`../letta-code` from
  the main checkout, never `$repo/letta-code`), and `docker/.env` is copied in by `setup` — a probe that
  resolves paths from its own cwd silently reads the wrong tree and reports absence as fact.

**A refused `edit` leaves the change unapplied and every check still green.** The tool answers with an error and
changes nothing, so a file can sit untouched while the session believes otherwise: five refusals in one session,
one of which left the feature's headline hook defined but never called — dead code three commits deep, green
`flow check` throughout, caught only by a review. Before `flow check`, re-read the target of any failed edit and
`git grep` that the new seam actually has a caller. Two flows also found that **a claim about a render path cannot
be proved by reading the component** — two headline review findings were exactly this (an ack that rendered as the
opposite of what happened; an image parked on a row whose renderer ignores it), with pure-helper tests green both
times. Either render it in a browser or say the claim is unverified.

**Prove a sync's pin before rebuilding for it.** After `flow verify`, check what is actually running read-only —
`docker exec lettuce-app-server-1 cat /usr/local/lib/node_modules/@letta-ai/letta-code/package.json` — and do not
type a hand `docker compose build app-server` followed by a second unscoped `up -d`: the hand pair is the forbidden
by-hand shape and it displaces the stack twice. If that proof reads the old pin, the rebuild is the full redeploy
`lettuce-upstream-sync` names (`up -d --build`, which is what retags `app-server` on the new base), routed through
the sanctioned deploy and named in the handoff — not an extra command of your own.

When the branch edits `scripts/ui-check.ts` itself, the owed item
is narrower: **the operator runs `bun run ui-check` once** during the container test — a click-through does
not execute the suite and CI's `live.yml` runs with `UI_CHECK=off`, so a new assertion would otherwise ship
never-run.

**Assertions read the stack's feature flags, and raising profiles is not free.** `ui-check` derives every
token-gated Settings row and Tools row from `/api/status`'s `features` instead of assuming every compose
profile is on, so it goes green on a lean stack (`COMPOSE_PROFILES=search,pi`) exactly as on the full prod
list — a new assertion about a gated surface must go through `featureOn`, or it fails on the machine that
reads it most. Raising the profiles to reach a section means an `up -d` with a different `COMPOSE_PROFILES`,
which starts sidecars and can recreate `app-server`: name that in the handoff rather than doing it quietly.

- [ ] built and running in the local container stack by `flow verify`'s own `dev` run (`build:bff`
      first for any web/ change, then unscoped `up -d`), left up while Verified? is asked, and the
      operator clicked through the change and said it works
- [ ] (ui) `bun run ui-check` screenshots plus a live look at 390 and 1280, reviewed as a whole screen
      — or `LETTUCE_TEST_PASSWORD` is not held: record the container probes and the owed human pass above
- [ ] the stack was **proven** up before Verified? was asked (`docker ps` all running, `health` green, and
      signed in with `.pi/local-secrets/test-password.md` where `SIGNIN=password`), and no other session
      recreated a service mid-pass — if it did, pause and tell the operator instead of asking
- [ ] the branch is on current `origin/main` before any review — `flow verify` rebases it for the deploy, but
      a `/flow-review` run earlier in implement judges the branch against the skills it branched from: if a
      parallel flow landed since, update first (`git merge origin/main` in the worktree; once the branch is
      pushed, merging is also the `## global` rule — never rebase a pushed branch) and re-run the checks
- [ ] `/flow-review` run **in implement, once `flow check` is green and before `flow verify` is run at all** —
      a fresh-session read-only review of the branch diff (the `flow-review` skill, or `flow_stage` op `review`),
      every must-have and should-have finding fixed, then recorded: `flow review done "<verdict>"` (a review worker
      records itself). dev-flow enforces the record — the first `flow verify` at implement already refuses
      without one, which is what makes "before verify" the position it can be kept in — and the position is what
      the enforcement buys: a review that runs after Verified? makes every
      fix cost a redeploy, a re-asked Verified? and the release gate's "commits landed after your Verified?"
      warning. The rule is live here because `release.review` is unset in this playbook, so it keeps the default
      review step; set it to empty and the gate stops asking. A `--docs` flow owes no review to the gate (it is exempt) — run one anyway, because two folds
      shipped false claims that only a read-only pass caught. On a code-free release branch,
      `check-release-hygiene --pr` over the branch stands in, named as such

**(ui) A state invented after Approve? is still a changed surface.** The mockup gate stops at plan, so copy or
a view added during implement — a review finding's error line, a new empty state — can reach a release with no
render and, often, no reachable browser path to it (a copy that only appears when a backend call fails cannot be
clicked at all). Re-render anything new into `plan/mockups/` with `scripts/mockup.ts`, or name it explicitly
waived at Verified? — the same rule as a plan-named measurement, one beat later.

**A probe that measures the scroll must measure a keyed row.** When a check asserts the viewport held its place,
record the anchor row's own identity and offset at interaction time (`[data-entry]`'s
`getBoundingClientRect()` relative to the scroller) and look it up by that identity again. Never infer the
anchor from "the topmost row the query found": rows scrolled past are still in the DOM and will answer, and
their verdict reads exactly like broken code. One flow spent six build-deploy-probe cycles (~40 min) debugging a
hold that was already exact (the wall sat at 10px before and after each page landed, at both 1280 and 390),
because its probe compared against the new first row.

**A repro that needed seeded data must be clickable at Verified?.** If the plan told you to delete what you
planted (it did: planted state destabilises `ui-check`), the headline state is gone with it, and the operator's
Verified? would be spoken over an app that cannot show the feature. Re-plant before the deploy, hand the seed
back for the click-through, delete it after, and say in the checkpoint that the state needed the seed — measured
by the agent is not seen by the human.

## pre-release

```flow
versionFile = VERSION
versionTag = {version}
changelog = CHANGELOG.md
releases = true
artifact = docker buildx imagetools inspect ghcr.io/dmarchevsky/lettuce-bff:{tag}
```

VERSION holds the whole release tag (`v<MAJOR>.<MINOR>.<PATCH>-letta_<LETTA_CODE_VERSION>`), which is
why `versionTag` is a bare `{version}` — do not let the doctor re-add the `v`. MINOR for new or changed
user-facing functionality, PATCH for everything else that ships. The version is cut here, per feature:
**one commit** bumps VERSION and renames `## [Unreleased]` to `## [v…] - <date>`, leaving an empty
`## [Unreleased]` above it — `check-release-hygiene` fails the branch when the two disagree, so a rename
without a bump is red. **A fold flow (started with `--reflections`) is never asked**: it merges unreleased —
one `## [Unreleased]` entry, no bump, no tag, and `--version` / `flow bump` will not name a class for it. **The bump
class is the operator's release call, made at Approve? and recorded there** — a bare Verified? is not
one, and neither a plan that stated a class nor a sync's own precedent is: on a flow Approve? left open,
ask the class before cutting the prep commit, since a class learned *after* it means re-cutting both the
prep commit and the changelog heading (only `flow bump <class> --confirmed`, or a `--version=<class>` on a
confirmed call, changes it afterwards). **A standing `yolo` has no Verified?
breath** — it runs the flow to this stage unasked — so stop and ask "which bump, or unversioned?" in the same
message as Release?, and hold the prep commit until the answer: a whole `v…` prep commit cut on an assumed
PATCH once came off with one `reset --hard`. Cutting the whole prep commit on an
assumed class once produced hours of soft-reset rework on history that was about to be pushed.
The heading an entry lands under is what CI derives the bump from: `### Added` and
`### Changed` are proof of a MINOR, so a PATCH flow files its entry under `### Fixed` or `### Removed`
— otherwise the derivation answers `unknown` against a `bump:patch` label. Reconcile the operator's bump
word against the changelog heading **before** cutting the prep commit, not when the hygiene check answers
`unknown`: an operator who holds a patch anyway against an `### Added` entry has made a deliberate
override, not an oversight — say so in the PR body and the prep commit message so nobody rediscovers it
as a bug. A flow that ships no version runs `flow release --no-version` on the operator's
word instead, **and it still owes its line**: an unversioned flow files one `## [Unreleased]` entry even
when `lettuce-releasing` calls the change internal-only, because the next versioned release folds
`Unreleased` under its heading and remembers what no image carries. No gate enforces that debt on a `bump:none` branch — `check-release-hygiene --pr` passes a docs branch with no entry and `flow release --no-version` accepts such a tree — so the line is the agent's duty, and a green hygiene run is not evidence it was written. A harness-only entry (playbook, skills,
CI) goes under `### Changed` — the heading rule above reads only at a versioned release, where the `bump:*`
label is what CI derives from and a harness flow carries `bump:none`. When a **versioned** release folds an
`Unreleased` line a parallel unversioned flow left under `### Changed`, the two heading rules collide (harness
prose files under Changed; a PATCH flow must not carry an `Added`/`Changed` block) — **the version being cut
decides**: move the sibling line under the heading this release's class needs and say so in the prep commit
message, rather than improvising live under a Release? deadline. Parallel branches collide on `VERSION`
and `CHANGELOG.md`: merge `main` in and re-derive
the version before asking Release?, because the gate refuses a tag that already exists.

**A behaviour change that lands after Verified? is not covered by it.** Whether it is a review fix or a
"fold it in" the operator asked for mid-checkpoint, a behaviour-changing commit after the word goes back
through `flow verify` before `flow release` — at pre-release that redeploys and re-asks Verified? over the
current tree, and the gate's own refusal says so. Which means review fixes belong *before* Verified? whenever
there is still an implement turn to take; once the word is given, one message asks Verified? again and
Release? only after. And a gate refusal is never answered with `--confirmed` in the same turn: the standing
word was already spent on the question the gate just re-asked, and re-running immediately is refused again.

**Never spend a release attempt finding out the bump.** A fold flow is asked nothing — it merges unreleased, so
there is no class to find. On any other flow the class is the release call recorded at Approve? and **no later gate
asks it again**, so a flow that reaches pre-release without one on record (approved by an older build, or approved
before the class was settled) asks the operator first and then changes it on the record — `flow bump <class>
--confirmed`, or `--version=<class>` / `--no-version` on the confirmed call — rather than
running the gate to discover the answer, which only spends a refusal beside a next tag a parallel flow already
took. The run-it-bare-and-let-it-refuse shape is only the standing-yolo recipe for a **versioned** flow, described
in `## release`.

**A code-free release flow** (its only commit is the bump) inverts the order above: `flow verify` refuses
a branch with nothing committed, so the release-prep commit is cut at implement, and pre-release only
validates and tags. The operator's Verified? was then spoken over the base, which covers this branch
only because the bump ships no runtime code — say so in the PR. The bump renames every image tag, so
verify's `dev` rebuilds all five images under the new name (app-server from scratch) and recreates every
container; `docker tag` the old name to the new one first for images whose content did not change, or
say plainly to expect the full build.

`VERSION` is not the only release literal: the compose image-tag default (`${LETTA_IMAGE_TAG:-v…}`) is a
release-literal site too and moves in the same commit — it is the tag a host without `LETTA_IMAGE_NS`
builds, and what CI compares against `VERSION` after the merge. `sync-upstream` leaves it alone on purpose.

- [ ] the `## [Unreleased]` changelog entry every flow owes — an unversioned flow included — with the
      `bump:minor` / `bump:patch` / `bump:none` label agreeing with it
- [ ] (versioned) the VERSION bump and any README / docs/CONFIGURATION.md sync, in that same
      release-prep commit
- [ ] (versioned) the compose image-tag default moved with VERSION in that same commit
- [ ] (versioned) the operator confirmed this exact tag, after being told the commit range and whether
      `app-server` gets recreated (an `app-server` recreate kills every in-flight turn; the BFF drain
      covers only bff)

## release

```flow
merge = merge
yolo = until-release
```

**`yolo = until-release` is the machine-readable half of the yolo rule in `## global`,** and it is weaker
than it sounds: it only stops a standing yolo from answering Release? for you — it never says whether the
question is needed at all, because `release.ask` defaults to `on-change`: Release? answers itself when
everything since Verified? is release prep, docs or tests, and the gate says so in its output. So the agent-side
rule is: **never replay a plan- or verify-stage yolo onto `flow release` as a pre-answer — run the gate and let
it decide.** Prose alone did not hold here: the block used to carry only `merge = merge`, so a plan-stage yolo
merged a version-bump branch under `--yolo` fourteen minutes before the operator said the word. If the gate
comes back `NEEDS-OPERATOR Release?`, ask it in chat and pass **`--confirmed` alone** (never a second `--yolo`);
a yolo answered **at** the release checkpoint is that word and passes. A fold flow or any unversioned flow never
reaches the question — it merges unreleased — so the gate runs once with the call already on record.

Publish only — the preparation happened above, and **the gate does the publishing**: `flow release
--confirmed` pushes the branch, opens the PR, waits for its CI, merges in the playbook's style, cuts the
annotated tag on the merge commit and pushes it, then records the release — tag on `origin`,
`release.artifact`, and the GitHub Release built from the changelog section — and reads it back. You run no
`git` or `gh` step of your own, and no `flow release-done` in the happy path: that verb is the catch-up
recorder `flow finish` falls back on.

The one thing you author first is **the PR body**. With `.github/pull_request_template.md` in the tree the
gate refuses to open a PR whose body it would have to synthesize from the changelog, because that drops the
template's gate list — so write `.dev-flow/<slug>/pr-body.md` from the template before running the gate:
every section filled, the changelog entry, and the commit the operator's Verified? was given over. (An
unversioned flow has no changelog heading to synthesize from, so the body is the only place its case lives.)

Nothing here deploys prod, and nothing is pushed, merged or tagged without the operator's **Release?** for
that specific change — a standing yes from an earlier change is not one (see `yolo = until-release` above).
The gate **resumes**: `publish waiting` means CI outlived its 30-minute wait, so re-run `flow release` in
this same turn — nothing wakes the session later; `publish stopped` names what is wrong (a red check to fix
on the branch, runs stuck in `queued` to `gh run cancel` + `gh run rerun`, or a forge refusal to report back
and stop).

**Re-read a PR body you edited before reporting from it.** `gh pr edit --body-file` can fail — GitHub's
Projects (classic) deprecation surfaced as a GraphQL error that made `gh` exit 1 with the edit not
applied — so the checkbox flips it was meant to apply never land, and a `gh pr checks --watch` chained
after it dies with it; a chat summary written from intent then says the opposite of what GitHub holds. The PR body is the gate list the operator trusts: after any
body edit, `gh pr view <n> --json body` and quote what is actually there; never chain a watch or a report
behind an edit whose exit code you have not checked. **The proven escape, now used on four PRs**, is to skip
`gh pr edit` and patch the REST endpoint: `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -F body=@<file>`
(or `--input <json>`), then the same `gh pr view` re-read to confirm the length changed.

**A watch that reports no checks has not watched anything.** (These are the hand-poll traps; a gate-run
publish waits for CI itself and reports the same two shapes as `publish waiting` and a queued run.) `gh pr checks <n> --watch` run straight after
`gh pr create` can exit at once with "no checks reported on the branch" because the runs have not
registered yet — which reads exactly like nothing-to-wait-for and invites a merge on a false green. Poll
again (a short sleep, re-run) until checks actually appear, and only then treat a green watch as green. The
sibling failure is a run stuck in `queued`: `gh run watch` will spend your whole shell timeout on a run
that never starts, and a run still queued long after later runs finished is a stuck slot, not a backlog —
re-trigger by pushing a new head commit rather than keep polling. The third shape is a **stale check-run**: the
workflow run has completed and its job reports `success`, but the check-run itself is still `in_progress` and
never clears on its own — one release waited three 30-minute gate windows (~90 min) on an `actionlint` check
whose job had finished green minutes earlier. The gate takes that at its job's word now (dev-flow 0.95.2 probes
`gh api repos/<owner>/<repo>/actions/jobs/<job-id>` after five minutes pending and names the stale check); when
you are polling by hand, do the same, and on `conclusion=success` push the new head commit that was already due
and let the fresh run stamp the check.

The tag *is* the publish trigger — pushing it runs `.github/workflows/publish.yml`, which pushes all five
images to GHCR and retags `latest` — so **`release.artifact` is what proves a release shipped**: the gate
waits for that run and refuses to record the release while the registry does not hold the tag. It exists
because two publishes came back
green and pushed nothing — `lettuce-pr-and-ci` says why a green Compose build is not proof of a push. A
green pipeline is not the artifact; the registry is. (An unversioned flow tags nothing, so this gate and
the artifact check both stand down.)

**The tail runs from `main` before `flow finish`, not after it.** The order is `flow release` (which merges, tags and records) → the
post-merge checks below, from `main` with a clean tree → `flow finish`, and the reason it is an order and
not a preference is that `flow finish` is the last gate and it *will* record a release it finds unrecorded
on its way to deleting the worktree. So a session that treats finish as the cleanup step can end with a
release recorded, a worktree gone and `deploy-check` never run.

- [ ] after the merge and from `main`: `bun run build` **first** — `deploy-check` compares the served bundle
      against this host's `web/dist`, and after a release built in a worktree that copy is stale
      (`build:bff` refreshes the image, never the host's copy) — then `bun run deploy-check` green, plus
      `bun run ui-check` and `bun run smoke` where they apply. A merge that ships nothing an image carries
      (playbook, docs, CI) still leaves build identity naming an older sha: rebuild `bff`, or record that
      there was nothing to rebuild. On this one-stack machine the honest close is often the **record**: if
      another flow's deploy is under review, or a recreate would kill someone's turn, write down what
      `deploy-check` says and hand off instead of rebuilding. Do not offer a shared-stack redeploy inside the
      Finish? question — a bare "finish" cannot say which of the two it means.
- [ ] **after any merge of `origin/main`, prove the changelog before pushing**: a three-way merge attaches your
      added lines to the renamed block, so an unversioned flow's entry can land under an already-tagged heading
      and nothing checks it — diff `CHANGELOG.md` against `origin/main` and confirm your own lines are still
      under `## [Unreleased]` (one fold's four clauses published under the previous tag until a hand repair).
- [ ] a versioned release's **image tag lags the checkout** on a build-locally host: the compose tag default
      moved with `VERSION`, so nothing built before the merge carries the new name and build identity fails
      with no flag to forgive it. Fix from `main` with a clean tree — `bun run build:bff` then
      `docker compose -f docker/compose.yml up -d --no-deps bff` (`--no-deps` is what keeps `app-server`
      from coming along; see the recreation warning above) — and then `deploy-check` is green because
      `VERSION` at `main` now equals the tag the image gets. The published GHCR images are the shipped
      artifact either way; this only proves the local stack matches the release. A host that pulls images
      instead of building them sets `LETTA_IMAGE_NS` (and `LETTA_IMAGE_TAG`) in its own gitignored
      `docker/.env`, and that is the operator's choice, never an agent's edit.

**A release-tag bump guarantees an `app-server` recreation**, and an `app-server` recreation kills every
in-flight turn with no drain — the BFF's drain covers `bff` alone. So after a versioned release, even a
scoped `docker compose up -d bff` on a build-locally host recreates `app-server`, because its image tag
default moved with `VERSION`. Name it in the handoff, and use `--no-deps` when the turn in flight matters.
Earlier versions of this playbook asked only "does app-server get recreated?", which made it sound
optional; for a versioned release it is not.
