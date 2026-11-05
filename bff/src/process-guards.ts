/**
 * Process-level guards: what may end this process, and what may not.
 *
 * The BFF owns the one upstream connection every conversation rides on, so a
 * socket hiccup must never take it down — an exit here is not a restart, it is
 * every in-flight turn orphaned and (on a docker-daemon boot) a container the
 * restart policy left dead. The connection layer already retries (`upstream/
 * connection.ts`), so these guards are the safety net under that, not the
 * mechanism: they catch what escapes as an uncaught exception.
 *
 * Narrow on purpose. A blanket swallow converts every future bug into a
 * half-alive process that answers `/healthz` while doing nothing, and the only
 * place allowed to decide the process ends is the drain in `shutdown.ts`. So a
 * transient socket error is logged and dropped; anything else is logged and the
 * process exits 1, which is exactly what happened before the guard existed.
 */

/** Network codes that mean "the far end is not reachable right now", not "we are broken". */
const TRANSIENT_SOCKET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
]);

/**
 * Whether `error` is a reachability problem rather than a defect.
 *
 * `ERR_UNHANDLED_ERROR` is what EventEmitter throws when an `error` event
 * arrives with no listener — the shape bun's `ws` shim delivers a failed
 * handshake in, with the real `ErrorEvent` hanging off `.context`. Bun's
 * implementation of `ws` also raises bare `ErrorEvent`s, which carry no `code`.
 */
export function isTransientSocketError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_SOCKET_CODES.has(code)) return true;
  if (code === "ERR_UNHANDLED_ERROR") return true;
  return typeof ErrorEvent !== "undefined" && error instanceof ErrorEvent;
}

export interface ProcessGuardOptions {
  log: (message: string) => void;
  /**
   * What happens to an error the guard will not swallow. Injectable so a test
   * can observe the fatal path without ending the test runner; production exits.
   */
  onFatal?: (error: unknown) => void;
}

/**
 * The `uncaughtException` handler, returned rather than installed so it can be
 * tested without taking over the process it is tested in.
 */
export function uncaughtExceptionHandler(options: ProcessGuardOptions): (error: unknown) => void {
  const onFatal = options.onFatal ?? (() => process.exit(1));
  return (error: unknown) => {
    if (isTransientSocketError(error)) {
      options.log(`Ignoring a transient socket error: ${describe(error)}`);
      return;
    }
    options.log(`Uncaught exception; the process is ending: ${describe(error)}`);
    onFatal(error);
  };
}

export function installProcessGuards(options: ProcessGuardOptions): void {
  process.on("uncaughtException", uncaughtExceptionHandler(options));

  // Not fatal by itself, and it should not become one: under bun an unhandled
  // rejection sets a non-zero exit code, which turns a dropped promise into a
  // dead BFF. Log it loudly enough to be worth fixing.
  process.on("unhandledRejection", (reason: unknown) => {
    options.log(`Unhandled rejection: ${describe(reason)}`);
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const context = (error as { context?: { message?: string } }).context?.message;
    const base = error.stack ?? `${error.name}: ${error.message}`;
    return context ? `${base}\n  reported by the socket: ${context}` : base;
  }
  return String(error);
}
