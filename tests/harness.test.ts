/**
 * The dev harness's own deciding logic, offline.
 *
 * Two pieces here failed in the wild and neither was visible from the script that
 * used it: a `--section` filter that mistook its own value for the origin would run
 * the whole suite anyway, and a cookie-jar line that merged name and value made
 * `curl -b` authenticate as nobody while the script that wrote it printed a cheerful
 * "signed in". Both are pure, so both are pinned here rather than discovered again
 * against a running stack.
 */
import { describe, expect, test } from "bun:test";
import { cookieJarLine, parseArgs } from "../scripts/harness.ts";

describe("parseArgs", () => {
  test("the bare argument is the origin, as it always was", () => {
    const args = parseArgs(["http://127.0.0.1:9999"]);
    expect(args.origin).toBe("http://127.0.0.1:9999");
    expect(args.positional).toBe("http://127.0.0.1:9999");
  });

  test("nothing given falls back to the dev port", () => {
    expect(parseArgs([]).origin).toBe("http://127.0.0.1:8090");
  });

  test("a flag's value is never mistaken for the origin", () => {
    const args = parseArgs(["--section", "phone"]);
    expect(args.sections).toEqual(["phone"]);
    expect(args.origin).toBe("http://127.0.0.1:8090");
    expect(args.positional).toBe("");
  });

  test("--section takes a comma list, lowercased for substring matching", () => {
    const args = parseArgs(["--section", "Phone, Settings deep"]);
    expect(args.sections).toEqual(["phone", "settings deep"]);
  });

  test("an origin before the flags still wins", () => {
    const args = parseArgs(["http://localhost:8091", "--section", "memory"]);
    expect(args.origin).toBe("http://localhost:8091");
    expect(args.sections).toEqual(["memory"]);
  });

  test("the positional caller decides what it means (screenshots: an output dir)", () => {
    expect(parseArgs(["/tmp/shots", "--shot", "chat"], "").positional).toBe("/tmp/shots");
  });

  test("--allow-stale-build is the escape hatch, and the env sets it too", () => {
    expect(parseArgs([]).staleBuild).toBe(false);
    expect(parseArgs(["--allow-stale-build"]).staleBuild).toBe(true);
  });
});

describe("cookieJarLine", () => {
  const line = cookieJarLine("http://127.0.0.1:8090", "letta_session=abc.123");

  test("curl's format is seven tab-separated fields", () => {
    expect(line.split("\t")).toHaveLength(7);
  });

  test("name and value are separate columns, or curl sends a garbage cookie", () => {
    const fields = line.split("\t");
    expect(fields[5]).toBe("letta_session");
    expect(fields[6]).toBe("abc.123");
  });

  test("the host carries the HttpOnly marker and no port", () => {
    expect(line.split("\t")[0]).toBe("#HttpOnly_127.0.0.1");
  });

  test("an expiry of zero means a session cookie", () => {
    expect(line.split("\t")[4]).toBe("0");
  });

  test("an origin without a scheme is refused by name, not silently", () => {
    expect(() => cookieJarLine("127.0.0.1:8090", "a=b")).toThrow("127.0.0.1:8090");
  });
});
