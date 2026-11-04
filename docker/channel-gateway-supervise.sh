#!/bin/sh
# The channel-gateway container's real entrypoint (docker/compose.yml mounts this
# over its `command:`; the image itself is upstream's, unmodified).
#
# Why a wrapper exists at all: Settings → Telegram writes the gateway's own
# state files (bff/src/channels/), and upstream reads two of the three live —
# routing and pairing are re-read per inbound message — but accounts.json (the
# bot token, `enabled`) is read exactly once, at startup, when
# `--restore-enabled-channels` picks what to start. The BFF cannot restart a
# container, so the gateway restarts itself: watch the checksum of every
# accounts.json, and when it changes while the gateway runs, TERM the child and
# start it again. That is the whole job.
#
# It deliberately watches NOTHING else. Restarting on pairing or route churn
# would drop turns in flight for changes the gateway already picks up live.
# A restart does drop whatever Telegram-fired turn was in flight — accepted,
# because the only trigger is an operator editing the bot in Settings.

set -eu

channels_dir=${LETTA_CHANNELS_DIR:-/root/.letta/channels}
poll_seconds=${CHANNEL_GATEWAY_POLL_SECONDS:-5}

child=""
stopping=0

forward_term() {
  stopping=1
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
  fi
}
trap forward_term TERM INT

fingerprint() {
  # An absent channels dir is a state, not an error: it is the empty
  # fingerprint the first Settings save changes.
  find "$channels_dir" -mindepth 2 -maxdepth 2 -name accounts.json 2>/dev/null |
    sort |
    xargs -r cksum 2>/dev/null || true
}

while :; do
  before=$(fingerprint)
  started=$(date +%s)

  # `--install-channel-runtimes` npm-installs the channel's runtime deps into
  # the state dir on start, so `letta channels install` is never a manual step.
  letta channel-gateway \
    --app-server-url ws://127.0.0.1:4500 \
    --restore-enabled-channels \
    --allow-startup-errors \
    --install-channel-runtimes &
  child=$!

  while :; do
    # One `sleep` rather than a ticker: a TERM landing during it is handled
    # within the poll window, well inside Docker's stop grace.
    sleep "$poll_seconds"
    if ! kill -0 "$child" 2>/dev/null; then
      break
    fi
    after=$(fingerprint)
    if [ "$after" != "$before" ]; then
      echo "[supervise] accounts changed — restarting the gateway" >&2
      kill -TERM "$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true
      break
    fi
  done

  wait "$child" 2>/dev/null || true
  child=""
  if [ "$stopping" -eq 1 ]; then
    exit 0
  fi
  # A child that dies at once (bad token with the network down) must not spin:
  # a crash under ten seconds buys a five-second pause before the next start,
  # because `--install-channel-runtimes` makes every start an npm check.
  if [ $(( $(date +%s) - started )) -lt 10 ]; then
    sleep 5
  fi
done
