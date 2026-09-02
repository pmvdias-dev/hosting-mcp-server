import { chromium } from 'playwright';
import fs from 'fs';
import readline from 'readline';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import {
  chromiumExtra,
  generateAndPinUserAgent,
  getProxyConfig,
  STEALTH_LAUNCH_ARGS,
} from './scrapers/stealth-browser.js';

// Absolute paths — important. This module is imported by index.js (the MCP
// server), which may be launched with a different cwd than the project root.
// Relative './sessions/...' paths silently wrote/read from the wrong place
// in that case. Everything below is anchored to this file's own directory.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(__dirname, 'sessions');

// ─── Minimal .env reader ─────────────────────────────────────────────────
// No dotenv dependency — parses KEY=VALUE lines from ./env at the repo root.
function loadEnv() {
  const envPath = join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  const raw = fs.readFileSync(envPath, 'utf-8');
  raw.split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const idx = t.indexOf('=');
    if (idx < 0) return;
    const key = t.slice(0, idx).trim();
    let val = t.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  });
  return out;
}

// ─── Booking automated login ─────────────────────────────────────────────
// Uses stored credentials from .env (BOOKING_EMAIL + BOOKING_PASSWORD) to
// perform a headless login and refresh the persistent Playwright profile.
// Returns { success, reason?, message? }. Kept isolated from saveBookingSession
// so the manual browser flow is untouched.
export async function attemptAutoLoginBooking({ log = null } = {}) {
  const emit = log ?? ((msg) => process.stderr.write(`[auto-login-booking] ${msg}\n`));
  const env = loadEnv();
  const email = env.BOOKING_EMAIL;
  const password = env.BOOKING_PASSWORD;
  if (!email || !password) {
    emit('no BOOKING_EMAIL/BOOKING_PASSWORD in .env — cannot auto-login');
    return { success: false, reason: 'no-credentials' };
  }
  const { profileDir } = PLATFORMS.booking;
  fs.mkdirSync(profileDir, { recursive: true });

  const pinnedUA = generateAndPinUserAgent();
  const proxy = getProxyConfig();

  let context;
  try {
    context = await chromiumExtra.launchPersistentContext(profileDir, {
      headless: true,
      args: [...STEALTH_LAUNCH_ARGS],
      viewport: { width: 1280, height: 800 },
      userAgent: pinnedUA,
      ...(proxy ? { proxy } : {}),
    });
  } catch (err) {
    emit(`launch failed: ${err.message}`);
    return { success: false, reason: 'launch-failed', message: err.message };
  }

  const page = context.pages()[0] ?? (await context.newPage());
  // On any failure we save a screenshot + the current URL to sessions/ so you
  // can eyeball what page Booking landed on.
  const dumpDebug = async (label) => {
    try {
      const debugPath = join(SESSIONS_DIR, `auto-login-debug-${label}.png`);
      await page.screenshot({ path: debugPath, fullPage: true });
      const urlPath = join(SESSIONS_DIR, `auto-login-debug-${label}.txt`);
      fs.writeFileSync(urlPath, `URL: ${page.url()}\nTITLE: ${await page.title().catch(() => '?')}\n`, 'utf-8');
      emit(`saved debug screenshot: ${debugPath}`);
    } catch (e) { emit(`debug dump failed: ${e.message}`); }
  };

  // Booking's login uses varying selectors — try a broad set, first match wins.
  // Includes the current data-testid pattern plus historical name/id/aria variants.
  const EMAIL_SELECTORS = [
    'input[data-testid*="username" i]',
    'input[data-testid*="email" i]',
    'input[data-testid*="loginname" i]',
    'input[aria-label*="email" i]',
    'input[aria-label*="username" i]',
    'input[name="username"]',
    'input[name="loginname"]',
    'input[name="email"]',
    'input[type="email"]',
    'input[id*="username" i]',
    'input[id*="loginname" i]',
    'input[id*="email" i]',
    'input:not([type="hidden"])[autocomplete*="username" i]',
    'input:not([type="hidden"])[autocomplete*="email" i]',
  ];
  const PASSWORD_SELECTORS = [
    'input[data-testid*="password" i]',
    'input[aria-label*="password" i]',
    'input[name="password"]',
    'input[type="password"]',
    'input[id*="password" i]',
    'input:not([type="hidden"])[autocomplete*="password" i]',
  ];
  const SUBMIT_SELECTORS = [
    'button[type="submit"]:not([disabled])',
    'button[data-testid*="submit" i]',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
  ];

  async function waitAnySelector(page, selectors, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const sel of selectors) {
        const el = await page.$(sel).catch(() => null);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) return { el, sel };
        }
      }
      await page.waitForTimeout(500);
    }
    return null;
  }

  try {
    emit('navigating to admin.booking.com');
    // Let Booking's own redirect chain take us to whatever sign-in URL applies
    // to this profile (op_token is a per-session nonce — hardcoding an empty
    // one lands on the wrong variant).
    await page.goto('https://admin.booking.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2000); // let Cloudflare / JS finish

    let currentUrl = page.url();
    emit(`landed on: ${currentUrl}`);

    // ── CAPTCHA check ──
    // Booking blocks headless automation with an image-CAPTCHA ("Let's make
    // sure you're human"). Detect it as early as possible so we don't waste
    // time trying to find form fields on a page that has none.
    const detectCaptcha = async () => {
      const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (/let'?s make sure you'?re human|not a robot|prove you'?re human|choose all the/i.test(body)) return true;
      const captchaEl = await page.$('img[src*="captcha" i], [class*="captcha" i], [id*="captcha" i]').catch(() => null);
      return !!captchaEl;
    };
    if (await detectCaptcha()) {
      emit('CAPTCHA detected on page');
      await dumpDebug('captcha');
      return { success: false, reason: 'captcha', message: `CAPTCHA on: ${currentUrl}` };
    }

    // Sometimes the persistent profile already has a valid session — in that
    // case we bounce straight to the extranet and there's no form to fill.
    if (/admin\.booking\.com\/hotel/.test(currentUrl) && !/sign-?in|login/i.test(currentUrl)) {
      emit('already authenticated — session was still valid');
    } else {
      // Step 1: username
      const emailHit = await waitAnySelector(page, EMAIL_SELECTORS, 15_000);
      if (!emailHit) {
        emit('email field not found on page');
        await dumpDebug('no-email-field');
        return { success: false, reason: 'no-email-field', message: `Final URL: ${page.url()}` };
      }
      emit(`email field matched: ${emailHit.sel}`);
      await emailHit.el.fill(email);

      // Click Continue/Next
      const nextHit = await waitAnySelector(page, SUBMIT_SELECTORS, 5_000);
      if (nextHit) { emit(`clicking submit (email step): ${nextHit.sel}`); await nextHit.el.click(); }
      await page.waitForTimeout(1500);
      emit(`after email submit: ${page.url()}`);

      // Re-check for CAPTCHA — Booking may only show it after email submit
      if (await detectCaptcha()) {
        emit('CAPTCHA detected after email submit');
        await dumpDebug('captcha-after-email');
        return { success: false, reason: 'captcha', message: `CAPTCHA on: ${page.url()}` };
      }

      // Step 2: password
      const passHit = await waitAnySelector(page, PASSWORD_SELECTORS, 20_000);
      if (!passHit) {
        emit('password field not found');
        await dumpDebug('no-password-field');
        // If we're still on Booking's sign-in URL with no password field, it's
        // almost always a CAPTCHA that the earlier detector missed (iframe /
        // shadow-root). Treat it as CAPTCHA so the cooldown applies.
        if (/account\.booking\.com\/sign-in/i.test(page.url())) {
          return { success: false, reason: 'captcha', message: `Likely CAPTCHA (no password field, still on ${page.url()})` };
        }
        return { success: false, reason: 'no-password-field', message: `Final URL: ${page.url()}` };
      }
      emit(`password field matched: ${passHit.sel}`);
      await passHit.el.fill(password);

      const signHit = await waitAnySelector(page, SUBMIT_SELECTORS, 5_000);
      if (signHit) { emit(`clicking submit (password step): ${signHit.sel}`); await signHit.el.click(); }

      // Wait for extranet redirect. If we get bounced to CAPTCHA / 2FA /
      // account picker, `waitForURL` will time out and we'll return failure.
      await page.waitForURL(/admin\.booking\.com\/hotel/, { timeout: 30_000 })
        .catch(() => { /* checked below */ });
      currentUrl = page.url();
      emit(`post-submit URL: ${currentUrl}`);
    }

    // Detect challenge / non-extranet landings
    if (/captcha|challenge|verify|2fa|otp|security/i.test(currentUrl)) {
      emit(`hit challenge page: ${currentUrl}`);
      await dumpDebug('challenge');
      return { success: false, reason: 'challenge', message: `Landed on: ${currentUrl}` };
    }
    if (!/admin\.booking\.com\/hotel/.test(currentUrl)) {
      emit(`did not reach extranet — final URL: ${currentUrl}`);
      await dumpDebug('not-extranet');
      return { success: false, reason: 'not-extranet', message: `Final URL: ${currentUrl}` };
    }

    // Confirm session cookies landed
    await page.waitForTimeout(1500); // let auth cookies settle
    const state = await context.storageState();
    const ssoAuth = state.cookies?.find((c) => c.name === 'bkng_sso_auth');
    const esadm = state.cookies?.find((c) => c.name === 'esadm');
    const hasAuth = (ssoAuth?.value?.length ?? 0) >= 50;
    const hasExtranet = (esadm?.value?.length ?? 0) >= 30;
    if (!hasAuth || !hasExtranet) {
      emit(`session cookies missing — hasAuth=${hasAuth} hasExtranet=${hasExtranet}`);
      return { success: false, reason: 'missing-cookies' };
    }

    // Persist state.json AND update the saved reservations URL (grab whatever
    // hotel URL we landed on so subsequent scraper calls use it).
    const sessionFile = join(SESSIONS_DIR, 'booking-session.json');
    fs.writeFileSync(sessionFile, JSON.stringify(state, null, 2), 'utf-8');

    const parsedUrl = new URL(currentUrl);
    parsedUrl.searchParams.delete('ses');
    const hotelId = parsedUrl.searchParams.get('hotel_id') ?? null;
    if (hotelId) {
      fs.writeFileSync(
        join(SESSIONS_DIR, 'booking-property.json'),
        JSON.stringify({ hotelId, hotelName: 'Central & Cosy - Easy Access Ground Floor Flat' }, null, 2),
        'utf-8'
      );
    }

    emit(`✓ auto-login succeeded (hotelId=${hotelId ?? 'unknown'})`);
    return { success: true, hotelId };
  } catch (err) {
    emit(`error: ${err.message}`);
    return { success: false, reason: 'error', message: err.message };
  } finally {
    try { await context.close(); } catch { /* ignore */ }
  }
}

const PLATFORMS = {
  airbnb: {
    loginUrl: 'https://www.airbnb.com/login',
    cookieFile: join(SESSIONS_DIR, 'airbnb-session.json'),
  },
  booking: {
    loginUrl: 'https://admin.booking.com',
    // Persistent profile dir — session stays valid across scraper runs
    profileDir: join(SESSIONS_DIR, 'booking-profile'),
  },
};

// ─── Booking.com: auto-detecting session refresh ──────────────────────────
//
// Opens a visible (headed) browser on the SAME persistent profile the
// headless scraper reuses. No terminal interaction required: it polls the
// page every 2s, and the moment it sees a valid extranet session it writes
// the session files to disk and closes the browser itself. If the user
// closes the browser first, it resolves with success: false instead of
// hanging or throwing.
//
// `log` defaults to stderr so this is safe to call from the MCP server
// (index.js talks JSON-RPC over stdout via StdioServerTransport — writing
// to stdout here would corrupt that stream). The CLI entrypoint below
// passes console.log explicitly for a nicer terminal experience.
export async function saveBookingSession({ timeoutMs = 10 * 60 * 1000, log = null } = {}) {
  const emit = log ?? ((msg) => process.stderr.write(`[save-session] ${msg}\n`));
  const { loginUrl, profileDir } = PLATFORMS.booking;

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const pinnedUA = generateAndPinUserAgent();
  emit('Generated UA for this session: ' + pinnedUA);

  const proxy = getProxyConfig();
  if (proxy) emit('Using proxy: ' + proxy.server);

  let context;
  try {
    context = await chromiumExtra.launchPersistentContext(profileDir, {
      headless: false,
      args: ['--start-maximized', ...STEALTH_LAUNCH_ARGS],
      viewport: null,
      userAgent: pinnedUA,
      ...(proxy ? { proxy } : {}),
    });
  } catch (err) {
    return {
      success: false,
      reason: 'launch-failed',
      message:
        `Could not open the browser: ${err.message}. ` +
        `If another session-refresh window is already open, close it first — ` +
        `only one process can use the booking-profile folder at a time.`,
    };
  }

  let closed = false;
  context.on('close', () => { closed = true; });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(loginUrl);

  // ── Auto-fill from .env (visible browser is safe from bot detection) ──
  // If BOOKING_EMAIL + BOOKING_PASSWORD are in .env, silently type them into
  // the login form and click through. User only needs to touch the browser
  // for OTP / CAPTCHA / auth-assurance. If auto-fill fails at any step, we
  // just leave the browser open and let the user type it in manually.
  const envCreds = loadEnv();
  if (envCreds.BOOKING_EMAIL && envCreds.BOOKING_PASSWORD) {
    // Fire and forget — the polling loop below still handles success detection
    // regardless of whether this succeeds.
    (async () => {
      try {
        // Wait for Booking to redirect from admin.booking.com → account.booking.com/sign-in
        await page.waitForTimeout(2000);

        const EMAIL_SELECTORS = [
          'input[data-testid*="username" i]',
          'input[data-testid*="email" i]',
          'input[name="username"]',
          'input[name="loginname"]',
          'input[name="email"]',
          'input[type="email"]',
        ];
        const PASSWORD_SELECTORS = [
          'input[data-testid*="password" i]',
          'input[name="password"]',
          'input[type="password"]',
        ];
        const SUBMIT_SELECTORS = [
          'button[type="submit"]:not([disabled])',
          'button:has-text("Continue")',
          'button:has-text("Sign in")',
          'button:has-text("Log in")',
        ];
        const waitAny = async (sels, timeout) => {
          const start = Date.now();
          while (Date.now() - start < timeout) {
            for (const s of sels) {
              const el = await page.$(s).catch(() => null);
              if (el && (await el.isVisible().catch(() => false))) return { el, sel: s };
            }
            await page.waitForTimeout(400);
          }
          return null;
        };

        const emailHit = await waitAny(EMAIL_SELECTORS, 12_000);
        if (!emailHit) { emit('auto-fill: email field not found — user can type manually'); return; }
        emit(`auto-fill: typing email into ${emailHit.sel}`);
        await emailHit.el.fill(envCreds.BOOKING_EMAIL);

        const continueHit = await waitAny(SUBMIT_SELECTORS, 3_000);
        if (continueHit) { emit('auto-fill: clicking Continue'); await continueHit.el.click(); }

        // Booking sometimes shows an intermediate "how do you want to sign in"
        // page: pick between "Sign in with password" and "Get email code".
        // Look for the password option and click it if present. If not, we're
        // already on the password page and this is a no-op.
        await page.waitForTimeout(1500);
        const PASSWORD_OPTION_SELECTORS = [
          'button[data-testid*="password" i]:not([type="submit"])',
          'a[data-testid*="password" i]',
          'button:has-text("Sign in with a password")',
          'button:has-text("Sign in with password")',
          'button:has-text("Use password")',
          'a:has-text("Sign in with password")',
          'a:has-text("Use password")',
          '[role="button"]:has-text("password")',
        ];
        // Only click if there's NO visible password input yet — avoids clicking
        // a stray element on the actual password page.
        const alreadyOnPasswordPage = await page.$('input[type="password"]:visible, input[name="password"]').catch(() => null);
        if (!alreadyOnPasswordPage) {
          const pwOpt = await waitAny(PASSWORD_OPTION_SELECTORS, 3_000);
          if (pwOpt) {
            emit(`auto-fill: clicking "Sign in with password" option (${pwOpt.sel})`);
            await pwOpt.el.click();
            await page.waitForTimeout(1000);
          } else {
            emit('auto-fill: no password-option button found, waiting directly for password field');
          }
        }

        const passHit = await waitAny(PASSWORD_SELECTORS, 15_000);
        if (!passHit) {
          emit('auto-fill: password field not appearing — user can proceed manually. Current URL: ' + page.url());
          return;
        }
        emit(`auto-fill: typing password into ${passHit.sel}`);
        await passHit.el.fill(envCreds.BOOKING_PASSWORD);

        const signHit = await waitAny(SUBMIT_SELECTORS, 3_000);
        if (signHit) { emit('auto-fill: clicking Sign in'); await signHit.el.click(); }
        // From here, OTP / CAPTCHA / trust-device may appear — user handles.
        // The polling loop below picks up whenever the URL lands on /hotel/.
      } catch (e) {
        emit(`auto-fill: hit an error, falling back to manual — ${e.message}`);
      }
    })();
  }

  emit('');
  emit('Log in with your Booking.com partner credentials, complete any 2FA,');
  emit('select your property if prompted, and open the reservations list.');
  emit('The session saves automatically once verified — no need to do anything else.');
  emit('');

  const start = Date.now();
  let saved = false;
  let savedInfo = null;

  while (!closed && !saved && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    if (closed) break;

    let currentUrl;
    try {
      currentUrl = page.url();
    } catch {
      break; // page/context is going away
    }

    const onAuthPage =
      currentUrl.includes('sign-in') ||
      currentUrl.includes('/login') ||
      currentUrl.startsWith('https://account.booking.com') ||
      !currentUrl.includes('admin.booking.com');

    if (onAuthPage) continue;

    let state;
    try {
      state = await context.storageState();
    } catch {
      break;
    }

    // Booking.com sets multiple session cookies; the meaningful ones for the
    // extranet are `bkng_sso_auth` (~150 chars) and `esadm` (~80 chars).
    const ssoAuth = state.cookies?.find((c) => c.name === 'bkng_sso_auth');
    const esadm = state.cookies?.find((c) => c.name === 'esadm');
    const hasAuth = (ssoAuth?.value?.length ?? 0) >= 50;
    const hasExtranet = (esadm?.value?.length ?? 0) >= 30;

    if (!hasAuth || !hasExtranet) continue;

    // Valid session detected — persist it, plus the URL variant the user
    // landed on (groups/, extranet_ng/, etc. are different products; using
    // the wrong one redirects to login regardless of session validity).
    const sessionFile = join(SESSIONS_DIR, 'booking-session.json');
    const urlsFile = join(SESSIONS_DIR, 'booking-urls.json');
    const propertyFile = join(SESSIONS_DIR, 'booking-property.json');

    const parsedUrl = new URL(currentUrl);
    parsedUrl.searchParams.delete('ses'); // one-time CSRF/auth nonce — would go stale if kept
    const reservationsUrl = parsedUrl.toString();
    const calendarUrl = reservationsUrl
      .replace(/reservations(\/index\.html)?(\?|$)/, 'calendar$1$2')
      .replace(/booking-list\.html(\?|$)/, 'calendar.html$1');
    const hotelId = parsedUrl.searchParams.get('hotel_id') ?? null;

    fs.writeFileSync(sessionFile, JSON.stringify(state, null, 2), 'utf-8');
    fs.writeFileSync(urlsFile, JSON.stringify({ reservationsUrl, calendarUrl }, null, 2), 'utf-8');
    if (hotelId) {
      fs.writeFileSync(
        propertyFile,
        JSON.stringify({ hotelId, hotelName: 'Central & Cosy - Easy Access Ground Floor Flat' }, null, 2),
        'utf-8'
      );
    }

    saved = true;
    savedInfo = {
      reservationsUrl,
      calendarUrl,
      hotelId,
      ssoAuthLen: ssoAuth.value.length,
      esadmLen: esadm.value.length,
    };

    emit('');
    emit('✓ Session saved successfully!');
    emit('  Reservations URL: ' + reservationsUrl);
    emit('  Calendar URL (derived): ' + calendarUrl);
    if (hotelId) emit('  Hotel ID: ' + hotelId);
    emit('');

    // Give the confirmation a moment to be visible, then close automatically.
    try { await page.waitForTimeout(1000); } catch { /* ignore */ }
    try { await context.close(); } catch { /* ignore */ }
    break;
  }

  // Let the 'close' event settle in case the loop exited via a thrown error
  // from a context the user just closed manually.
  await new Promise((r) => setTimeout(r, 200));

  if (saved) {
    return { success: true, message: 'Booking.com session saved successfully.', ...savedInfo };
  }

  if (closed) {
    return {
      success: false,
      reason: 'closed-before-valid',
      message: 'Browser was closed before a valid, logged-in session was detected. No session was saved — try again and wait until the reservations list is visible before closing.',
    };
  }

  try { await context.close(); } catch { /* ignore */ }
  return {
    success: false,
    reason: 'timeout',
    message: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for a valid Booking.com login.`,
  };
}

// ─── Airbnb: auto-detecting session refresh ───────────────────────────────
//
// Two stages: (1) log in and reach the hosting dashboard — cookies are saved
// as soon as that's detected, and reservations/messages/calendar work from
// that point on; (2) navigate to Earnings > Paid, which triggers Airbnb's
// separate 2FA gate the first time — cookies are re-saved once that page is
// reached so the earnings scraper doesn't need its own prompt later. Stage 2
// is optional: closing the browser after stage 1 still yields a usable
// session, just without earnings access.
//
// Both stages are detected by polling the URL — no terminal interaction
// needed. `log` defaults to stderr for the same reason as saveBookingSession
// (safe to call from the MCP server without corrupting its stdio transport).
export async function saveAirbnbSession({ timeoutMs = 15 * 60 * 1000, log = null } = {}) {
  const emit = log ?? ((msg) => process.stderr.write(`[save-session] ${msg}\n`));
  const { loginUrl, cookieFile } = PLATFORMS.airbnb;

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
      ],
    });
  } catch (err) {
    return { success: false, reason: 'launch-failed', message: `Could not open the browser: ${err.message}` };
  }

  let closed = false;
  browser.on('disconnected', () => { closed = true; });

  const ctx = await browser.newContext({
    viewport: null,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  await page.goto(loginUrl);

  emit('');
  emit('Log in to Airbnb (email / Google / phone + any 2FA).');
  emit('The session saves automatically once the hosting dashboard is detected.');
  emit('');

  const start = Date.now();
  let hostingSaved = false;
  let earningsSaved = false;
  let earningsUrl = null;

  // ── Stage 1: reach the hosting dashboard ──
  while (!closed && !hostingSaved && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    if (closed) break;

    let url;
    try { url = page.url(); } catch { break; }
    if (!url.includes('airbnb.com/hosting')) continue;

    try {
      await page.waitForTimeout(1500); // let all auth cookies land
      const cookies = await ctx.cookies();
      fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2), 'utf-8');
      hostingSaved = true;
      emit('');
      emit(`✓ Hosting session saved (${cookies.length} cookies).`);
    } catch {
      break;
    }
  }

  if (hostingSaved) {
    emit('');
    emit('Optional — for earnings/payout data: click "Earnings" > "Paid" in the');
    emit('sidebar, enter any verification code Airbnb asks for, then wait.');
    emit('This step is optional; close the browser now to skip it.');
    emit('');

    // ── Stage 2: earnings 2FA unlock (optional, same browser session) ──
    while (!closed && !earningsSaved && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 2000));
      if (closed) break;

      let url;
      try { url = page.url(); } catch { break; }
      const onEarnings =
        url.includes('transaction_history') ||
        url.includes('earning') ||
        url.includes('payout') ||
        url.includes('finances');
      if (!onEarnings) continue;

      try {
        await page.waitForTimeout(1000);
        const cookies = await ctx.cookies();
        fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2), 'utf-8');
        fs.writeFileSync(
          join(SESSIONS_DIR, 'airbnb-earnings-url.json'),
          JSON.stringify({ url }, null, 2),
          'utf-8'
        );
        earningsSaved = true;
        earningsUrl = url;
        emit('');
        emit('✓ Earnings access saved too.');
        emit('');
      } catch {
        break;
      }
    }

    // Auto-close once both stages are done — otherwise leave the browser
    // open for the user to finish stage 2, or close it themselves to skip it.
    if (earningsSaved) {
      try { await page.waitForTimeout(800); } catch { /* ignore */ }
      try { await browser.close(); } catch { /* ignore */ }
    }
  }

  await new Promise((r) => setTimeout(r, 200)); // let 'disconnected' settle

  if (!hostingSaved) {
    try { await browser.close(); } catch { /* ignore */ }
    if (closed) {
      return {
        success: false,
        reason: 'closed-before-valid',
        message: 'Browser was closed before login completed. No session was saved.',
      };
    }
    return {
      success: false,
      reason: 'timeout',
      message: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Airbnb login.`,
    };
  }

  return {
    success: true,
    hostingSaved: true,
    earningsSaved,
    earningsUrl,
    message: earningsSaved
      ? 'Airbnb session saved, including earnings/payout access.'
      : 'Airbnb session saved (reservations, messages, calendar will work). Earnings access was skipped — call this again and complete the Earnings > Paid step if you need payout data.',
  };
}

// ─── CLI entrypoint (unchanged UX for `node save-session.js <platform>`) ──

function waitForEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

async function runCli() {
  const platform = process.argv[2];

  if (!platform || !PLATFORMS[platform]) {
    console.error('Usage: node save-session.js <platform>');
    console.error('');
    console.error('  node save-session.js airbnb');
    console.error('  node save-session.js booking');
    process.exit(1);
  }

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  if (platform === 'booking') {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  BOOKING.COM SESSION SAVE');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    console.log('A browser window is opening. Log in with your partner credentials,');
    console.log('complete any 2FA, select your property if prompted, and open the');
    console.log('reservations list. The session saves automatically once verified —');
    console.log('you do NOT need to press Enter or run anything else. Once you see');
    console.log('"Session saved successfully" below, the browser closes itself.');
    console.log('');

    const result = await saveBookingSession({ log: console.log });

    if (!result.success) {
      console.error('✗ ' + result.message);
      process.exit(1);
    }
    return;
  }

  // Airbnb
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  AIRBNB SESSION SAVE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('A browser window is opening. Log in (email / Google / phone + any 2FA).');
  console.log('The session saves automatically once the hosting dashboard is detected —');
  console.log('no need to press Enter. After that, optionally click Earnings > Paid');
  console.log('(and enter any verification code) to unlock payout data too; otherwise');
  console.log('just close the browser when you\'re done.');
  console.log('');

  const result = await saveAirbnbSession({ log: console.log });

  if (!result.success) {
    console.error('✗ ' + result.message);
    process.exit(1);
  }
}

// Only run the CLI flow when this file is executed directly
// (`node save-session.js booking`) — NOT when index.js imports
// `saveBookingSession` for the refresh_booking_session MCP tool.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
