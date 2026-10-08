/**
 * Visual and layout assertions against a running stack.
 *
 * Unit tests cannot see a clipped tab bar or a sheet that opens off-screen, and
 * eyeballing ad-hoc screenshots is worse than nothing: a first pass with old
 * headless Chrome's `--window-size` appeared to show a broken 390px layout,
 * which turned out to be the tool not setting a layout viewport at all. Real
 * viewports plus measured assertions is the difference between checking the app
 * and checking the screenshot harness.
 *
 * Auth is one navigation: /auth/dev-login sets the dev-bypass cookie and
 * redirects to /, so no profile or cookie juggling is needed.
 *
 * Usage: bun run ui-check [bffOrigin]
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

const ORIGIN = process.argv[2] ?? "http://127.0.0.1:8090";
const OUT_DIR = new URL("../.ui-check/", import.meta.url).pathname;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1200, height: 900 };

let failures = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/**
 * Playwright pins a Chromium build that may not be the one cached on this
 * machine, and downloading ~150MB to assert on CSS is not a good trade. Reuse
 * whatever chromium-* build is already present; fall back to Playwright's own
 * resolution when none is.
 */
function chromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache)
    .filter((name) => name.startsWith("chromium-"))
    .sort()
    .reverse();
  for (const build of builds) {
    const candidate = join(cache, build, "chrome-linux64", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Load the app authenticated and settled. */
async function open(browser: Browser, viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  await page.goto(`${ORIGIN}/auth/dev-login`, { waitUntil: "networkidle" });
  return page;
}

/**
 * The BFF's profile-gated features, read through the page's own session.
 * Settings sections hide per token (web/google/codex/claude/pi), so any
 * section-list assertion must derive what it expects instead of hardcoding —
 * which stack is up varies between CI and a developer's docker/.env.
 */
async function readFeatures(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(async () => {
    const response = await fetch("/api/status");
    if (!response.ok) return {};
    const body = (await response.json()) as { features?: Record<string, boolean> };
    // An absent flag means everything is on — the same rule the UI applies.
    return body.features ?? {};
  });
}

function featureOn(features: Record<string, boolean>, name: string): boolean {
  return features[name] !== false;
}

/**
 * Elements the user can never reach, because they extend past the viewport and
 * nothing between them and the root scrolls.
 *
 * Comparing `documentElement.scrollWidth` to `clientWidth` does NOT work here:
 * `.app` is `overflow: hidden`, so anything too wide is silently clipped rather
 * than extending the scroll area — the page reports a clean 390/390 while a tab
 * bar is cut in half. Only `auto`/`scroll` rescue an overflowing element;
 * `hidden` is precisely the bug being looked for.
 */
async function overflow(page: Page): Promise<{ clientWidth: number; clipped: string[] }> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const limit = root.clientWidth;
    const clipped: string[] = [];

    for (const el of Array.from(document.querySelectorAll("*"))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right <= limit + 1) continue;

      let scrollable = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const overflowX = getComputedStyle(p).overflowX;
        if (overflowX === "auto" || overflowX === "scroll") {
          scrollable = true;
          break;
        }
      }
      if (scrollable) continue;

      const cls = (el.className || "").toString().trim().split(/\s+/)[0] ?? "";
      clipped.push(
        `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""} right=${Math.round(rect.right)}`,
      );
    }
    // Ancestors of a clipped node are usually clipped too; the first few are enough.
    return { clientWidth: limit, clipped: clipped.slice(0, 5) };
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT_DIR, `${name}.png`) });
}

mkdirSync(OUT_DIR, { recursive: true });

const executablePath = chromiumExecutable();
console.log(`chromium: ${executablePath ?? "(playwright default)"}`);
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  // Required inside containers and unprivileged environments.
  args: ["--no-sandbox"],
});

try {
  // ── Phone ────────────────────────────────────────────────────────────────
  section(`Phone (${PHONE.width}px)`);
  {
    const page = await open(browser, PHONE);
    await shot(page, "phone-chat");

    const box = await overflow(page);
    check("nothing is clipped off-screen", box.clipped.length === 0, box);

    check("all six tabs are reachable", (await page.locator("nav.tabs button").count()) === 6);
    check(
      "the top bar names the agent",
      (await page.locator(".topbar .where-agent").innerText()).trim() !== "",
    );
    check("no drawer on a phone", !(await page.locator(".sidebar").isVisible()));

    // The switcher: agents and conversations in one full-screen menu, opened
    // from the composer. Each list starts with its own "new" card, in one
    // shared style, and the agents sit at the bottom, in thumb reach.
    const switcherButton = page.locator(
      '.composer-row button[aria-label="Agents and conversations"]',
    );
    check("composer has the switcher button", await switcherButton.isVisible());
    await switcherButton.click();
    const switcher = page.locator(".switcher");
    check("switcher opens", await switcher.isVisible());
    const news = switcher.locator(".switcher-new");
    const newLabels = await news.allInnerTexts();
    check(
      "New conversation and New agent are both there",
      newLabels.some((t) => t.startsWith("New conversation")) &&
        newLabels.some((t) => t === "New agent"),
      newLabels,
    );
    const newStyles = await news.evaluateAll((els) =>
      els.map((el) => {
        const cs = getComputedStyle(el);
        return [cs.borderStyle, cs.borderColor, cs.color, cs.fontWeight, cs.height].join("|");
      }),
    );
    check('both "new" cards share one style', new Set(newStyles).size === 1, newStyles);
    const agentsBox = await switcher.locator(".switcher-agents").boundingBox();
    check(
      "agents sit at the bottom",
      agentsBox !== null && Math.abs(agentsBox.y + agentsBox.height - PHONE.height) < 2,
      agentsBox,
    );
    const switcherBox = await overflow(page);
    check("switcher has nothing clipped", switcherBox.clipped.length === 0, switcherBox);
    await shot(page, "phone-switcher");
    await switcher.locator(".switcher-bar .sheet-close").click();
    check("back closes the switcher", (await page.locator(".switcher").count()) === 0);

    // The phone's Back button closes the top modal, never the app.
    const url = page.url();
    const pressBack = async () => {
      await page.evaluate(() => history.back());
      await page.waitForTimeout(400);
    };
    const onOverlayEntry = () =>
      page.evaluate(
        () => (history.state as { lettaOverlay?: boolean } | null)?.lettaOverlay === true,
      );
    check("closing on screen leaves no stale Back entry", !(await onOverlayEntry()));

    await switcherButton.click();
    await pressBack();
    check(
      "Back closes the switcher and stays in the app",
      (await page.locator(".switcher").count()) === 0 &&
        page.url() === url &&
        (await page.locator(".composer textarea").isVisible()),
    );

    await switcherButton.click();
    const more = page.locator(".switcher-list .switcher-more").first();
    if ((await more.count()) > 0) {
      await more.click();
      await pressBack();
      check(
        "Back closes the ⋯ menu first, keeping the switcher",
        (await page.locator(".switcher-menu").count()) === 0 &&
          (await page.locator(".switcher").count()) === 1,
      );
    }
    await pressBack();
    check("then Back closes the switcher", (await page.locator(".switcher").count()) === 0);

    // An agent's ⋯ is a menu — Edit, Pin, Delete — opening above the button,
    // fully on screen even though the agents sit in their own scrolling box.
    await switcherButton.click();
    const agentCard = (name: string) =>
      page.locator(".switcher-agents .switcher-card.agent", {
        has: page.locator(".switcher-card-title", { hasText: name }),
      });
    const firstName = (
      await page.locator(".switcher-agents .switcher-card-title").first().innerText()
    ).trim();
    const openAgentMenu = async () => {
      await agentCard(firstName).locator(".switcher-more").click();
      return page.locator(".switcher-menu.floating");
    };
    let agentMenu = await openAgentMenu();
    const menuItems = (await agentMenu.locator("button").allInnerTexts()).map((t) => t.trim());
    const wasPinned = menuItems[1] === "Unpin";
    check(
      "agent ⋯ offers Edit, Pin, Archive and Delete",
      JSON.stringify(menuItems) ===
        JSON.stringify(["Edit", wasPinned ? "Unpin" : "Pin to top", "Archive", "Delete…"]),
      menuItems,
    );
    const agentMenuWidth = (await agentMenu.boundingBox())?.width ?? 0;
    check(
      "the agent menu is sized to its items (150-260px)",
      agentMenuWidth >= 150 && agentMenuWidth <= 260,
      { agentMenuWidth },
    );
    const menuBox = await agentMenu.boundingBox();
    check(
      "the agent menu is fully on screen",
      menuBox !== null &&
        menuBox.x >= 0 &&
        menuBox.y >= 0 &&
        menuBox.x + menuBox.width <= PHONE.width &&
        menuBox.y + menuBox.height <= PHONE.height,
      menuBox,
    );
    await shot(page, "phone-agent-menu");
    await pressBack();
    check(
      "Back closes the agent menu first, keeping the switcher",
      (await page.locator(".switcher-menu.floating").count()) === 0 &&
        (await page.locator(".switcher").count()) === 1,
    );

    // Pin, then put it back: the check leaves the pin state as it found it.
    const pinnedMark = () => agentCard(firstName).locator(".switcher-pin").count();
    agentMenu = await openAgentMenu();
    await agentMenu.locator("button").nth(1).click();
    await page.waitForTimeout(600);
    check("pinning toggles the agent's pin mark", (await pinnedMark()) === (wasPinned ? 0 : 1));
    if (!wasPinned) {
      check(
        "a pinned agent is listed first",
        (await page.locator(".switcher-agents .switcher-card-title").first().innerText()).trim() ===
          firstName,
      );
    }
    agentMenu = await openAgentMenu();
    await agentMenu.locator("button").nth(1).click();
    await page.waitForTimeout(600);
    check("and back again", (await pinnedMark()) === (wasPinned ? 1 : 0));

    // Delete asks for the name first; Cancel leaves everything alone.
    agentMenu = await openAgentMenu();
    await agentMenu.locator('button:has-text("Delete")').click();
    const deleteSheet = page.locator(".sheet-panel", { hasText: "Delete agent" });
    check("Delete opens the name confirmation", await deleteSheet.isVisible());
    check(
      "Delete stays disabled until the name is typed",
      await deleteSheet.locator('button:text-is("Delete")').isDisabled(),
    );
    await deleteSheet.locator('button:text-is("Cancel")').click();
    check("Cancel keeps the switcher open", (await page.locator(".switcher").count()) === 1);

    // Archive: on an agent that is not the one open, so nothing switches; the
    // check unarchives it again. Archived agents are hidden until asked for.
    const otherName = (
      await page
        .locator(".switcher-agents .switcher-card.agent:not(.selected) .switcher-card-title")
        .first()
        .innerText()
        .catch(() => "")
    ).trim();
    if (!otherName) {
      console.log("  SKIP  archiving an agent (only one agent)");
    } else {
      const otherCard = () =>
        page.locator(".switcher-agents .switcher-card.agent", {
          has: page.locator(".switcher-card-title", { hasText: otherName }),
        });
      await otherCard().locator(".switcher-more").click();
      await page.locator('.agent-menu button:has-text("Archive")').click();
      await page.waitForTimeout(600);
      check("an archived agent leaves the list", (await otherCard().count()) === 0);
      const reveal = page.locator(
        '.switcher-agents .switcher-archived:has-text("Show archived agents")',
      );
      check("a link offers the archived agents", (await reveal.count()) === 1);
      await reveal.click();
      check(
        "shown, it is dimmed and tagged",
        (await otherCard().getAttribute("class"))?.includes("archived") === true &&
          (await otherCard().locator(".archived-tag").count()) === 1,
      );
      await otherCard().locator(".switcher-more").click();
      const archivedItems = (await page.locator(".agent-menu button").allInnerTexts()).map((t) =>
        t.trim(),
      );
      check(
        "an archived agent's menu offers Unarchive, not Pin",
        JSON.stringify(archivedItems) === JSON.stringify(["Edit", "Unarchive", "Delete…"]),
        archivedItems,
      );
      await shot(page, "phone-archived-agent");
      await page.locator('.agent-menu button:has-text("Unarchive")').click();
      await page.waitForTimeout(600);
      check(
        "unarchived, it is back and the link is gone",
        (await otherCard().count()) === 1 &&
          !((await otherCard().getAttribute("class")) ?? "").includes("archived") &&
          (await page
            .locator('.switcher-agents .switcher-archived:has-text("archived agents")')
            .count()) === 0,
      );
    }
    await page.locator(".switcher-bar .sheet-close").click();

    await page.locator('.composer-row button[aria-label^="Filter"]').click();
    await pressBack();
    check(
      "Back closes a sheet and stays in the app",
      (await page.locator(".sheet-panel").count()) === 0 && page.url() === url,
    );

    // Fingertip-sized: every composer control is at least 44px on a phone, only
    // the switcher sits on the left, and the row fits without a sideways scroll.
    const controls = await page.evaluate(() => {
      const row = document.querySelector(".composer-row") as HTMLElement;
      // "Left" means before the spacer, the gap that splits the row, not left of
      // centre: six 44px buttons fill most of a phone row.
      const gap = (row.querySelector(".spacer") as HTMLElement).getBoundingClientRect().left;
      const buttons = [...row.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
      // The round send/stop control is its own fingertip floor (40px) — it is
      // deliberately a size under its flat neighbours — so it is checked
      // against that floor instead of the row-wide 44px.
      const round = buttons.find((b) => b.classList.contains("glyph-btn"));
      const roundOk =
        !round ||
        (round.getBoundingClientRect().width >= 40 && round.getBoundingClientRect().height >= 40);
      return {
        small: buttons
          .filter((b) => !b.classList.contains("glyph-btn"))
          .map((b) => ({
            name: b.getAttribute("aria-label"),
            ...b.getBoundingClientRect().toJSON(),
          }))
          .filter((b) => b.width < 44 || b.height < 44)
          .map((b) => `${b.name} ${Math.round(b.width)}x${Math.round(b.height)}`),
        roundOk,
        left: buttons
          .filter((b) => b.getBoundingClientRect().right <= gap)
          .map((b) => b.getAttribute("aria-label")),
        scrolls: row.scrollWidth > row.clientWidth + 1,
      };
    });
    check("composer buttons are at least 44px", controls.small.length === 0, controls.small);
    check("the round send/stop is at least 40px", controls.roundOk, controls.roundOk);
    check(
      "only the switcher is on the left",
      controls.left.length === 1 && controls.left[0] === "Agents and conversations",
      controls.left,
    );
    check("composer row fits without scrolling", !controls.scrolls);

    // The composer is the single control surface; each control must exist and
    // be an icon button with an accessible name.
    for (const label of ["Filter the transcript"]) {
      const button = page.locator(`.composer-row button[aria-label="${label}"]`);
      check(`composer has "${label}"`, (await button.count()) === 1);
      check(`"${label}" is an icon button`, (await button.locator("svg.icon").count()) === 1);
    }
    // The model button's accessible name gains the model in force once one is
    // known ("Model: <name>"), so match on the prefix.
    const model = page.locator('.composer-row button[aria-label^="Model"]');
    check("composer has a model button", (await model.count()) === 1);
    check("model button is an icon button", (await model.locator("svg.icon").count()) === 1);
    const permission = page.locator('.composer-row button[aria-label^="Permission mode"]');
    check("composer has a permission-mode button", (await permission.count()) === 1);
    check(
      "permission button is icon-only",
      (await permission.innerText()).trim().length === 0,
      await permission.innerText(),
    );
    check(
      "permission button colours the mode",
      /\bmode-(unrestricted|acceptEdits|standard|strict)\b/.test(
        (await permission.getAttribute("class")) ?? "",
      ),
      await permission.getAttribute("class"),
    );
    check(
      "composer has a send button",
      (await page.locator('.composer-row button[aria-label="Send message"]').count()) === 1,
    );
    // The composer's one action button is the round glyph button; the box's
    // top border carries the resize grip (drag to pin a height, double-click
    // for auto-fit — see `Composer.tsx`).
    check(
      "composer has one round action button",
      (await page.locator(".composer-row .glyph-btn").count()) === 1,
    );
    check(
      "composer has a resize grip",
      (await page.locator(".composer-box .composer-resize").count()) === 1,
    );

    // Every icon-only control must be nameable; today's regression was that
    // most glyph buttons had no accessible name at all.
    const unnamed = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button"))
        .filter((b) => {
          const hasIcon = b.querySelector("svg.icon") !== null;
          const text = (b.textContent ?? "").trim();
          const named = b.getAttribute("aria-label") || b.getAttribute("title");
          return hasIcon && text.length === 0 && !named;
        })
        .map((b) => b.className || "(button)"),
    );
    check("no unnamed icon-only buttons", unnamed.length === 0, unnamed);

    // The glyph census this replaced: emoji and dingbats rendered per-platform.
    // UI chrome only: transcript entries hold what agents and people wrote,
    // and an agent's "→" there is content, not a glyph button — counting it
    // made the check fail on whatever conversation happened to be newest.
    const glyphs = await page.evaluate(() => {
      const found = new Set<string>();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.parentElement?.closest(".entry")
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      });
      // Emoji, dingbats, arrows and geometric shapes. The variation selector is
      // an alternation branch, not a class member: it combines with the glyph
      // before it, so a class cannot express it.
      const re =
        /[\u2190-\u21FF\u2300-\u23FF\u25A0-\u25FF\u2600-\u27BF]|[\u{1F300}-\u{1FAFF}]|\uFE0F/gu;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const m of (node.textContent ?? "").matchAll(re)) found.add(m[0]);
      }
      return [...found];
    });
    check("no emoji or dingbat glyphs left in the UI", glyphs.length === 0, glyphs);

    check(
      "favicon link is present",
      await page.evaluate(() => {
        const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
        return Boolean(link?.href?.startsWith("data:image/svg+xml"));
      }),
    );
    check(
      "the filter row above the transcript is gone",
      (await page.locator(".filters").count()) === 0,
    );

    // Sheets open, and Escape closes them.
    await page.locator('.composer-row button[aria-label^="Filter"]').click();
    check("filters sheet opens", await page.locator(".sheet-panel").isVisible());
    const groups = await page
      .locator(".sheet-panel .menu-list")
      .first()
      .locator(".menu-row-title")
      .allInnerTexts();
    check(
      "five filter groups incl. Tasks",
      groups.length === 5 && groups.some((g) => g.includes("Tasks")),
      groups,
    );
    // Ticked means shown: with nothing filtered every kind is on screen, so
    // every box reads ticked (it used to be the reverse — all unticked, all shown).
    const groupStates = await page
      .locator(".sheet-panel .menu-list")
      .first()
      .locator(".menu-row")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-pressed")));
    check(
      "filter boxes start ticked",
      groupStates.length === 5 && groupStates.every((state) => state === "true"),
      groupStates,
    );
    // Timestamps: on by default, and the filter-sheet toggle hides them.
    const timestampToggle = page.locator(".sheet-panel .menu-row", { hasText: "Timestamps" });
    const toggleInput = {
      isChecked: async () => (await timestampToggle.getAttribute("aria-pressed")) === "true",
      uncheck: async () => {
        if (await toggleInput.isChecked()) await timestampToggle.click();
      },
      check: async () => {
        if (!(await toggleInput.isChecked())) await timestampToggle.click();
      },
    };
    check("timestamp toggle is in the filter sheet", (await timestampToggle.count()) === 1);
    check("timestamps are on by default", await toggleInput.isChecked());
    const hasEntries = (await page.locator(".messages .entry").count()) > 0;
    if (hasEntries) {
      check("entries carry a timestamp", (await page.locator(".messages time").count()) > 0);
    }
    await toggleInput.uncheck();
    check(
      "turning timestamps off hides them",
      (await page.locator(".messages time").count()) === 0,
    );
    await toggleInput.check();
    if (hasEntries) {
      check(
        "turning them back on restores them",
        (await page.locator(".messages time").count()) > 0,
      );
    }
    if (hasEntries) {
      // One message system: you on the right, the agent full width on the
      // left, different rail colours; steps folded; no uppercase labels.
      const style = await page.evaluate(() => {
        const user = document.querySelector<HTMLElement>(".messages .entry.user");
        const agent = document.querySelector<HTMLElement>(
          ".messages .entry.assistant:not(.subagent)",
        );
        const list = document.querySelector<HTMLElement>(".messages");
        const uppercase = [...document.querySelectorAll<HTMLElement>(".messages *")].filter(
          (el) => getComputedStyle(el).textTransform === "uppercase" && el.textContent?.trim(),
        ).length;
        return {
          userRail: user ? getComputedStyle(user).borderRightColor : null,
          agentRail: agent ? getComputedStyle(agent).borderLeftColor : null,
          userRight:
            user && list
              ? list.getBoundingClientRect().right - user.getBoundingClientRect().right < 30
              : null,
          uppercase,
          overflow: list ? list.scrollWidth > list.clientWidth + 1 : false,
        };
      });
      if (style.userRail && style.agentRail) {
        check(
          "you and the agent have different rail colours",
          style.userRail !== style.agentRail,
          style,
        );
      }
      if (style.userRight !== null) check("your messages sit on the right", style.userRight, style);
      check("no uppercase labels in the transcript", style.uppercase === 0, style);
      check("the transcript does not scroll sideways", !style.overflow, style);
      // A lone "\n" text part between tool calls used to draw an empty
      // "Agent" panel per step; such text is dropped now.
      const emptyAnswers = await page.evaluate(
        () =>
          [
            ...document.querySelectorAll<HTMLElement>(
              ".messages .entry.assistant:not(.subagent) > .bubble",
            ),
          ].filter((el) => !el.textContent?.trim()).length,
      );
      check("no empty agent message panels", emptyAnswers === 0, { emptyAnswers });
      const steps = page.locator(".messages .steps-head").first();
      if ((await steps.count()) > 0) {
        check("steps start collapsed", (await steps.getAttribute("aria-expanded")) === "false");
        // The filter sheet is still open over the transcript (the checks after
        // this need it), so its scrim would take a real pointer click.
        await steps.evaluate((el: HTMLElement) => el.click());
        check("a tap opens the steps", (await steps.getAttribute("aria-expanded")) === "true");
        await steps.evaluate((el: HTMLElement) => el.click());
      }
    }
    await shot(page, "phone-filters");
    check(
      "sheet is a bottom sheet on a phone",
      await page.evaluate(() => {
        const panel = document.querySelector(".sheet-panel");
        if (!panel) return false;
        const rect = panel.getBoundingClientRect();
        return Math.abs(rect.bottom - window.innerHeight) < 2;
      }),
    );
    await page.keyboard.press("Escape");
    check("escape closes the sheet", (await page.locator(".sheet-panel").count()) === 0);

    await page.locator('.composer-row button[aria-label^="Permission mode"]').click();
    check("permission sheet opens", await page.locator(".sheet-panel").isVisible());
    await shot(page, "phone-permissions");
    await page.keyboard.press("Escape");

    // Every composer menu follows one set of rules: a header with a ✕, no
    // footer, and the shared row.
    for (const label of ["Filter", "Permission mode", "Model"]) {
      await page.locator(`.composer-row button[aria-label^="${label}"]`).first().click();
      await page.waitForTimeout(600);
      const shape = await page.evaluate(() => ({
        close: document.querySelectorAll(".sheet-panel .sheet-head .sheet-close").length,
        footer: document.querySelectorAll(".sheet-panel .sheet-actions").length,
        oldRows: document.querySelectorAll(".sheet-panel .picker").length,
        rows: document.querySelectorAll(".sheet-panel .menu-row").length,
        // Compact, but never below a fingertip target.
        shortRows: [...document.querySelectorAll(".sheet-panel .menu-row")].filter(
          (row) => row.getBoundingClientRect().height < 44,
        ).length,
      }));
      check(
        `"${label}" menu: header ✕, no footer, shared rows ≥44px`,
        shape.close === 1 &&
          shape.footer === 0 &&
          shape.oldRows === 0 &&
          shape.rows > 0 &&
          shape.shortRows === 0,
        shape,
      );
      await page.locator(".sheet-panel .sheet-close").click();
      await page.waitForTimeout(300);
    }

    // Typed slash commands. The popover has to be reachable without the sheet,
    // and it must not be the thing that pushes the composer off-screen — it
    // sits above a textarea the on-screen keyboard has already crowded.
    const textarea = page.locator(".composer textarea");
    await textarea.fill("/cl");
    const popover = page.locator(".composer-suggestions");
    check("typing a slash opens the suggestions", await popover.isVisible());
    check(
      "suggestions are filtered to the prefix",
      // An id match, not has-text: "/clear" is a text substring of
      // "/clear-messages" too, so has-text(/clear) over-counted once a second
      // command shared the prefix.
      (await popover.locator("li").count()) > 0 &&
        (await popover.locator("#composer-suggestion-clear").count()) === 1,
    );
    check(
      "a suggestion is highlighted by default",
      (await popover.locator("button.active").count()) === 1,
    );
    await shot(page, "phone-slash-suggestions");
    const withPopover = await overflow(page);
    check("suggestions do not clip the composer", withPopover.clipped.length === 0, withPopover);

    await page.keyboard.press("Escape");
    check("escape closes the suggestions", (await popover.count()) === 0);

    // A pasted absolute path is a message, not a command — the popover must
    // stay out of the way of it.
    await textarea.fill("/work/agent-x/notes.md");
    check("a path does not open the suggestions", (await popover.count()) === 0);
    await textarea.fill("");

    // An unsent draft survives a tab switch — the composer unmounts when the
    // Chat tab is left, so the text has to be persisted and restored.
    await textarea.fill("half a thought, unsent");
    await page.locator('nav.tabs button:text-is("Files")').click();
    await page.locator(".composer textarea").waitFor({ state: "detached" });
    await page.locator('nav.tabs button:text-is("Chat")').click();
    const restored = page.locator(".composer textarea");
    await restored.waitFor({ state: "visible" });
    check(
      "an unsent draft is restored after switching tabs",
      (await restored.inputValue()) === "half a thought, unsent",
      await restored.inputValue(),
    );
    await restored.fill("");

    // Files on a phone: size and date fold under the name, so the name gets
    // the row instead of about eight characters of it.
    await page.locator('nav.tabs button:text-is("Files")').click();
    await page.waitForTimeout(1200);
    const nameShare = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(".list > li.file-row");
      const name = row?.querySelector<HTMLElement>(".grow-row");
      return row && name ? name.offsetWidth / row.offsetWidth : null;
    });
    if (nameShare === null) {
      console.log("  SKIP  file names get the row (empty workspace)");
    } else {
      check("a file name gets most of the row on a phone", nameShare >= 0.6, { nameShare });
    }

    // The git entry points sit in the same pane-bar as New file; at phone
    // width the bar must still fit, and the sheet must open and close like
    // every other sheet. They are only offered for a folder inside a git
    // repository, and a default agent workspace is a plain directory — so the
    // negative path is the one an ordinary run exercises.
    const phoneHistory = page.locator('.pane-bar button:has-text("History")');
    const phoneBranch = page.locator('.pane-bar button:has-text("Branch")');
    if ((await phoneHistory.count()) === 0) {
      check(
        "no git controls in a non-repository folder on a phone",
        (await phoneBranch.count()) === 0,
        { history: 0, branch: await phoneBranch.count() },
      );
      console.log("  SKIP  git actions on a phone (this workspace is not a git repository)");
    } else {
      check(
        "History and Branch are both on the Files pane bar on a phone",
        (await phoneBranch.count()) > 0,
      );
      await phoneHistory.click();
      await page.waitForTimeout(800);
      const phoneSheet = page.locator('.sheet-panel[aria-label="History"]');
      await phoneSheet.waitFor({ state: "visible", timeout: 5000 });
      const sheetBox = await overflow(page);
      check(
        "the history sheet has nothing clipped on a phone",
        sheetBox.clipped.length === 0,
        sheetBox,
      );
      await shot(page, "phone-files-history");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      check(
        "escape closes the history sheet",
        (await page.locator('.sheet-panel[aria-label="History"]').count()) === 0,
      );
    }
    await page.locator('nav.tabs button:text-is("Chat")').click();

    // The Agent tab's section switcher wraps rather than widening the pane.
    // The generic `overflow()` cannot see this: `.pane` scrolls vertically,
    // which makes its computed overflow-x `auto` too, so an over-wide bar
    // counted as "inside a scroller" and passed while the whole pane scrolled
    // sideways.
    await page.locator('nav.tabs button:text-is("Agent")').click();
    await page.locator(".section-tabs").waitFor();
    await shot(page, "phone-agent");
    const agentWidth = await page.evaluate(() => {
      const bar = document.querySelector(".section-tabs") as HTMLElement;
      const pane = bar.parentElement as HTMLElement;
      return { bar: bar.scrollWidth, pane: pane.scrollWidth, client: pane.clientWidth };
    });
    check(
      "agent sections fit the phone width (no sideways scroll)",
      agentWidth.bar <= agentWidth.client && agentWidth.pane <= agentWidth.client,
      agentWidth,
    );
    const sectionButtons = page.locator(".section-tabs button");
    const lastBox = await sectionButtons.last().boundingBox();
    check(
      "every agent section is on screen",
      lastBox !== null && lastBox.x + lastBox.width <= PHONE.width,
      lastBox,
    );

    // Skills on a phone: long names, badges and paths must wrap, not push the
    // pane sideways — measured on the pane for the same reason as above.
    await page.locator('.section-tabs button:text-is("Skills")').click();
    await page.locator(".skill-group-head").first().waitFor({ timeout: 10_000 });
    await page.locator('.skill-group-head:has-text("Bundled")').click();
    await page.locator('.skill-main[aria-expanded="false"]').first().click();
    const skillsWidth = await page.evaluate(() => {
      const pane = document.querySelector(".skill-list")?.closest(".pane") as HTMLElement;
      return { scroll: pane.scrollWidth, client: pane.clientWidth };
    });
    check(
      "skills list fits the phone width (no sideways scroll)",
      skillsWidth.scroll <= skillsWidth.client,
      skillsWidth,
    );
    await shot(page, "phone-skills");

    // Settings for every agent: the top bar's gear. On a phone, the Agent
    // tab's wrapping chips with short names over the open section — no list
    // to back out of. All nine must be on screen with no sideways scroll.
    await page.locator('.topbar button[aria-label="Settings"]').click();
    await page.locator(".settings-screen").waitFor();
    const phoneChips = (
      await page.locator(".settings-screen .section-tabs button").allInnerTexts()
    ).map((t) => t.trim());
    const features = await readFeatures(page);
    const expectedPhoneChips = [
      "Models",
      ...(featureOn(features, "web") ? ["Web"] : []),
      "MCP",
      ...(featureOn(features, "google") ? ["Google"] : []),
      ...(featureOn(features, "codex") ? ["Codex"] : []),
      ...(featureOn(features, "claude") ? ["Claude"] : []),
      ...(featureOn(features, "pi") ? ["Remote Pi"] : []),
      "Skills",
      "Push",
      "About",
    ];
    check(
      `phone settings chips are ${expectedPhoneChips.join(" / ")}`,
      JSON.stringify(phoneChips) === JSON.stringify(expectedPhoneChips),
      phoneChips,
    );
    check(
      "phone settings show chips, not the desktop list",
      (await page.locator(".settings-nav").count()) === 0 &&
        (await page.locator(".settings-content").isVisible()),
    );
    const chipsFit = await page.evaluate(() => {
      const bar = document.querySelector(".settings-screen .section-tabs") as HTMLElement;
      const last = bar.lastElementChild?.getBoundingClientRect();
      return { scroll: bar.scrollWidth, client: bar.clientWidth, lastRight: last?.right ?? 0 };
    });
    check(
      "every settings chip is on screen (no sideways scroll)",
      chipsFit.scroll <= chipsFit.client && chipsFit.lastRight <= PHONE.width,
      chipsFit,
    );
    await shot(page, "phone-settings");
    await page.locator('.settings-screen .section-tabs button:text-is("MCP")').click();
    await page.waitForTimeout(700);
    check(
      "a chip opens its section",
      (await page.locator(".settings-screen .section-tabs button.active").innerText()) === "MCP" &&
        (await page.locator(".settings-content").innerText()).includes("MCP"),
    );
    const sectionWidth = await page.evaluate(() => {
      const pane = document.querySelector(".settings-content") as HTMLElement;
      return { scroll: pane.scrollWidth, client: pane.clientWidth };
    });
    check(
      "a settings section fits the phone width",
      sectionWidth.scroll <= sectionWidth.client,
      sectionWidth,
    );
    await shot(page, "phone-settings-mcp");
    await page.locator('.settings-screen button[aria-label="Close"]').click();
    check("close leaves settings", (await page.locator(".settings-screen").count()) === 0);

    await page.close();
  }

  // ── Desktop ──────────────────────────────────────────────────────────────
  section(`Desktop (${DESKTOP.width}px)`);
  {
    const page = await open(browser, DESKTOP);
    await shot(page, "desktop-chat");

    const box = await overflow(page);
    check("nothing is clipped off-screen", box.clipped.length === 0, box);

    check(
      "no switcher button in the composer on desktop",
      !(await page
        .locator('.composer-row button[aria-label="Agents and conversations"]')
        .isVisible()),
    );
    check(
      "sidebar is pinned on screen",
      await page.evaluate(() => {
        const el = document.querySelector(".sidebar");
        return el ? el.getBoundingClientRect().left >= 0 : false;
      }),
    );

    // The agents are a list on a panel of their own, not a dropdown, and look
    // unlike the conversations under them.
    check("no agent dropdown on desktop", (await page.locator(".sidebar select").count()) === 0);
    const agentRowCount = await page.locator(".sidebar .agent-row").count();
    check("agents are listed as rows", agentRowCount >= 1, { agentRowCount });
    const panels = await page.evaluate(() => {
      const bg = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).backgroundColor : null;
      };
      return { agents: bg(".sidebar-agents"), sidebar: bg(".sidebar") };
    });
    check(
      "the agents panel has its own background",
      panels.agents !== null && panels.agents !== panels.sidebar,
      panels,
    );
    check(
      "agents carry an avatar, conversations do not",
      (await page.locator(".sidebar .agent-row .agent-avatar").count()) === agentRowCount &&
        (await page.locator(".sidebar .conversations .agent-avatar").count()) === 0,
    );
    const bars = await page.evaluate(() => {
      const left = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).borderLeftWidth : null;
      };
      return {
        agent: left(".sidebar .agent-row.active"),
        conversation: left(".sidebar .conversations li.conversation-row.active"),
      };
    });
    check(
      "the open agent and conversation are both marked by a left bar",
      bars.agent === "3px" && (bars.conversation === null || bars.conversation === "3px"),
      bars,
    );

    // Each agent row has its own ⋯: the phone's agent menu, opening below it.
    await page.locator(".sidebar .agent-row.active").hover();
    await page.locator(".sidebar .agent-row.active .agent-more").click();
    const deskMenu = page.locator(".agent-menu");
    const deskItems = (await deskMenu.locator("button").allInnerTexts()).map((t) => t.trim());
    check(
      "desktop agent ⋯ offers the same actions",
      deskItems.length === 4 && deskItems[0] === "Edit" && deskItems[2] === "Archive",
      deskItems,
    );
    const deskBox = await deskMenu.boundingBox();
    check(
      "desktop agent menu is sized to its items and on screen",
      deskBox !== null &&
        deskBox.width >= 150 &&
        deskBox.width <= 260 &&
        deskBox.y + deskBox.height <= DESKTOP.height,
      deskBox,
    );
    await shot(page, "desktop-agent-menu");
    await page.keyboard.press("Escape");
    check("Escape closes it", (await deskMenu.count()) === 0);

    await page.locator('.composer-row button[aria-label^="Filter"]').click();
    check("filters sheet opens", await page.locator(".sheet-panel").isVisible());
    check(
      "sheet is a centred modal on desktop",
      await page.evaluate(() => {
        const panel = document.querySelector(".sheet-panel");
        if (!panel) return false;
        const rect = panel.getBoundingClientRect();
        // Centred means a gap below it, unlike the phone bottom sheet.
        return window.innerHeight - rect.bottom > 20;
      }),
    );
    const filterWidth = await page.evaluate(
      () => document.querySelector(".sheet-panel")?.getBoundingClientRect().width ?? 0,
    );
    check("a menu sheet is dialog-sized, not column-wide", filterWidth <= 600, { filterWidth });
    await shot(page, "desktop-filters");
    await page.keyboard.press("Escape");

    // The Agent tab holds the selected agent's settings and nothing shared.
    await page.locator('nav.tabs button:text-is("Agent")').click();
    await page.waitForTimeout(500);
    const expectedChips = ["General", "Secrets", "Reflection", "Skills"];
    const chipLabels = (await page.locator(".section-tabs button").allInnerTexts()).map((t) =>
      t.trim(),
    );
    check(
      `agent chips are ${expectedChips.join(" / ")}`,
      JSON.stringify(chipLabels) === JSON.stringify(expectedChips),
      chipLabels,
    );
    check(
      "the agent's General section edits it in place",
      (await page.locator('.pane label:has-text("Name") input').count()) === 1 &&
        (await page.locator('.pane button:text-is("Delete agent…")').count()) === 1,
    );
    const agentBox = await overflow(page);
    check("agent tab has nothing clipped", agentBox.clipped.length === 0, agentBox);

    // App-wide conventions, section by section: one toggle (MenuRow, never the
    // platform checkbox) and one heading voice (sentence case, never uppercase).
    const conventions: Record<string, { checkboxes: number; uppercase: string[] }> = {};
    const scan = () =>
      page.evaluate(() => ({
        checkboxes: document.querySelectorAll('input[type="checkbox"]').length,
        uppercase: [
          ...document.querySelectorAll<HTMLElement>(".pane *, .sidebar *, .settings-screen *"),
        ]
          .filter(
            (el) => getComputedStyle(el).textTransform === "uppercase" && el.textContent?.trim(),
          )
          .map((el) => (el.textContent ?? "").trim().slice(0, 30)),
      }));
    for (const chip of expectedChips) {
      await page.locator(`.section-tabs button:text-is("${chip}")`).click();
      await page.waitForTimeout(700);
      conventions[`Agent/${chip}`] = await scan();
      // Secrets needs an agent selected; Reflection needs a conversation, and
      // renders an empty-state notice when it has none. Both must lay out.
      const box = await overflow(page);
      check(`agent ${chip.toLowerCase()} has nothing clipped`, box.clipped.length === 0, box);
    }

    // The Tools tab: one chip per shared family, the chip carries the on/off box
    // (role=checkbox — the platform checkbox is still banned everywhere), and
    // clicking the name opens that family's per-agent settings.
    await page.locator('nav.tabs button:text-is("Tools")').click();
    await page.waitForTimeout(700);
    const toolsFeatures = await readFeatures(page);
    const expectedToolChips = [
      ["google", "Google"],
      ["codex", "Codex"],
      ["claude", "Claude"],
      ["pi", "Remote Pi"],
    ]
      .filter(([key]) => featureOn(toolsFeatures, key))
      .map(([, label]) => label);
    const toolChipLabels = (
      await page.locator(".tool-chips button:not(.chip-check)").allInnerTexts()
    ).map((t) => t.trim());
    check(
      `tools chips are ${expectedToolChips.join(" / ")}`,
      JSON.stringify(toolChipLabels) === JSON.stringify(expectedToolChips),
      toolChipLabels,
    );
    check(
      "every tools chip carries its own box and no native checkbox exists",
      (await page.locator(".tool-chips button[aria-pressed]").count()) ===
        expectedToolChips.length &&
        (await page.evaluate(() => document.querySelectorAll('input[type="checkbox"]').length)) ===
          0,
      {
        boxes: await page.locator(".tool-chips button[aria-pressed]").count(),
      },
    );
    check(
      "the tools pane loads access from the BFF",
      (await page.locator('.pane label:has-text("Google") select').count()) === 1,
    );
    if (featureOn(toolsFeatures, "pi")) {
      await page.locator('.tool-chips button:text-is("Remote Pi")').click();
      await page.locator('.pane label:has-text("Where this agent runs pi work") select').waitFor({
        timeout: 10_000,
      });
      check(
        "remote pi shows where this agent runs pi work",
        (await page
          .locator('.pane label:has-text("Where this agent runs pi work") select')
          .count()) === 1,
      );
    }
    const toolsBox = await overflow(page);
    check("tools tab has nothing clipped", toolsBox.clipped.length === 0, toolsBox);
    await shot(page, "desktop-tools");

    // Back to the Agent tab for its own sections.
    await page.locator('nav.tabs button:text-is("Agent")').click();
    await page.waitForTimeout(400);

    // Agent → Skills: the list comes from the BFF's own discovery, so it is
    // populated with no turn running (bundled skills alone are ~20). Bundled
    // starts collapsed; descriptions are one line until a row is tapped.
    await page.locator('.section-tabs button:text-is("Skills")').click();
    await page.locator(".skill-group-head").first().waitFor({ timeout: 10_000 });
    const bundledHead = page.locator('.skill-group-head:has-text("Bundled")');
    check("skills list is populated without a turn", (await bundledHead.count()) === 1);
    check(
      "bundled group starts collapsed",
      (await bundledHead.getAttribute("aria-expanded")) === "false",
    );
    await bundledHead.click();
    const rows = page.locator(".skill-item");
    check("expanding bundled lists its skills", (await rows.count()) > 5, await rows.count());
    // Pin the row by index: a locator on aria-expanded="false" would move to
    // the next collapsed row the moment this one expands.
    const clampedIndex = await page
      .locator(".skill-main")
      .evaluateAll((els) => els.findIndex((el) => el.getAttribute("aria-expanded") === "false"));
    const expandable = page.locator(".skill-main").nth(clampedIndex);
    if (clampedIndex >= 0) {
      const desc = expandable.locator(".skill-desc");
      const before = (await desc.boundingBox())?.height ?? 0;
      await expandable.click();
      const after = (await desc.boundingBox())?.height ?? 0;
      check("tapping a clamped description expands it", after > before, { before, after });
      check(
        "an expanded row shows its path",
        (await expandable.locator(".skill-path").count()) === 1,
      );
      await expandable.click();
    } else {
      check("some description is long enough to clamp", false);
    }
    check(
      "enabling a skill for every agent is not in the agent's tab",
      (await page.locator('button:text-is("Enable globally")').count()) === 0,
    );
    const agentSkillsBox = await overflow(page);
    check("agent skills has nothing clipped", agentSkillsBox.clipped.length === 0, agentSkillsBox);
    await shot(page, "desktop-agent-skills");

    // Its link goes to global Settings, open on Global skills.
    await page.locator('.pane button:text-is("Settings → Global skills")').click();
    await page.locator(".settings-screen").waitFor();
    check(
      "the skills link opens global skills",
      (await page.locator(".settings-content-title").innerText()) === "Global skills",
    );
    await page.keyboard.press("Escape");
    check("Escape closes settings", (await page.locator(".settings-screen").count()) === 0);

    // Settings for every agent, from the gear: list and section side by side.
    await page.locator('.topbar button[aria-label="Settings"]').click();
    await page.locator(".settings-screen").waitFor();
    check(
      "desktop settings show the list and a section together",
      (await page.locator(".settings-nav").isVisible()) &&
        (await page.locator(".settings-content").isVisible()),
    );
    check(
      "the selected settings row is marked by its border, not a tick",
      (await page.locator(".settings-nav .menu-row.selected").count()) === 1 &&
        (await page.locator(".settings-nav .menu-row-check").count()) === 0,
    );
    const desktopFeatures = await readFeatures(page);
    const expectedRows = [
      "Providers & models",
      ...(featureOn(desktopFeatures, "web") ? ["Web search"] : []),
      "MCP servers",
      ...(featureOn(desktopFeatures, "google") ? ["Google"] : []),
      ...(featureOn(desktopFeatures, "codex") ? ["Codex workers"] : []),
      ...(featureOn(desktopFeatures, "claude") ? ["Claude Code workers"] : []),
      ...(featureOn(desktopFeatures, "pi") ? ["Remote Pi"] : []),
      "Global skills",
      "Notifications",
      "About",
    ];
    const rowLabels = (await page.locator(".settings-nav .menu-row-title").allInnerTexts()).map(
      (t) => t.trim(),
    );
    check(
      `settings rows are ${expectedRows.join(" / ")}`,
      JSON.stringify(rowLabels) === JSON.stringify(expectedRows),
      rowLabels,
    );
    check(
      "no per-agent section among the shared ones",
      !rowLabels.some((label) => ["Secrets", "Reflection"].includes(label)),
      rowLabels,
    );
    const openSection = async (label: string) => {
      await page.locator(`.settings-nav .menu-row:has-text("${label}")`).click();
      await page.waitForTimeout(700);
    };
    for (const label of expectedRows) {
      await openSection(label);
      conventions[`Settings/${label}`] = await scan();
      const box = await overflow(page);
      check(`${label} has nothing clipped`, box.clipped.length === 0, box);
    }
    const offenders = Object.entries(conventions).filter(
      ([, found]) => found.checkboxes > 0 || found.uppercase.length > 0,
    );
    check(
      "no native checkboxes or uppercase labels in any section",
      offenders.length === 0,
      offenders,
    );

    // Codex loads its settings from the BFF (GET /api/codex/settings); a form
    // means the route answered, not just that the row exists.
    await openSection("Codex workers");
    check(
      "codex section loads its settings",
      (await page.locator('.menu-row:has-text("Allow Codex workers")').count()) === 1,
      await page.locator(".settings-content").innerText(),
    );

    // Same for Claude Code (GET /api/claude/settings).
    await openSection("Claude Code workers");
    check(
      "claude section loads its settings",
      (await page.locator('.menu-row:has-text("Allow Claude Code workers")').count()) === 1,
      await page.locator(".settings-content").innerText(),
    );

    if (featureOn(desktopFeatures, "pi")) {
      // Same for Remote Pi (GET /api/pi/settings).
      await openSection("Remote Pi");
      check(
        "remote pi section loads its settings",
        (await page.locator('.menu-row:has-text("Allow Remote Pi")').count()) === 1,
        await page.locator(".settings-content").innerText(),
      );
    }

    // Google loads its status from the BFF (GET /api/google). Under dev bypass
    // the form must also say it is locked, not just grey its inputs out.
    await openSection("Google");
    const googleText = await page.locator(".settings-content").innerText();
    check(
      "google section loads its status",
      (await page.locator('.menu-row:has-text("Allow agents to use Google")').count()) === 1,
      googleText,
    );
    const googleLocked = await page.locator('label:has-text("Gmail") select').isDisabled();
    check(
      "a locked google section says why",
      !googleLocked || googleText.includes("Read-only here"),
      googleText,
    );
    // Every service has a level row; Contacts is one of them (workspace-mcp's
    // People API), so its select must render with its two levels.
    check(
      "google lists a Contacts level row",
      (await page.locator('label:has-text("Contacts") select').count()) === 1 &&
        (await page.locator('label:has-text("Contacts") select option').count()) === 3,
      googleText,
    );

    // The release tag the BFF bakes in (VERSION → /api/status → About). Assert
    // the shape, not a literal: the value is whatever the running image carries,
    // and a stale image is deploy-check's problem, not this one's.
    await openSection("About");
    const aboutText = await page.locator(".settings-content").innerText();
    check(
      "about shows the lettuce release tag",
      /lettuce\s+v\d+\.\d+\.\d+-letta_\d+\.\d+\.\d+/.test(aboutText),
      aboutText,
    );

    await openSection("Providers & models");

    // Models served: count in the heading, provider per row.
    const servedHeading = await page.locator('.section-note:has-text("Models served")').innerText();
    check("models-served heading carries a count", /\(\d+\)/.test(servedHeading), servedHeading);

    // Refreshing against a stable endpoint must NOT raise the change warning —
    // a detector that cries wolf on every refresh is worse than none.
    const warningSelector = '.warning:has-text("different set of models")';
    check(
      "no spurious model-change warning on load",
      (await page.locator(warningSelector).count()) === 0,
    );
    await page.locator('button:has-text("Refresh models")').click();
    await page.waitForTimeout(2500);
    check(
      "no spurious model-change warning after a refresh",
      (await page.locator(warningSelector).count()) === 0,
    );

    // Capability-less endpoints get an Edit link per row, opening the
    // declaration sheet. On a stack serving only native endpoints there are
    // none — then there is nothing to check, and that must not fail. Wait for
    // the first row to render: the list arrives over the socket after the
    // section opens.
    await page
      .locator('.section-note:has-text("Models served") ~ ul li')
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => {});
    const modelEditLinks = page.locator(
      '.section-note:has-text("Models served") ~ ul .row button:has-text("Edit")',
    );
    const editCount = await modelEditLinks.count();
    if (editCount > 0) {
      await modelEditLinks.first().click();
      const sheet = page.locator(".sheet-panel[aria-label]");
      check(
        "model edit sheet opens with capability toggles",
        (await sheet.locator('.menu-row:has-text("Vision")').count()) === 1 &&
          (await sheet.locator('.menu-row:has-text("Thinking")').count()) === 1,
        await sheet.innerText(),
      );
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      check("model edit sheet closes", (await sheet.count()) === 0);
    } else {
      check("served rows without an editable endpoint show no Edit link", true);
    }

    // Global skills: only the global scope, plus the enable-by-path form.
    await openSection("Global skills");
    const enableButton = page.locator('button:text-is("Enable globally")');
    check("global skills offers an enable field", (await enableButton.count()) === 1);
    check("enable is disabled until a path is typed", await enableButton.isDisabled());
    await page
      .locator('.settings-content input[placeholder^="/work/"]')
      .fill("/work/agent-x/.agents/skills/s");
    check("enable becomes available with a path", await enableButton.isEnabled());
    check(
      "global skills lists no other scope",
      (await page.locator(".settings-content .skill-group-head").count()) === 0,
    );
    const squeezed = await page
      .locator(".pane > pre.tool-args")
      .evaluateAll((els) =>
        els.filter((el) => el.scrollHeight > el.clientHeight + 1).map((el) => el.textContent),
      );
    check("skills example commands are shown in full", squeezed.length === 0, squeezed);
    await shot(page, "desktop-global-skills");

    // Notifications: headless Chromium supports the Push/Notification APIs,
    // so this renders the real toggle rather than the iOS install notice —
    // just needs to render without clipping, not actually subscribe.
    await openSection("Notifications");
    check(
      "notifications section offers a toggle or an unsupported notice",
      (await page
        .locator('button:has-text("Enable notifications"), p:has-text("not supported")')
        .count()) > 0,
    );
    // The test-notification button is only useful once a device is subscribed,
    // and headless Chromium cannot subscribe (no push service), so its absence
    // here is the assertion: it must not offer a button that could only fail.
    check(
      "no test-notification button until this device is subscribed",
      (await page.locator('button:has-text("Send a test notification")').count()) === 0,
    );
    await shot(page, "desktop-notifications");

    await shot(page, "desktop-settings");
    await page.locator('.settings-screen button[aria-label="Close"]').click();

    // Sheet geometry. MemoryTab and TasksTab used to hand-roll the markup and
    // omit .sheet-panel, so on desktop the body and the actions became two
    // independently centred flex items — a narrow box with the buttons floating
    // outside it. The panel carries the desktop width, the radius and the
    // shadow, so its presence is the assertion that matters.
    await page.locator('nav.tabs button:text-is("Tasks")').click();
    await page.waitForTimeout(1000);
    await page.locator(".pane-bar button, .pane button").filter({ hasText: "New" }).first().click();
    await page.waitForTimeout(500);
    check("task sheet renders a panel", (await page.locator(".sheet-panel").count()) === 1);
    check(
      "a form sheet has the same header and close as a menu",
      (await page.locator(".sheet-panel .sheet-head .sheet-close").count()) === 1,
    );
    check(
      "actions live inside the panel, not beside it",
      (await page.locator(".sheet-panel .sheet-actions").count()) === 1,
    );
    const geometry = await page.evaluate(() => {
      const p = document.querySelector(".sheet-panel")?.getBoundingClientRect();
      const a = document.querySelector(".sheet-actions")?.getBoundingClientRect();
      const b = document.querySelector(".sheet-body")?.getBoundingClientRect();
      return p && a && b
        ? {
            panelWidth: Math.round(p.width),
            actionsInside: a.left >= p.left - 1 && a.right <= p.right + 1,
            bodyInside: b.left >= p.left - 1 && b.right <= p.right + 1,
            centred: Math.abs(p.left + p.width / 2 - window.innerWidth / 2) < 2,
          }
        : null;
    });
    const formPanelWidth = geometry?.panelWidth ?? 0;
    // A form is the standard tier: a dialog, not a banner across the column.
    check(
      "a form sheet takes the standard width",
      formPanelWidth >= 500 && formPanelWidth <= 600,
      geometry,
    );
    check("panel is centred", geometry?.centred === true, geometry);
    check(
      "body and actions are within the panel",
      Boolean(geometry?.bodyInside && geometry?.actionsInside),
      geometry,
    );
    await shot(page, "desktop-sheet");

    // The shared Sheet supplies a scrim and an Escape handler; the hand-rolled
    // ones had neither, so a sheet could only be dismissed by its own button.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check("escape closes the task sheet", (await page.locator(".sheet-panel").count()) === 0);

    // A document sheet must actually be bigger than a form sheet, and must give
    // its height to the content: the memory editor used to scroll inside a
    // scrolling body, so a 5KB block showed about a dozen lines.
    await page.locator('nav.tabs button:text-is("Memory")').click();
    await page.waitForTimeout(1500);
    const memoryBlocks = await page.locator(".pane .list > li button").count();
    if (memoryBlocks === 0) {
      console.log("  SKIP  document sheet sizing (this agent has no memory blocks)");
    } else {
      await page.locator(".pane .list > li button").first().click();
      await page.waitForTimeout(600);
      const doc = await page.evaluate(() => {
        const panel = document.querySelector(".sheet-panel.fill");
        const body = document.querySelector(".sheet-panel.fill .sheet-body");
        const editor = document.querySelector(".sheet-panel.fill .memory-editor");
        if (!panel || !body || !editor) return null;
        return {
          panelWidth: Math.round(panel.getBoundingClientRect().width),
          editorHeight: Math.round(editor.getBoundingClientRect().height),
          // The body must NOT be the scroller; the editor must be.
          bodyScrolls: body.scrollHeight > body.clientHeight + 1,
        };
      });
      check("memory sheet fills its panel", doc !== null);
      // Width comes from the size tier, not `fill`: a document (spacious) takes
      // the 880px content column, a form the standard 560px.
      check(
        "a document sheet is wider than a form",
        (doc?.panelWidth ?? 0) > formPanelWidth + 200,
        {
          form: formPanelWidth,
          document: doc?.panelWidth,
        },
      );
      check("the editor gets the panel's height", (doc?.editorHeight ?? 0) > 300, doc);
      check("only one scroll region — the body does not scroll", doc?.bodyScrolls === false, doc);
      await shot(page, "desktop-memory-sheet");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }

    // Files must be retrievable, not just browsable. Anything the agent writes
    // — a tailored docx, a converted pdf — is otherwise stranded on the server.
    await page.locator('nav.tabs button:text-is("Files")').click();
    await page.waitForTimeout(1500);
    const fileRows = page.locator('.file-row button[aria-label^="Download "]');
    const downloadable = await fileRows.count();
    if (downloadable === 0) {
      // Asserting against an empty tree would pass for the wrong reason.
      console.log("  SKIP  a file downloads (no files in this agent's workspace)");
    } else {
      check("file rows carry a download button", downloadable > 0, { downloadable });

      // Prefer an ordinary file: a dotfile is a worse subject, because the
      // browser renames it on the way out (see below).
      const labels = await fileRows.evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label") ?? ""),
      );
      const names = labels.map((label) => label.replace(/^Download /, ""));
      const pick = Math.max(
        names.findIndex((name) => !name.startsWith(".")),
        0,
      );
      // Chromium strips leading dots from a download filename on purpose, so a
      // page cannot drop a hidden file into someone's Downloads folder. Nothing
      // we can or should override — the expectation is what the browser will
      // actually write.
      const expected = (names[pick] ?? "").replace(/^\.+/, "");

      // The only assertion that proves the blob actually reaches the browser's
      // download manager rather than just being built in memory.
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 15_000 }),
        fileRows.nth(pick).click(),
      ]);
      check(
        "a file download starts with the right name",
        download.suggestedFilename() === expected,
        {
          expected,
          got: download.suggestedFilename(),
        },
      );
      const filesBox = await overflow(page);
      check("files list has nothing clipped", filesBox.clipped.length === 0, filesBox);
      await shot(page, "desktop-files");
    }

    // Git history: the controls only exist for a folder inside a repository,
    // and the probed workspace usually is not one — so a missing pair is
    // asserted as a pair, and the sheet flow runs only when there is a repo.
    // Commit-row assertions still follow the download-skip idiom below: a row
    // asserted against an empty repository would pass for the wrong reason.
    const historyButton = page.locator('.pane-bar button:has-text("History")');
    const branchButton = page.locator('.pane-bar button:has-text("Branch")');
    if ((await historyButton.count()) === 0) {
      check("no git controls in a non-repository folder", (await branchButton.count()) === 0, {
        history: 0,
        branch: await branchButton.count(),
      });
      console.log("  SKIP  git actions (this workspace is not a git repository)");
    } else {
      check("Branch is on the Files pane bar", (await branchButton.count()) > 0);
      await historyButton.first().click();
      const historySheet = page.locator('.sheet-panel[aria-label="History"]');
      await historySheet.waitFor({ state: "visible", timeout: 5000 });
      const rows = historySheet.locator(".git-commits .git-commit");
      let isRepo = true;
      try {
        await rows.first().waitFor({ state: "visible", timeout: 5000 });
      } catch {
        isRepo = false;
      }
      const historyBox = await overflow(page);
      check("the history sheet has nothing clipped", historyBox.clipped.length === 0, historyBox);
      if (!isRepo) {
        console.log("  SKIP  commit rows and detail (this workspace is not a git repository)");
        await shot(page, "desktop-files-history");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        check(
          "escape closes the history sheet",
          (await page.locator('.sheet-panel[aria-label="History"]').count()) === 0,
        );
      } else {
        await rows.first().click();
        await historySheet.locator(".git-message").waitFor({ state: "visible", timeout: 5000 });
        check(
          "the commit detail renders its message",
          (await historySheet.locator(".git-message").count()) === 1,
        );
        const fileRows = await historySheet.locator(".git-file").count();
        const mergeNote = await historySheet.getByText("merge commits show none").count();
        check("the detail lists changed files (or says merge)", fileRows > 0 || mergeNote > 0, {
          fileRows,
          mergeNote,
        });
        const detailBox = await overflow(page);
        check("the commit detail has nothing clipped", detailBox.clipped.length === 0, detailBox);
        await shot(page, "desktop-files-history-detail");

        // Back to the list, then dismiss by clicking the scrim.
        await historySheet.locator('button:has-text("Commits")').click();
        await rows.first().waitFor({ state: "visible", timeout: 5000 });
        check(
          "Commits returns to the list",
          (await historySheet.locator(".git-commits .git-commit").count()) > 0,
        );
        await page.locator(".sheet-scrim").click();
        await page.waitForTimeout(300);
        check(
          "clicking outside closes the history sheet",
          (await page.locator('.sheet-panel[aria-label="History"]').count()) === 0,
        );
      }
    }

    // A reload must come back to the agent you were on. It used to land on
    // whichever one agent_list returned first, which on a phone meant losing
    // your place every time the tab was reloaded.
    await page.locator('nav.tabs button:text-is("Chat")').click();
    const agentIds = await page
      .locator(".sidebar .agent-row")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-agent-id") ?? ""));
    const openAgent = () =>
      page
        .locator(".sidebar .agent-row.active")
        .getAttribute("data-agent-id")
        .catch(() => null);

    if (agentIds.length < 2) {
      // Nothing to switch to, so the assertion would pass for the wrong reason.
      console.log("  SKIP  selection survives a reload (needs two agents)");
    } else {
      const before = await openAgent();
      const target = agentIds.find((id) => id !== before) ?? before ?? "";
      await page.locator(`.sidebar .agent-row[data-agent-id="${target}"] .agent-row-main`).click();
      await page.waitForTimeout(1500);
      const conversationBefore = await page
        .locator(".conversations li.active .conversation-name")
        .innerText()
        .catch(() => "");

      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(2000);
      const after = await openAgent();
      check("agent selection survives a reload", after === target, {
        expected: target,
        got: after,
      });
      if (conversationBefore) {
        const conversationAfter = await page
          .locator(".conversations li.active .conversation-name")
          .innerText()
          .catch(() => "");
        check(
          "conversation selection survives a reload",
          conversationAfter === conversationBefore,
          { expected: conversationBefore, got: conversationAfter },
        );
      }
    }

    await page.close();
  }

  // ── Activity indicators ──────────────────────────────────────────────────
  // A turn cannot be started on demand here, so the BFF's `__bff_activity`
  // frame is injected into a real session instead. What is asserted is what a
  // DOM count cannot see: the dot occupies space and is painted. It once
  // shipped with no CSS at all — present in the DOM, 0x0 on screen.
  section("Activity indicators");
  for (const viewport of [DESKTOP, PHONE]) {
    const page = await browser.newPage({ viewport });
    let inject: ((frame: string) => void) | null = null;
    await page.routeWebSocket(/\/ws$/, (ws) => {
      ws.connectToServer();
      inject = (frame) => ws.send(frame);
    });
    await page.goto(`${ORIGIN}/auth/dev-login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    // The sidebar stays mounted, hidden, on a phone, so this reads there too.
    const agentId = await page
      .locator(".sidebar .agent-row.active")
      .getAttribute("data-agent-id")
      .catch(() => null);
    const rows = page.locator(".conversations li:not(.activity-note)");
    if (!agentId || (await rows.count()) === 0 || !inject) {
      check(`${viewport.width}px: activity check has an agent and a conversation`, false);
      await page.close();
      continue;
    }
    const send = inject as (frame: string) => void;
    // Mark a conversation other than the open one, so the phone badge shows too.
    const selection = await page.evaluate(() => localStorage.getItem("lettuce:selection"));
    const openId = selection ? (JSON.parse(selection).conversationId as string | null) : null;
    send(
      JSON.stringify({
        type: "__bff_activity",
        active: [
          { agent_id: agentId, conversation_id: "default" },
          ...(openId ? [{ agent_id: agentId, conversation_id: openId }] : []),
        ],
      }),
    );
    await page.waitForTimeout(300);

    const painted = (selector: string) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { found: false };
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          found: true,
          width: rect.width,
          height: rect.height,
          background: style.backgroundColor,
          visible:
            rect.width >= 6 && rect.height >= 6 && style.backgroundColor !== "rgba(0, 0, 0, 0)",
        };
      }, selector);

    if (viewport === DESKTOP) {
      if (openId) {
        const dot = await painted(".conversations .conversation-name .activity-dot");
        check(
          "desktop: a responding conversation's dot is painted",
          dot.found && Boolean(dot.visible),
          dot,
        );
      }
      const note = await painted(".activity-note .activity-dot");
      check(
        "desktop: the default-conversation notice is painted",
        note.found && Boolean(note.visible),
        note,
      );
    } else {
      const badge = await painted(".topbar .badge-dot");
      check("phone: the menu badge is painted", badge.found && Boolean(badge.visible), badge);
    }

    // The status dot doubles as the way into the list of responding
    // conversations: while any scope is active it is a button, and clicking a
    // row switches to that conversation.
    const busyDot = page.locator(".topbar button.link-dot.busy");
    check(
      `${viewport.width}px: the status dot is a button while turns run`,
      (await busyDot.count()) === 1,
    );
    // A second conversation to switch to, taken from the sidebar list.
    const otherId = await page.evaluate((open) => {
      for (const row of document.querySelectorAll(".conversations li.conversation-row")) {
        const id = row.getAttribute("data-conversation-id");
        if (id && id !== open) return id;
      }
      return null;
    }, openId);
    if (otherId) {
      send(
        JSON.stringify({
          type: "__bff_activity",
          active: [
            { agent_id: agentId, conversation_id: "default" },
            ...(openId ? [{ agent_id: agentId, conversation_id: openId }] : []),
            { agent_id: agentId, conversation_id: otherId },
          ],
        }),
      );
      await page.waitForTimeout(200);
      await busyDot.click();
      const sheet = page.locator('.sheet-panel[aria-label="Responding now"]');
      await sheet.waitFor({ state: "visible", timeout: 3000 });
      check(`${viewport.width}px: the dot opens the responding list`, true);
      check(
        `${viewport.width}px: the default conversation shows as a note`,
        (await sheet.locator(".activity-note").count()) === 1,
      );
      // The open conversation first (marked as current), then the other one.
      const sheetRows = sheet.locator(".menu-row");
      const expectedRows = openId ? 2 : 1;
      check(
        `${viewport.width}px: the sheet lists the responding conversations`,
        (await sheetRows.count()) === expectedRows,
        { expected: expectedRows },
      );
      await shot(page, `activity-sheet-${viewport.width}`);
      await sheetRows.nth(openId ? 1 : 0).click();
      await sheet.waitFor({ state: "hidden", timeout: 3000 });
      const after = await page.evaluate(() => localStorage.getItem("lettuce:selection"));
      check(
        `${viewport.width}px: clicking a row switches to that conversation`,
        after !== null && JSON.parse(after).conversationId === otherId,
        { expected: otherId, got: after },
      );
    }
    await shot(page, `activity-${viewport.width}`);
    await page.close();
  }

  // ── Context gauge ────────────────────────────────────────────────────────
  // Usage lives in the BFF (`GET /api/turn-usage`), which knows only real
  // turns, so that route is stubbed with a cache-hit turn and one
  // `usage_statistics` delta is injected to make the page fetch it.
  // Asserted: the gauge lands in the top bar (not the composer, where it did
  // not fit on a phone), leaves the title room, the sheet shows the whole
  // prompt with its cache hit, and opens the limit editor. Nothing is saved —
  // the limit is real agent state.
  section("Context gauge");
  for (const viewport of [DESKTOP, PHONE]) {
    const page = await browser.newPage({ viewport });
    await page.route(/\/api\/turn-usage\?/, (route) =>
      route.fulfill({
        json: {
          current: null,
          last: {
            promptTokens: 790,
            cachedTokens: 24_655,
            lastPromptTokens: 25_445,
            lastCachedTokens: 24_655,
            cacheReported: true,
            completionTokens: 16,
            reasoningTokens: 13,
            steps: 1,
            contextTokens: 25_461,
          },
        },
      }),
    );
    let inject: ((frame: string) => void) | null = null;
    await page.routeWebSocket(/\/ws$/, (ws) => {
      ws.connectToServer();
      inject = (frame) => ws.send(frame);
    });
    await page.goto(`${ORIGIN}/auth/dev-login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    if (!inject) {
      check(`${viewport.width}px: context check has a session`, false);
      await page.close();
      continue;
    }
    (inject as (frame: string) => void)(
      JSON.stringify({
        type: "stream_delta",
        delta: {
          message_type: "usage_statistics",
          prompt_tokens: 25445,
          completion_tokens: 16,
          reasoning_tokens: 13,
          context_tokens: 25461,
        },
      }),
    );
    await page.waitForTimeout(300);
    const w = viewport.width;
    check(
      `${w}px: the composer no longer carries a token count`,
      (await page.locator(".composer .turn-usage").count()) === 0,
    );
    const gauge = page.locator(".topbar .ctx-gauge");
    check(`${w}px: the gauge is in the top bar`, (await gauge.count()) === 1);
    if ((await gauge.count()) === 1) {
      const label = (await gauge.innerText()).trim();
      check(`${w}px: the gauge reads used / limit`, /^\d+k \/ \d+k$/.test(label), label);
      const box = await gauge.boundingBox();
      check(`${w}px: the gauge is on screen`, !!box && box.x >= 0 && box.x + box.width <= w, box);
      const title = await page.locator(".topbar .where").boundingBox();
      check(`${w}px: the title keeps room beside it`, !!title && title.width >= 120, title);
      await shot(page, `context-gauge-${w}`);

      await gauge.click();
      const sheet = page.locator(".sheet");
      await sheet.waitFor({ timeout: 3000 }).catch(() => {});
      const text = await sheet.innerText().catch(() => "");
      check(
        `${w}px: the sheet shows the prompt size`,
        text.includes("Prompt") && text.includes("25,445"),
        text.slice(0, 200),
      );
      check(
        `${w}px: the sheet shows the cache hit`,
        text.includes("Cache hit") && text.includes("24,655") && text.includes("97% of prompt"),
        text.slice(0, 300),
      );
      const limitRow = page.locator(".kv-tap");
      await page
        .waitForFunction(() => !document.querySelector(".kv-tap:disabled"), null, { timeout: 5000 })
        .catch(() => {});
      check(`${w}px: the limit row is tappable`, await limitRow.isEnabled().catch(() => false));
      await shot(page, `context-sheet-${w}`);
      await limitRow.click().catch(() => {});
      const input = page.locator(".limit-edit input");
      check(`${w}px: tapping the limit opens the editor`, (await input.count()) === 1);
      check(
        `${w}px: the editor has presets and both scopes`,
        (await page.locator(".limit-preset").count()) === 3 &&
          (await page.locator(".limit-edit .menu-row").count()) === 2,
      );
      const { clipped } = await overflow(page);
      check(`${w}px: nothing clipped with the editor open`, clipped.length === 0, clipped);
      await shot(page, `context-limit-${w}`);
      await page
        .locator(".limit-actions .ghost")
        .click()
        .catch(() => {});
      check(
        `${w}px: Cancel returns to the limit row`,
        (await page.locator(".kv-tap").count()) === 1,
      );
    }
    await page.close();
  }

  // ── Enter on a phone ─────────────────────────────────────────────────────
  // A real touch device: coarse pointer, no hover. There Enter must add a new
  // line and never send — an accidental send cannot be taken back. A plain
  // phone-sized viewport does not emulate the pointer, hence the context.
  section("Enter on a touch device");
  {
    const context = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/auth/dev-login`, { waitUntil: "networkidle" });
    const textarea = page.locator(".composer textarea");
    await textarea.waitFor();
    await textarea.fill("first line");
    await textarea.press("End");
    await textarea.press("Enter");
    await textarea.pressSequentially("second line");
    const value = await textarea.inputValue();
    check("Enter adds a new line instead of sending", value === "first line\nsecond line", value);
    await textarea.fill("");
    await context.close();
  }

  // Inputs, selects and buttons share one height (--control-h). They had drifted
  // to five — 36 to 44px — with fields at 16px text beside 14px buttons. Touch
  // keeps 16px text (iOS zooms a focused input below that) but not a taller box.
  // `?settings=google` is the link an agent gives when Google access is lost:
  // it must open Settings on Google and leave no param behind to reopen it.
  section("Settings deep link");
  {
    const page = await open(browser, DESKTOP);
    await page.goto(`${ORIGIN}/?settings=google`, { waitUntil: "networkidle" });
    await page.locator(".settings-screen").waitFor({ timeout: 10_000 });
    check(
      "?settings=google opens Settings on Google",
      (await page.locator(".settings-content-title").innerText()) === "Google",
    );
    check("the param is stripped", !page.url().includes("settings="), page.url());
    await page.close();
  }

  section("Form controls share one height");
  for (const [label, options] of [
    ["mouse", { viewport: DESKTOP }],
    ["touch", { viewport: PHONE, isMobile: true, hasTouch: true }],
  ] as const) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/auth/dev-login`, { waitUntil: "networkidle" });
    await page.locator('nav.tabs button:text-is("Agent")').click();
    await page.locator('.section-tabs button:text-is("Reflection")').click();
    await page.locator(".field select").first().waitFor();
    const sizes = await page.evaluate(() => {
      const measure = (selector: string) => {
        const el = [...document.querySelectorAll<HTMLElement>(selector)].find(
          (candidate) => candidate.offsetParent !== null,
        );
        if (!el) return null;
        return {
          height: Math.round(el.getBoundingClientRect().height * 10) / 10,
          font: getComputedStyle(el).fontSize,
        };
      };
      return {
        input: measure('.field input:not([type="checkbox"])'),
        select: measure(".field select"),
        // The pane's buttons: the sidebar's heading actions are compact by design.
        button: measure(".main .button:not(.compact)"),
      };
    });
    const heights = Object.values(sizes)
      .filter((size) => size !== null)
      .map((size) => size.height);
    check(
      `${label}: input, select and button are one height`,
      heights.length >= 3 && heights.every((height) => height === heights[0]),
      sizes,
    );
    const fieldFont = label === "touch" ? "16px" : "14px";
    check(
      `${label}: field text is ${fieldFont}`,
      sizes.input?.font === fieldFont && sizes.select?.font === fieldFont,
      sizes,
    );
    await context.close();
  }

  // The desktop sidebar's rows: the open one marked by a left accent bar, like
  // the agent list's, and one ⋯ menu (the phone switcher's) instead of
  // rename/archive icons on every row.
  section("Sidebar conversation menu");
  {
    const page = await open(browser, DESKTOP);
    const active = page.locator(".sidebar .conversations li.conversation-row.active");
    await active.waitFor();
    const border = await active.evaluate((el) => ({
      color: getComputedStyle(el).borderLeftColor,
      width: getComputedStyle(el).borderLeftWidth,
    }));
    const accent = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    check(
      "the open conversation has the accent left bar",
      border.color === accent && border.width === "3px",
      { border, accent },
    );
    check(
      "rows carry no rename/archive icons",
      (await page.locator(".sidebar .conversations button[aria-label^='Rename']").count()) === 0,
    );
    await page.mouse.move(600, 400);
    const idle = page.locator(".sidebar .conversations li.conversation-row:not(.active)").first();
    check(
      "⋯ is hidden on a row not pointed at",
      (await idle.count()) === 0 || !(await idle.locator(".conversation-more").isVisible()),
    );
    await active.locator(".conversation-more").click();
    const menu = active.locator(".switcher-menu");
    check(
      "⋯ opens Rename and Archive",
      (await menu.isVisible()) &&
        (await menu.locator("button", { hasText: "Rename" }).count()) === 1 &&
        (await menu.locator("button", { hasText: /Archive|Unarchive/ }).count()) === 1,
    );
    await page.keyboard.press("Escape");
    check("Escape closes it", (await page.locator(".sidebar .switcher-menu").count()) === 0);
    await active.locator(".conversation-more").click();
    await page.locator(".main").click({ position: { x: 400, y: 300 } });
    check(
      "a click elsewhere closes it",
      (await page.locator(".sidebar .switcher-menu").count()) === 0,
    );
    await shot(page, "desktop-sidebar-menu");
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(
  failures === 0
    ? `\n✓ ui-check passed — screenshots in ${OUT_DIR}`
    : `\n✗ ui-check FAILED (${failures}) — screenshots in ${OUT_DIR}`,
);
process.exit(failures === 0 ? 0 : 1);
