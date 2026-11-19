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

/**
 * Parse the arguments by walking them, not by `indexOf`: with `indexOf`, a value
 * that happens to start with `--` (`--out --weird.png`) is read as a filename and
 * writes a file nobody asked for, and `--width --x` becomes a `NaN` window size.
 */
const options: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i] as string;
  if (!arg.startsWith("--")) {
    positional.push(arg);
    continue;
  }
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`✗ ${arg} needs a value that is not another flag`);
    process.exit(2);
  }
  options[arg] = value;
  i += 1;
}

function take(name: string, fallback: string): string {
  return options[name] ?? fallback;
}

function takeSize(name: string, fallback: number): number {
  const raw = options[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 8192) {
    console.error(`✗ ${name} wants a whole pixel count between 1 and 8192, got "${raw}"`);
    process.exit(2);
  }
  return value;
}

const source = positional[0];
if (!source) {
  console.error(
    "usage: bun scripts/mockup.ts <file.html> [--width 1280] [--height 900] [--out <png>]",
  );
  process.exit(2);
}
if (positional.length > 1) {
  console.error(`✗ unexpected extra argument: ${positional.slice(1).join(" ")}`);
  process.exit(2);
}

const html = resolve(source);
if (!existsSync(html)) {
  console.error(`no such file: ${html}`);
  process.exit(2);
}
const width = takeSize("--width", 1280);
const height = takeSize("--height", 900);
const out = resolve(
  take(
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
