/**
 * The number every session cookie carries, and the one way to revoke them.
 *
 * A session is a signed, stateless cookie: nothing on the server remembers it,
 * so nothing could take one back before its 30-day expiry — not a password
 * change, not a sign-out, not a cookie that leaked to an agent app on a sibling
 * port. The epoch is the smallest state that fixes that: every cookie is minted
 * with the current number, a cookie with any other number is refused, and
 * bumping the number signs every device out at once.
 *
 * It lives beside the password hash on the `bff-auth` volume
 * (`config.signinDir`) for the same reason the hash does: agent shells mount
 * `LETTA_STATE_DIR` read-write as uid 0, and a file an agent can write is a
 * revocation an agent can undo.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../errors.ts";

export class SessionEpoch {
  private value: number;

  constructor(
    private readonly dir: string,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.value = this.read();
  }

  private get file(): string {
    return join(this.dir, "session-epoch");
  }

  /** Absent or unreadable is epoch 0: the first boot, before anything was revoked. */
  private read(): number {
    try {
      const parsed = Number(readFileSync(this.file, "utf8").trim());
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    } catch {
      return 0;
    }
  }

  current(): number {
    return this.value;
  }

  /**
   * Revoke every session minted so far. Synchronous on purpose: it is one tiny
   * write on a path that runs a handful of times a year, and the caller mints
   * its replacement cookie on the very next line.
   *
   * A write that fails still revokes for the life of this process — and says so,
   * because after a restart the old number, and every cookie carrying it, is
   * back.
   */
  bump(): number {
    this.value += 1;
    try {
      mkdirSync(this.dir, { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${this.value}\n`, { mode: 0o600 });
      renameSync(temp, this.file);
    } catch (error) {
      this.log(
        `! Could not persist the session epoch (${errorMessage(error)}): sessions are revoked ` +
          "until this process restarts, and valid again after it.",
      );
    }
    return this.value;
  }
}
