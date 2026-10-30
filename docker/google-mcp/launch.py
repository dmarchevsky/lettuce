"""Start workspace-mcp with the recipient guard installed (see recipient_guard.py).

The supervisor runs this instead of the `workspace-mcp` script, passing the same
arguments, and always sets LETTUCE_ALLOWED_RECIPIENTS — a JSON list, empty for
no restriction. A missing or unreadable value stops here instead of serving
unguarded.
"""

import json
import os
import sys

import recipient_guard


def allowed_from_env():
    raw = os.environ.get("LETTUCE_ALLOWED_RECIPIENTS")
    if raw is None:
        raise ValueError("LETTUCE_ALLOWED_RECIPIENTS is not set")
    value = json.loads(raw)
    if not isinstance(value, list) or not all(isinstance(entry, str) for entry in value):
        raise ValueError("LETTUCE_ALLOWED_RECIPIENTS is not a list of strings")
    return value


def main():
    try:
        allowed = allowed_from_env()
    except ValueError as error:
        print(f"[google-mcp] {error}; refusing to start", file=sys.stderr, flush=True)
        sys.exit(2)
    if recipient_guard.install(allowed, os.environ.get("USER_GOOGLE_EMAIL")):
        print(f"[google-mcp] recipient guard on: {len(allowed)} allowed", file=sys.stderr, flush=True)

    from main import main as workspace_mcp

    sys.argv = ["workspace-mcp", *sys.argv[1:]]
    workspace_mcp()


if __name__ == "__main__":
    main()
