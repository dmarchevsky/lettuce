# The app-server image: upstream's letta/letta, unmodified, plus optionally the
# Codex and Claude Code CLIs that letta-code's external coding workers run, and
# always the GitHub CLI its `WatchPR` tool shells out to. Build context is this
# directory only (see compose.yml), so nothing else from the repo — least of
# all docker/.env — ever reaches the daemon.
#
# CODING_FEATURES is the raw COMPOSE_PROFILES string (see docker/compose.yml):
# `codex` is installed only when it carries the exact token `codex`, and
# `claude` only when it carries `claude`. Compose cannot substring-test
# COMPOSE_PROFILES in YAML, so the word-match lives here instead — which also
# means the SAME image tag can be built with or without the CLIs, and a token
# change is only picked up by a rebuild. What was actually installed is written
# to /opt/lettuce/features, one name per line, so the BFF can log loudly at
# connect when a token is on but the CLI is not in the image.
ARG LETTA_CODE_VERSION
FROM letta/letta:${LETTA_CODE_VERSION}

ARG CODING_FEATURES=

# The install manifest, read by the BFF on every connect. Always written, even
# when empty — a missing file means an image that predates this mechanism, and
# the BFF says so instead of guessing. Each line is `<name> <version>`, taken
# from the CLI itself in the step that installs it, so About can show what the
# image really runs instead of repeating a pin that a stale image disproves.
# (An old image has bare names; the BFF reads a missing version as unknown.)
RUN mkdir -p /opt/lettuce && : > /opt/lettuce/features

# The real CLI stays off PATH; `codex` on PATH is always the shim
# (codex-shim.mjs), installed even when the real CLI is not — its preflight
# refusal ("not installed") is the clean answer for a worker task, and the BFF
# additionally writes `enabled: false` while the token is off.
ARG CODEX_VERSION
RUN case ",${CODING_FEATURES}," in *,codex,*) \
      npm install --global --prefix /opt/codex "@openai/codex@${CODEX_VERSION}" \
      && v="$(/opt/codex/bin/codex --version | grep -oE '[0-9]+\.[0-9]+[^ ]*' | head -1)" \
      && test -n "$v" && printf 'codex %s\n' "$v" >> /opt/lettuce/features ;; esac

# Same arrangement for Claude Code (`subagent_type: "claude-code"`): the real
# CLI off PATH, `claude` on PATH is the shim (claude-shim.mjs), which injects
# the Anthropic-compatible endpoint settings as env and refuses when disabled.
ARG CLAUDE_CODE_VERSION
RUN case ",${CODING_FEATURES}," in *,claude,*) \
      npm install --global --prefix /opt/claude-code "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      && v="$(/opt/claude-code/bin/claude --version | grep -oE '[0-9]+\.[0-9]+[^ ]*' | head -1)" \
      && test -n "$v" && printf 'claude %s\n' "$v" >> /opt/lettuce/features ;; esac

# Logs the real errno of a failed child spawn, which letta-code discards (a
# subagent that could not start reports only "exited with code unknown"). In
# ENV, not compose, so the variable can never point at a file this image lacks:
# a missing --require target stops every node process in the container.
COPY spawn-diagnostics.cjs /opt/lettuce/spawn-diagnostics.cjs
ENV NODE_OPTIONS="--require /opt/lettuce/spawn-diagnostics.cjs"

# letta-code's self-updater, off. Every `letta` process without a subcommand
# (the reflection and other subagents the server spawns, an agent shell running
# `letta -p`) otherwise runs `npm install -g @letta-ai/letta-code@latest` here
# whenever npm has a newer release. npm moves the live install aside while it
# works, so the running server loses files such as image-resize-worker.js
# ("the image processing worker is missing"), and a successful update would
# run a letta-code the UI was not compiled against. In ENV, not compose, so
# `docker exec` shells and every child process get it too.
ENV DISABLE_AUTOUPDATER=1

COPY shim-core.mjs codex-shim.mjs /opt/codex-shim/
RUN chmod 755 /opt/codex-shim/codex-shim.mjs \
    && ln -s /opt/codex-shim/codex-shim.mjs /usr/local/bin/codex

COPY claude-shim-core.mjs claude-shim.mjs /opt/claude-shim/
RUN chmod 755 /opt/claude-shim/claude-shim.mjs \
    && ln -s /opt/claude-shim/claude-shim.mjs /usr/local/bin/claude

# GitHub CLI for WatchPR (letta-code 0.33.3+ runs `gh api …`). The base image
# has no apt, gzip or git, so this is the release tarball, checked against the
# release's own checksum list and gunzipped with node's zlib.
ARG GH_VERSION
ARG TARGETARCH
RUN set -eu; \
    asset="gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    base="https://github.com/cli/cli/releases/download/v${GH_VERSION}"; \
    cd /tmp; \
    curl -fsSLO "$base/$asset"; \
    curl -fsSL "$base/gh_${GH_VERSION}_checksums.txt" | grep " $asset\$" | sha256sum -c -; \
    node -e 'process.stdin.pipe(require("zlib").createGunzip()).pipe(process.stdout)' < "$asset" \
      | tar -x -C /tmp; \
    install -m 755 "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh_*; \
    v="$(gh --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"; \
    test -n "$v"; \
    printf 'gh %s\n' "$v" >> /opt/lettuce/features
