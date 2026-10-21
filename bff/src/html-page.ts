/**
 * The pages the BFF renders by hand: the result of an OAuth round trip, which has
 * to work with no bundle loaded and (for sign-in) no session yet.
 *
 * Shared because the two callers — the Google Workspace consent and Google
 * sign-in — would otherwise each write their own escaping, and an unescaped
 * detail string in a page served from the app's own origin is a session hijack.
 */

import { hardenedResponse } from "./security-headers.ts";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function resultPage(options: {
  hardened: Record<string, string>;
  title: string;
  detail: string;
  status: number;
  /** A line of guidance under the link back into the app. */
  note?: string;
}): Response {
  const { hardened, title, detail, status, note } = options;
  const html =
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>${escapeHtml(title)}</title>` +
    `<body style="font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">` +
    `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>` +
    (note ? `<p>${escapeHtml(note)}</p>` : "") +
    `<p><a href="/">Back to the app</a></p>`;
  return hardenedResponse(hardened, html, { "content-type": "text/html; charset=utf-8" }, status);
}
