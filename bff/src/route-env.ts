/**
 * The Hono environment every `register*Routes` function accepts.
 *
 * `index.ts` owns the real app, whose variables declare a resolved session; a
 * route module takes any app whose middleware stores one under `session` and
 * trusts `requireSession` to have refused the request when it is missing. That
 * way a route module never imports the boot module — which would be an import
 * cycle, since it imports the route module — and stays testable against a stub.
 */
export type RouteEnv = { Variables: { session?: unknown } };

/** Narrower `RouteEnv` for a route that reads the signed-in identity. */
export type RouteEnvWithEmail = { Variables: { session?: { email: string } | null } };
