"""Run workspace-mcp exactly as /policy/sidecar.json says, and nothing else.

The BFF writes that file (Settings -> Google Workspace, bff/src/google/). It lives on a
volume the app-server never mounts, so no agent can change it. Everything that
widens or narrows what agents can do in Google is decided here, at launch:

  * `--permissions` from the file, which is also what workspace-mcp filters
    its tools by;
  * a clean environment, so no inherited WORKSPACE_MCP_* variable can add to
    it (workspace-mcp reads env fallbacks for its mode flags);
  * the one tool that starts an OAuth consent, removed — the BFF owns consent;
  * server-side file paths refused, or an agent could attach /creds to a mail;
  * the allowed recipients list, enforced inside workspace-mcp by
    recipient_guard.py (launch.py installs it before the server starts).

The file is polled; any change restarts the server with the new arguments. When
it says disabled (or is missing, or unreadable) nothing listens at all.
"""

import json
import os
import signal
import subprocess
import sys
import time

POLICY = "/policy/sidecar.json"
LAUNCHER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "launch.py")
POLL_SECONDS = 2
# Tools that start or alter authentication. workspace-mcp would otherwise let
# any agent generate a consent link and send it to the user.
DISABLED_TOOLS = ["start_google_auth"]


def log(message):
    print(f"[google-mcp] {message}", file=sys.stderr, flush=True)


def read_policy():
    try:
        with open(POLICY, encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        log(f"unreadable {POLICY}: {error}; serving nothing")
        return None
    if not isinstance(raw, dict) or raw.get("enabled") is not True:
        return None
    email = raw.get("email")
    permissions = raw.get("permissions")
    if not isinstance(email, str) or "@" not in email:
        return None
    if not isinstance(permissions, list) or not permissions:
        return None
    if not all(isinstance(p, str) and ":" in p for p in permissions):
        return None
    if not raw.get("clientId") or not raw.get("clientSecret"):
        return None
    # Absent means none set; anything else malformed serves nothing, like the rest.
    allowed = raw.get("allowedRecipients", [])
    if not isinstance(allowed, list) or not all(isinstance(entry, str) for entry in allowed):
        return None
    return {
        "email": email,
        "permissions": permissions,
        "clientId": str(raw["clientId"]),
        "clientSecret": str(raw["clientSecret"]),
        "allowedRecipients": allowed,
    }


def command_for(policy):
    return [
        sys.executable,
        LAUNCHER,
        "--transport", "streamable-http",
        "--single-user",
        "--permissions", *policy["permissions"],
        "--disabled-tools", *DISABLED_TOOLS,
    ]


def environment_for(policy):
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": "/tmp",
        "PYTHONUNBUFFERED": "1",
        "WORKSPACE_MCP_HOST": "0.0.0.0",
        "WORKSPACE_MCP_PORT": "8000",
        "WORKSPACE_MCP_CREDENTIALS_DIR": "/creds",
        "WORKSPACE_MCP_DISABLE_LOCAL_FILES": "true",
        "GOOGLE_OAUTH_CLIENT_ID": policy["clientId"],
        "GOOGLE_OAUTH_CLIENT_SECRET": policy["clientSecret"],
        "USER_GOOGLE_EMAIL": policy["email"],
        "LETTUCE_ALLOWED_RECIPIENTS": json.dumps(policy["allowedRecipients"]),
    }
    return env


def stop(child):
    if child is None or child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


def main():
    child = None
    current = None
    stopping = False

    def on_signal(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    while not stopping:
        policy = read_policy()
        exited = child is not None and child.poll() is not None
        if policy != current or exited:
            stop(child)
            child = None
            if exited and policy == current:
                log("workspace-mcp exited; restarting in 5s")
                time.sleep(5)
            current = policy
            if policy is None:
                log("disabled: serving nothing")
            else:
                log(f"serving {policy['email']} with {' '.join(policy['permissions'])}")
                child = subprocess.Popen(command_for(policy), env=environment_for(policy))
        time.sleep(POLL_SECONDS)

    stop(child)


if __name__ == "__main__":
    main()
