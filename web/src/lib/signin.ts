/**
 * The sign-in client: what the browser posts for each method, and the shape of a
 * refusal.
 *
 * Routes and their rules live in `bff/src/auth/routes.ts`. The one thing worth
 * naming twice is `SignInPaused` — a locked-out sign-in is a wait, not a wrong
 * answer, and the form has to say how long rather than count down guesses.
 */

export type Access = "lan" | "cloudflared";
export type Signin = "none" | "password" | "cf-access" | "google";

/** What each method is called in the UI. `none` says what it is, not what it lacks. */
export const SIGNIN_LABELS: Record<Signin, string> = {
  none: "Nobody (this machine only)",
  password: "Password",
  "cf-access": "Cloudflare Access",
  google: "Google account",
};

/**
 * The two address-free methods share one identity, `owner`, which is a good log
 * line and a strange thing to tell a person. Everything else is an email.
 */
export function identityLabel(email: string | null): string | null {
  return email === "owner" ? "the owner" : email;
}

export class SignInPaused extends Error {
  constructor(
    message: string,
    readonly retryAfter: number,
  ) {
    super(message);
  }
}

async function post(path: string, body: Record<string, string>): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return;

  // The refusals are JSON with a message; the routes that refuse a whole method
  // answer plain text. Either way the text is written for the person reading it.
  const raw = (await response.text()).trim();
  let message = raw;
  try {
    const data = JSON.parse(raw) as { error?: string; retryAfter?: number };
    if (data.retryAfter) {
      throw new SignInPaused(data.error ?? "Too many attempts.", data.retryAfter);
    }
    if (data.error) message = data.error;
  } catch (cause) {
    if (cause instanceof SignInPaused) throw cause;
  }
  throw new Error(message || `The server answered ${response.status}.`);
}

export function signInWithPassword(password: string): Promise<void> {
  return post("/auth/login", { password });
}

/** First run: choose the password and be signed in by the same response. */
export function choosePassword(password: string): Promise<void> {
  return post("/auth/setup", { password });
}

export function changePassword(current: string, next: string): Promise<void> {
  return post("/auth/change-password", { current, next });
}

export async function signOut(): Promise<void> {
  await fetch("/auth/logout", { method: "POST" });
}
