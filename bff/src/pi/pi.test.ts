import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  expect(cmd).toContain("cd '/home/worker/pi' && env PATH='/opt/node/bin:/opt/pi/bin:$PATH'");
  expect(cmd).toContain("pi --mode json");
  expect(cmd).toContain(`'review '\\''my'\\'' code'`);
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
  // VALID_KEY is not a real PEM: ssh-keygen -y fails and we report no public
  // key rather than keeping the generated one as a lie.
  const pasted = await service.save({ privateKey: VALID_KEY });
  expect(pasted.privateKey).toBe(`${VALID_KEY.trimEnd()}\n`);
  expect(pasted.publicKey).toBe(null);
});
