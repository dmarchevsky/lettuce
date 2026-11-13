import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertEffectiveUsable,
  DEFAULT_PI_AGENT_SETTINGS,
  effectivePiSettings,
  InvalidPiAgentSettingsError,
  isDefaultPiAgentSettings,
  PiAgentSettingsStore,
  parsePiAgentSettings,
} from "./agent-settings.ts";
import { DEFAULT_PI_SETTINGS, type PiSettings, piConfigured } from "./settings.ts";

const GLOBAL: PiSettings = {
  ...DEFAULT_PI_SETTINGS,
  enabled: true,
  host: "pi.example.invalid",
  user: "worker",
  port: 22,
  workdir: "/home/worker/pi",
  pathPrepend: "/home/worker/.nvm/bin",
  command: "pi-bolt",
  model: "big/model",
  privateKey: "-----BEGIN TEST KEY-----\nabc\n",
};

const fileIn = () => join(mkdtempSync(join(tmpdir(), "pi-agents-")), "agents.json");

describe("parsePiAgentSettings", () => {
  test("an own host or user that reads as an ssh option is refused", () => {
    expect(parsePiAgentSettings({ mode: "own", host: "-oProxyCommand=id" })).toBeNull();
    expect(parsePiAgentSettings({ mode: "own", user: "-lroot" })).toBeNull();
    expect(parsePiAgentSettings({ mode: "own", host: "192.0.2.7", user: "w" })?.host).toBe(
      "192.0.2.7",
    );
  });

  test("nothing but defaults is the same as saying nothing", () => {
    expect(parsePiAgentSettings({})).toEqual(DEFAULT_PI_AGENT_SETTINGS);
    expect(isDefaultPiAgentSettings(DEFAULT_PI_AGENT_SETTINGS)).toBe(true);
    expect(isDefaultPiAgentSettings({ ...DEFAULT_PI_AGENT_SETTINGS, workdir: "/x" })).toBe(false);
  });

  test("an own record keeps what it is given and blanks the rest", () => {
    const parsed = parsePiAgentSettings({ mode: "own", workdir: " /home/w/research " });
    expect(parsed).toEqual({
      ...DEFAULT_PI_AGENT_SETTINGS,
      mode: "own",
      workdir: "/home/w/research",
    });
  });

  test("a PATH prefix arrives normalized, like the global one", () => {
    expect(parsePiAgentSettings({ pathPrepend: "/home/w/.pi/bin/:/opt/x//" })?.pathPrepend).toBe(
      "/home/w/.pi/bin:/opt/x",
    );
  });

  test("the command is kept as typed (trimmed) — the words are the runner's business", () => {
    expect(parsePiAgentSettings({ command: "  pi-bolt --thinking high " })?.command).toBe(
      "pi-bolt --thinking high",
    );
    expect(parsePiAgentSettings({ command: 7 })).toBe(null);
  });

  test("junk is refused, not coerced", () => {
    expect(parsePiAgentSettings(null)).toBe(null);
    expect(parsePiAgentSettings("nope")).toBe(null);
    expect(parsePiAgentSettings({ port: "22" })).toBe(null);
    expect(parsePiAgentSettings({ port: 99_999 })).toBe(null);
    expect(parsePiAgentSettings({ host: 7 })).toBe(null);
    // An explicit null model means "the remote pi's own default", which is not
    // the same as inheriting the global model — so it must survive the parse.
    expect(parsePiAgentSettings({ model: null })?.model).toBe(null);
    expect(parsePiAgentSettings({ model: "" })?.model).toBe("");
  });
});

describe("effectivePiSettings", () => {
  test("global mode ignores the record entirely", () => {
    const effective = effectivePiSettings(GLOBAL, {
      ...DEFAULT_PI_AGENT_SETTINGS,
      mode: "global",
      workdir: "/should/not/be/used",
    });
    expect(effective.workdir).toBe(GLOBAL.workdir);
    expect(effective.source).toBe("global");
  });

  test("own mode fills only the fields it names", () => {
    const effective = effectivePiSettings(GLOBAL, {
      mode: "own",
      host: "",
      port: null,
      user: "",
      pathPrepend: "",
      command: "",
      workdir: "/home/worker/research",
      model: null,
    });
    expect(effective.workdir).toBe("/home/worker/research");
    expect(effective.host).toBe("pi.example.invalid");
    expect(effective.port).toBe(22);
    expect(effective.pathPrepend).toBe("/home/worker/.nvm/bin");
    expect(effective.command).toBe("pi-bolt");
    expect(effective.model).toBe("big/model");
    expect(effective.source).toBe("agent");
  });

  test("a whole other host, with the shared key", () => {
    const effective = effectivePiSettings(GLOBAL, {
      mode: "own",
      host: "other.example.invalid",
      port: 2222,
      user: "research",
      pathPrepend: "",
      command: "pi",
      workdir: "/srv/research",
      model: "",
    });
    expect(effective.host).toBe("other.example.invalid");
    expect(effective.port).toBe(2222);
    expect(effective.user).toBe("research");
    // One agent can run a different build than the rest, and an empty command
    // falls back to the global one rather than to nothing.
    expect(effective.command).toBe("pi");
    expect(effectivePiSettings(GLOBAL, { ...DEFAULT_PI_AGENT_SETTINGS, mode: "own" }).command).toBe(
      "pi-bolt",
    );
    // "" is the agent opting out of a model, not inheriting the global one.
    expect(effective.model).toBe("");
    // Custody is never forked: the key is the global one, always.
    expect(effective.privateKey).toBe(GLOBAL.privateKey);
    expect(piConfigured(effective)).toBe(true);
  });

  test("an own record is only saveable when the result is usable", () => {
    expect(() => assertEffectiveUsable({ ...GLOBAL, source: "agent" })).not.toThrow();
    expect(() =>
      assertEffectiveUsable({ ...GLOBAL, workdir: "relative/path", source: "agent" }),
    ).toThrow(InvalidPiAgentSettingsError);
    expect(() => assertEffectiveUsable({ ...GLOBAL, user: "", source: "agent" })).toThrow(/user/);
    expect(() => assertEffectiveUsable({ ...GLOBAL, privateKey: null, source: "agent" })).toThrow(
      /deploy key/,
    );
    // A command the runner could not tokenize is refused here, at save, rather
    // than thrown back from an agent's turn.
    expect(() =>
      assertEffectiveUsable({ ...GLOBAL, command: "pi-bolt 'oops", source: "agent" }),
    ).toThrow(/Command/);
    expect(() =>
      assertEffectiveUsable({ ...GLOBAL, command: "pi --mode text", source: "agent" }),
    ).toThrow(/the run adds its own/);
  });
});

describe("PiAgentSettingsStore", () => {
  test("only agents that differ from the default are stored, and it round-trips", async () => {
    const file = fileIn();
    const store = new PiAgentSettingsStore(file, () => {});
    expect(store.get("agent-a")).toEqual(DEFAULT_PI_AGENT_SETTINGS);
    store.set("agent-a", { ...DEFAULT_PI_AGENT_SETTINGS, workdir: "/home/a" });
    store.set("agent-b", DEFAULT_PI_AGENT_SETTINGS);
    await store.drain();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      "agent-a": { ...DEFAULT_PI_AGENT_SETTINGS, workdir: "/home/a" },
    });
    expect(new PiAgentSettingsStore(file, () => {}).get("agent-a").workdir).toBe("/home/a");
    // Writing the default back removes the entry rather than storing a no-op.
    store.set("agent-a", DEFAULT_PI_AGENT_SETTINGS);
    await store.drain();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });

  test("remove forgets the agent, and a damaged file means everyone inherits", () => {
    const file = fileIn();
    const store = new PiAgentSettingsStore(file, () => {});
    store.set("agent-a", {
      mode: "own",
      host: "h",
      port: null,
      user: "",
      pathPrepend: "",
      command: "",
      workdir: "/w",
      model: null,
    });
    store.remove("agent-a");
    expect(store.all()).toEqual({});
    writeFileSync(file, "{not json");
    expect(new PiAgentSettingsStore(file, () => {}).all()).toEqual({});
  });

  test("an unknown agent id is not an agent", () => {
    const store = new PiAgentSettingsStore(fileIn(), () => {});
    expect(() => store.set("../escape", DEFAULT_PI_AGENT_SETTINGS)).toThrow();
  });
});
