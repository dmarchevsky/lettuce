# The app-server image: upstream's letta/letta, unmodified, plus optionally the
# Codex and Claude Code CLIs that letta-code's external coding workers run, and
# always the GitHub CLI its `WatchPR` tool shells out to, and the variables that
# send what agents install to /opt/agent-tools (the end). Build context is this
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
