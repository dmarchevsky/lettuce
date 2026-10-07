import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  buildProbeRemoteCommand,
  classifyCheckOutput,
  hostIsPinned,
  type PiCheckRecord,
  parseChecks,
  pinnedHostKey,
  renderChecks,
} from "./check.ts";
import {
  buildPiRemoteCommand,
  buildSshArgs,
  DirPiRunStore,
  isPiSessionId,
  type PiProcess,
  type PiRunMeta,
  PiRunner,
  piAgentId,
  shq,
} from "./runner.ts";
import { lastAssistantText, PiService, piKeyFile, piSettingsFile } from "./service.ts";
import {
  applyPiSettingsUpdate,
  DEFAULT_PI_SETTINGS,
  normalizePathPrepend,
  type PiSettings,
  parsePiSettings,
  piConfigured,
  toPublicPiSettings,
} from "./settings.ts";
import { parsePiRun, summarizePiRun } from "./transcript.ts";

const BASE: PiSettings = {
  ...DEFAULT_PI_SETTINGS,
  enabled: true,
  host: "pi.example.invalid",
  user: "worker",
  workdir: "/home/worker/pi",
  privateKey: "-----BEGIN TEST KEY-----\nabc\n",
  pathPrepend: "/opt/node/bin:/opt/pi/bin",
};

const VALID_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n";

// ── settings ─────────────────────────────────────────────────────────────────

test("key custody is recorded, never guessed", () => {
  // Nothing stored and nothing generated: the generated flow is what the form
  // may offer, and a damaged file cannot claim custody for a paste.
  expect(parsePiSettings(null).keySource).toBe("generated");
  expect(parsePiSettings('{"keySource": 7}').keySource).toBe("generated");
  // Pasting a PEM says who supplied the key…
  const pasted = applyPiSettingsUpdate(DEFAULT_PI_SETTINGS, { privateKey: VALID_KEY });
  expect(pasted.keySource).toBe("pasted");
  // …and a later save that never touches the key must not rewrite that.
  expect(applyPiSettingsUpdate({ ...pasted, host: "h" }, { host: "h2" }).keySource).toBe("pasted");
});

test("defaults are disabled and public shape never carries the key", () => {
  const publicSettings = toPublicPiSettings(parsePiSettings(null));
  expect(publicSettings.enabled).toBe(false);
  expect(publicSettings.hasKey).toBe(false);
  expect("privateKey" in publicSettings).toBe(false);
});

test("a stored key survives an update that does not mention it", () => {
  const saved = { ...BASE, privateKey: VALID_KEY };
  const next = applyPiSettingsUpdate(saved, { host: "other.example.invalid" });
  expect(next.privateKey).toBe(VALID_KEY);
  expect(next.host).toBe("other.example.invalid");
});

test("enabling requires a complete configuration including a key", () => {
  expect(() =>
    applyPiSettingsUpdate(
      { ...DEFAULT_PI_SETTINGS },
      { enabled: true, host: "h", user: "u", workdir: "/w" },
    ),
  ).toThrow(/key/);
  const ok = applyPiSettingsUpdate(
    { ...DEFAULT_PI_SETTINGS },
    { enabled: true, host: "h", user: "u", workdir: "/w", privateKey: VALID_KEY },
  );
  expect(ok.enabled).toBe(true);
  expect(piConfigured(ok)).toBe(true);
  expect(piConfigured({ ...DEFAULT_PI_SETTINGS })).toBe(false);
});

test("a replaced PEM clears the stale public half", () => {
  const hadPub = { ...BASE, privateKey: VALID_KEY, publicKey: "ssh-ed25519 AAAA old" };
  const replaced = applyPiSettingsUpdate(hadPub, { privateKey: `${VALID_KEY}x` });
  expect(replaced.publicKey).toBe(null);
  const untouched = applyPiSettingsUpdate(hadPub, { host: "other.example.invalid" });
  expect(untouched.publicKey).toBe("ssh-ed25519 AAAA old");
});

test("workdir must be absolute and keys must be PEM", () => {
  expect(() =>
    applyPiSettingsUpdate({ ...BASE, enabled: false }, { workdir: "relative/dir", enabled: true }),
  ).toThrow(/absolute/);
  expect(() => applyPiSettingsUpdate({ ...BASE }, { privateKey: "hunter2" })).toThrow(/PEM/);
});

// ── remote command / ssh argv ────────────────────────────────────────────────

test("shq survives single quotes", () => {
  expect(shq("it's")).toBe(`'it'\\''s'`);
});

test("the remote command cd's, prepends PATH, and quotes the prompt", () => {
  const cmd = buildPiRemoteCommand(BASE, { prompt: "review 'my' code" });
  expect(cmd).toContain(
    String.raw`cd '/home/worker/pi' && env PATH='/opt/node/bin:/opt/pi/bin':"$PATH"`,
  );
  expect(cmd).toContain("pi --mode json");
  expect(cmd).toContain(`'review '\\''my'\\'' code'`);
});

test("the PATH prepend hands $PATH to the remote shell", () => {
  // `PATH='<x>:$PATH'` looks right and is not: the remote shell never expands a
  // quoted `$PATH`, so env gets a PATH of one directory plus five literal
  // characters, and the run dies naming the program env could not find.
  for (const cmd of [
    buildPiRemoteCommand(BASE, { prompt: "x" }),
    buildProbeRemoteCommand({ workdir: "/home/w/pi", pathPrepend: "/opt/pi/bin" }),
  ]) {
    expect(cmd).not.toContain(":$PATH'");
    expect(cmd).toContain(String.raw`:"$PATH"`);
  }
});

test("the probe's PATH assignment actually finds the shell it runs", () => {
  // Run for real, locally: /bin/sh must be reachable through the PATH the probe
  // builds. A prepend naming no real directory is the strictest case — with a
  // quoted `$PATH` this answers "No such file or directory" instead.
  const command = buildProbeRemoteCommand({
    workdir: "",
    pathPrepend: "/nonexistent-lettuce-test-dir",
  });
  const result = Bun.spawnSync(["sh", "-c", command]);
  const text = result.stdout.toString() + result.stderr.toString();
  // Whether pi is installed here is not the point (this box has it, CI may not);
  // the point is that /bin/sh was found through the PATH we built.
  expect(result.exitCode).toBe(0);
  expect(text).not.toMatch(/No such file or directory/);
  expect(text).toMatch(/lettuce: pi not on PATH|\d+\.\d+/);
});

test("a PATH prefix is normalized before it can reach a PATH search", () => {
  // `/home/worker/.pi/agent/bin/` is what a person pastes, and the trailing
  // slash is visible to the program found through it: `$dir/pi` becomes
  // `bin//pi`, and pi's own launcher, which walks path elements off `$0` to find
  // its install directory, then reads `bin/install/current-version` and fails.
  expect(normalizePathPrepend("  /home/w/.pi/agent/bin/ ")).toBe("/home/w/.pi/agent/bin");
  expect(normalizePathPrepend("/a//:/b/")).toBe("/a:/b");
  expect(normalizePathPrepend("::")).toBe("");
  expect(normalizePathPrepend("")).toBe("");
  const stored = parsePiSettings(
    JSON.stringify({ ...DEFAULT_PI_SETTINGS, pathPrepend: "/opt/pi/bin/" }),
  );
  expect(stored.pathPrepend).toBe("/opt/pi/bin");
  // A saved record keeps its old shape until a save normalizes it; both paths work.
  expect(
    applyPiSettingsUpdate(DEFAULT_PI_SETTINGS, { pathPrepend: "/opt/pi/bin/" }).pathPrepend,
  ).toBe("/opt/pi/bin");
  // And the command is built from the normalized value even if a record kept
  // the old shape.
  const cmd = buildPiRemoteCommand({ ...BASE, pathPrepend: "/opt/pi/bin/" }, { prompt: "x" });
  expect(cmd).toContain(`env PATH='/opt/pi/bin':"$PATH"`);
  expect(cmd).not.toContain("//");
});

test("empty pathPrepend emits no env PATH at all", () => {
  const cmd = buildPiRemoteCommand({ ...BASE, pathPrepend: "  " }, { prompt: "x" });
  expect(cmd).not.toContain("env");
});

test("session resume passes --session and rejects non-UUIDs", () => {
  const session = "01a10e10-08ec-705d-a364-5cfa40e1a963";
  expect(isPiSessionId(session)).toBe(true);
  expect(buildPiRemoteCommand(BASE, { prompt: "x", session })).toContain(`--session '${session}'`);
  expect(() => buildPiRemoteCommand(BASE, { prompt: "x", session: "'; rm -rf / #" })).toThrow();
});

test("ssh argv is hardened and the key file is the one identity", () => {
  const args = buildSshArgs(BASE, { keyFile: "/k", knownHostsFile: "/kh" }, "true");
  const joined = args.join(" ");
  expect(joined).toContain("-o BatchMode=yes");
  expect(joined).toContain("-o StrictHostKeyChecking=yes");
  expect(joined).toContain("-o UserKnownHostsFile=/kh");
  expect(joined).toContain("-p 22");
  expect(args.at(-2)).toBe("worker@pi.example.invalid");
  // IdentityFile + IdentitiesOnly always: the stored key is THE identity, and
  // no agent that happens to be reachable may substitute another.
  expect(joined).toContain("-o IdentityFile=/k");
  expect(joined).toContain("-o IdentitiesOnly=yes");
  expect(joined).not.toContain("IdentityAgent");
});

// ── runner ───────────────────────────────────────────────────────────────────

class FakeChild implements PiProcess {
  stdout = "";
  stderr = "";
  killed = false;
  private settle!: (v: { code: number | null }) => void;
  readonly exited = new Promise<{ code: number | null }>((resolve) => (this.settle = resolve));
  emit(chunk: string): void {
    this.stdout += chunk;
  }
  /** Wired by the harness that cares about stderr (the host check). */
  emitErr?: (chunk: string) => void;
  finish(code: number): void {
    this.settle({ code });
  }
  kill(): void {
    this.killed = true;
    this.finish(255);
  }
}

function only(children: FakeChild[]): FakeChild {
  const child = children[0];
  if (!child) throw new Error("no child spawned");
  return child;
}

function harness() {
  const children: FakeChild[] = [];
  const spawner = (
    _args: readonly string[],
    onStdout: (chunk: string) => void,
    _onStderr: (chunk: string) => void,
  ): PiProcess => {
    const child = new FakeChild();
    children.push(child);
    // Fake delivery: the child's emit() pushes through this callback.
    child.emit = (chunk: string) => onStdout(chunk);
    return child;
  };
  return { children, spawner };
}

async function freshRunner() {
  const dir = await mkdtemp(`${tmpdir()}/pi-runs-`);
  let now = new Date("2026-10-05T12:00:00.000Z");
  const store = new DirPiRunStore(dir);
  const { children, spawner } = harness();
  const runner = new PiRunner(store, spawner, () => now);
  return { dir, store, runner, children, setNow: (d: Date) => (now = d) };
}

const SESSION = "01a10e10-08ec-705d-a364-5cfa40e1a963";

test("a completed run records session, settled and files", async () => {
  const { dir, store, runner, children } = await freshRunner();
  const meta = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "hi" },
  );
  const child = only(children);
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/tmp"}\n`);
  child.emit(`{"type":"agent_settled"}\n`);
  child.finish(0);
  await Bun.sleep(10);
  expect(meta.state).toBe("completed");
  expect(meta.session).toBe(SESSION);
  const readBack = await store.read(meta.runId);
  expect(readBack?.state).toBe("completed");
  const events = await readFile(`${dir}/${meta.runId}.jsonl`, "utf8");
  expect(events).toContain("agent_settled");
});

test("killing the local ssh detaches, never claims the remote stopped", async () => {
  const { store, runner, children } = await freshRunner();
  const meta = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "hi" },
  );
  const child = only(children);
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/tmp"}\n`);
  expect(runner.isRunning(meta.runId)).toBe(true);
  expect(runner.stop(meta.runId)).toBe(true);
  await Bun.sleep(10);
  expect(meta.state).toBe("detached");
  expect((await store.read(meta.runId))?.state).toBe("detached");
  expect(runner.stop(meta.runId)).toBe(false);
});

test("ssh failing before any output is a failure with the stderr tail", async () => {
  const { runner, children } = await freshRunner();
  const meta = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "hi" },
  );
  const child = only(children);
  child.finish(255);
  await Bun.sleep(10);
  expect(meta.state).toBe("failed");
});

test("boot reconciliation detaches orphaned runs", async () => {
  const { store, runner } = await freshRunner();
  const orphan: PiRunMeta = {
    runId: "11111111-2222-3333-4444-555555555555",
    kind: "run",
    agentId: null,
    session: SESSION,
    prompt: "old",
    model: null,
    target: "worker@pi.example.invalid",
    startedAt: "2026-10-04T10:00:00.000Z",
    endedAt: null,
    state: "running",
    exitCode: null,
    settled: false,
    eventCount: 3,
    lastEventAt: null,
    error: null,
  };
  await store.create(orphan);
  expect(await runner.reconcileOnBoot()).toBe(1);
  expect((await store.read(orphan.runId))?.state).toBe("detached");
});

// ── transcript ───────────────────────────────────────────────────────────────

test("pi_<uuid> is the linking agent id", () => {
  expect(piAgentId(SESSION)).toBe(`pi_${SESSION}`);
});

test("the parser turns a captured stream into steps", () => {
  const meta: PiRunMeta = {
    runId: "r",
    kind: "run",
    agentId: null,
    session: SESSION,
    prompt: "do it",
    model: null,
    target: "t",
    startedAt: "2026-10-05T12:00:00.000Z",
    endedAt: null,
    state: "completed",
    exitCode: 0,
    settled: true,
    eventCount: 4,
    lastEventAt: null,
    error: null,
  };
  const events = [
    `{"type":"session","id":"${SESSION}"}`,
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"done"}],"timestamp":1760000000000}}`,
    `{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"ls"}}`,
    `{"type":"tool_execution_end","toolCallId":"c1","result":{"content":[{"type":"text","text":"file.txt"}]},"isError":false}`,
    `{"type":"agent_settled"}`,
  ].join("\n");
  const run = parsePiRun(meta, events);
  expect(run.steps.map((s) => s.kind)).toEqual(["prompt", "reasoning", "message", "command"]);
  const command = run.steps.find((s) => s.kind === "command");
  expect(command && "output" in command && command.output).toContain("file.txt");
  expect(summarizePiRun(meta).session).toBe(SESSION);
  expect(lastAssistantText(events)).toBe("done");
});

// ── service (file custody + gating) ─────────────────────────────────────────

test("the service stores settings privately, gates on the token, and answers with text", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pi-svc-`);
  let token = false;
  const service = new PiService({
    paths: { dir },
    featureEnabled: () => token,
    spawner: () => new FakeChild(),
  });
  expect((await service.piRun({ prompt: "x" })).isError).toBe(true);

  token = true;
  const saved = await service.save({
    enabled: true,
    host: "pi.example.invalid",
    user: "worker",
    port: 22,
    workdir: "/home/worker/pi",
    privateKey: VALID_KEY,
    pathPrepend: "/bin",
  });
  expect(saved.enabled).toBe(true);
  const keyOnDisk = await readFile(piKeyFile({ dir }), "utf8");
  expect(keyOnDisk).toContain("BEGIN OPENSSH PRIVATE KEY");
  // ssh refuses keys with lax permissions; writePrivate must make them tight.
  const { stat } = await import("node:fs/promises");
  expect(((await stat(piKeyFile({ dir }))).mode & 0o777).toString(8)).toBe("600");
  expect((await stat(piSettingsFile({ dir }))).mode.toString(8).slice(-3)).toBe("600");
});

test("generateKeyPair stores a fresh pair and serves only the public half", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pi-gen-`);
  const service = new PiService({
    paths: { dir },
    featureEnabled: () => true,
    spawner: () => new FakeChild(),
  });
  await service.save({ host: "h", user: "u", workdir: "/w" }); // incomplete is fine pre-enable
  const generated = await service.generateKeyPair();
  expect(generated.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
  expect(generated.publicKey).toMatch(/^ssh-ed25519 \S+ lettuce-pi-worker$/);

  const served = toPublicPiSettings(generated);
  expect(served.hasKey).toBe(true);
  expect(served.publicKey).toBe(generated.publicKey);
  expect("privateKey" in served).toBe(false);

  const onDisk = await readFile(piKeyFile({ dir }), "utf8");
  expect(onDisk === generated.privateKey).toBe(true);
  expect(((await stat(piKeyFile({ dir }))).mode & 0o777).toString(8)).toBe("600");

  // Rotation replaces the pair outright (old public half must be re-pasted).
  const rotated = await service.generateKeyPair();
  expect(rotated.publicKey).not.toBe(generated.publicKey);
  expect((await service.load()).publicKey).toBe(rotated.publicKey);
});

test("a pasted PEM keeps its derived public half, garbage loses it", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pi-pub-`);
  const service = new PiService({
    paths: { dir },
    featureEnabled: () => true,
    spawner: () => new FakeChild(),
  });
  const generated = await service.generateKeyPair();
  expect(generated.publicKey).toMatch(/^ssh-ed25519 /);
  expect(generated.keySource).toBe("generated");
  // VALID_KEY is not a real PEM: ssh-keygen -y fails and we report no public
  // key rather than keeping the generated one as a lie.
  const pasted = await service.save({ privateKey: VALID_KEY });
  expect(pasted.privateKey).toBe(`${VALID_KEY.trimEnd()}\n`);
  expect(pasted.publicKey).toBe(null);
  expect(pasted.keySource).toBe("pasted");
  // Rotating replaces the pasted key, so custody really is lettuce's again.
  expect((await service.generateKeyPair()).keySource).toBe("generated");
});

// ── checking a host ──────────────────────────────────────────────────────────

test("known_hosts pinning is per host and per port", () => {
  const hosts =
    "pi.example.invalid ssh-ed25519 AAAAone\n[pi.example.invalid]:2222 ssh-ed25519 AAAAtwo\n# comment\n";
  expect(hostIsPinned(hosts, "pi.example.invalid", 22)).toBe(true);
  expect(hostIsPinned(hosts, "pi.example.invalid", 2222)).toBe(true);
  expect(hostIsPinned(hosts, "pi.example.invalid", 2223)).toBe(false);
  expect(hostIsPinned("", "pi.example.invalid", 22)).toBe(false);
  expect(pinnedHostKey(hosts, "pi.example.invalid", 22)).toContain("AAAAone");
});

test("a check is classified into something the form can act on", () => {
  expect(classifyCheckOutput({ code: 0, stdout: "pi v0.9.1\n", stderr: "" }).state).toBe("ready");
  expect(classifyCheckOutput({ code: 0, stdout: "pi v0.9.1\n", stderr: "" }).piVersion).toBe(
    "0.9.1",
  );
  expect(
    classifyCheckOutput({ code: 0, stdout: "lettuce: pi not on PATH", stderr: "" }).state,
  ).toBe("no_pi");
  expect(
    classifyCheckOutput({ code: 0, stdout: "lettuce: no such workdir", stderr: "" }).state,
  ).toBe("no_workdir");
  expect(
    classifyCheckOutput({
      code: 255,
      stdout: "",
      stderr: "worker@h: Permission denied (publickey).\n",
    }).state,
  ).toBe("auth_failed");
  expect(
    classifyCheckOutput({
      code: 255,
      stdout: "",
      stderr: "ssh: connect to host h port 22: Connection refused\n",
    }).state,
  ).toBe("unreachable");
  // A changed host key is the one answer that must not be silently retried.
  expect(
    classifyCheckOutput({
      code: 255,
      stdout: "",
      stderr: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n",
    }).detail,
  ).toMatch(/matches the pinned/);
});

test("a pi that is installed but cannot start is named for what is wrong", () => {
  // pi prints a module stack in this case (a `node` too old for it is the usual
  // cause), and the first line of a stack is not an explanation. The probe names
  // the failure and reports the node version, so the pill can say what to change.
  const broken = [
    "lettuce: pi failed",
    "file:///home/w/.pi/agent/install/releases/1.0.4/cli.js:2",
    'import { createRequire, enableCompileCache } from "node:module";',
    "SyntaxError: The requested module 'node:module' does not provide an export named 'enableCompileCache'",
    "lettuce: node v20.19.2",
    "",
  ].join("\n");
  const check = classifyCheckOutput({ code: 0, stdout: broken, stderr: "" });
  expect(check.state).toBe("no_pi");
  expect(check.detail).toContain("cannot run");
  expect(check.detail).toContain("enableCompileCache");
  expect(check.detail).toContain("node v20.19.2");
  // And a pi that answers with a bare version — which is what pi actually
  // prints — is ready, not "no pi".
  expect(classifyCheckOutput({ code: 0, stdout: "lettuce: pi 1.0.4\n", stderr: "" })).toMatchObject(
    {
      state: "ready",
      piVersion: "1.0.4",
    },
  );
  expect(
    classifyCheckOutput({ code: 0, stdout: "lettuce: pi not on PATH\n", stderr: "" }),
  ).toMatchObject({ state: "no_pi" });
});

test("the probe asks about workdir, PATH and pi in one ssh", () => {
  const withPrepend = buildProbeRemoteCommand({
    workdir: "/home/w/pi",
    pathPrepend: "/opt/pi/bin",
  });
  expect(withPrepend).toContain(`[ -d '/home/w/pi' ]`);
  expect(withPrepend).toContain("lettuce: no such workdir");
  expect(withPrepend).toContain(`env PATH='/opt/pi/bin':"$PATH" /bin/sh -c`);
  expect(withPrepend).toContain("pi --version");
  const plain = buildProbeRemoteCommand({ workdir: "", pathPrepend: "" });
  expect(plain).not.toContain("env PATH=");
  expect(plain).toContain("/bin/sh -c");
});

test("checks persist per target and a damaged record is no record", () => {
  const one: PiCheckRecord = {
    "worker@h:22": {
      target: "worker@h:22",
      state: "ready",
      ok: true,
      detail: "pi v0.9.1",
      at: "2026-01-01T00:00:00.000Z",
      piVersion: "0.9.1",
      pinnedFingerprint: "SHA256:abc",
    },
  };
  expect(parseChecks(renderChecks(one))).toEqual(one);
  expect(parseChecks("{not json")).toEqual({});
  expect(parseChecks('{"worker@h:22": {"nonsense": 1}}')).toEqual({});
});

async function checkHarness() {
  const dir = await mkdtemp(`${tmpdir()}/pi-check-`);
  const spawned: { args: readonly string[]; child: FakeChild }[] = [];
  // The check awaits its files before it spawns, so tests take the child from a
  // promise instead of reaching for a spawn that has not happened yet.
  const waiting: ((entry: { args: readonly string[]; child: FakeChild }) => void)[] = [];
  const nextChild = async () => {
    const last = spawned.at(-1);
    if (last) return last;
    return new Promise<{ args: readonly string[]; child: FakeChild }>((resolve) =>
      waiting.push(resolve),
    );
  };
  const spawner = (
    args: readonly string[],
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ): PiProcess => {
    const child = new FakeChild();
    const entry = { args, child };
    spawned.push(entry);
    const waiter = waiting.shift();
    if (waiter) waiter(entry);
    child.emit = (chunk: string) => onStdout(chunk);
    child.emitErr = (chunk: string) => onStderr(chunk);
    return child;
  };
  const service = new PiService({ paths: { dir }, featureEnabled: () => true, spawner });
  await service.save({
    enabled: true,
    host: "pi.example.invalid",
    user: "worker",
    workdir: "/home/worker/pi",
    privateKey: VALID_KEY,
  });
  return { dir, service, spawned, nextChild };
}

test("an unpinned host is reported unpinned without ever reaching ssh", async () => {
  const { service, spawned } = await checkHarness();
  const check = await service.checkHost();
  expect(check.state).toBe("unpinned");
  expect(check.ok).toBe(false);
  expect(spawned.length).toBe(0);
  // Remembered, because the phone must show what the laptop learned.
  expect(
    (await service.lastCheck({ host: "pi.example.invalid", port: 22, user: "worker" }))?.state,
  ).toBe("unpinned");
});

test("a pinned host is probed with the run's own ssh flags and PATH", async () => {
  const { dir, service, nextChild } = await checkHarness();
  await writeFile(`${dir}/known_hosts`, "pi.example.invalid ssh-ed25519 AAAAone\n", "utf8");
  // The PATH prefix from the form is the one the probe must use, since it is
  // the same prefix a run gets.
  const pending = service.checkHost({ pathPrepend: "/opt/pi/bin" });
  const { args, child } = await nextChild();
  child.emit("pi v0.9.1\n");
  child.finish(0);
  const check = await pending;
  expect(check.state).toBe("ready");
  expect(check.piVersion).toBe("0.9.1");
  expect(check.target).toBe("worker@pi.example.invalid:22");
  const joined = args.join(" ");
  expect(joined).toContain("-o StrictHostKeyChecking=yes");
  expect(joined).toContain(String.raw`env PATH='/opt/pi/bin':"$PATH" /bin/sh -c`);
});

test("an unsaved form is checked, and a refused key is named as such", async () => {
  const { dir, service, spawned, nextChild } = await checkHarness();
  await writeFile(`${dir}/known_hosts`, "pi.example.invalid ssh-ed25519 AAAAone\n", "utf8");
  const pending = service.checkHost({ port: 2222, pathPrepend: "/opt/pi/bin" });
  // Port 2222 is not pinned, so the answer is still "unpinned" — checking the
  // form's values means checking exactly those values.
  const unpinned = await pending;
  expect(unpinned.target).toBe("worker@pi.example.invalid:2222");
  expect(unpinned.state).toBe("unpinned");
  expect(spawned.length).toBe(0);

  await writeFile(`${dir}/known_hosts`, "[pi.example.invalid]:2222 ssh-ed25519 AAAAone\n", "utf8");
  const retry = service.checkHost({ port: 2222 });
  const { child } = await nextChild();
  child.emitErr?.("worker@pi.example.invalid: Permission denied (publickey).\n");
  child.finish(255);
  const refused = await retry;
  expect(refused.state).toBe("auth_failed");
  expect(refused.detail).toMatch(/authorized_keys/);
});
