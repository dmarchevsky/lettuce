---
name: lettuce-ui-verification
description: 'lettuce UI-change gates: before implementing any web/ change, mock the target state at phone (390px) and desktop (1280px) into the flow plan and get the mockups approved; after implementing, a holistic visual pass over screenshots and the live page — task accomplishment, consistency with sibling screens, broken layout, overflows, stray scrollbars — never pixel diffs. Mechanics: a static mock page linking web/src/styles.css for fidelity, rendered to plan/mockups/ PNGs with headless chromium and embedded in plan.md, plus Playwright screenshots and ui-check output in .ui-check/. Also when a screenshot is itself the deliverable (a README image, a mockup crop): review the element at the size it really renders. Read before implementing any web/ UI change, before handing a UI change off for the container test, before regenerating a README screenshot, or when a review asks "does this fit the app".'
---

# UI change gates: mockups before, visual pass after

Two gates bracket every `web/` UI change. Both are eyes-on: no pixel-diff tool, no new CI job —
`ui-check` already owns the measurable layout assertions. The gates exist because a transcript-only
review cannot see that a row wraps, a timer wobbles, or a control reads wrong at 390px.

## Gate 1 — target state approved before implementing

When the change is more than a trivial fix, before writing UI code, in the **plan** stage — dev-flow's UI
feature gate requires rendered mockups in the plan directory and refuses a plan without them
(`mockupGlobs`, default `*.png`):

1. **Never invent a mock's shell markup — capture the live surface first.** `captureSurface` (exported
   from `scripts/harness.ts`) lifts the real DOM subtree for a selector into a self-contained shell
   document — live `outerHTML`, the `html`/`body` classes, and a link to the app's own stylesheet — so
   write it to `plan/mockups/shell.html` and author the mock *from that*: open the pane (`openPane`),
   `captureSurface(page, "<pane root>", { outPath: "plan/mockups/shell.html" })` at the viewport you
   will render at, and start there. A selector matching nothing throws loudly on purpose: a hand-invented
   "Memory pane" burned ~40 calls and a wrong pane, twice, because its markup was imagined. If you cannot
   name the selector, inspect the live page — do not guess one.
2. Write one static mock per screen/state at `.dev-flow/<slug>/plan/mockups/<screen>.html` that **links
   the real stylesheet** — from `plan/mockups/` that is `../../../../web/src/styles.css` — and
   reuses the app's own class names and tokens. Fidelity is then by construction, not by effort —
   colours, type scale, borders, square corners all real.
3. Render each one at **both widths — phone 390 and desktop 1280** with one command, one section per
   variant/state, and **embed every PNG in plan.md** so the plan is one reviewable document. A mock that was
   never rendered is not a mockup:

   ```bash
   bun scripts/mockup.ts <screen>.html --width 1280 --height 900 --out <screen>-desktop.png
   ```

   **Do not hand-roll the chromium call.** `mockup.ts` passes the flags that cannot be guessed and lies when
   wrong: `chrome-headless-shell` reports `pointer: none` / `hover: none` unless `--blink-settings=primary…`
   says otherwise, so every rule gated on `(pointer: fine)` or `(hover: hover)` silently does not apply even
   at desktop width — the desktop composer font and the hover-revealed row actions among them, and the
   `(pointer: coarse)` phone blocks stay off too. The `min-width: 900px` layout still applies, so the shot
   looks plausible while quietly missing the fine/hover-gated styling — which reads as "the CSS is missing"
   and costs a debugging loop chasing CSS that is fine. (The plausible-looking `--primaryPointerType=4` form
   is ignored by the shell; the script's form is the one that works, verified against a `matchMedia` probe.)

   **It refuses to render a mock whose stylesheet `<link>` does not resolve**, and prints the resolved path
   when it does — a white page used to mean no stylesheet, silently, and a bisect conclusion drawn from a
   dead-link render is bogus. Keep mock/repro HTML under
   `plan/mockups/` where that relative depth is known — never `.dev-flow/<slug>/tmp/`, whose extra level makes
   the `../` point at nothing.

4. **A surface the app hides at that width renders blank until you un-hide it, and the direction is per
   surface.** `.rail` / `nav.rail` is `display: none` below 900px, so a 390 mock of the rail needs an explicit
   `display` override; `.where-avatar` (the 44px phone header face) is the mirror image — shown by default and
   `display: none` from 900px, so it is the **1280** mock of the header that needs the override. Guess the
   direction and you add a no-op rule to the wrong shot. Size tokens come from the stylesheet's own `:root`, so
   a mock that links it gets `--rail-w` / `--rail-row` for free — if a row collapses, check the link resolved
   (step 3) before hand-declaring tokens. Two authoring gotchas that produce a quietly empty render: a mock's
   element ids must match `getElementById` exactly (hyphens vs underscores leave a section blank), and a
   headless DOM dump never shows a top-level `const` in a classic script, so element-id globals are not
   created for script-scoped consts.

5. Name a recommendation and **stop for Approve?** — the gate question is the mockup approval, and the
   approved mock is the spec.

Skip mockups only for changes a screenshot of the fix would explain better than a mock (one-line
label, colour token); say so in the PR. `--ui` is what makes the gate demand them: `flow start <slug>
--ui`.

**A mockup approves STRUCTURE, never SCALE.** What the operator signs off is what is on screen and where
it sits; the pixel dimensions an unbuilt mock implies are provisional. A redesign that ran twenty approved
mockups at one rail width then spent four implement rounds resizing that same rail burned a mockup + build
+ deploy cycle per round. So for a redesign: the plan marks its size tokens (`--rail-w`, row heights,
icon sizes) provisional and its first build carries **geometry only** — layout and sizes, no skin — then
the scale is decided once in front of the real app, and the mockups are re-rendered from the **live DOM**
(inspect the rendered box, paste it into the mock) after each scale change so the approved artifact keeps
matching what ships.

## Gate 2 — holistic visual pass after implementing

After the implementation runs in the container (or the local stack), before handing to the operator's
own test — and repeat on the merged artifact if the bundle changed:

1. Capture every changed surface at both widths: `bun run ui-check` (screenshots land in
   `.ui-check/`), or Playwright against the live stack when the state needs real data — drive a
   real turn or state, then screenshot. A quick live sampler (poll a DOM node's text every ~250 ms
   through a scripted turn) is how the working line was actually verified, transient states included.
   To prove one surface without paying the whole suite (~2 min/run), run one section:
   `bun scripts/ui-check.ts --list` names them, `--section <name>` runs one. For a single README
   image, `bun scripts/screenshots.ts --shot <name>` renders just that one.
2. Review the screenshots holistically — the checklist is the gate:
   - can a user accomplish the task from what is on screen, no hidden affordances;
   - does the surface read like its neighbours — same type scale, spacing rhythm, icon language,
     control heights (`--control-h`), square theme;
   - nothing broken: clipped text, overlapping rows, text colliding with icons;
   - no horizontal overflow at 390px; long strings truncate mid-string where the tail matters;
   - no unnecessary scrollbars (a one-line textarea with a scrollbar is the classic);
   - transient states exist in both directions (loading/empty/error), and numbers don't jitter.
3. Pixel accuracy is **not** the goal — placement inside a few pixels of a mock is fine; a control
   that reads wrong, or a state no one tested, is not.
4. Record what was looked at in the PR's container-test section: surfaces, widths, states.

**When a screenshot is itself the deliverable** (a README image, a mockup), also review each element at
the size it actually renders, not only in the full-page PNG: a fixture avatar glyph that must read inside
a 28px disc (~13px of glyph) is invisible at 1280x800, and a full-page-only pass ships it. The crop must
come from the generator itself (no PIL or ImageMagick on this machine): capture the element — or a clip at
`deviceScaleFactor` 2–3 — alongside the full page, and look at both before committing. An operator caught
what the full-page pass missed and it cost a full regenerate-and-commit round.

Fix what the pass finds before the PR; a visual-pass finding that changes scope goes back to gate 1.

## Every operator round re-proves, and re-sweeps

A redesign-style flow earns one of these per round the operator answers, not one per feature:

- **Keep the proof-shim where the flow can see it.** The static layout replica and its probe scripts
  live under `plan/` (e.g. `plan/proof/`), never `/tmp` — a replica that proved three real defects
  was gone by the next day and cost a turn each time it had to be rebuilt. **Re-run it every round**:
  geometry that passed at R7 is not proven at R11, and "nothing UI changed this round" is exactly
  what the stale comment will contradict.
- **Do a claim-level sweep of everything that describes the surface you just changed** — code
  comments, the `description:` frontmatter, and the skill docs (`lettuce-ui-conventions` et al).
  Grep the *claims* ("docked at the foot", "names-only", "five equal slots"), not the phrase: the
  same-class cousin that rewords the same geometry is missed by a phrase grep and read as truth by
  the next flow. In one redesign flow 6 of 8 verify passes failed on stale-geometry comments that
  survived a phrase grep this way.

## Why this lives outside CI

Tier A has no stack and no data; Tier B cannot yet seed an agent, so it proves boot, not screens.
Layout invariants worth asserting forever do belong in `ui-check` as measured assertions — the visual
pass is for everything that needs judgment, which is most of design.
