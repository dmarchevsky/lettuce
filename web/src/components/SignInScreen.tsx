import { type FormEvent, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import { choosePassword, SignInPaused, type Signin, signInWithPassword } from "../lib/signin.ts";
import { toast } from "./Toast.tsx";

/**
 * The page a visitor who is not signed in gets, per method.
 *
 * It used to be prose telling people to go edit `docker/.env`, because there was
 * no credential to type. Now three of the four methods get a real control here,
 * and the fourth (`cf-access`) explains what to do instead, since its credential
 * is a cookie Cloudflare puts on the request before it ever reaches the app.
 */

interface Props {
  signin: Signin;
  /** No password exists yet: the first visitor picks it, and claims the instance. */
  setupRequired: boolean;
}

/** A session was just minted: reload so every screen loads under it. */
function enter() {
  window.location.assign("/");
}

function refusalOf(cause: unknown): string {
  return cause instanceof SignInPaused
    ? `Too many attempts — try again in ${cause.retryAfter}s.`
    : errorMessage(cause);
}

function PasswordForm({ setup }: { setup: boolean }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (setup && password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (setup) await choosePassword(password);
      else await signInWithPassword(password);
      enter();
    } catch (cause) {
      setError(refusalOf(cause));
      setBusy(false);
    }
  };

  if (setup) {
    return (
      <form className="signin-form" onSubmit={submit}>
        <label className="field">
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="at least 10 characters"
            autoComplete="new-password"
          />
        </label>
        <label className="field">
          Repeat password
          <input
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            placeholder="the same again"
            autoComplete="new-password"
          />
        </label>
        {error ? <p className="warning small">{error}</p> : null}
        <button className="button" type="submit" disabled={busy || !password}>
          Set password &amp; continue
        </button>
      </form>
    );
  }

  return (
    <form className="signin-form" onSubmit={submit}>
      <label className="field">
        Password
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
        />
      </label>
      {error ? <p className="warning small">{error}</p> : null}
      <button className="button" type="submit" disabled={busy || !password}>
        Sign in
      </button>
    </form>
  );
}

export function SignInScreen({ signin, setupRequired }: Props) {
  if (signin === "password") {
    return (
      <main className="shell center">
        <h1>Lettuce</h1>
        {setupRequired ? (
          <>
            <p className="muted">First run — choose the password this instance signs in with.</p>
            <PasswordForm setup />
            <p className="warning small">
              Whoever reaches this page first claims this instance — keep the port closed until you
              have been here.
            </p>
          </>
        ) : (
          <>
            <p className="muted">Sign in to continue.</p>
            <PasswordForm setup={false} />
          </>
        )}
      </main>
    );
  }

  if (signin === "google") {
    return (
      <main className="shell center">
        <h1>Lettuce</h1>
        <p className="muted">Sign in with an allowed Google account.</p>
        <div className="signin-form">
          <a className="button" href="/auth/google/start">
            Sign in with Google
          </a>
        </div>
      </main>
    );
  }

  if (signin === "none") {
    return (
      <main className="shell center">
        <h1>Lettuce</h1>
        <p className="muted">
          Anyone who can reach this address is the owner. It listens on this machine only.
        </p>
        <div className="signin-form">
          <a className="button" href="/auth/login">
            Continue
          </a>
        </div>
        <p className="muted small">
          To reach it from another device, set <code>SIGNIN=password</code>.
        </p>
      </main>
    );
  }

  // Cloudflare Access: its login is a redirect the app cannot start from inside
  // the page, so the page's job is to say reload.
  return (
    <main className="shell center">
      <h1>Lettuce</h1>
      <p className="muted">
        Not signed in. This instance is reached through Cloudflare Access — if you are seeing this
        on the tunnel, reload; direct access without Access is not supported.
      </p>
      <div className="signin-form">
        <button
          type="button"
          className="button"
          onClick={() => {
            toast("Reloading…");
            enter();
          }}
        >
          Reload
        </button>
      </div>
    </main>
  );
}
