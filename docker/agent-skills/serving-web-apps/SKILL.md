---
name: serving-web-apps
description: Load this BEFORE starting any web server, web app, API, dashboard or preview that the user should open in a browser — it says which ports are reachable from the user's network (3000-3099 only), how to bind, how to keep the process running, and which URL to give the user.
---

# Serving web apps to the user

You run inside a Docker container. A server you start is **only reachable from the user's
browser if it listens on a published port**. Anything else — `localhost`, a container
address like `172.18.x.x`, or a port outside the range below — works for you but not for
the user.

## Rules

1. **Port: pick one in the range `$AGENT_APP_PORTS` (3000-3099).** Nothing outside it is
   reachable. Check it is free first, and prefer a stable port per app so links keep working:

   ```bash
   ss -ltnH | awk '{print $4}' | grep -E ':(30[0-9]{2})$'   # ports already in use
   ```

2. **Bind to all interfaces (`0.0.0.0`), never `127.0.0.1`/`localhost`.** Examples:
   `python3 -m http.server 3000 --bind 0.0.0.0`, `vite --host 0.0.0.0 --port 3000`,
   `next dev -H 0.0.0.0 -p 3000`, `uvicorn app:app --host 0.0.0.0 --port 3000`,
   Node `server.listen(3000, "0.0.0.0")`.

3. **Run it detached, with a log, so it outlives your turn and your shell:**

   ```bash
   mkdir -p "$PWD/logs"
   setsid nohup <command> > "$PWD/logs/<app>.log" 2>&1 < /dev/null &
   sleep 2; curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/
   ```

   Confirm it answers before telling the user it is up. Note the app, its port and the
   exact start command somewhere you will find again (your memory, or a README next to
   the app), so you can restart it later.

4. **Give the user this URL:** `http://$AGENT_APP_HOST:<port>`. If `$AGENT_APP_HOST` is
   empty, say `http://<your server's LAN address>:<port>` and ask the user to fill in the
   address — never hand out `localhost` or a `172.x` container address.

## Things to tell the user when relevant

- **It is not permanent.** Every process you start lives in the Letta container and stops
  when that container restarts (updates, redeploys). Offer to restart it when asked; the
  command you noted in rule 3 is what makes that quick.
- **There is no login.** Anyone who can reach the server on the network can open the app.
  Do not serve secrets, credentials or private files through it.
- To stop an app: `pkill -f '<distinctive part of the command>'`, or find the PID with
  `ss -ltnp | grep :<port>`.
