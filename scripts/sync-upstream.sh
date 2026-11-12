#!/usr/bin/env bash
# Move the letta-code reference checkout to a release tag and report protocol /
# behavioral drift. The checkout is a plain clone of upstream, pinned to a tag.
#
# Usage: scripts/sync-upstream.sh v<version>
set -euo pipefail

UI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKOUT="${LETTA_CODE_DIR:-$(cd "$UI_ROOT/.." && pwd)/letta-code}"
UPSTREAM_URL="https://github.com/letta-ai/letta-code.git"
REF="${1:-}"

# Files whose *types* we consume — drift here is also caught by `bun run typecheck`.
PROTOCOL_FILES=(
  "src/types/protocol_v2.ts"
  "src/types/app-server-info.ts"
  "src/types/app-server-protocol.ts"
  "src/types/cwd-protocol.ts"
  "src/types/queue-update-protocol.ts"
  "src/types/conversation-fork-protocol.ts"
  "src/types/subagent-protocol.ts"
  "src/types/runtime-start-protocol.ts"
  "src/types/schedule-protocol.ts"
  "src/websocket/listener/listener-constants.ts"
)

# Files whose *behavior* we depend on but whose types will NOT catch a change.
# See AGENTS.md — these are the invariants that keep chat alive across tab switches.
BEHAVIOR_FILES=(
  "src/websocket/listener/connection-lifecycle.ts"
  "src/websocket/listener/lifecycle.ts"
  "src/channels/gateway-supervisor.ts"
  "src/websocket/app-server.ts"
  "src/websocket/app-server-auth.ts"
  "src/websocket/listener/interrupts.ts"
  "src/websocket/listener/control-inputs.ts"
  # Hand-parsed in web/src/state/use-conversation.ts (readBackgroundProcesses):
  # an unlisted kind is dropped, so a new one silently vanishes from Tasks.
  "src/types/background-process-protocol.ts"
  # Which tools agents get. 0.33 dropped `memory` and `MultiEdit` from every
  # toolset; AGENTS.md and web/src/lib/tool-summary.ts describe the tool set.
  "src/tools/toolset-catalog.ts"
  # Settings → Skills: bff/src/skills/ re-implements skill discovery (roots,
  # override order, frontmatter, the local-agent bundled exclusions), because
  # upstream publishes the list only on a live conversation runtime.
  "src/agent/skills.ts"
  "src/agent/client-skills.ts"
  "src/utils/frontmatter.ts"
  # The Codex worker path our shim sits in (docker/codex): the turn/start
  # sandbox policy it rewrites and the `codex login status` preflight it must pass.
  # Also the argv letta-code uses to spawn the app-server — the shim finds its
  # subcommand in the first non-option argument, and a Codex CLI override
  # prepended before `app-server` that it cannot read means no sandbox rewrite.
  "src/tools/impl/codex-app-server.ts"
  "src/tools/impl/external-coding-agent.ts"
  # Settings → Telegram (bff/src/channels/) writes upstream's own channel state:
  # the accounts.json write shape (camel/snake canonicalization, inline token in
  # file mode), the routing/pairing JSON, and the live-vs-restart split (routes
  # re-read per message, accounts only at startup — docker/channel-gateway-supervise.sh).
  "src/channels/accounts.ts"
  "src/channels/credential-store.ts"
  "src/channels/routing.ts"
  "src/channels/routing-store.ts"
  "src/channels/pairing.ts"
  "src/channels/access-control.ts"
  "src/cli/subcommands/channel-gateway.ts"
  # The shared MCP list (bff/src/mcp) is a settings file `letta mcp` reads with
  # HOME pointed elsewhere: it relies on initialize() not persisting once the
  # rollback flag is set, on getAgentSettings matching agentId + baseUrl, and on
  # `--agent` taking any id.
  "src/settings-manager.ts"
  "src/cli/subcommands/mcp.ts"
  "src/cli/subcommands/mcp-io.ts"
  # The native web tools are a mod the BFF writes (bff/src/web-tools/mod.ts):
  # where global mods are discovered, the default-export + tools.register shape,
  # that listener turns get them whatever the toolset, that `reload` re-imports
  # them, and the diagnostics file Settings → Web reads.
  "src/mods/mod-sources.ts"
  "src/mods/mod-engine.ts"
  "src/mods/types.ts"
  "src/mods/mod-diagnostics-file.ts"
  # Where the mods the BFF writes are *discovered*: it resolves through settings-path now, so a
  # LETTA_CONFIG_DIR moves it out from under the fixed /root/.letta/mods the BFF writes into.
  "src/mods/paths.ts"
  "src/websocket/listener/mod-adapter.ts"
  "src/websocket/listener/commands.ts"
  "src/tools/manager.ts"
  # `approval: "ask"` on the Google write tools and mcp_call_write relies on
  # approvalPolicy "ask" prompting in Standard/Strict and running in Unrestricted.
  "src/permissions/checker.ts"
  "src/permissions/mode.ts"
  # Settings → Providers: hosts naming models vendor/model go through
  # connect_provider (bff/src/providers/routes.ts), because the providers mod
  # refuses a "/" in an id, and the BFF parses that refusal's message out of the
  # diagnostics file (vision.ts) to say why a provider did not load. The connection
  # takes a baseUrl for any provider, keeps a stored one when an update sends none,
  # and a stored one replaces every catalog model's own base.
  "src/providers/connect-provider-service.ts"
  "src/backend/local/local-provider-auth-store.ts"
  "src/backend/dev/pi-provider-mod-validation.ts"
  "src/backend/dev/pi-model-factory.ts"
  # Every `~/.letta` path upstream resolves goes through this now (HOME, LETTA_HOME, and the newer
  # LETTA_CONFIG_DIR, which outranks LETTA_HOME). Our own GH_CONFIG_DIR does NOT follow it — a moved
  # root would leave /root/.letta/gh behind — so a change here splits our hardcoded paths in two.
  "src/utils/settings-path.ts"
  # Who may steer or stop a child: the ownership rule, and the id shapes it accepts.
  "src/websocket/listener/commands/subagent-control.ts"
  # The event log read_subagent_events pages, and the two gating sites the skill describes.
  "src/agent/subagent-events.ts"
  "src/tools/impl/task.ts"
  "src/tools/impl/task-transcript.ts"
  # The request-kind header the local backend sends to llama.cpp, and its two call sites.
  "src/backend/dev/pi-request-headers.ts"
  "src/backend/dev/pi-stream-adapter.ts"
  # What a compaction is summarised with, and what happens when one cannot get under the
  # pressure threshold: on our local backend a cloud model name can only fail, and a
  # compaction that loops instead of failing overruns llama.cpp.
  "src/backend/local/compaction.ts"
  "src/backend/local/local-backend.ts"
  # Where a turn's reported usage comes from, including the client-side api_cost_usd the
  # local backend now fills in (bff/src/session/turn-usage.ts reads this shape).
  "src/backend/dev/provider-turn-executor.ts"
)

# The connections serve the catalog bundled in this package: which hosts name
# models vendor/model, and how many models each serves.
CATALOG_PACKAGE="@earendil-works/pi-ai"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# Only published releases have an image and an npm package to pin to.
[[ "$REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail "Usage: sync-upstream.sh v<version>  (a published release tag, not a branch)"

[[ -d "$CHECKOUT/.git" ]] || git clone "$UPSTREAM_URL" "$CHECKOUT"
cd "$CHECKOUT"

say "Upstream checkout: $CHECKOUT"

# ── 1. The checkout carries no local changes ──────────────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
  git status --short
  fail "Upstream checkout has local changes. It is read-only — see AGENTS.md."
fi

CURRENT="$(git rev-parse HEAD)"
# Fetch by URL, so any clone works whatever its remotes are called.
git fetch --tags "$UPSTREAM_URL"
TARGET="$(git rev-parse "$REF^{commit}")"

# docker/.env is gitignored, so it is the one pin site a sync would otherwise
# leave behind — and a value there outranks compose's default, so the host keeps
# building the older release and survives every later sync. It should not be set
# at all, so drop it wherever it is found (before the "already synced" exit, so
# re-running the command cleans a host that only has this problem).
if [[ -f "$UI_ROOT/docker/.env" ]] && grep -q '^LETTA_CODE_VERSION=' "$UI_ROOT/docker/.env"; then
  sed -i -E '/^LETTA_CODE_VERSION=/d' "$UI_ROOT/docker/.env"
  echo "  docker/.env: removed LETTA_CODE_VERSION — docker/compose.yml carries the pin"
fi

if [[ "$CURRENT" == "$TARGET" ]]; then
  say "Already at $REF ($(git rev-parse --short HEAD)). Nothing to sync."
  exit 0
fi

say "Syncing $(git rev-parse --short "$CURRENT") -> $(git rev-parse --short "$TARGET") ($REF)"
git --no-pager log --oneline "$CURRENT".."$TARGET" | head -40 || true
echo "  ($(git rev-list --count "$CURRENT".."$TARGET") commits)"

# ── 2. Protocol drift ─────────────────────────────────────────────────────────
say "Protocol drift"
PROTO_CHANGED=0
for f in "${PROTOCOL_FILES[@]}"; do
  if ! git diff --quiet "$CURRENT" "$TARGET" -- "$f"; then
    PROTO_CHANGED=1
    printf '  changed: %s\n' "$f"
    # Message types added / removed, so the report is readable at a glance.
    git diff "$CURRENT" "$TARGET" -- "$f" \
      | grep -E '^[+-]  type: "' \
      | sed -E 's/^([+-])  type: "([^"]+)".*/    \1 \2/' \
      | sort -u -k2 || true
  fi
done
[[ $PROTO_CHANGED -eq 0 ]] && echo "  none"

OLD_VER="$(git show "$CURRENT:src/types/app-server-info.ts" | grep -oP 'APP_SERVER_PROTOCOL_VERSION = \K[0-9]+' || echo '?')"
NEW_VER="$(git show "$TARGET:src/types/app-server-info.ts"  | grep -oP 'APP_SERVER_PROTOCOL_VERSION = \K[0-9]+' || echo '?')"
if [[ "$OLD_VER" != "$NEW_VER" ]]; then
  warn "  APP_SERVER_PROTOCOL_VERSION: $OLD_VER -> $NEW_VER  (breaking — review the client)"
else
  echo "  APP_SERVER_PROTOCOL_VERSION: $NEW_VER (unchanged)"
fi

# ── 3. Behavioral drift (types will not catch these) ──────────────────────────
say "Behavioral drift — invariants types cannot check"
BEHAV_CHANGED=0
for f in "${BEHAVIOR_FILES[@]}"; do
  if ! git diff --quiet "$CURRENT" "$TARGET" -- "$f"; then
    BEHAV_CHANGED=1
    warn "  changed: $f  ($(git diff --shortstat "$CURRENT" "$TARGET" -- "$f" | xargs))"
  fi
done
if [[ $BEHAV_CHANGED -eq 1 ]]; then
  warn ""
  warn "  Re-verify by hand before trusting this sync:"
  warn "   * connection-lifecycle.ts — does closing the LAST subscribed connection still"
  warn "     cancel the turn? Our whole multiplexer design exists because of this."
  warn "   * lifecycle.ts — do process services (cron scheduler, channels) still start on"
  warn "     first client attach?"
  warn "   * gateway-supervisor.ts — did channels move to the spawned gateway? It has no"
  warn "     --ws-auth support and would break Telegram under capability-token auth."
  warn "   * channels/accounts|routing|pairing|credential-store|access-control +"
  warn "     subcommands/channel-gateway.ts — a changed on-disk shape, canonicalization,"
  warn "     credential-store default, or a gateway flag? bff/src/channels/state.test.ts"
  warn "     pins the current shapes against upstream's own writers; regenerate the"
  warn "     fixtures there and re-check whether pairing/routing still apply live."
  warn "     docker/channel-gateway-supervise.sh restarts on accounts.json only."
  warn "   * app-server.ts / app-server-auth.ts — did the Origin / Bearer handling change?"
  warn "   * interrupts.ts — is a live tool_return_message still BOTH the singular fields and"
  warn "     a tool_returns[] array? web/src/lib/messages.ts reads both; protocol_v2.ts types"
  warn "     neither, so typecheck sees nothing."
  warn "   * control-inputs.ts — does handleAbortMessageInput still return false with no frames"
  warn "     when nothing is active, and still emit Interrupted before the turn unwinds?"
  warn "   * background-process-protocol.ts — a new kind? readBackgroundProcesses drops it."
  warn "   * toolset-catalog.ts — tools added/removed? Update tool-summary.ts and AGENTS.md."
  warn "   * skills.ts / client-skills.ts / frontmatter.ts — new skill root, changed override"
  warn "     order or parsing? Mirror it in bff/src/skills/ and compare /api/skills with a"
  warn "     live turn's current_available_skills."
  warn "   * settings-manager.ts / subcommands/mcp*.ts — does \`letta mcp --agent <id>\` with"
  warn "     HOME=/root/.letta/mcp-home still read the shared list without rewriting it?"
  warn "     Run the mcp-servers wrapper's \`list\` and \`call\` in the container."
  warn "   * mod-engine.ts / mod-diagnostics-file.ts — is a refused mod still reported in"
  warn "     the diagnostics file with mod.path equal to the file the BFF wrote?"
  warn "   * pi-provider-mod-validation.ts — is a \"/\" in a model id still refused, and"
  warn "     does the message still start \"Provider <id>,\"? vision.ts parses it, and the"
  warn "     connection types in bff/src/providers/registry.ts exist because of the rule."
  warn "   * connect-provider-service.ts / local-provider-auth-store.ts / pi-model-factory.ts"
  warn "     — does connect_provider still take baseUrl for any provider, keep a stored one"
  warn "     on an update that sends none (routes.ts disconnects first for that), and does a"
  warn "     stored one still replace every catalog model's base?"
  warn "   * settings-path.ts — did the product config root move off HOME? bff/src/skills/"
  warn "     discovery.ts hardcodes /root/.letta/skills, the mcp-servers wrapper runs"
  warn "     HOME=/root/.letta/mcp-home, and bff writes mods to /root/.letta/mods, so a moved"
  warn "     root silently splits all three from what the BFF wrote. GH_CONFIG_DIR is ours and"
  warn "     does not follow it, so /root/.letta/gh would be left where it was."
  warn "   * mods/paths.ts — same question from the mod side: does the BFF-rendered mod still"
  warn "     land where the listener discovers mods?"
  warn "   * subagent-control.ts — does steering still accept a LOCAL"
  warn "     codex_<thread>/claude_<session> id, and is ownership still judged against the"
  warn "     caller's parent scope? That rule is the whole boundary for what a browser may"
  warn "     send about a child."
 warn "   * codex-app-server.ts — how does it spawn the app-server now? The shim rewrites"
 warn "     its stdin only when it reads `app-server` as the subcommand (first non-option argv,"
 warn "     since upstream can prepend `-c` CLI overrides for tracing); miss that and Codex is"
 warn "     asked for a bubblewrap sandbox inside the container. Does a worker launch still pass"
 warn "     the `codex login status` preflight our shim must satisfy?"
else
  echo "  none"
fi

catalog_version() {
  git show "$1:package.json" | grep -oP "\"$CATALOG_PACKAGE\": \"\K[^\"]+" || echo '?'
}
OLD_CATALOG="$(catalog_version "$CURRENT")"
NEW_CATALOG="$(catalog_version "$TARGET")"
if [[ "$OLD_CATALOG" != "$NEW_CATALOG" ]]; then
  warn "  $CATALOG_PACKAGE: $OLD_CATALOG -> $NEW_CATALOG  (the model catalog moved: does a host"
  warn "  in bff/src/providers/registry.ts now name models vendor/model, or stop to? Recount"
  warn "  OpenRouter's served models for docs/CONFIGURATION.md.)"
else
  echo "  $CATALOG_PACKAGE: $NEW_CATALOG (unchanged)"
fi

# ── 4. Apply ──────────────────────────────────────────────────────────────────
say "Applying"
git -c advice.detachedHead=false checkout --detach "$TARGET"

if [[ -n "$(git status --porcelain)" ]]; then
  fail "Upstream checkout is dirty after checkout."
fi
echo "  now at $REF ($(git rev-parse --short HEAD))"

# ── 5. Re-pin to the new release ──────────────────────────────────────────────
# The checkout is not a build input — the UI consumes @letta-ai/letta-code
# from npm and the images come from letta/letta on Docker Hub. So there is
# nothing to rebuild here; what has to move is the version literal.
VERSION="$(node -p "require('$CHECKOUT/package.json').version")"
say "Re-pinning to $VERSION"

# Both artifacts must actually exist, or the stack pins a version it cannot run.
npm view "@letta-ai/letta-code@$VERSION" version >/dev/null 2>&1 \
  || fail "npm has no @letta-ai/letta-code@$VERSION — sync to a published release tag."
docker manifest inspect "letta/letta:$VERSION" >/dev/null 2>&1 \
  || fail "Docker Hub has no letta/letta:$VERSION — sync to a published release tag."
echo "  published on npm and Docker Hub"

cd "$UI_ROOT"
# Every tracked home of the literal; check-version-pin.ts asserts the result.
sed -i -E "s|(\"@letta-ai/letta-code\": \")[^\"]+(\")|\1$VERSION\2|" \
  package.json bff/package.json web/package.json
sed -i -E "s|(LETTA_CODE_VERSION:-)[^}]+(\})|\1$VERSION\2|g" docker/compose.yml
# NOTE: this deliberately does not touch `LETTA_IMAGE_TAG:-v…` in the same file.
# That literal names the RELEASE whose images CI published, not the letta-code pin,
# so it moves with VERSION in the release-prep commit — and check-release-hygiene.ts
# fails the branch when the two disagree. Rewriting it here would point a synced but
# unreleased branch at images that do not exist yet.
# The docs' defaults table states the same default, so a sync that missed it told
# every reader the wrong version. check-version-pin.ts counts it as a site now.
# In JS rather than sed: the row is a markdown pair of backticked cells, and a
# sed replacement of \1 followed by digits reads as group 19 and shreds the file.
bun -e '
const [file, version] = process.argv.slice(1);
const text = await Bun.file(file).text();
const next = text.replace(/`LETTA_CODE_VERSION` \| `[^`]+`/, () =>
  "`LETTA_CODE_VERSION` | `" + version + "`");
if (next === text) {
  console.error(file + ": no pin row to rewrite in the docs defaults table");
  process.exit(1);
}
await Bun.write(file, next);
' docs/CONFIGURATION.md "$VERSION"

bun install
bun scripts/check-version-pin.ts || fail "Version pins disagree after the bump."

say "Typechecking UI against the new protocol"
if bun run typecheck; then
  say "Sync complete. No typed protocol breakage."
  echo "  A host whose docker/.env sets LETTA_CODE_VERSION needs the line gone before "
  echo "  its next deploy — the stale-pin story: docs/upstream-notes.md#stale-pin-story."
  echo "  Locally a version bump is a full rebuild: docker compose -f docker/compose.yml up -d --build"
  echo "  In prod the release publishes the images instead: LETTA_IMAGE_TAG's default in"
  echo "  docker/compose.yml is bumped with VERSION at pre-release, and publish.yml pushes them."
else
  fail "Typecheck failed — the protocol changed under us. Fix the UI — upstream is not ours to patch."
fi
