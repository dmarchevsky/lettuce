/**
 * The render claims behind `waiting-model`: a confirmed model call under long
 * silence shows the neutral waiting face — dots, no warning triangle, no Stop —
 * and its timer counts the silence, not the whole turn. Claims about what this
 * component renders, so they live in a real DOM, not in a source read.
 */
import { expect, test } from "bun:test";
import { mount } from "../test/harness.tsx";
import { WorkingLine } from "./WorkingLine.tsx";

const TURN = Date.now() - 400_000; // the turn has been running a long time
const SILENCE = Date.now() - 90_000; // ... and silent for a minute and a half

function line(modelCallActive: boolean) {
  return mount(
    <WorkingLine
      entries={[]}
      queue={[]}
      cwd="/work/a"
      stopping={false}
      turnStartedAt={TURN}
      lastActivityAt={SILENCE}
      compactStartedAt={null}
      usage={null}
      modelCallActive={modelCallActive}
      liveSubagents={{}}
      onAbort={() => {}}
    />,
  );
}

test("a confirmed model call renders the neutral waiting face", async () => {
  const h = await line(true);
  const root = h.find(".working-line");
  expect(root?.className).toContain("state-waiting-model");
  expect(root?.className).not.toContain("warn");
  expect(h.text(".working-line")).toContain("Waiting for model");
  // Dots, not the warning triangle; no Stop button on this face.
  expect(root?.querySelector(".working-dots")).not.toBeNull();
  expect(root?.querySelector(".wl-glyph")).toBeNull();
  expect(root?.querySelector(".wl-stop")).toBeNull();
  // The timer counts the silence (~1:30), not the 6:40 turn.
  expect(h.text(".working-line")).toContain("1:3");
});

test("without the witness the amber stall still renders as before", async () => {
  const h = await line(false);
  const root = h.find(".working-line");
  expect(root?.className).toContain("state-stall");
  expect(root?.className).toContain("warn");
  expect(h.text(".working-line")).toContain("No activity");
  expect(root?.querySelector(".wl-stop")).not.toBeNull();
});
