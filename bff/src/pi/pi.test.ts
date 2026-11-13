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
  buildPiFetchRemoteCommand,
  buildPiLsRemoteCommand,
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
import {
  lastAssistantText,
  PI_TOOL_NAMES,
  PI_TOOL_SPECS,
  PiService,
  piKeyFile,
  piKnownHostsFile,
  piSettingsFile,
} from "./service.ts";
import {
  applyPiSettingsUpdate,
  DEFAULT_PI_COMMAND,
  DEFAULT_PI_SETTINGS,
  InvalidPiSettingsError,
  normalizePathPrepend,
  type PiSettings,
  parsePiCommand,
  parsePiSettings,
  piCommandWords,
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

test("the remote command cd's and prepends PATH — the prompt is not in argv (C2)", () => {
  const cmd = buildPiRemoteCommand(BASE, {});
  expect(cmd).toContain(
    String.raw`cd '/home/worker/pi' && env PATH='/opt/node/bin:/opt/pi/bin':"$PATH" /bin/sh -c`,
  );
  expect(cmd).toContain("pi --mode json");
  // The prompt travels via stdin (it must never be readable in the remote's ps).
  expect(cmd).not.toContain("review");
  // The pid marker: pi is exec'd inside the inner shell, so that shell's $$ is
  // pi's own pid — and the exec passes pi's exit code through untouched. The
  // marker survives the wrapper's double quotes escaped, not expanded.
  expect(cmd).toContain(String.raw`echo \"lettuce-remote-pid \$\$\" >&2;`);
  // The exit marker: the wrapper prints pi's real code once it is gone, which is
  // how a crash stops looking like a lost connection.
  expect(cmd).toContain('rc=$?; echo "lettuce-remote-exit $rc" >&2; exit $rc');
});

test("the wrapper reports the program's own exit code (crash vs lost connection)", async () => {
  // The distinction the marker exists for, executed for real: a program that
  // exits 3 must be reported as 3 by the wrapper AND leave ssh with 3. Without
  // the marker, a crash and a dropped connection are the same number.
  const dir = await mkdtemp(`${tmpdir()}/pi-shape-`);
  const { writeFile, chmod } = await import("node:fs/promises");
  const prog = `${dir}/exit-3.sh`;
  await writeFile(prog, "#!/bin/sh\nexit 3\n");
  await chmod(prog, 0o755);
  const cmd = buildPiRemoteCommand(
    { ...BASE, workdir: "/tmp", pathPrepend: "", command: prog },
    { model: null },
  );
  const r = Bun.spawnSync(["sh", "-c", cmd]);
  expect(r.stderr.toString()).toMatch(/lettuce-remote-exit 3/);
  expect(r.exitCode).toBe(3);

  // And the crash case: a program killed by a signal reports 128+n through the
  // same marker, which is what a lost connection can never produce.
  const killer = `${dir}/kill-self.sh`;
  await writeFile(killer, "#!/bin/sh\nkill -9 $$\n");
  await chmod(killer, 0o755);
  const killed = Bun.spawnSync([
    "sh",
    "-c",
    buildPiRemoteCommand(
      { ...BASE, workdir: "/tmp", pathPrepend: "", command: killer },
      { model: null },
    ),
  ]);
  expect(killed.stderr.toString()).toMatch(/lettuce-remote-exit 137/);
  expect(killed.exitCode).toBe(137);
});

test("the force-stop wrapper really passes the exit code through", () => {
  // Run the generated shape locally: a failing program must exit non-zero and
  // the pid marker must reach stderr — the two promises the wrapper makes.
  const command = buildPiRemoteCommand(
    { ...BASE, workdir: "/tmp", pathPrepend: "" },
    {
      model: null,
    },
  ).replace("pi --mode json", "false --mode json");
  const failed = Bun.spawnSync(["sh", "-c", command]);
  expect(failed.exitCode).not.toBe(0);
  expect(failed.stderr.toString()).toMatch(/lettuce-remote-pid \d+/);
  const ok = Bun.spawnSync([
    "sh",
    "-c",
    buildPiRemoteCommand({ ...BASE, workdir: "/tmp", pathPrepend: "" }, {}).replace(
      "pi --mode json",
      "true --mode json",
    ),
  ]);
  expect(ok.exitCode).toBe(0);
});

test("the exec wrapper really carries stdin to the program (the & form cannot)", () => {
  // The regression this shape exists for: a `&`-backgrounded job gets
  // /dev/null stdin when job control is off, so the first stdin design made
  // pi see an instant EOF. The exec'd program must read the piped prompt.
  const cmd = buildPiRemoteCommand({ ...BASE, workdir: "/tmp", pathPrepend: "" }, {}).replace(
    "exec pi --mode json --approve",
    "exec cat",
  );
  // `printf X | cd … && sh` would pipe into `cd` — the pipeline must feed the
  // whole compound command, which is exactly what ssh stdin does for real.
  const r = Bun.spawnSync(["sh", "-c", `printf PROMPT-VIA-STDIN | ( ${cmd} )`]);
  expect(r.stdout.toString()).toContain("PROMPT-VIA-STDIN");
  expect(r.stderr.toString()).toMatch(/lettuce-remote-pid \d+/);
});

test("the PATH prepend hands $PATH to the remote shell", () => {
  // `PATH='<x>:$PATH'` looks right and is not: the remote shell never expands a
  // quoted `$PATH`, so env gets a PATH of one directory plus five literal
  // characters, and the run dies naming the program env could not find.
  for (const cmd of [
    buildPiRemoteCommand(BASE, {}),
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
  const cmd = buildPiRemoteCommand({ ...BASE, pathPrepend: "/opt/pi/bin/" }, {});
  expect(cmd).toContain(`env PATH='/opt/pi/bin':"$PATH"`);
  expect(cmd).not.toContain("//");
});

test("empty pathPrepend emits no env PATH at all", () => {
  const cmd = buildPiRemoteCommand({ ...BASE, pathPrepend: "  " }, {});
  expect(cmd).not.toContain("env");
});

test("session resume passes --session and rejects non-UUIDs", () => {
  const session = "01a10e10-08ec-705d-a364-5cfa40e1a963";
  expect(isPiSessionId(session)).toBe(true);
  expect(buildPiRemoteCommand(BASE, { session })).toContain(
    `--session '\\''${session}'\\''`, // quoted once per shell it travels through
  );
  expect(() => buildPiRemoteCommand(BASE, { session: "'; rm -rf / #" })).toThrow();
});

test("ssh argv is hardened and the key file is the one identity", () => {
  const args = buildSshArgs(BASE, { keyFile: "/k", knownHostsFile: "/kh" }, "true");
  const joined = args.join(" ");
  expect(joined).toContain("-o BatchMode=yes");
  expect(joined).toContain("-o StrictHostKeyChecking=yes");
  expect(joined).toContain("-o UserKnownHostsFile=/kh");
  expect(joined).toContain("-p 22");
  expect(args.at(-2)).toBe("worker@pi.example.invalid");
  // The destination can never be read as an option, whatever it starts with.
  expect(args.at(-3)).toBe("--");
  // IdentityFile + IdentitiesOnly always: the stored key is THE identity, and
  // no agent that happens to be reachable may substitute another.
  expect(joined).toContain("-o IdentityFile=/k");
  expect(joined).toContain("-o IdentitiesOnly=yes");
  expect(joined).not.toContain("IdentityAgent");
});

test("a host or user that reads as an ssh option is refused at save", () => {
  for (const host of ["-oProxyCommand=id", "pi host", "pi;id", "a/b", "$(id)"]) {
    expect(() => applyPiSettingsUpdate(BASE, { host })).toThrow("hostname");
  }
  for (const user of ["-lroot", "wor ker", "a@b", "x;y"]) {
    expect(() => applyPiSettingsUpdate(BASE, { user })).toThrow("login name");
  }
  for (const host of ["pi.example.invalid", "192.0.2.7", "2001:db8::7", "pi_box-2"]) {
    expect(applyPiSettingsUpdate(BASE, { host }).host).toBe(host);
  }
  expect(applyPiSettingsUpdate(BASE, { user: "svc_pi-2" }).user).toBe("svc_pi-2");
});

// ── runner ───────────────────────────────────────────────────────────────────

class FakeChild implements PiProcess {
  stdout = "";
  stderr = "";
  killed = false;
  /** What the runner wrote as the prompt through the ssh stdin (C2). */
  stdinText: string | null = null;
  stdinClosed = false;
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
  sendStdin(text: string): void {
    this.stdinText = text;
    this.stdinClosed = true;
  }
  closeStdin(): void {
    this.stdinClosed = true;
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
    onStderr: (chunk: string) => void,
  ): PiProcess => {
    const child = new FakeChild();
    children.push(child);
    // Fake delivery: the child's emit() pushes through this callback.
    child.emit = (chunk: string) => onStdout(chunk);
    child.emitErr = (chunk: string) => onStderr(chunk);
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
    conversationId: null,
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
    bytesCaptured: 0,
    remotePid: null,
    remoteExit: null,
    error: null,
  };
  await store.create(orphan);
  expect(await runner.reconcileOnBoot()).toBe(1);
  expect((await store.read(orphan.runId))?.state).toBe("detached");
});

test("boot reconciliation reports the orphan it detaches — the conversation is waiting", async () => {
  // A BFF restart mid-run leaves a conversation that dispatched the run waiting
  // for a verdict that will never arrive on its own. Marking the meta detached is
  // half the job; the other half is the hook that writes the line into the
  // transcript, which used to fire only for runs this process had watched.
  const dir = await mkdtemp(`${tmpdir()}/pi-runs-`);
  const store = new DirPiRunStore(dir);
  const { spawner } = harness();
  const settled: { state: string; conversationId: string | null }[] = [];
  const runner = new PiRunner(
    store,
    spawner,
    () => new Date(),
    (meta) => settled.push({ state: meta.state, conversationId: meta.conversationId }),
  );
  await store.create({
    runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    kind: "send",
    agentId: "agent-local-0fefdba6",
    conversationId: "local-conv-120",
    session: SESSION,
    prompt: "old work",
    model: null,
    target: "worker@pi.example.invalid",
    startedAt: "2026-10-04T10:00:00.000Z",
    endedAt: null,
    state: "running",
    exitCode: null,
    settled: false,
    eventCount: 12,
    lastEventAt: null,
    bytesCaptured: 0,
    remotePid: null,
    remoteExit: null,
    error: null,
  });
  expect(await runner.reconcileOnBoot()).toBe(1);
  expect(settled).toEqual([{ state: "detached", conversationId: "local-conv-120" }]);
});

test("progress reaches the store while the run streams — throttled, and never only in memory", async () => {
  // The prod lesson in one test: a `send` run streams for minutes and read
  // `events 0` the whole time, because the meta reached disk only at exit.
  const { store, runner, children, setNow } = await freshRunner();
  const meta = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "send", prompt: "plan it", session: SESSION },
  );
  const child = only(children);
  for (let i = 0; i < 3; i += 1) child.emit(`{"type":"message_update","i":${i}}\n`);
  await Bun.sleep(20);
  // Under both thresholds: the deliberate cheapness — not a per-line write.
  expect((await store.read(meta.runId))?.eventCount).toBe(0);
  setNow(new Date("2026-10-05T12:00:03.000Z")); // past the flush interval
  child.emit(`{"type":"message_update","i":3}\n`);
  await Bun.sleep(20);
  const disk = await store.read(meta.runId);
  expect(disk?.eventCount).toBe(4);
  expect(disk?.bytesCaptured).toBeGreaterThan(0);
  expect(disk?.lastEventAt).not.toBeNull();
  child.finish(0);
});

test("the progress feed fires on the throttled flushes and exactly once at settle", async () => {
  // The pushed frames replaced four browser pollers; this pins their cadence:
  // one frame per meta flush (never per line) and a final terminal frame.
  const dir = await mkdtemp(`${tmpdir()}/pi-runs-`);
  let now = new Date("2026-10-05T12:00:00.000Z");
  const store = new DirPiRunStore(dir);
  const { children, spawner } = harness();
  const frames: { state: string; events: number }[] = [];
  const runner = new PiRunner(
    store,
    spawner,
    () => now,
    undefined,
    (meta) => {
      frames.push({ state: meta.state, events: meta.eventCount });
    },
  );
  const meta = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "hi" },
  );
  const child = only(children);
  for (let i = 0; i < 3; i += 1) child.emit(`{"type":"message_update","i":${i}}\n`);
  await Bun.sleep(20);
  // Under both flush thresholds: no frame, same deliberate cheapness as the disk.
  expect(frames.length).toBe(0);
  now = new Date("2026-10-05T12:00:03.000Z"); // past the flush interval
  child.emit(`{"type":"message_update","i":3}\n`);
  await Bun.sleep(20);
  expect(frames).toEqual([{ state: "running", events: 4 }]);
  child.finish(0);
  await Bun.sleep(20);
  expect(frames.length).toBe(2);
  // A clean ssh exit is the finish line even with no `agent_settled` line in the
  // stream: pi exits when its prompts are done, and treating that one event as
  // the only completion signal left runs unreported. What matters here is that
  // the terminal frame fires once.
  expect(frames[1]?.state).toBe("completed");
  void meta;
});

test("the remote pid captured from stderr reaches the durable meta", async () => {
  const { store, runner, children } = await freshRunner();
  const meta = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "hi" },
  );
  const child = only(children);
  child.emitErr?.("lettuce-remote-pid 4242\n");
  await Bun.sleep(10);
  expect((await store.read(meta.runId))?.remotePid).toBe(4242);
  child.finish(255);
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
    conversationId: null,
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
    bytesCaptured: 0,
    remotePid: null,
    remoteExit: null,
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

// ── the configured command ───────────────────────────────────────────────────

test("the command field splits into words the way the remote shell would", () => {
  expect(parsePiCommand("pi")).toEqual(["pi"]);
  expect(parsePiCommand("  pi-bolt   --thinking high ")).toEqual(["pi-bolt", "--thinking", "high"]);
  expect(parsePiCommand("/opt/pi/bin/pi-bolt")).toEqual(["/opt/pi/bin/pi-bolt"]);
  expect(parsePiCommand(`pi-bolt --note "a b"`)).toEqual(["pi-bolt", "--note", "a b"]);
  expect(parsePiCommand(`pi-bolt --note 'a b'`)).toEqual(["pi-bolt", "--note", "a b"]);
  // An apostrophe inside a single-quoted word is what sh would have to refuse;
  // here it is just a character of the word.
  expect(parsePiCommand(`sh -c 'it'\\''s'`)).toEqual(["sh", "-c", "it's"]);
  // Empty is "use the default", not an empty command.
  expect(parsePiCommand("")).toEqual([]);
  expect(piCommandWords("")).toEqual([DEFAULT_PI_COMMAND]);
  expect(piCommandWords(null)).toEqual([DEFAULT_PI_COMMAND]);
  expect(piCommandWords("pi-bolt --x")).toEqual(["pi-bolt", "--x"]);
});

test("a command that cannot be a command is refused where it is set", () => {
  expect(() => parsePiCommand(`pi-bolt "unclosed`)).toThrow(InvalidPiSettingsError);
  expect(() => parsePiCommand("pi-bolt trail\\")).toThrow(/backslash/);
  // A newline here would tear the remote compound command apart.
  expect(() => parsePiCommand("pi-bolt\nrm -rf /")).toThrow(/control/);
  expect(() => parsePiCommand('pi-bolt ""')).toThrow(/empty/);
});

test("the command may not use the flags the run appends after it", () => {
  // `--mode text` ahead of ours, or `--` alone, and the runner is reading
  // positional arguments instead of the json stream it was built for.
  for (const bad of ["pi --mode text", "pi --", "pi --approve --session x", "pi --model m"]) {
    expect(() => parsePiCommand(bad)).toThrow(/the run adds its own/);
  }
  expect(() => applyPiSettingsUpdate(BASE, { command: "pi --mode text" })).toThrow(
    InvalidPiSettingsError,
  );
  // A word that merely starts with one is nobody else's flag.
  expect(parsePiCommand("pi --model-name gpt")).toEqual(["pi", "--model-name", "gpt"]);
});

test("the tokenizer follows sh, not a plausible approximation of it", () => {
  // Inside double quotes a backslash escapes only $ ` " \ ; anywhere else it is
  // a backslash, and dropping it is how `--note "a\b"` loses a character.
  expect(parsePiCommand('pi --note "a\\b"')).toEqual(["pi", "--note", "a\\b"]);
  expect(parsePiCommand('pi --note "a\\"b"')).toEqual(["pi", "--note", 'a"b']);
  expect(parsePiCommand('pi --note "a\\$b"')).toEqual(["pi", "--note", "a$b"]);
  // A non-breaking space is part of a word: sh splits on space, tab and newline,
  // and silently renaming the program from a paste is worse than an unknown
  // command the check reports.
  expect(parsePiCommand("pi-bolt x")).toEqual(["pi-bolt x"]);
});

test("the command round-trips through settings, and an unusable stored one is dropped", () => {
  const saved = parsePiSettings(JSON.stringify({ ...BASE, command: " pi-bolt --thinking high " }));
  expect(saved.command).toBe("pi-bolt --thinking high");
  // A record from before the field existed still runs pi.
  const before = parsePiSettings(JSON.stringify({ ...BASE, command: undefined }));
  expect(before.command).toBe(DEFAULT_PI_COMMAND);
  // A hand-edited value nobody can see in the UI must not break every run.
  expect(parsePiSettings(JSON.stringify({ ...BASE, command: 'pi "oops' })).command).toBe(
    DEFAULT_PI_COMMAND,
  );
  expect(applyPiSettingsUpdate(BASE, { command: "pi-bolt" }).command).toBe("pi-bolt");
  expect(applyPiSettingsUpdate({ ...BASE, command: "pi-bolt" }, { command: "" }).command).toBe(
    DEFAULT_PI_COMMAND,
  );
  expect(() => applyPiSettingsUpdate(BASE, { command: "pi-bolt 'oops" })).toThrow(
    InvalidPiSettingsError,
  );
});

test("the run executes the configured program, and our flags come last", () => {
  const cmd = buildPiRemoteCommand(
    { ...BASE, command: "pi-bolt --thinking high" },
    { session: "00000000-0000-4000-8000-000000000000", model: "m" },
  );
  expect(cmd).toContain("exec pi-bolt --thinking high --mode json --approve");
  // Our flags are the last words, whatever the operator typed before them.
  expect(cmd.indexOf("--approve")).toBeLessThan(cmd.indexOf("--session"));
  expect(cmd.indexOf("--session")).toBeLessThan(cmd.indexOf("--model"));
  // The default shape is unchanged, fixtures and all.
  expect(buildPiRemoteCommand(BASE, {})).toContain("exec pi --mode json --approve");
});

test("an argument with a space survives the two shells as one argument", () => {
  // The whole point of tokenizing here instead of passing the line through: the
  // remote must see the words, not re-split them. printf stands in for pi and
  // prints one bracket per argument it actually received.
  const cmd = buildPiRemoteCommand(
    { ...BASE, workdir: "/tmp", pathPrepend: "", command: "printf '[%s]' --tag 'a b'" },
    {},
  );
  const r = Bun.spawnSync(["sh", "-c", cmd]);
  expect(r.stdout.toString()).toBe("[--tag][a b][--mode][json][--approve]");
});

test("what an operator types stays literal through three shells", () => {
  // The nesting is the risk: a value goes single-quoted into the inner script,
  // and the inner script sits double-quoted inside the wrapper inside the
  // single-quoted ssh argument. A `$`, a backtick, a quote or a backslash that
  // survives literally here is the proof the quoting layers hold — and a model
  // name is exactly where someone types one.
  const nasty = "mo del$HOME`ticked\"quoted'aim\\slash";
  const cmd = buildPiRemoteCommand(
    { ...BASE, workdir: "/tmp", pathPrepend: "", command: "printf '[%s]'" },
    { model: nasty },
  );
  const r = Bun.spawnSync(["sh", "-c", cmd]);
  const out = r.stdout.toString();
  expect(out).toBe(`[--mode][json][--approve][--model][${nasty}]`);
});

test("the probe asks about the configured command, not the one we assumed", () => {
  const probe = buildProbeRemoteCommand({
    workdir: "",
    pathPrepend: "",
    command: "pi-bolt --thinking high",
  });
  expect(probe).toContain("command -v pi-bolt");
  expect(probe).toContain("pi-bolt --thinking high --version");
  // The markers are protocol between the probe and classifyCheckOutput; the
  // operator sees the command's own name in the detail instead.
  expect(probe).toContain("lettuce: pi not on PATH");
  expect(buildProbeRemoteCommand({ workdir: "", pathPrepend: "" })).toContain("command -v pi");
});

test("a check names the program the operator typed", () => {
  expect(
    classifyCheckOutput({
      code: 0,
      stdout: "lettuce: pi not on PATH",
      stderr: "",
      commandName: "pi-bolt",
    }).detail,
  ).toMatch(/`pi-bolt` is not on the PATH/);
  expect(
    classifyCheckOutput({
      code: 0,
      stdout: "lettuce: pi failed\nSyntaxError: bad\nlettuce: node v20.19.2",
      stderr: "",
      commandName: "pi-bolt",
    }).detail,
  ).toMatch(/^pi-bolt is installed but cannot run/);
  expect(
    classifyCheckOutput({
      code: 0,
      stdout: "lettuce: pi 1.4.2",
      stderr: "",
      commandName: "pi-bolt",
    }).detail,
  ).toBe("pi-bolt v1.4.2");
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

// ── progress, waiting, and force-stop at the tool surface ────────────────────

/** The nth spawned ssh child of a run harness, loudly (tests fail with a name). */
function spawnedChild(spawned: { child: FakeChild }[], n: number): FakeChild {
  const entry = spawned[n];
  if (!entry) throw new Error(`expected ${n + 1} spawned ssh, saw ${spawned.length}`);
  return entry.child;
}

/** Poll until `done` holds. A shared CI runner delivers async work later than
 *  any fixed sleep guesses, so nothing in this file waits on a guess. */
async function waitFor(what: string, done: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (await done()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Wait for the nth spawn instead of sleeping a fixed guess. */
async function waitForSpawns(spawned: { child: FakeChild }[], n: number): Promise<FakeChild> {
  await waitFor(`spawn #${n}`, () => spawned.length >= n);
  return spawnedChild(spawned, n - 1);
}

/** A settle/progress frame as it was when it fired — see runHarness. */
interface Frame {
  runId: string;
  eventCount: number;
  state: PiRunMeta["state"];
}

async function runHarness(opts: { slowStoreMs?: number } = {}) {
  const dir = await mkdtemp(`${tmpdir()}/pi-runsvc-`);
  const spawned: { args: readonly string[]; child: FakeChild }[] = [];
  const settled: PiRunMeta[] = [];
  const progress: Frame[] = [];
  const spawner = (
    args: readonly string[],
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ): PiProcess => {
    const child = new FakeChild();
    spawned.push({ args, child });
    child.emit = (chunk: string) => onStdout(chunk);
    child.emitErr = (chunk: string) => onStderr(chunk);
    return child;
  };
  const service = new PiService({
    paths: { dir },
    featureEnabled: () => true,
    spawner,
    // The runner passes the LIVE meta to both hooks and keeps mutating it, so a
    // bare push reads back the counters as of now, not as of the frame — with
    // slow writes that reads as a flush that already landed. The progress frames
    // are what a test waits on, so they are copied; `settled` is read after the
    // run is over, when nothing mutates it any more.
    onSettle: (meta) => settled.push(meta),
    onProgress: (meta) =>
      progress.push({ runId: meta.runId, eventCount: meta.eventCount, state: meta.state }),
  });
  // A shared CI runner's disk lands a durable write late. Slowing every meta
  // write is the regression guard for the test that opts in: a wait that guesses
  // how long a flush takes fails locally every time instead of occasionally on
  // CI. It is opt-in per test on purpose — the other fixed sleeps in this file
  // wait on spawns and streams, not on a meta write.
  if (opts.slowStoreMs) {
    const slowMs = opts.slowStoreMs;
    const update = service.store.update.bind(service.store);
    service.store.update = async (meta: PiRunMeta) => {
      await Bun.sleep(slowMs);
      await update(meta);
    };
  }
  await service.save({
    enabled: true,
    host: "pi.example.invalid",
    user: "worker",
    port: 22,
    workdir: "/home/worker/pi",
    privateKey: VALID_KEY,
  });
  await writeFile(`${dir}/known_hosts`, "pi.example.invalid ssh-ed25519 AAAAone\n", "utf8");
  const files = {
    keyFile: piKeyFile({ dir }),
    knownHostsFile: piKnownHostsFile({ dir }),
  };
  return { dir, service, spawned, settled, progress, files };
}

test("pi_run records the dispatching conversation and the settle report answers back", async () => {
  const { service, spawned, settled } = await runHarness();
  // Emit the session once the ssh really exists — a loaded CI runner can
  // deliver the spawn later than any fixed timer assumes.
  const started = service.piRun(
    { prompt: "clone the repo" },
    { agentId: "agent-local-0fefdba6", conversationId: "local-conv-120" },
  );
  (await waitForSpawns(spawned, 1)).emit(
    `{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/w"}\n`,
  );
  const answer = await started;
  expect(answer.isError).toBe(false);
  expect(answer.text).toContain("nothing to poll"); // Option A: event, not polling
  const runId = answer.text.match(/run ([0-9a-f-]{36})/)?.[1] ?? "";
  expect(runId).not.toBe("");
  const child = spawnedChild(spawned, 0);
  child.emit(
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"cloned"}],"timestamp":1760000000000}}\n`,
  );
  child.emit('{"type":"agent_settled"}\n');
  child.finish(0);
  for (let i = 0; i < 200 && !settled.some((m) => m.runId === runId); i += 1) await Bun.sleep(10);
  const done = settled.find((m) => m.runId === runId);
  expect(done?.conversationId).toBe("local-conv-120");
  const pending = service.settleReport(done!);
  const findChild = await waitForSpawns(spawned, 2); // the manifest find must answer too
  findChild.finish(0);
  const report = await pending;
  expect(report.startsWith("<task-notification>")).toBe(true);
  expect(report).toContain("completed");
  expect(report).toContain("clone the repo");
  expect(report).toContain("cloned");
  expect(report).toContain("do not poll");
});

test("a clean exit with no settle line is a completed run, not a mystery", async () => {
  // The bug that taught agents to poll: the run finished, ssh exited 0, and
  // because the stream never carried `agent_settled` we called it detached and
  // told no one.
  const { store, runner, children } = await freshRunner();
  const meta = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "hi" },
  );
  const child = only(children);
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/tmp"}\n`);
  child.finish(0);
  await Bun.sleep(10);
  expect(meta.state).toBe("completed");
  expect(meta.settled).toBe(false); // the fact is still recorded separately
  expect((await store.read(meta.runId))?.state).toBe("completed");
});

test("a pi that crashes mid-run is failed with its own exit code, not a detach", async () => {
  // The bug this exists for: a run that streamed and then died was filed as
  // `detached` with `error: null` (ssh's stderr was only kept for a run that
  // captured nothing), and the agent reading that blamed the network.
  const { store, runner, children } = await freshRunner();
  const meta = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "hi" },
  );
  const child = only(children);
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/tmp"}\n`);
  child.emitErr?.("lettuce-remote-pid 4711\n");
  child.emitErr?.("Killed\nlettuce-remote-exit 137\n");
  child.finish(137); // the wrapper reported pi's own death by SIGKILL
  await Bun.sleep(10);
  expect(meta.state).toBe("failed");
  expect(meta.remoteExit).toBe(137);
  expect(meta.error).toContain("pi exited 137");
  expect(meta.error).toContain("Killed");
  expect((await store.read(meta.runId))?.remoteExit).toBe(137);
});

test("a connection that dies mid-run says the pipe went away, with ssh's own words", async () => {
  const { runner, children } = await freshRunner();
  const meta = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "hi" },
  );
  const child = only(children);
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/tmp"}\n`);
  child.emitErr?.("Connection to pi.example.invalid closed by remote host.\n");
  child.finish(255); // ssh's own code, and no exit marker: pi never reported
  await Bun.sleep(10);
  expect(meta.state).toBe("detached");
  expect(meta.remoteExit).toBeNull();
  expect(meta.error).toContain("never reported its exit");
  expect(meta.error).toContain("closed by remote host");
});

test("a detach we were asked for says so, instead of reading like a crash", async () => {
  const { runner, children } = await freshRunner();
  const meta = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "hi" },
  );
  const child = only(children);
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/tmp"}\n`);
  runner.stop(meta.runId); // closes the local capture; the fake kill exits ssh
  await Bun.sleep(10);
  expect(meta.state).toBe("detached");
  expect(meta.error).toContain("capture stopped on request");
});

test("a stop we asked for outranks the exit code the worker reported", async () => {
  // The kill path can land a marker alongside the stop. Our choice is still the
  // story the run gets — with the code named, not hidden.
  const { runner, children } = await freshRunner();
  const meta = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "hi" },
  );
  const child = only(children);
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/tmp"}\n`);
  runner.stop(meta.runId);
  child.emitErr?.("Killed\nlettuce-remote-exit 137\n");
  child.finish(137);
  await Bun.sleep(10);
  expect(meta.state).toBe("detached");
  expect(meta.error).toContain("capture stopped on request");
  expect(meta.error).toContain("pi exited 137");
});

test("a settled run stays completed even when the wrapper reports a late non-zero exit", async () => {
  const { runner, children } = await freshRunner();
  const meta = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "hi" },
  );
  const child = only(children);
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/tmp"}\n`);
  child.emit(`{"type":"agent_settled"}\n`);
  child.emitErr?.("lettuce-remote-exit 1\n");
  child.finish(1);
  await Bun.sleep(10);
  expect(meta.state).toBe("completed");
  expect(meta.remoteExit).toBe(1); // the fact is kept, the verdict is pi's
});

test("the error a run carries is the reason, not the wrapper's protocol or a dump", async () => {
  // The tail lands in a conversation and on a card. `brief` drops the marker lines
  // and caps the length, so what an agent reads is a clause, not 2 kB of noise.
  const { runner, children } = await freshRunner();
  const meta = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "hi" },
  );
  const child = only(children);
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/tmp"}\n`);
  child.emitErr?.(`${"noise\n".repeat(400)}out of memory\nlettuce-remote-exit 134\n`);
  child.finish(134);
  await Bun.sleep(10);
  expect(meta.state).toBe("failed");
  expect(meta.error).toContain("out of memory");
  expect(meta.error).not.toContain("lettuce-remote-");
  expect(meta.error!.length).toBeLessThan(260);
});

test("an interrupted capture still detaches, and a run with no output still fails", async () => {
  const { store, runner, children } = await freshRunner();
  const meta = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "hi" },
  );
  const child = only(children);
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/tmp"}\n`);
  child.finish(255); // ssh died mid-stream: we stopped watching, that is all we know
  await Bun.sleep(10);
  expect(meta.state).toBe("detached");
  const failed = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "hi again" },
  );
  only(children.slice(-1)).finish(0); // exit 0, but nothing was ever captured
  await Bun.sleep(10);
  expect(failed.state).toBe("failed");
  void store;
});

test("a detached run reports itself too — silence is what taught agents to poll", async () => {
  const { service, spawned, settled, files } = await runHarness();
  const meta = await service.runner.start(await service.load(), files, {
    kind: "run",
    prompt: "orphan",
    agentId: "agent-local-0fefdba6",
    conversationId: "local-conv-120",
  });
  const child = spawnedChild(spawned, 0);
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/w"}\n`);
  service.runner.stop(meta.runId); // the capture dies while the remote may live on
  await waitFor("the run to settle", () => settled.length === 1);
  const pending = service.settleReport(settled[0]!);
  const findChild = await waitForSpawns(spawned, 2); // the manifest find must answer too
  findChild.finish(0);
  const report = await pending;
  expect(report).toContain("detached");
  expect(report).toContain("stopped capturing");
  expect(report).toContain("never start a duplicate");
  void child;
});

test("pi_wait never waits: it says the wait is retired and gives the status", async () => {
  const { service, spawned, files } = await runHarness();
  const meta = await service.runner.start(await service.load(), files, {
    kind: "run",
    prompt: "slow task",
  });
  const child = spawnedChild(spawned, 0);
  expect(child.stdinText).toBe("slow task"); // C2: the prompt rode the stdin, not argv
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/w"}\n`);
  const t0 = Date.now();
  const waited = await service.piWait({ run: meta.runId });
  expect(Date.now() - t0).toBeLessThan(1_000); // it does not hold the turn
  expect(waited.isError).toBe(false);
  expect(waited.text).toContain("waiting is retired");
  expect(waited.text).toContain(`run ${meta.runId} — running`); // and it says where the run is
  service.runner.stop(meta.runId);
});

test("pi_wait is off the menu the model reads, but the handler still answers", async () => {
  expect(PI_TOOL_SPECS.some((spec) => spec.name === "pi_wait")).toBe(false);
  expect(PI_TOOL_NAMES).not.toContain("pi_wait");
  const { service } = await runHarness();
  expect(service.handlers().has("pi_wait")).toBe(true);
  const answer = await service.handlers().get("pi_wait")!({});
  expect(answer.isError).toBe(true); // it wants a run, and it says so
  expect(answer.text).toContain("`run`");
});

test("a session's runs come back oldest first, and only its own", async () => {
  const { store } = await freshRunner();
  const other = "02b20f00-0000-4000-8000-000000000000";
  const make = (runId: string, startedAt: string, session: string | null): PiRunMeta => ({
    runId,
    kind: "run",
    agentId: null,
    conversationId: null,
    session,
    prompt: `p ${runId}`,
    model: null,
    target: "worker@pi.example.invalid",
    startedAt,
    endedAt: null,
    state: "completed",
    exitCode: 0,
    settled: true,
    eventCount: 1,
    lastEventAt: null,
    bytesCaptured: 0,
    remotePid: null,
    remoteExit: null,
    error: null,
  });
  await store.create(
    make("11111111-1111-4111-8111-111111111111", "2026-10-05T12:03:00.000Z", SESSION),
  );
  await store.create(
    make("22222222-2222-4222-8222-222222222222", "2026-10-05T12:01:00.000Z", SESSION),
  );
  await store.create(
    make("33333333-3333-4333-8333-333333333333", "2026-10-05T12:02:00.000Z", other),
  );
  const mine = await store.listBySession(SESSION);
  expect(mine.map((m) => m.startedAt)).toEqual([
    "2026-10-05T12:01:00.000Z",
    "2026-10-05T12:03:00.000Z",
  ]);
  expect(await store.listBySession("no-such-session")).toEqual([]);
});

test("stopping a run kills the remote pi and records cancelled — later, never rewritten", async () => {
  const { service, spawned, files } = await runHarness();
  const meta = await service.runner.start(await service.load(), files, {
    kind: "run",
    prompt: "runaway",
  });
  const runChild = spawnedChild(spawned, 0);
  runChild.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/w"}\n`);
  runChild.emitErr?.("lettuce-remote-pid 4711\n");
  await Bun.sleep(20);

  const stopping = service.piStop({ run: meta.runId });
  const killChild = await waitForSpawns(spawned, 2); // the kill ssh spawns async
  expect(spawned[1]!.args.join(" ")).toContain("kill 4711");
  expect(spawned[1]!.args.join(" ")).toContain("-o StrictHostKeyChecking=yes");
  killChild.finish(0);
  const res = await stopping;
  expect(res.isError).toBe(false);

  const disk = await service.getRun(meta.runId);
  expect(disk?.state).toBe("cancelled");
  expect(disk?.error).toContain("stopped");
  // The dying ssh's exit path runs late — it must not overwrite the verdict.
  runChild.finish(255);
  await Bun.sleep(20);
  expect((await service.getRun(meta.runId))?.state).toBe("cancelled");
});

test("stop without a recorded pid refuses and offers detach", async () => {
  const { service, spawned, files } = await runHarness();
  const meta = await service.runner.start(await service.load(), files, {
    kind: "run",
    prompt: "old style",
  });
  const res = await service.piStop({ run: meta.runId });
  expect(res.isError).toBe(true);
  expect(res.text).toContain("no recorded remote pid");
  expect(res.text).toContain("detach:true");
  expect(spawned.length).toBe(1); // refused before reaching ssh
  service.runner.stop(meta.runId);
});

test("pi_stop {detach:true} only closes the capture, and says what that really means", async () => {
  const { service, spawned, files } = await runHarness();
  const meta = await service.runner.start(await service.load(), files, {
    kind: "run",
    prompt: "leave it alone",
  });
  const child = spawnedChild(spawned, 0);
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/w"}\n`);
  const res = await service.piStop({ run: meta.runId, detach: true });
  expect(res.isError).toBe(false);
  expect(res.text).toContain("NOT killed");
  expect(res.text).toContain("die writing to the stream");
  expect(spawned.length).toBe(1); // no kill ssh: this is the whole point of detach
  await waitFor("the run to settle", () => spawned[0] !== undefined && meta.state !== "running");
  child.finish(255);
});

test("pi_stop {force:true} still means the default, for older callers", async () => {
  const { service, spawned, files } = await runHarness();
  const meta = await service.runner.start(await service.load(), files, {
    kind: "run",
    prompt: "legacy call",
  });
  const runChild = spawnedChild(spawned, 0);
  runChild.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/w"}\n`);
  runChild.emitErr?.("lettuce-remote-pid 4711\n");
  await Bun.sleep(20);
  const stopping = service.piStop({ run: meta.runId, force: true });
  const killChild = await waitForSpawns(spawned, 2);
  expect(spawned[1]!.args.join(" ")).toContain("kill 4711");
  killChild.finish(0);
  expect((await stopping).isError).toBe(false);
  expect((await service.getRun(meta.runId))?.state).toBe("cancelled");
});

test("a running-but-silent read says quiet, and names the step in flight", async () => {
  const { dir, service, spawned, files } = await runHarness();
  const meta = await service.runner.start(await service.load(), files, {
    kind: "run",
    prompt: "serve it",
  });
  const child = spawnedChild(spawned, 0);
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/w"}\n`);
  child.emit(
    `{"type":"tool_execution_start","toolCallId":"c1","toolName":"Bash","args":{"command":"python3 -m http.server 8000"}}\n`,
  );
  await Bun.sleep(20);
  // Quiet truth is the capture file's mtime; age it instead of sleeping 60s.
  const { utimes } = await import("node:fs/promises");
  const past = new Date(Date.now() - 5 * 60_000 - 1000);
  await utimes(`${dir}/runs/${meta.runId}.jsonl`, past, past);
  const status = await service.piStatus({ run: meta.runId });
  expect(status.text).toContain("quiet 5m");
  expect(status.text).toContain("now: Bash:");
  expect(status.text).toContain("http.server 8000");
  // The line must not read as "probably hung": it states whether the capture is
  // alive, that silence is normal, and not to stop the run for it.
  expect(status.text).toContain("ssh alive");
  expect(status.text).toContain("do not stop it for being quiet");
  // No remote pid was recorded for this run, so the probe says it cannot ask
  // rather than silently claiming the process is there.
  expect(status.text).toContain("no remote pid was recorded");
  child.finish(0);
});

test("a quiet run gets one liveness probe, and the answer is cached", async () => {
  const { dir, service, spawned, files } = await runHarness();
  const meta = await service.runner.start(await service.load(), files, {
    kind: "run",
    prompt: "think it over",
  });
  const child = spawnedChild(spawned, 0);
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/w"}\n`);
  child.emitErr?.("lettuce-remote-pid 4711\n");
  await Bun.sleep(20);
  const { utimes } = await import("node:fs/promises");
  const past = new Date(Date.now() - 5 * 60_000 - 1000);
  await utimes(`${dir}/runs/${meta.runId}.jsonl`, past, past);

  const pending = service.piStatus({ run: meta.runId });
  const probe = await waitForSpawns(spawned, 2); // the run's ssh, then the ps ssh
  expect(spawned[1]!.args.join(" ")).toContain("ps -o stat=,etime=,pcpu= -p 4711");
  probe.emit("S 5:12 9.1\n");
  probe.finish(0);
  const first = await pending;
  expect(first.text).toContain("remote pi pid 4711 is running (S 5:12 9.1)");
  const afterFirst = spawned.length;
  const second = await service.piStatus({ run: meta.runId });
  expect(second.text).toContain("remote pi pid 4711 is running");
  expect(spawned.length).toBe(afterFirst); // the second read came from the cache
  child.finish(0);
});

test("a quiet run with no ssh left says so, and does not claim liveness", async () => {
  // The restart case: the meta still reads `running` because nothing recorded
  // its end, and no child exists to hold the claim "ssh alive" true.
  const { dir, service, files } = await runHarness();
  const runId = "55555555-6666-4777-8888-999999999999";
  await service.store.create({
    runId,
    kind: "run",
    agentId: null,
    conversationId: null,
    session: SESSION,
    prompt: "left running",
    model: null,
    target: "worker@pi.example.invalid",
    startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    endedAt: null,
    state: "running",
    exitCode: null,
    settled: false,
    eventCount: 3,
    lastEventAt: null,
    bytesCaptured: 10,
    remotePid: null,
    remoteExit: null,
    error: null,
  });
  const { utimes } = await import("node:fs/promises");
  const past = new Date(Date.now() - 5 * 60_000);
  await utimes(`${dir}/runs/${runId}.jsonl`, past, past);
  void files;
  const status = await service.piStatus({ run: runId });
  expect(status.text).toContain("no longer holds the ssh");
  expect(status.text).not.toContain("ssh alive;");
});

test("the liveness probe tells gone from unreachable", async () => {
  // `ps` exits 1 for no such process; ssh exits 255 when the worker is not
  // reachable at all. Saying "the run died" in the second case would be a guess.
  for (const [code, expectText] of [
    [1, "pid 4711 is gone"],
    [255, "did not answer the probe"],
  ] as const) {
    const { dir, service, spawned, files } = await runHarness();
    const meta = await service.runner.start(await service.load(), files, {
      kind: "run",
      prompt: "probe me",
    });
    const child = spawnedChild(spawned, 0);
    child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/w"}\n`);
    child.emitErr?.("lettuce-remote-pid 4711\n");
    await Bun.sleep(20);
    const { utimes } = await import("node:fs/promises");
    const past = new Date(Date.now() - 5 * 60_000 - 1000);
    await utimes(`${dir}/runs/${meta.runId}.jsonl`, past, past);
    const pending = service.piStatus({ run: meta.runId });
    const probe = await waitForSpawns(spawned, 2);
    probe.finish(code);
    const res = await pending;
    expect(res.text).toContain(expectText);
    child.finish(0);
  }
});

test("a send onto a session with a live run is announced as queueing", async () => {
  const { service, spawned, files } = await runHarness();
  const meta = await service.runner.start(await service.load(), files, {
    kind: "run",
    prompt: "first",
  });
  spawnedChild(spawned, 0).emit(
    `{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/w"}\n`,
  );
  await Bun.sleep(10);
  const res = await service.piSend({ session: SESSION, prompt: "second" }, { agentId: null });
  expect(res.isError).toBe(false);
  expect(res.text).toContain(`run ${meta.runId} is still live on this session`);
  expect(res.text).toContain("queues behind it");
  spawnedChild(spawned, 0).kill(); // the first run (detach via kill closes its capture)
  spawnedChild(spawned, 1).kill(); // the queued send
});

test("statusFacts gives the card state, progress, the step in flight, and the verdict", async () => {
  // 100 ms is enough to outlast any fixed sleep a future edit could guess with,
  // and small enough to leave the run well inside Bun's 5 s per-test timeout.
  const { service, spawned, settled, progress, files } = await runHarness({ slowStoreMs: 100 });
  const meta = await service.runner.start(await service.load(), files, {
    kind: "run",
    prompt: "card me",
  });
  const child = spawnedChild(spawned, 0);
  child.emit(`{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/w"}\n`);
  child.emit(
    `{"type":"tool_execution_start","toolCallId":"c1","toolName":"Bash","args":{"command":"ls -la"}}\n`,
  );
  // The throttle is <=2 s: the next line after the window flushes the counters.
  await Bun.sleep(2_100);
  child.emit(`{"type":"message_start","message":{"role":"assistant"}}\n`);
  // The runner's progress frame fires only after the flush it summarises has
  // resolved (runner.ts flushMeta), so this waits for the durable write itself
  // — no sleep, and no second read of the record to look for it.
  await waitFor("the flush the third line owes", () =>
    progress.some((m) => m.eventCount >= 3 && m.state === "running"),
  );
  const live = await service.statusFacts(meta.runId);
  expect(live?.state).toBe("running");
  expect(Number(live?.eventCount)).toBeGreaterThanOrEqual(3);
  expect(Number(live?.bytesCaptured)).toBeGreaterThan(0);
  expect(live?.nowTool).toBe("Bash");
  expect(String(live?.nowInput)).toContain("ls -la");
  expect(Number(live?.quietSeconds)).toBeLessThan(60);

  child.emit(
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"all done"}]}}\n`,
  );
  child.emit(`{"type":"agent_settled"}\n`);
  child.finish(0);
  // The exit path records the verdict, then settles.
  await waitFor("the run to settle", () => settled.length === 1);
  const done = await service.statusFacts(meta.runId);
  expect(done?.state).toBe("completed");
  expect(done?.lastSaid).toContain("all done");
});

test("retention sweep keeps the newest N and forgets what is past the age floor", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pi-sweep-`);
  const store = new DirPiRunStore(dir);
  const now = Date.now();
  const id = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const make = async (n: number, ageDays: number) => {
    const meta = {
      runId: id(n),
      kind: "run",
      agentId: null,
      conversationId: null,
      session: null,
      target: "worker@h",
      prompt: `run ${n}`,
      model: null,
      startedAt: new Date(now - ageDays * 86_400_000).toISOString(),
      endedAt: null,
      state: "running",
      exitCode: null,
      error: null,
      settled: false,
      eventCount: 0,
      lastEventAt: null,
      bytesCaptured: 0,
      remotePid: null,
      remoteExit: null,
    } as unknown as PiRunMeta;
    await store.create(meta);
    await store.appendEvent(meta, "{}");
  };
  for (let i = 1; i <= 6; i++) await make(i, i); // ages 1..6 days
  expect(await store.sweep(4, 14 * 86_400_000, now)).toBe(2); // keep 4 newest
  expect((await store.list(99)).map((m) => m.runId)).toEqual([id(1), id(2), id(3), id(4)]);
  expect(await store.read(id(5))).toBeNull();
  // Age floor bites even inside the keep window.
  expect(await store.sweep(4, 3 * 86_400_000, now)).toBe(1); // id(4) is 4 days old
  expect((await store.list(99)).map((m) => m.runId)).toEqual([id(1), id(2), id(3)]);
});

// ── C1: pi_fetch / pi_ls ─────────────────────────────────────────────────────

test("the fetch/ls remote guards confine the path and mark every refusal", () => {
  const fetchCmd = buildPiFetchRemoteCommand(BASE, "shots/../shot.png");
  expect(fetchCmd).toContain("'shots/../shot.png'"); // quoted whole
  expect(fetchCmd).toContain("realpath -e"); // resolved remotely before matching
  expect(fetchCmd).toContain("base64"); // bytes survive the text capture
  expect(fetchCmd).toContain("lettuce-fetch: outside");
  expect(fetchCmd).toContain("lettuce-fetch: too_big");
  const lsCmd = buildPiLsRemoteCommand(BASE, "notes");
  expect(lsCmd).toContain("'notes'");
  expect(lsCmd).toContain("lettuce-ls: outside");
});

test("pi_fetch lands the bytes under the run and answers with the link", async () => {
  const { service, spawned, files } = await runHarness();
  const meta = await service.runner.start(await service.load(), files, {
    kind: "run",
    prompt: "screenshot it",
  });
  const pending = service.piFetch({ run: meta.runId, path: "shots/shot.png" });
  const fetchChild = await waitForSpawns(spawned, 2); // artifact ssh follows the async settings read
  fetchChild.emit("lettuce-fetch: size 6\n");
  fetchChild.emit("SGVsbG8h\n");
  fetchChild.finish(0);
  const res = await pending;
  expect(res.isError).toBe(false);
  expect(res.text).toContain(`/api/pi/runs/${meta.runId}/files/shot.png`);
  expect((await service.store.readFile(meta.runId, "shot.png"))?.toString()).toBe("Hello!");
  expect(await service.store.listFiles(meta.runId)).toEqual([{ name: "shot.png", size: 6 }]);

  // Refusals carry the reason, not the file.
  const denied = service.piFetch({ run: meta.runId, path: "/etc/shadow" });
  const denyChild = await waitForSpawns(spawned, 3);
  denyChild.emit("lettuce-fetch: outside\n");
  denyChild.finish(0);
  const res2 = await denied;
  expect(res2.isError).toBe(true);
  expect(res2.text).toContain("confined");
});

test("artifact names cannot be paths, and sweeps take the files with the run", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pi-files-`);
  const store = new DirPiRunStore(dir);
  const runId = "11111111-2222-4333-8444-555555555555";
  expect(DirPiRunStore.safeFileName("../../evil name.png")).toBe("evil_name.png");
  const saved = await store.saveFile(
    runId,
    "../oops/totally.broken.png",
    new TextEncoder().encode("x"),
  );
  expect(saved).toBe("totally.broken.png");
  expect(await store.readFile(runId, "../../etc/passwd")).toBeNull();
  expect(await store.readFile(runId, saved)).not.toBeNull();
  // A run record so the sweep can find it — then sweep it and the files go too.
  const meta = {
    runId,
    kind: "run",
    agentId: null,
    conversationId: null,
    session: null,
    target: "worker@h",
    prompt: "f",
    model: null,
    startedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    endedAt: null,
    state: "completed",
    exitCode: 0,
    error: null,
    settled: true,
    eventCount: 0,
    lastEventAt: null,
    bytesCaptured: 0,
    remotePid: null,
    remoteExit: null,
  } as unknown as PiRunMeta;
  await store.create(meta);
  expect(await store.sweep(10, 14 * 86_400_000, Date.now())).toBe(1);
  expect(await store.listFiles(runId)).toEqual([]);
});

test("a session lookup rides the index in-process and the disk after a restart", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pi-session-`);
  const store = new DirPiRunStore(dir);
  // Count the fallback scans: the index must answer without one.
  let scans = 0;
  const scanAll = store.list.bind(store);
  store.list = async (limit: number) => {
    scans += 1;
    return scanAll(limit);
  };
  const runId = "33333333-4444-4555-9666-777777777777";
  const session = "44444444-5555-4666-8777-888888888888";
  const meta = {
    runId,
    kind: "run",
    agentId: null,
    conversationId: null,
    session: null,
    target: "worker@h",
    prompt: "p",
    model: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    state: "running",
    exitCode: null,
    error: null,
    settled: false,
    eventCount: 0,
    lastEventAt: null,
    bytesCaptured: 0,
    remotePid: null,
    remoteExit: null,
  } as unknown as PiRunMeta;
  await store.create(meta);
  // The session arrives with the stream, after the run file exists.
  await store.update({ ...meta, session });
  expect((await store.findBySession(session))?.runId).toBe(runId);
  expect(scans).toBe(0);
  // A run nobody here wrote is still findable: the scan is the fallback.
  const reopened = new DirPiRunStore(dir);
  let coldScans = 0;
  const coldScanAll = reopened.list.bind(reopened);
  reopened.list = async (limit: number) => {
    coldScans += 1;
    return coldScanAll(limit);
  };
  expect((await reopened.findBySession(session))?.runId).toBe(runId);
  expect(coldScans).toBeGreaterThan(0);
  expect(await store.findBySession("55555555-6666-4777-8888-999999999999")).toBeNull();
});

// ── operational feedback (prod lessons from the olla agent's runs) ──────────

const BIG_LINES = {
  filler: "x".repeat(8_000),
};

test("pi_result digs a buried final answer out; pi_log formats the stream tail", async () => {
  const { service, spawned, settled } = await runHarness();
  const started = service.piRun({ prompt: "big answer" });
  (await waitForSpawns(spawned, 1)).emit(
    `{"type":"session","version":3,"id":"${SESSION}","timestamp":"t","cwd":"/w"}\n`,
  );
  const answer = await started;
  expect(answer.isError).toBe(false);
  const child = spawnedChild(spawned, 0);
  child.emit(
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"${BIG_LINES.filler} buried here"}],"timestamp":1}}\n`,
  );
  child.emit('{"type":"tool_execution_start","toolName":"bash","args":{"command":"ls"}}\n');
  child.emit(
    '{"type":"tool_execution_end","toolName":"bash","isError":false,"result":{"content":[{"text":"a.txt"}]}}\n',
  );
  child.emit(
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"FINAL: a.txt exists"}],"timestamp":2}}\n',
  );
  child.emit('{"type":"agent_settled"}\n');
  child.finish(0);
  await Bun.sleep(100);
  const runId = answer.text.match(/run ([0-9a-f-]{36})/)?.[1] ?? "";
  // The buried answer: the pre-fix 4 KB tail window would have missed it.
  const result = await service.piResult({ run: runId });
  expect(result.isError).toBe(false);
  expect(result.text).toContain("FINAL: a.txt exists");
  const full = await service.piResult({ run: runId, transcript: true });
  expect(full.text).toContain("$ bash");
  expect(full.text).toContain("a.txt");
  const log = await service.piLog({ run: runId });
  expect(log.text).toContain("→ bash");
  expect(log.text).toContain('{"command":"ls"}');
  expect(log.text).toContain("assistant: FINAL: a.txt exists");
  expect(settled.length).toBe(1);
});

test("pi_exec runs a raw command on the worker and reports the exit honestly", async () => {
  const { service, spawned } = await runHarness();
  const pending = service.piExec({ command: "git log --oneline -1" });
  for (let i = 0; i < 40 && spawned.length === 0; i++) await Bun.sleep(25);
  const child = spawnedChild(spawned, 0);
  expect(String(spawned[0]?.args.at(-1))).toContain("git log --oneline -1");
  child.emit("abc123 the only commit\n");
  child.finish(0);
  const answer = await pending;
  expect(answer.isError).toBe(false);
  expect(answer.text).toContain("exit 0");
  expect(answer.text).toContain("abc123 the only commit");
});

test("pi_fetch save carries base64 for the mod; the settle manifest lists touched files", async () => {
  const dir = await mkdtemp(`${tmpdir()}/pi-ops-`);
  const spawner = (args: readonly string[], onStdout: (chunk: string) => void): PiProcess => {
    const child = new FakeChild();
    const remote = String(args.at(-1));
    queueMicrotask(() => {
      if (remote.includes("lettuce-fetch")) onStdout("lettuce-fetch: size 3\nYWJj\n");
      else if (remote.includes("find")) onStdout("plan.md 2048\nnotes/x.md 512\n");
      child.finish(0);
    });
    return child;
  };
  const service = new PiService({ paths: { dir }, featureEnabled: () => true, spawner });
  await service.save({
    enabled: true,
    host: "pi.example.invalid",
    user: "worker",
    port: 22,
    workdir: "/home/worker/pi",
    privateKey: VALID_KEY,
  });
  await writeFile(`${dir}/known_hosts`, "pi.example.invalid ssh-ed25519 AAAAone\n", "utf8");
  const meta = {
    runId: "99999999-2222-3333-4444-555555555555",
    kind: "run",
    agentId: "a1",
    conversationId: "c1",
    session: SESSION,
    prompt: "write a plan",
    model: null,
    target: "worker@pi.example.invalid:22",
    startedAt: "2026-10-06T10:00:00.000Z",
    endedAt: "2026-10-06T10:20:00.000Z",
    state: "completed",
    exitCode: 0,
    settled: true,
    eventCount: 2,
    lastEventAt: "2026-10-06T10:20:00.000Z",
    bytesCaptured: 100,
    remotePid: null,
    remoteExit: null,
    error: null,
  } as unknown as PiRunMeta;
  await service.store.create(meta);
  const fetched = (await service.piFetch({
    run: meta.runId,
    path: "plan.md",
    save: "docs/../plan.md",
  })) as { text: string; isError: boolean; content_b64?: string; save_path?: string };
  expect(fetched.isError).toBe(false);
  expect(fetched.content_b64).toBe("YWJj");
  expect(fetched.save_path).toBe(`pi/${meta.runId.slice(0, 8)}/docs/plan.md`);
  expect(fetched.save_path).not.toContain("..");
  const report = await service.settleReport(meta);
  expect(report).toContain("plan.md (2 KB)");
  expect(report).toContain("notes/x.md (1 KB)");
  expect(report).toContain("pi_fetch");
});

test("the event budget ships armed: absent in old settings means 200k, 0 stays off", async () => {
  const { service } = await runHarness(); // save() writes without any budget field
  const stored = await service.load();
  expect(stored.maxEvents).toBe(200_000); // the net that catches an 8.2 M-event run
  expect(stored.maxRuntimeMinutes).toBe(0); // runtime stays opt-in: quiet long runs survive
  await service.save({ host: "pi.example.invalid", maxEvents: 0 });
  expect((await service.load()).maxEvents).toBe(0); // an explicit 0 is still "off"
});

test("the run budget cancels a runaway: by events, and by wall clock", async () => {
  const { runner, children } = await freshRunner();
  const meta = await runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "runaway", maxEvents: 3 },
  );
  const child = only(children);
  child.emit(`{"type":"session","id":"${SESSION}"}\n`);
  for (let i = 0; i < 6; i++) child.emit(`{"type":"thinking","n":${i}}\n`);
  await Bun.sleep(30);
  expect(meta.state).toBe("cancelled");
  expect(meta.error).toContain("budget exceeded (3 events)");

  // Runtime budget: the clock is fake-past by more than the one-minute cap,
  // so the deadline has already passed the moment the run starts.
  const late = await freshRunner();
  late.setNow(new Date(Date.now() - 61_000));
  const timed = await late.runner.start(
    BASE,
    { keyFile: "/k", knownHostsFile: "/kh" },
    { kind: "run", prompt: "slowpoke", maxRuntimeMinutes: 1 },
  );
  await Bun.sleep(50);
  expect(timed.state).toBe("cancelled");
  expect(timed.error).toContain("budget exceeded (1 min runtime)");
});
