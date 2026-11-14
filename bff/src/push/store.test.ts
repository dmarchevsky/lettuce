import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushSubscriptionStore } from "./store.ts";

const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "push-store-test-"));
  dirs.push(dir);
  return join(dir, "push-subscriptions.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

const subscription = {
  endpoint: "https://push.example/abc",
  keys: { p256dh: "key1", auth: "key2" },
};

describe("PushSubscriptionStore endpoints", () => {
  test("only a public https push service is stored: the BFF posts to it later", () => {
    const store = new PushSubscriptionStore(tempFile());
    const keys = subscription.keys;
    for (const endpoint of [
      "http://push.example/abc",
      "http://searxng:8080/",
      "https://localhost:8080/internal/tools/x",
      "https://127.0.0.1/",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(() => store.add({ endpoint, keys }, "me@example.com")).toThrow("Malformed");
    }
  });
});

describe("PushSubscriptionStore preferences", () => {
  test("a fresh subscription defaults every preference to true", () => {
    const store = new PushSubscriptionStore(tempFile());
    const record = store.add(subscription, "me@example.com");
    expect(record.preferences).toEqual({ completed: true, failed: true, approval: true });
  });

  test("subscribing with explicit preferences honours them", () => {
    const store = new PushSubscriptionStore(tempFile());
    const record = store.add(subscription, "me@example.com", { completed: false });
    expect(record.preferences).toEqual({ completed: false, failed: true, approval: true });
  });

  test("re-subscribing an existing endpoint without preferences preserves them", () => {
    const store = new PushSubscriptionStore(tempFile());
    store.add(subscription, "me@example.com", { completed: false, approval: false });
    const record = store.add(subscription, "me@example.com");
    expect(record.preferences).toEqual({ completed: false, failed: true, approval: false });
  });

  test("updatePreferences merges a partial patch onto the existing record", () => {
    const store = new PushSubscriptionStore(tempFile());
    store.add(subscription, "me@example.com");
    const record = store.updatePreferences(subscription.endpoint, { failed: false });
    expect(record.preferences).toEqual({ completed: true, failed: false, approval: true });

    const again = store.updatePreferences(subscription.endpoint, { completed: false });
    expect(again.preferences).toEqual({ completed: false, failed: false, approval: true });
  });

  test("updatePreferences throws for an unknown endpoint", () => {
    const store = new PushSubscriptionStore(tempFile());
    expect(() => store.updatePreferences("https://nope", { completed: false })).toThrow();
  });

  test("a record persisted before preferences existed loads as all-true", () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify([
        {
          endpoint: subscription.endpoint,
          keys: subscription.keys,
          email: "me@example.com",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ]),
    );
    const store = new PushSubscriptionStore(file);
    expect(store.getPreferences(subscription.endpoint)).toEqual({
      completed: true,
      failed: true,
      approval: true,
    });
  });

  test("getPreferences returns null for an unknown endpoint", () => {
    const store = new PushSubscriptionStore(tempFile());
    expect(store.getPreferences("https://nope")).toBeNull();
  });
});

/**
 * The bug these guard: `writeQueue` was chained with a bare `then`, so the
 * first throwing write left it permanently REJECTED. Every later persist then
 * attached to a rejected promise and its callback never ran — subscriptions
 * silently stopped being saved while the in-memory map kept working, which is
 * invisible until the process restarts and every device is gone.
 */
describe("PushSubscriptionStore write resilience", () => {
  test("a failed write does not poison later writes", async () => {
    // Parent directory does not exist, so the first write throws ENOENT.
    const dir = mkdtempSync(join(tmpdir(), "push-store-resilience-"));
    dirs.push(dir);
    const file = join(dir, "missing", "push-subscriptions.json");

    const errors: unknown[] = [];
    const store = new PushSubscriptionStore(file, (error) => errors.push(error));

    store.add(subscription, "me@example.com");
    await store.drain();
    expect(errors).toHaveLength(1);
    expect(existsSync(file)).toBe(false);

    // Now make the write possible. The queue must still be alive.
    mkdirSync(join(dir, "missing"));
    store.add(
      { endpoint: "https://push.example/second", keys: { p256dh: "k", auth: "a" } },
      "me@example.com",
    );
    await store.drain();

    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { endpoint: string }[];
    expect(saved.map((r) => r.endpoint)).toEqual([
      "https://push.example/abc",
      "https://push.example/second",
    ]);
  });

  test("the error is reported rather than swallowed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "push-store-error-"));
    dirs.push(dir);
    const errors: unknown[] = [];
    const store = new PushSubscriptionStore(join(dir, "nope", "p.json"), (e) => errors.push(e));
    store.add(subscription, "me@example.com");
    await store.drain();
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toContain("ENOENT");
  });
});
