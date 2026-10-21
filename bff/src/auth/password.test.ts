import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttemptLockout,
  assertPasswordIsUsable,
  MIN_PASSWORD_LENGTH,
  PasswordStore,
} from "./password.ts";

async function tempStore(): Promise<PasswordStore> {
  return new PasswordStore(await mkdtemp(join(tmpdir(), "lettuce-signin-")));
}

async function exists(store: PasswordStore): Promise<boolean> {
  try {
    await stat(join(await storeDir(store), "signin.json"));
    return true;
  } catch {
    return false;
  }
}

/** The store keeps its directory private; reach it the same way the store does. */
async function storeDir(store: PasswordStore): Promise<string> {
  return (store as unknown as { dir: string }).dir;
}

describe("assertPasswordIsUsable", () => {
  test("takes the minimum length and nothing shorter", () => {
    expect(() => assertPasswordIsUsable("x".repeat(MIN_PASSWORD_LENGTH))).not.toThrow();
    expect(() => assertPasswordIsUsable("x".repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(
      /at least 10 characters/,
    );
  });

  test("shrugs off a non-string from a request body", () => {
    expect(() => assertPasswordIsUsable(undefined as unknown as string)).toThrow(/at least/);
  });
});

describe("PasswordStore", () => {
  test("an empty store is unclaimed, and claiming it closes that", async () => {
    const store = await tempStore();
    expect(await store.claimed()).toBe(false);
    expect(await store.current()).toBeNull();

    await store.setPassword("correct horse battery");
    expect(await store.claimed()).toBe(true);
    expect(await exists(store)).toBe(true);
  });

  test("the file holds a salted scrypt hash, never the password", async () => {
    const store = await tempStore();
    await store.setPassword("correct horse battery");
    const text = await readFile(join(await storeDir(store), "signin.json"), "utf8");
    const stored = JSON.parse(text) as { kdf: string; salt: string; hash: string };
    expect(stored.kdf).toBe("scrypt");
    expect(stored.salt).toHaveLength(32);
    expect(stored.hash).not.toContain("correct");
    expect(stored.hash.length).toBeGreaterThan(64);
  });

  test("only the owner's process may read it", async () => {
    const store = await tempStore();
    await store.setPassword("correct horse battery");
    const info = await stat(join(await storeDir(store), "signin.json"));
    expect((info.mode & 0o777).toString(8)).toBe("600");
  });

  test("verify answers for the right password and every wrong one", async () => {
    const store = await tempStore();
    await store.setPassword("correct horse battery");
    expect(await store.verify("correct horse battery")).toBe(true);
    expect(await store.verify("correct horse batter")).toBe(false);
    expect(await store.verify("correct horse battery stamina")).toBe(false);
    expect(await store.verify("")).toBe(false);
  });

  test("re-setting replaces the hash, so the old password stops working", async () => {
    const store = await tempStore();
    await store.setPassword("correct horse battery");
    await store.setPassword("staple on the desk now");
    expect(await store.verify("correct horse battery")).toBe(false);
    expect(await store.verify("staple on the desk now")).toBe(true);
  });

  test("a half-written file is refused as a password, and counts as claimed", async () => {
    const store = await tempStore();
    // The failure that matters is the direction it fails in: an unreadable
    // credential must never be read as "nobody has claimed this yet".
    await store.setPassword("correct horse battery");
    const dir = await storeDir(store);
    await writeFile(join(dir, "signin.json"), "{not json");
    // A fresh store, so the answer comes from reading the file and not from the
    // memo the write above left behind.
    const reopened = new PasswordStore(dir);
    expect(await reopened.claimed()).toBe(true);
    await expect(reopened.current()).rejects.toThrow(/unreadable/);
    // Verification fails loudly rather than as "wrong password": an owner with a
    // corrupt credential file would otherwise be locked out with no clue why.
    await expect(reopened.verify("correct horse battery")).rejects.toThrow(/unreadable/);
  });

  test("a file that parses but holds no hash is the same refusal", async () => {
    const store = await tempStore();
    await writeFile(join(await storeDir(store), "signin.json"), JSON.stringify({ kdf: "scrypt" }));
    await expect(store.current()).rejects.toThrow(/unreadable/);
  });
});

describe("AttemptLockout", () => {
  function withClock(): {
    lockout: AttemptLockout;
    now: () => number;
    advance: (s: number) => void;
  } {
    let ms = 1_000_000;
    const now = () => ms;
    return {
      lockout: new AttemptLockout(now),
      now,
      advance: (seconds) => {
        ms += seconds * 1000;
      },
    };
  }

  test("the first four failures only cost an attempt", () => {
    const { lockout, advance } = withClock();
    for (let i = 0; i < 4; i += 1) {
      expect(lockout.recordFailure()).toBe(0);
      expect(lockout.waitSeconds()).toBe(0);
    }
    expect(lockout.attemptsLeft()).toBe(1);
    void advance;
  });

  test("the fifth locks for a minute, and the wait counts down", () => {
    const { lockout, advance } = withClock();
    for (let i = 0; i < 5; i += 1) lockout.recordFailure();
    expect(lockout.waitSeconds()).toBe(60);
    advance(30);
    expect(lockout.waitSeconds()).toBe(30);
    advance(31);
    expect(lockout.waitSeconds()).toBe(0);
  });

  test("a locked-out run keeps doubling, up to the cap", () => {
    const { lockout, advance } = withClock();
    const waits: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      for (let i = 0; i < 5; i += 1) waits.push(lockout.recordFailure());
      advance(60 * 60);
    }
    expect(waits.filter((wait) => wait > 0)).toEqual([60, 120, 240, 480, 900, 900]);
    // Attempts keep counting during a pause, so the message still makes sense.
    expect(lockout.attemptsLeft()).toBe(5);
  });

  test("a success clears the whole history", () => {
    const { lockout } = withClock();
    for (let i = 0; i < 4; i += 1) lockout.recordFailure();
    lockout.recordSuccess();
    expect(lockout.attemptsLeft()).toBe(5);
    // Five more failures are a fresh five, not the fifth of the old run.
    for (let i = 0; i < 4; i += 1) expect(lockout.recordFailure()).toBe(0);
    expect(lockout.recordFailure()).toBe(60);
  });
});

describe("concurrent first sets", () => {
  test("the file survives both writers and no temp file is left behind", async () => {
    const store = await tempStore();
    const dir = await storeDir(store);
    await Promise.all([
      store.setPassword("first correct horse"),
      store.setPassword("second correct horse"),
      store.setPassword("third correct horse"),
    ]);
    expect(await exists(store)).toBe(true);
    const intact =
      (await store.verify("first correct horse")) ||
      (await store.verify("second correct horse")) ||
      (await store.verify("third correct horse"));
    expect(intact).toBe(true);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
