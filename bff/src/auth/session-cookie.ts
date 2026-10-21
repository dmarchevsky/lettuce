import { createHmac, timingSafeEqual } from "node:crypto";
import type { Signin } from "../config.ts";

export const SESSION_COOKIE = "letta_session";

export interface SessionPayload {
  email: string;
  /** Unix seconds. */
  exp: number;
  /**
   * The method that minted this session. A session is proof of what the visitor
   * actually did, so one minted under a looser method must not pass for a
   * stricter one: the cookie `SIGNIN=none` hands to every visitor would otherwise
   * stay valid for its whole TTL after the operator tightens to `password`, and
   * the pre-split `DEV_BYPASS_EMAIL` cookie is still sitting in browsers today.
   * Absent means older than this check, which is also a refusal.
   */
  via: Signin;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(value: string): Buffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64 + "=".repeat((4 - (base64.length % 4)) % 4), "base64");
}

function sign(body: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

export function encodeSession(payload: SessionPayload, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

export function decodeSession(token: string, secret: string, via: Signin): SessionPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(body, secret);

  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8"));
  } catch {
    return null;
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as SessionPayload).email !== "string" ||
    typeof (payload as SessionPayload).exp !== "number"
  ) {
    return null;
  }

  const session = payload as SessionPayload;
  if (session.exp * 1000 < Date.now()) return null;
  if (session.via !== via) return null;
  return session;
}

export function buildSessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return buildSessionCookie("", 0, secure);
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}
