/**
 * Isolated browser automation for the coding agent.
 *
 * Opens a URL in a headless Chromium session, optionally runs a sequence of
 * approved interaction steps (click / fill / wait), captures console messages,
 * takes a full-page screenshot, and returns structured results the agent can
 * reason about directly.
 *
 * Browser binaries are installed lazily on first use and are then reused for
 * all subsequent calls in the same server process.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────────────────────────────────────

export type InteractionStep =
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "wait"; ms: number }
  | { type: "navigate"; url: string };

export interface BrowserScreenshotOptions {
  url: string;
  viewportWidth?: number;
  viewportHeight?: number;
  /** 'load' | 'networkidle' | 'domcontentloaded' — default 'load' */
  waitFor?: string;
  interactions?: InteractionStep[];
  /** Overall timeout in milliseconds (default 30 000) */
  timeoutMs?: number;
  /**
   * The one localhost port the browser is allowed to contact — must match the
   * project's active preview server port.  Every other localhost / private-IP /
   * metadata request is aborted at the Playwright network layer, covering
   * redirects, XHR, WebSocket upgrades, and all subresource fetches.
   * Pass `null` to forbid all loopback access.
   */
  allowedLocalhostPort: number | null;
}

export interface BrowserScreenshotResult {
  /** Base-64 encoded PNG screenshot */
  screenshotB64: string;
  /** Page <title> at time of screenshot */
  title: string;
  /** Final URL after any redirects */
  finalUrl: string;
  /** Console messages captured during the session */
  consoleLogs: Array<{ level: string; text: string }>;
  /** Any JS errors thrown on the page */
  pageErrors: string[];
  /** Which interaction steps completed before the screenshot */
  interactionsCompleted: string[];
  /** Steps that failed (selector not found, timeout, etc.) */
  interactionErrors: string[];
}

// ── Browser readiness ─────────────────────────────────────────────────────────

let browserReady: boolean | null = null; // null = unknown

/**
 * Build a secret-free environment for child processes that run Chromium.
 * Defined at module level so both the readiness probe and the screenshot runner
 * use the identical sanitized environment.
 */
function buildSafeChildEnv(): Record<string, string> {
  const safeEnv: Record<string, string> = {};
  for (const key of [
    "PATH", "HOME", "DISPLAY", "XAUTHORITY",
    "PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
  ]) {
    if (process.env[key] !== undefined) safeEnv[key] = process.env[key] as string;
  }
  return safeEnv;
}

/**
 * Attempt a real minimal headless Chromium launch in a child process.
 * Returns true when the launch succeeds, false on any error.
 *
 * Checking only `chromium.executablePath()` is NOT sufficient: `headless: true`
 * requires the separate `chromium_headless_shell` binary, which is only present
 * after a full `playwright install chromium`.  A path-existence check can pass
 * while the actual headless launch fails.
 */
async function probeLaunch(): Promise<boolean> {
  try {
    await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { chromium } from 'playwright';
         const b = await chromium.launch({ headless: true });
         await b.close();`,
      ],
      { timeout: 25_000, env: buildSafeChildEnv() },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the Playwright Chromium binary (including headless shell) is installed
 * and actually launchable.  Installs if the probe fails and then verifies the
 * install by probing again — guaranteeing that a successful return means the
 * tool will work, not merely that some executable file exists on disk.
 */
async function ensureBrowser(): Promise<void> {
  if (browserReady === true) return;

  if (await probeLaunch()) {
    browserReady = true;
    return;
  }

  // Install Chromium + system dependencies (~150 MB on first run).
  await execFileAsync(
    "npx",
    ["playwright", "install", "chromium", "--with-deps"],
    { timeout: 300_000 }, // 5 min download budget
  );

  // Confirm the install works with a second real launch — if this fails we
  // surface a clear error rather than silently returning a tool failure later.
  if (!await probeLaunch()) {
    throw new Error(
      "Chromium was installed but headless launch still fails. " +
      "Check that system dependencies are present (run: npx playwright install-deps chromium).",
    );
  }

  browserReady = true;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Open `url` in a headless browser, run optional interaction steps, take a
 * screenshot, and return the structured result.
 */
export async function browserScreenshot(
  opts: BrowserScreenshotOptions
): Promise<BrowserScreenshotResult> {
  const {
    url,
    viewportWidth = 1280,
    viewportHeight = 800,
    waitFor = "load",
    interactions = [],
    timeoutMs = 30_000,
    allowedLocalhostPort,
  } = opts;

  await ensureBrowser();

  // Run the browser session in a child process so any crash doesn't take down
  // the main API server process and so we get a clean context every time.
  const script = buildBrowserScript({
    url,
    viewportWidth,
    viewportHeight,
    waitFor,
    interactions,
    timeoutMs,
    allowedLocalhostPort: allowedLocalhostPort ?? null,
  });

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      timeout: timeoutMs + 10_000,
      maxBuffer: 50 * 1024 * 1024, // 50 MB for screenshots
      // Scrub application secrets from the child process environment before
      // spawning Chromium.  Even when --disable-setuid-sandbox is active, a
      // renderer exploit can only access the sanitized env — not JWT_SECRET,
      // STUDIO_MASTER_KEY, DATABASE_URL, or any other server secret.
      env: buildSafeChildEnv(),
    },
  );

  const result = JSON.parse(stdout) as BrowserScreenshotResult;
  return result;
}

// ── Script builder ────────────────────────────────────────────────────────────

function buildBrowserScript(opts: {
  url: string;
  viewportWidth: number;
  viewportHeight: number;
  waitFor: string;
  interactions: InteractionStep[];
  timeoutMs: number;
  allowedLocalhostPort: number | null;
}): string {
  // Serialize options into the generated script as JSON so no shell-escaping is needed.
  const payload = JSON.stringify(opts);

  return `
import { chromium } from 'playwright';

const opts = ${payload};

// ── Network-level SSRF guard ─────────────────────────────────────────────────
// The tool is restricted to the project's own localhost preview server.
//
// Two complementary layers enforce this:
//
//   1. Chrome --host-resolver-rules (connection-time enforcement):
//      Chrome's built-in DNS resolver is configured to return NOTFOUND for
//      every hostname except "localhost".  This pins the resolver at the
//      engine level and closes the DNS-rebinding TOCTOU gap — there is no
//      window between our check and Chrome's actual connection attempt.
//      Requests to plain IP addresses bypass the resolver, so the route
//      interceptor below handles those.
//
//   2. page.route interceptor (belt-and-suspenders for direct-IP requests):
//      Catches any request whose URL contains a raw IP address (which Chrome
//      connects to directly without a DNS lookup) and blocks everything except
//      the designated localhost preview port.

function isBlockedUrl(rawUrl) {
  // data: and blob: carry no SSRF risk.
  if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return false;
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return true; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;

  // Strip trailing dots (a trailing "." is a common hostname-check bypass).
  const hostname = parsed.hostname.toLowerCase().replace(/\\.+$/, '');

  // Only the project preview port on localhost is reachable.
  // Anything that is not a loopback address is blocked here (for direct-IP
  // requests) and at the Chrome DNS level (for hostname-based requests).
  const isLoopback = hostname === 'localhost' || /^127\\./.test(hostname) ||
                     hostname === '::1' || hostname === '0:0:0:0:0:0:0:1';

  if (!isLoopback) return true; // all non-loopback addresses are blocked

  if (opts.allowedLocalhostPort === null) return true;
  const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
  return port !== opts.allowedLocalhostPort;
}

const browser = await chromium.launch({
  headless: true,
  args: [
    // --no-sandbox is required in container environments (Replit, Docker) where
    // the kernel's user-namespace or seccomp configuration prevents Chromium from
    // creating its own sandbox.  The container itself provides process isolation.
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    // Pin Chrome's DNS resolver: only "localhost" may be resolved.  All other
    // hostnames return NOTFOUND immediately — no network lookup occurs, no
    // DNS-rebinding window exists.  Raw IP addresses bypass this (they need no
    // DNS), which is why the route interceptor above handles those separately.
    '--host-resolver-rules=MAP * ~NOTFOUND EXCLUDE localhost',
  ],
});
const ctx = await browser.newContext({
  viewport: { width: opts.viewportWidth, height: opts.viewportHeight },
  userAgent: 'Mozilla/5.0 (compatible; ClownInAgent/1.0; +browserScreenshot)',
  // Block service workers — page.route() does not intercept requests made by
  // service workers, so an attacker-controlled page could register one and use
  // it to reach private-network destinations outside the SSRF guard.
  serviceWorkers: 'block',
});
// ── Context-level network guards (cover ALL pages including popups) ────────────

// Block all HTTP(S) requests — applied at the context level so it covers the
// initial navigation of any popup the page opens, not just the main page.
await ctx.route('**/*', async (route) => {
  if (isBlockedUrl(route.request().url())) {
    await route.abort('addressunreachable');
  } else {
    await route.continue();
  }
});

// Block all WebSocket connections — page.route / context.route do NOT govern
// WebSocket handshakes; context.routeWebSocket is required.  Screenshots have
// no need for live sockets, so we close every one before it connects.
await ctx.routeWebSocket('**', (ws) => { ws.close(); });

const page = await ctx.newPage();

// Close any popup (new tab / window) the page tries to open before it can
// issue its own navigation to a private address.  The context-level route
// guard above also fires for popup navigations, but closing the popup
// immediately is the more robust additional defence.  We register this
// handler AFTER creating the main page so that the 'page' event for the
// main page itself is not captured by this handler.
ctx.on('page', (popup) => { if (popup !== page) popup.close().catch(() => {}); });

const consoleLogs = [];
const pageErrors = [];

page.on('console', (msg) => {
  consoleLogs.push({ level: msg.type(), text: msg.text().slice(0, 500) });
});
page.on('pageerror', (err) => {
  pageErrors.push(err.message.slice(0, 500));
});

const waitUntil = ['load', 'networkidle', 'domcontentloaded'].includes(opts.waitFor) ? opts.waitFor : 'load';

try {
  await page.goto(opts.url, { waitUntil, timeout: opts.timeoutMs });
} catch (navErr) {
  await browser.close();
  const empty = Buffer.from('').toString('base64');
  process.stdout.write(JSON.stringify({
    screenshotB64: empty,
    title: '',
    finalUrl: opts.url,
    consoleLogs,
    pageErrors: [navErr.message || String(navErr)],
    interactionsCompleted: [],
    interactionErrors: ['Navigation failed: ' + (navErr.message || String(navErr))],
  }));
  process.exit(0);
}

const interactionsCompleted = [];
const interactionErrors = [];

for (const step of opts.interactions) {
  try {
    if (step.type === 'click') {
      await page.locator(step.selector).first().click({ timeout: 5000 });
      interactionsCompleted.push('click ' + step.selector);
    } else if (step.type === 'fill') {
      await page.locator(step.selector).first().fill(step.value, { timeout: 5000 });
      interactionsCompleted.push('fill ' + step.selector);
    } else if (step.type === 'wait') {
      await page.waitForTimeout(Math.min(step.ms, 10000));
      interactionsCompleted.push('wait ' + step.ms + 'ms');
    } else if (step.type === 'navigate') {
      await page.goto(step.url, { waitUntil, timeout: opts.timeoutMs });
      interactionsCompleted.push('navigate ' + step.url);
    }
  } catch (stepErr) {
    interactionErrors.push(step.type + (step.selector ? ' ' + step.selector : '') + ': ' + (stepErr.message || String(stepErr)).slice(0, 200));
  }
}

const title = await page.title().catch(() => '');
const finalUrl = page.url();
const screenshotBuf = await page.screenshot({ type: 'png', fullPage: true });
const screenshotB64 = screenshotBuf.toString('base64');

await browser.close();

process.stdout.write(JSON.stringify({
  screenshotB64,
  title,
  finalUrl,
  consoleLogs,
  pageErrors,
  interactionsCompleted,
  interactionErrors,
}));
`;
}
