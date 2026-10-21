---
name: lettuce-access-and-signin
description: 'lettuce access and sign-in mechanics: the two independent axes (`ACCESS=lan|cloudflared` for the route, `SIGNIN=none|password|cf-access|google` for the method) that replaced the single `LETTA_MODE` auth decision and the removed `DEV_BYPASS_EMAIL`; the boot refusals that make them agree (ACCESS versus the cloudflared profile token both directions, cf-access without a tunnel, `none` behind a tunnel or on a wide bind); `LETTA_HOST_BIND`/`BFF_BIND` and why the in-container bind is never the boundary under Compose; the scrypt password store on the `bff-auth` named volume and why it is not under `LETTA_STATE_DIR`; first-run UI setup and the lockout; the one shared `GOOGLE_CLIENT_ID` for sign-in and Google Workspace with two redirect URIs; `GOOGLE_ALLOW_INSECURE_SIGNIN`; `/api/status`''s `access`/`signin`/`setup_required` and Settings → Access / Sign-in. Read before touching bff/src/config.ts, bff/src/auth/, bff/src/google/settings.ts client resolution, docker/compose.yml auth variables, or the sign-in screens.'
---

# Access and sign-in (the two axes)

Loaded from `AGENTS.md`. One setting used to answer both questions, which is why a laptop install
could not ask for a password and a tunneled one could not ask for anything but Access.

- **`config.access` is the route, `config.signin` is the method.** Both come from env
  (`LETTA_ACCESS` ← `ACCESS`, `LETTA_SIGNIN` ← `SIGNIN` in `docker/compose.yml`) and both **derive
  from `COMPOSE_PROFILES` when unset** — `cloudflared`/`cf-access` with the tunnel token,
  `lan`/`none` without — so an existing `docker/.env` boots with the behaviour it had. `LETTA_MODE`
  stays what it always was: the feature-token list. Nothing in `web/` or the BFF should read `mode`
  for auth again; `checkUpgradeOrigin` takes `access`, `resolve-session` gates on
  `signin === "cf-access"` because that is the only method with a header to read.
- **The refusals live in `assertSigninIsSafe` (`bff/src/config.ts`), not in a compose comment.**
  Compose cannot derive one setting's default from another's value, so: `ACCESS` must match the
  `cloudflared` token **both ways**; `cf-access` without a tunnel (no `Cf-Access-Jwt-Assertion` can
  ever arrive); `none` behind a tunnel; `none` with a non-loopback `hostBind`. A new combination
  belongs there with a message naming the variable to change, and a case in `config.test.ts`.
- **The in-container bind is not the boundary under Compose.** `BFF_BIND` publishes the port on the
  host, and a DNAT never arrives on the container's loopback — that is why the old
  `DEV_BYPASS_ALLOW_REMOTE` existed, and why `bindHostname` in `index.ts` binds `127.0.0.1` only when
  **no `LETTA_HOST_BIND` is declared** (a bare `bun run dev`). Under Compose the socket binds
  `0.0.0.0` and the boot check on the declared `hostBind` is what enforces the rule. Do not "fix"
  this by binding loopback unconditionally: every published port stops answering.
- **`DEV_BYPASS_EMAIL` / `DEV_BYPASS_ALLOW_REMOTE` are gone and their presence is a boot error**
  (`assertNoRemovedAuthVariables`) naming the replacement — a silently ignored variable would leave
  someone believing a door they set is open. `GOOGLE_ALLOW_DEV_BYPASS` became
  `GOOGLE_ALLOW_INSECURE_SIGNIN`, same meaning: an agent shell shares this network namespace and can
  reach the loopback port, so under `SIGNIN=none` a Google policy change needs that opt-in.
- **The password is a scrypt hash on the `bff-auth` named volume — never under `LETTA_STATE_DIR`.**
  `bff/src/auth/password.ts` (N=2^14, r=8, p=1, `signin.json` mode 0600, write-then-rename). The app-server
  mounts the state tree read-write as uid 0 and agent shells run in it, so a hash parked there is
  readable by anything an agent can persuade to run a command. The store doubles as the claim on the
  instance: no file means unclaimed, `claimed()` is memoised and `/api/status` builds
  `setup_required` from it. `AttemptLockout` is in-memory (5 wrong → 60 s, doubling, 15 min cap), so
  a BFF restart clears a lockout — acceptable, it is a throttle, not a vault.
- **First run is a UI setup, not a `.env` value and not a generated secret.** `POST /auth/setup`
  answers until a credential exists and 410s after; the same response mints the session. Anyone who
  reaches an unclaimed instance sets the password, which is why the docs say to set it before
  widening `BFF_BIND`.
- **One Google OAuth client, from env.** `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are the only
  source `SIGNIN=google` can use (sign-in happens before Settings is reachable), and
  `bff/src/google/service.ts` prefers them over the stored pair while **leaving the stored pair in
  the file** as the fallback — `clientOf()` is the single answer used by consent, sidecar config and
  token refresh, because a refresh token is only good for the client that was issued it. Both redirect
  URIs must be registered per origin: `/auth/google/callback` and `/api/google/oauth/callback`.
  `PublicGoogleSettings.clientSource` says which one is live.
- **`/api/status` distinguishes nothing for an anonymous caller but the method.** Unauthenticated it
  returns `authenticated`, `access`, `signin`, `setup_required` and nothing else — enough to render a
  sign-in screen, not enough to fingerprint a deployment. `host_bind`, `public_origin` and
  `password_updated_at` (what Settings → Access / → Sign-in render) are behind the session like every
  other operational field. `password_updated_at` comes from the boot read that warms `claimed()`.
- **Sessions keep one shape and carry the method that minted them.** `SessionPayload` is
  `{email, exp, via}` — `password` and `none` mint the fixed identity `owner`, so nothing downstream
  branches on the method, but `decodeSession(token, secret, via)` refuses a cookie whose `via` is not
  the current `config.signin`. That check is load-bearing: a signature only proves the cookie came
  from this BFF, and `none` (like the old dev bypass) hands one to every visitor, so without it a
  tightened `SIGNIN` would keep honouring those sessions for the whole TTL. A cookie predating the
  field fails the same way, which is why an upgrade from the bypass signs everyone out. The web UI
  keys its warning pill off `signin === "none"` (`AuthPill`), the only method where the session is a
  formality.
- **`/auth/*` is throttled by the same `HttpRateLimiter` as the API**, per identity, and
  `ANONYMOUS_API_PATHS` does not need the Google login callback added — it lives under `/auth`, which
  `requireSession` never gated.
- **The test harness logs in like anyone else.** `scripts/ui-check.ts` and
  `scripts/persistence-smoke.ts` hit `GET /auth/login` (mints a session under `none`); under
  `SIGNIN=password` they need `UI_CHECK_PASSWORD` / `SMOKE_PASSWORD`. There is no dev-login route.
