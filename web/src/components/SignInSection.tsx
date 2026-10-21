import { type FormEvent, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import { changePassword, identityLabel, SIGNIN_LABELS, type Signin } from "../lib/signin.ts";
import { toast } from "./Toast.tsx";

interface Props {
  signin: Signin;
  email: string | null;
  /** When the password was last set; only meaningful for `password`. */
  passwordUpdatedAt?: string | null;
}

/**
 * Settings → Sign-in: who is allowed in, and what they had to prove to get here.
 *
 * The method itself is not editable here — it is `SIGNIN` in `docker/.env`, and
 * changing it changes what the BFF will boot as, so it belongs with the other
 * deployment variables. What this section can do is change the one credential
 * that lives on the box: the password. The current one is required, because a
 * stolen session cookie should not be enough to lock its owner out.
 */
export function SignInSection({ signin, email, passwordUpdatedAt }: Props) {
  const rows: [string, string][] = [["Sign-in", SIGNIN_LABELS[signin]]];
  const who = identityLabel(email);
  if (who) rows.push(["Signed in as", who]);
  if (signin === "password" && passwordUpdatedAt) {
    rows.push(["Password set", passwordUpdatedAt.slice(0, 10)]);
  }

  return (
    <>
      <ul className="list">
        {rows.map(([label, value]) => (
          <li key={label} className="row-between pad">
            <span className="muted">{label}</span>
            <span>{value}</span>
          </li>
        ))}
      </ul>

      {signin === "password" ? (
        <>
          <p className="section-note">Change password</p>
          <ChangePasswordForm />
          <p className="muted small">
            Five wrong attempts in a row pause sign-in for a minute, doubling up to fifteen minutes.
            The password itself is never stored — only a scrypt hash, on the BFF's own volume, which
            is why a lost one is reset by hand rather than recovered here.
          </p>
        </>
      ) : signin === "google" ? (
        <p className="section-note">
          Sign-in uses the Google client in <code>docker/.env</code> — the same one the Google
          Workspace section uses once its profile token is on — and admits only the addresses listed
          in <code>ALLOWED_USERS</code>. Adding someone means adding their address there and
          redeploying.
        </p>
      ) : signin === "cf-access" ? (
        <p className="section-note">
          Cloudflare Access decides who gets in, before a request reaches this instance;{" "}
          <code>ALLOWED_USERS</code> is the second gate behind it. Both live in{" "}
          <code>docker/.env</code>. Sign out here would sign you out of the app but not of Access,
          so there is nothing to do from this page.
        </p>
      ) : (
        <p className="warning section-note">
          Nobody is asked to sign in: whoever reaches this address is the owner. Boot only allows
          this while the port listens on this machine — see Settings → Access. To open the port to a
          network, set <code>SIGNIN=password</code> first.
        </p>
      )}

      <p className="muted small">
        The method is <code>SIGNIN</code> in <code>docker/.env</code> — <code>none</code>,{" "}
        <code>password</code>, <code>cf-access</code> or <code>google</code> — and it is independent
        of how the instance is reached, which Settings → Access reports.
      </p>
    </>
  );
}

function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (next !== confirm) {
      setError("The two new passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast("Password changed.");
    } catch (cause) {
      setError(errorMessage(cause));
    }
    setBusy(false);
  };

  return (
    <form className="signin-form" onSubmit={submit}>
      <label className="field">
        Current password
        <input
          type="password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          autoComplete="current-password"
        />
      </label>
      <label className="field">
        New password
        <input
          type="password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          placeholder="at least 10 characters"
          autoComplete="new-password"
        />
      </label>
      <label className="field">
        Repeat new password
        <input
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
        />
      </label>
      {error ? <p className="warning small">{error}</p> : null}
      <button className="button" type="submit" disabled={busy || !current || !next}>
        Change password
      </button>
    </form>
  );
}
