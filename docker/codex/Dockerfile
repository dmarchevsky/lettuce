# The app-server image: upstream's letta/letta, unmodified, plus the Codex and
# Claude Code CLIs that letta-code's external coding workers run, and always the
# GitHub CLI its `WatchPR` tool shells out to, and the variables that
# send what agents install to /opt/agent-tools (the end). Build context is this
# directory only (see compose.yml), so nothing else from the repo — least of
# all docker/.env — ever reaches the daemon.
#
# There is no build-time choice about the coding CLIs: BOTH are always installed,
# which is what the published image has always been built with. The `codex` and
# `claude` profile tokens are a runtime Settings switch only (see docker/compose.yml);
# there used to be a `CODING_FEATURES` build arg carrying COMPOSE_PROFILES in, so
# the same tag could be built with or without the CLIs, a local toggle needed a
# rebuild no tag recorded, and nothing running could say which CLIs the image
# held. `/opt/lettuce/features` is that record now: one line per CLI the image
# really carries, whatever the switches say.
ARG LETTA_CODE_VERSION
FROM letta/letta:${LETTA_CODE_VERSION}

# The install manifest, read by the BFF on every connect. Always written, even
# when empty — a missing file means an image that predates this mechanism, and
# the BFF says so instead of guessing. Each line is `<name> <version>`, taken
# from the CLI itself in the step that installs it, so About can show what the
# image really runs instead of repeating a pin that a stale image disproves.
# (An old image has bare names; the BFF reads a missing version as unknown.)
# A version line is written for every CLI in the image because the question the
# marker answers is what is HERE, not what is switched on.
RUN mkdir -p /opt/lettuce && : > /opt/lettuce/features

# The real CLI stays off PATH; `codex` on PATH is always the shim
# (codex-shim.mjs). The shim answers `--version` whatever the Settings switch
# says — that is how a running container reports its Codex — and refuses every
# invocation that would run a worker while the worker is off.
ARG CODEX_VERSION
RUN npm install --global --prefix /opt/codex "@openai/codex@${CODEX_VERSION}" \
    && v="$(/opt/codex/bin/codex --version | grep -oE '[0-9]+\.[0-9]+[^ ]*' | head -1)" \
    && test -n "$v" && printf 'codex %s\n' "$v" >> /opt/lettuce/features

# Same arrangement for Claude Code (`subagent_type: "claude-code"`): the real
# CLI off PATH, `claude` on PATH is the shim (claude-shim.mjs), which injects
# the Anthropic-compatible endpoint settings as env and refuses a run when
# disabled, while `--version` still answers.
ARG CLAUDE_CODE_VERSION
RUN npm install --global --prefix /opt/claude-code "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && v="$(/opt/claude-code/bin/claude --version | grep -oE '[0-9]+\.[0-9]+[^ ]*' | head -1)" \
    && test -n "$v" && printf 'claude %s\n' "$v" >> /opt/lettuce/features

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

# GitHub CLI for WatchPR (letta-code 0.33.3+ runs `gh api …`). The release
# tarball, checked against the release's own checksum list.
ARG GH_VERSION
ARG TARGETARCH
RUN set -eu; \
    asset="gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    base="https://github.com/cli/cli/releases/download/v${GH_VERSION}"; \
    cd /tmp; \
    curl -fsSLO "$base/$asset"; \
    curl -fsSL "$base/gh_${GH_VERSION}_checksums.txt" | grep " $asset\$" | sha256sum -c -; \
    tar -xzf "$asset" -C /tmp; \
    install -m 755 "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh_*; \
    v="$(gh --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"; \
    test -n "$v"; \
    printf 'gh %s\n' "$v" >> /opt/lettuce/features

# Where the tools agents install go: /opt/agent-tools, the `tools/` bind mount
# under LETTA_STATE_DIR (see compose.yml), so they survive a recreate. Each
# package manager's own variable points there, so `npm i -g`, `go install`,
# `uv tool install` and cargo-binstall land in it without the agent having to
# remember; the installing-tools agent skill covers what no variable can
# (downloaded binaries, the go toolchain, prebuilt Rust tools because there is
# no C linker, no apt, cron jobs).
# Not letta-code's own LETTA_TOOLS_DIR (default /root/.letta/bin, where it keeps
# binaries it manages, such as ripgrep; persisted by the letta-home mount). The
# two are different folders on purpose: do not merge them, since /root/.letta
# also holds provider keys and CLI logins, and agent tools stay out of it.
# Only what is worth keeping goes on the mount: tools, uv's Pythons and the Go
# toolchain. Caches (uv's ~/.cache/uv, Go's module cache under the default
# GOPATH /root/go, npm's ~/.npm) stay in the container layer, so a backup of
# LETTA_STATE_DIR does not carry gigabytes it can download again. uv copies
# instead of hardlinking because cache and targets are on different filesystems.
# Appended to PATH, never prepended: an agent's `npm i -g @letta-ai/letta-code`
# or `npm i -g npm` must not shadow the pinned `letta` the container starts, or
# the `codex`/`claude` shims. In ENV, not compose, so `docker exec` shells, every
# child process, and anything else run from this image get them too.
# Login shells are the exception: Debian's /etc/profile resets PATH for root, and
# letta-code's exec_command tool and the coding workers run `bash -lc`. The
# profile.d script appends AGENT_TOOLS_PATH again; the other variables survive a
# login shell untouched.
# uv only ever uses its own Pythons (only-managed), kept in the folder: a tool
# environment built on the image's /usr/bin/python3 would break the day the base
# image moves to a new Python.
RUN printf '%s\n' \
      '# Login shells reset PATH (/etc/profile); add the agent-tools dirs back. See docker/codex/Dockerfile.' \
      'case ":$PATH:" in *":$AGENT_TOOLS_PATH:"*) ;; *) [ -n "$AGENT_TOOLS_PATH" ] && PATH="$PATH:$AGENT_TOOLS_PATH" ;; esac' \
      > /etc/profile.d/agent-tools.sh
ENV AGENT_TOOLS_PATH=/opt/agent-tools/bin:/opt/agent-tools/cargo/bin:/opt/agent-tools/go/bin \
    NPM_CONFIG_PREFIX=/opt/agent-tools \
    CARGO_HOME=/opt/agent-tools/cargo \
    GOBIN=/opt/agent-tools/bin \
    UV_TOOL_DIR=/opt/agent-tools/uv/tools \
    UV_TOOL_BIN_DIR=/opt/agent-tools/bin \
    UV_PYTHON_INSTALL_DIR=/opt/agent-tools/uv/python \
    UV_PYTHON_BIN_DIR=/opt/agent-tools/bin \
    UV_PYTHON_PREFERENCE=only-managed \
    UV_LINK_MODE=copy
ENV PATH="${PATH}:${AGENT_TOOLS_PATH}"

# A cron job starts with almost no environment, so the installing-tools skill
# has cron lines run their script through agent-env, which loads what PID 1 was
# started with. Checked here, where the build step is PID 1 and holds this ENV:
# a broken agent-env fails the build instead of every agent's cron job.
COPY agent-env /usr/local/bin/agent-env
RUN chmod 755 /usr/local/bin/agent-env \
    && env -i PATH=/usr/bin:/bin /usr/local/bin/agent-env sh -c \
      'command -v node >/dev/null && test "$NPM_CONFIG_PREFIX" = /opt/agent-tools \
       && case ":$PATH:" in *":/opt/agent-tools/bin:"*) ;; *) exit 1 ;; esac'
