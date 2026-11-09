/**
 * The session gate is middleware-order-dependent, and nothing else can see it.
 *
 * `index.ts` guards every `/api` and `/push` route with
 * `app.use("/api/*", requireSession)`, and Hono applies middleware only to routes
 * registered *after* it. So the security property "an anonymous visitor cannot
 * read agent data" is held by where a line sits in a 1950-line file: add a new
 * `app.get("/api/…")` above the gate — next to `/healthz`, which is where a new
 * endpoint visually belongs — and it answers strangers, with no type error, no
 * lint rule and no other test to notice. `index.ts` cannot be imported by a test
 * (it boots the server and reads the environment on import), so the check reads
 * the source, the way `scripts/check-docs.ts` and `check-version-pin.ts` do.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

/** The gate per namespace, and the path prefix it is supposed to cover. */
const GATES: readonly { prefix: string; marker: string }[] = [
  { prefix: "/api/", marker: 'app.use("/api/*", requireSession);' },
  { prefix: "/push/", marker: 'app.use("/push/*", requireSession);' },
];

/** `app.<verb>("/path"…` — every route this file registers itself. */
const ROUTE = /app\.(?:get|post|put|delete|patch|all)\(\s*"([^"]+)"/g;
/** A route family mounted from its own module: `registerGoogleRoutes(app, …)`. */
const FAMILY = /register[A-Za-z0-9]*Routes\(\s*app\b/g;

/**
 * The paths allowed to answer an anonymous caller, read out of the file rather
 * than copied here: a second list would drift, and drift in *this* list is the
 * bug being guarded against.
 */
function anonymousPaths(): Set<string> {
  const block = /const ANONYMOUS_API_PATHS = new Set\(\[([\s\S]*?)\]\);/.exec(source);
  expect(block, "index.ts must declare ANONYMOUS_API_PATHS").not.toBeNull();
  return new Set([...block![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!));
}

function lineOf(offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

test("every gated route is registered after its requireSession middleware", () => {
  const anonymous = anonymousPaths();
  for (const gate of GATES) {
    const gateAt = source.indexOf(gate.marker);
    expect(gateAt, `index.ts no longer has ${gate.marker}`).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const match of source.matchAll(ROUTE)) {
      const path = match[1]!;
      if (!path.startsWith(gate.prefix)) continue;
      if (anonymous.has(path)) continue;
      if (match.index! < gateAt)
        offenders.push(`${path} (line ${lineOf(match.index!)}, gate is line ${lineOf(gateAt)})`);
    }
    expect(
      offenders,
      `${gate.prefix} routes registered above ${gate.marker} answer anonymous callers. Move them ` +
        "below the middleware, or — only for a screen that must render signed out — add the exact " +
        "path to ANONYMOUS_API_PATHS with the reason it is safe.",
    ).toEqual([]);
  }
});

/**
 * Hono matches a parameterised path in registration order, so
 * `GET /api/avatars/recents` has to be registered before `GET /api/avatars/:id`
 * or the literal path is read as a face id and answers 404 — with everything
 * still typechecking. Same reason this file reads source for the session gate.
 */
test("a literal route is registered before the parameterised route that would swallow it", () => {
  for (const verb of ["get", "put"]) {
    const literal = source.indexOf(`app.${verb}("/api/avatars/recents"`);
    const param = source.indexOf(`app.${verb}("/api/avatars/:id"`);
    expect(
      literal,
      `index.ts no longer registers app.${verb}("/api/avatars/recents")`,
    ).toBeGreaterThan(0);
    // `DELETE /api/avatars/:id` has no literal sibling; only GET and PUT do.
    if (param > 0) expect(literal).toBeLessThan(param);
  }
});

test("no route family is mounted above the session gates", () => {
  const gateAt = Math.min(...GATES.map((gate) => source.indexOf(gate.marker)));
  expect(gateAt).toBeGreaterThan(0);

  const offenders: string[] = [];
  for (const match of source.matchAll(FAMILY)) {
    if (match.index! < gateAt)
      offenders.push(
        `${source.slice(match.index, match.index + 40).split("(")[0]} (line ${lineOf(match.index!)})`,
      );
  }
  expect(
    offenders,
    "a register*Routes call above the requireSession middleware mounts its whole family — " +
      "every path inside it — outside the session gate.",
  ).toEqual([]);
});
