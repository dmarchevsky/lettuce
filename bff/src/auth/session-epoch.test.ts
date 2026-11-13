import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSession, encodeSession } from "./session-cookie.ts";
import { SessionEpoch } from "./session-epoch.ts";

const dir = () => mkdtempSync(join(tmpdir(), "lettuce-epoch-"));

describe("SessionEpoch", () => {
  test("starts at 0, and a bump outlives the process", () => {
    const where = dir();
    const epoch = new SessionEpoch(where);
    expect(epoch.current()).toBe(0);
    expect(epoch.bump()).toBe(1);
    expect(new SessionEpoch(where).current()).toBe(1);
  });

  test("a file that is not a number reads as the first epoch, not a crash", () => {
    const where = dir();
    writeFileSync(join(where, "session-epoch"), "not a number\n");
    expect(new SessionEpoch(where).current()).toBe(0);
  });

  test("a directory it cannot write still revokes for this process, and says so", () => {
    const lines: string[] = [];
    const epoch = new SessionEpoch("/proc/lettuce-no-such-dir", (line) => lines.push(line));
    expect(epoch.bump()).toBe(1);
    expect(epoch.current()).toBe(1);
    expect(lines[0]).toContain("Could not persist");
  });

  test("a bump is what retires a cookie", () => {
    const epoch = new SessionEpoch(dir());
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = encodeSession(
      { email: "owner", exp, via: "password", epoch: epoch.current() },
      "secret",
    );
    expect(decodeSession(token, "secret", "password", epoch.current())?.email).toBe("owner");
    epoch.bump();
    expect(decodeSession(token, "secret", "password", epoch.current())).toBeNull();
  });
});
