/**
 * Ad-hoc visual pass for the sign-in surfaces, against the running container.
 *
 * Not part of the suite and not a `package.json` script: it mutates the stack it
 * points at. It claims an unclaimed instance, then spends five wrong passwords to
 * reach the lockout, so run it against a dev stack you are willing to own. What
 * it covers is the part `ui-check` cannot — a flow with state — and it leaves the
 * PNGs in .ui-check/ for the look at 390 and 1280.
 *
 *   UI_CHECK_PASSWORD=… bun scripts/signin-screens.ts [bffOrigin]
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const ORIGIN = process.argv[2] ?? "http://127.0.0.1:8090";
const PASSWORD = process.env.UI_CHECK_PASSWORD;
const OUT = ".ui-check";

/** Same trick ui-check uses: reuse a cached Chromium build instead of a 150 MB download. */
function chromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache)
    .filter((name) => name.startsWith("chromium"))
    .sort()
    .reverse();
  for (const build of builds) {
    for (const rel of [
      join(build, "chrome-linux64", "chrome"),
      join(build, "chrome-headless-shell-linux64", "chrome-headless-shell"),
    ]) {
      const candidate = join(cache, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const SIZES = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 900 },
];

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/signin-${name}.png`, fullPage: true });
  console.log(`  → ${OUT}/signin-${name}.png`);
}

async function main(): Promise<void> {
  if (!PASSWORD) throw new Error("UI_CHECK_PASSWORD is required");
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    ...(chromiumExecutable() ? { executablePath: chromiumExecutable() } : {}),
  });

  // 1. Unclaimed first run: the setup form.
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
    await shot(page, `setup-${size.name}`);
    console.log(`  heading: ${await page.locator("h1, h2").first().innerText()}`);
    await page.close();
  }

  // 2. Mismatch, then the real submit — the same page signs you in.
  const page = await browser.newPage({ viewport: { width: SIZES[0]!.width, height: 844 } });
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  const fields = page.locator('input[type="password"]');
  await fields.nth(0).fill(PASSWORD);
  await fields.nth(1).fill(`${PASSWORD}x`);
  await page.getByRole("button", { name: /set password/i }).click();
  await page.waitForTimeout(400);
  await shot(page, "setup-mismatch-390");
  console.log(`  mismatch: ${await page.locator(".warning").first().innerText()}`);

  await fields.nth(1).fill(PASSWORD);
  await page.getByRole("button", { name: /set password/i }).click();
  await page.waitForSelector(".app", { timeout: 15_000 });
  await page.waitForTimeout(1_500);
  console.log(
    "  claimed and signed in:",
    await page.locator(".topbar h2, .topbar").first().innerText(),
  );

  // 3. Settings → Access and → Sign-in, at both sizes, now that there is a session.
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const section of ["access", "signin"]) {
      await page.goto(`${ORIGIN}/?settings=${section}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);
      await page.screenshot({
        path: `${OUT}/signin-settings-${section}-${size.name}.png`,
        fullPage: true,
      });
      console.log(`  → ${OUT}/signin-settings-${section}-${size.name}.png`);
    }
  }

  // 4. Signed out: the password form (not setup any more), then the lockout.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => fetch("/auth/logout", { method: "POST" }));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
    const field = page.locator('input[type="password"]').first();
    if (!(await field.count())) break;
    await field.fill("definitely-not-the-password");
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForTimeout(500);
  }
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await page.locator('input[type="password"]').first().fill("definitely-not-the-password");
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForTimeout(500);
  await shot(page, "lockout-390");
  console.log(`  after five wrong: ${await page.locator(".warning").first().innerText()}`);

  await browser.close();
}

await main();
