/**
 * Render one HTML file to a PNG — the sanctioned way to turn a mockup into a
 * picture, because every UI flow was retyping the same five-flag incantation
 * (six times in one flow) or hand-rolling a python variant that failed twice.
 *
 * The flags are not decoration. Headless chromium renders a `--window-size` page
 * with a *coarse* pointer unless told otherwise, so a mock of the desktop layout
 * silently came back with the phone layout — the failure mode this file exists to
 * make impossible. It also refuses to render a page whose stylesheet `<link>` does
 * not resolve: a mock with a dead href renders unstyled and looks like a styling
 * bug in the app rather than a typo in the mock.
 *
 * Usage: bun scripts/mockup.ts <file.html> [--width 1280] [--height 900] [--out <png>]
 *
 * The two widths the UI gates care about are 1280 (desktop) and 390 (phone); the
 * stylesheet is linked from the checkout, so a mock in a plan directory points at
 * it with a relative path — see `lettuce-ui-verification` for which checkout's
 * stylesheet a mock may link.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromiumExecutable, headlessRenderArgs } from "./harness.ts";

const argv = process.argv.slice(2);

function flag(name: string, fallback: string): string {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
}

const source = argv.find((arg) => !arg.startsWith("--") && !isFlagValue(arg));
if (!source) {
  console.error(
    "usage: bun scripts/mockup.ts <file.html> [--width 1280] [--height 900] [--out <png>]",
  );
  process.exit(2);
}
/** The argument after a value-taking flag is not the positional, even bare. */
function isFlagValue(arg: string): boolean {
  const i = argv.indexOf(arg);
  return i > 0 && ["--width", "--height", "--out"].includes(argv[i - 1] as string);
}

const html = resolve(source);
if (!existsSync(html)) {
  console.error(`no such file: ${html}`);
  process.exit(2);
}
const width = Number(flag("--width", "1280"));
const height = Number(flag("--height", "900"));
const out = resolve(
  flag(
    "--out",
    join(
      dirname(html),
      `${html
        .split("/")
        .pop()
        ?.replace(/\.html?$/, "")}.png`,
    ),
  ),
);

// ── The stylesheet must resolve, or the picture lies ──────────────────────────
const htmlText = readFileSync(html, "utf-8");
const css = htmlText.match(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/g) ?? [];
const hrefs = css
  .map((tag) => tag.match(/href=["']([^"']+)["']/)?.[1])
  .filter((href): href is string => !!href);
if (hrefs.length === 0) {
  console.error(
    `✗ ${source} links no stylesheet. A mock renders through the app's own ` +
      "`web/src/styles.css`, or it proves nothing about layout. See lettuce-ui-verification.",
  );
  process.exit(1);
}
for (const href of hrefs) {
  if (href.startsWith("http://") || href.startsWith("https://")) continue;
  const target = resolve(dirname(html), href);
  if (!existsSync(target)) {
    console.error(
      `✗ ${source} links ${href}, which resolves to ${target} — nothing there. ` +
        "A dead stylesheet renders an unstyled page that looks like a broken design.",
    );
    process.exit(1);
  }
  console.log(`stylesheet: ${href} (${(statSync(target).size / 1024).toFixed(1)} KB)`);
}

// ── Render ────────────────────────────────────────────────────────────────────
const executable = chromiumExecutable();
if (!executable) {
  console.error("No Chromium found. Run `npx playwright install --with-deps chromium`.");
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });

const args = headlessRenderArgs(`file://${html}`, out, width, height);
console.log(`chromium: ${executable}`);
const result = Bun.spawnSync([executable, ...args], { stdout: "pipe", stderr: "pipe" });
const log = new TextDecoder().decode(result.stderr);

if (result.exitCode !== 0 || !existsSync(out)) {
  console.error(`✗ chromium exited ${result.exitCode} and wrote no PNG.\n${log}`);
  process.exit(1);
}
const bytes = statSync(out).size;
if (bytes < 1024) {
  console.error(`✗ ${out} is ${bytes} bytes — that is a blank page, not a mock.\n${log}`);
  process.exit(1);
}
console.log(`✓ ${out} (${width}x${height}, ${(bytes / 1024).toFixed(1)} KB)`);
