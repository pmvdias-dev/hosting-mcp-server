import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { chromium } from 'playwright';
import {
  chromiumExtra,
  getPinnedUserAgent,
  getProxyConfig,
  randomDelay,
  STEALTH_LAUNCH_ARGS,
} from './stealth-browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR    = join(__dirname, '../sessions/booking-profile');
const SESSION_FILE   = join(__dirname, '../sessions/booking-session.json');
const URLS_FILE      = join(__dirname, '../sessions/booking-urls.json');
const PROPERTY_FILE  = join(__dirname, '../sessions/booking-property.json');

function getSavedUrls() {
  const defaults = {
    reservationsUrl: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/booking-list.html',
    calendarUrl:     'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/calendar.html',
    payoutsUrl:      'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/payouts.html',
  };
  if (!fs.existsSync(URLS_FILE)) return defaults;
  const saved = JSON.parse(fs.readFileSync(URLS_FILE, 'utf-8'));
  // Derive payoutsUrl from the saved reservations URL if not explicitly stored.
  // save-session.js strips ?ses= but keeps hotel_id, so this preserves it.
  if (!saved.payoutsUrl && saved.reservationsUrl) {
    // Use URL parsing so hotel_id and lang are preserved in the derived URL.
    try {
      const u = new URL(saved.reservationsUrl);
      u.pathname = u.pathname
        .replace(/booking-list\.html$/, 'payouts.html')
        .replace(/reservations(\/index\.html)?$/, 'payouts.html');
      saved.payoutsUrl = u.toString();
    } catch { /* ignore — fall through to default */ }
  }
  return { ...defaults, ...saved };
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function withDateRange(baseUrl, days) {
  const url = new URL(baseUrl);
  const start = new Date();
  const end = new Date();
  end.setDate(end.getDate() + days);
  url.searchParams.set('date_from', fmtDate(start));
  url.searchParams.set('date_to', fmtDate(end));
  url.searchParams.set('lang', url.searchParams.get('lang') ?? 'en');
  return url.toString();
}

let _diagLines = [];

function bookingLog(msg, extra) {
  const line = JSON.stringify({ ts: new Date().toISOString(), source: 'booking.js', msg, ...extra });
  process.stderr.write(line + '\n');
  _diagLines.push(extra ? `${msg} ${JSON.stringify(extra)}` : msg);
}

function resetDiag() { _diagLines = []; }

function diagPrefix() {
  return _diagLines.length
    ? '\n--- booking.js diagnostic log ---\n' + _diagLines.map((l, i) => `  [${i + 1}] ${l}`).join('\n') + '\n---\n'
    : '';
}

function diagError(err) {
  const prefix = diagPrefix();
  if (!prefix) return err;
  const wrapped = new Error(prefix + err.message);
  wrapped.stack = prefix + (err.stack ?? err.message);
  return wrapped;
}

// Flush the accumulated diagnostic log to mcp-server.log even on a successful
// run, so we can see WHY a scrape produced an unexpected (empty / _raw) result
// without forcing an error. Same JSON format as index.js's logger.
function diagInfo(toolName) {
  const prefix = diagPrefix();
  if (!prefix) return;
  try {
    const LOG_FILE = join(__dirname, '..', 'mcp-server.log');
    fs.appendFileSync(
      LOG_FILE,
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'debug',
        tool: toolName,
        message: prefix,
      }) + '\n'
    );
  } catch {
    /* never let logging break the scrape */
  }
}

// ─── Concurrency mutex ────────────────────────────────────────────────────
// All public booking exports share the same persistent profile dir
// (`sessions/booking-profile`). Two parallel calls would launch two contexts
// on the same dir → race → second call gets corrupted cookies and lands on
// sign-in. Same module-level state (_diagLines) interleaves between calls.
// Serializing through one promise queue fixes both.
let _bookingQueue = Promise.resolve();
function _bookingSerialize(fn) {
  const next = _bookingQueue.then(() => fn(), () => fn());
  _bookingQueue = next.catch(() => {});
  return next;
}

// ─── Auto session refresh ────────────────────────────────────────────────
// When any scraper call throws "Session expired", automatically trigger the
// login-browser flow (saveBookingSession) and retry the original call once.
// If refresh also fails, propagate a clearer combined error.
async function _autoRefreshOnExpiry(fn) {
  const stderrLog = (msg, extra) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), source: 'auto-refresh', msg, ...(extra || {}) });
    process.stderr.write(line + '\n');
    try {
      fs.appendFileSync(
        join(__dirname, '..', 'mcp-server.log'),
        JSON.stringify({ ts: new Date().toISOString(), level: 'debug', tool: 'auto-refresh', message: msg + (extra ? ' ' + JSON.stringify(extra) : '') }) + '\n'
      );
    } catch { /* ignore */ }
  };
  stderrLog('wrapper entered');
  try {
    const result = await fn();
    stderrLog('inner fn returned normally');
    return result;
  } catch (err) {
    const msg = String(err?.message || err);
    stderrLog('caught error', { msgHead: msg.slice(0, 200), matchesExpired: /session expired/i.test(msg) });
    if (!/session expired/i.test(msg)) throw err;
    stderrLog('session expired detected — trying automated login first');
    // Give the closed browser context a beat before we launch a new one.
    await new Promise((r) => setTimeout(r, 500));

    // ── Auto-login cooldown ──
    // Booking's fraud system CAPTCHAs the headless browser after too many
    // login attempts. When we hit CAPTCHA we write a cooldown timestamp; while
    // it's active we skip auto-login entirely and go straight to the manual
    // browser. Prevents wasting 30-40s per Booking call retrying against a
    // CAPTCHA that won't clear until Booking's counter resets.
    const COOLDOWN_FILE = join(__dirname, '..', 'sessions', 'auto-login-cooldown.json');
    // 24h cooldown after CAPTCHA: Booking's fraud counter usually clears in
    // 24-48h if there's no further bot-like activity. Retrying too soon just
    // resets the counter.
    const COOLDOWN_MS   = 24 * 60 * 60 * 1000; // 24 hours
    const readCooldown = () => {
      try {
        if (!fs.existsSync(COOLDOWN_FILE)) return null;
        const j = JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf-8'));
        return typeof j.until === 'number' ? j.until : null;
      } catch { return null; }
    };
    const writeCooldown = () => {
      try {
        fs.writeFileSync(COOLDOWN_FILE, JSON.stringify({
          until: Date.now() + COOLDOWN_MS,
          reason: 'captcha',
          setAt: new Date().toISOString(),
        }), 'utf-8');
      } catch (e) { stderrLog('failed to write cooldown', { msg: e.message }); }
    };
    const cooldownUntil = readCooldown();
    const inCooldown = cooldownUntil && cooldownUntil > Date.now();

    // Single-shot automated headless login using .env credentials. If it
    // fails for any reason (CAPTCHA, OTP, bad selector, etc.) we go straight
    // to the manual browser — no retries. Repeated headless attempts are
    // what triggered Booking's fraud counter in the first place.
    let refreshResult = null;
    let mod;
    try {
      mod = await import('../save-session.js');
    } catch (impErr) {
      throw new Error(`Could not load save-session module: ${impErr?.message ?? impErr}`);
    }

    if (inCooldown) {
      const mins = Math.round((cooldownUntil - Date.now()) / 60000);
      stderrLog(`auto-login cooldown active — ${mins} min remaining, skipping to manual browser`);
    }

    for (let i = 1; i <= 1 && !inCooldown; i++) {
      stderrLog(`auto-login attempt ${i}`);
      let auto = null;
      try {
        auto = await mod.attemptAutoLoginBooking();
        if (auto?.success) {
          stderrLog('auto-login succeeded', { attempt: i });
          refreshResult = auto;
          break;
        }
        stderrLog('auto-login failed', { attempt: i, reason: auto?.reason, message: auto?.message });
      } catch (autoErr) {
        stderrLog('auto-login threw', { attempt: i, msg: autoErr?.message });
      }
      // If Booking demanded an email OTP, retrying is pointless — it'll ask
      // again. Go straight to the manual browser so the user can enter the
      // code (and ideally tick "trust this device" so future auto-logins skip
      // OTP entirely).
      const isOtpChallenge = auto?.reason === 'challenge' &&
        /otp|email-code|verify|2fa/i.test(auto?.message || '');
      if (isOtpChallenge) {
        stderrLog('OTP challenge detected — skipping remaining auto-login attempts');
        break;
      }
      // If Booking CAPTCHA'd us, no amount of retrying will help until their
      // fraud counter cools down. Set a 4-hour cooldown and skip to manual.
      if (auto?.reason === 'captcha') {
        stderrLog('CAPTCHA detected — engaging 4h auto-login cooldown, skipping to manual');
        writeCooldown();
        break;
      }
      // Small pause between attempts so we don't hammer Booking on the same
      // second — helps if the first attempt got flagged transiently.
      if (i < 2) await new Promise((r) => setTimeout(r, 2500));
    }

    // If both auto-login attempts failed, fall back to the visible browser
    // for the user to complete the login (handles CAPTCHA / 2FA / etc.).
    if (!refreshResult?.success) {
      stderrLog('auto-login failed twice — opening manual browser');
      try {
        refreshResult = await mod.saveBookingSession();
      } catch (refreshErr) {
        const rmsg = refreshErr?.message ?? String(refreshErr);
        stderrLog('manual refresh threw', { msg: rmsg });
        throw new Error(
          `Session was expired, auto-login failed twice, and manual browser also failed: ${rmsg}. ` +
          `Try running "node save-session.js booking" manually.`
        );
      }
    }
    stderrLog('session refresh completed', { success: !!refreshResult?.success });
    if (!refreshResult?.success) {
      // User closed the browser without logging in — no point retrying.
      throw new Error(
        `Session refresh was cancelled (browser closed before login completed). ` +
        `Please re-run the tool to re-open the login browser.`
      );
    }
    // Booking's persistent profile has just been written to disk by
    // saveBookingSession. Launching a new Playwright context immediately after
    // sometimes races the lockfile release, and even when the launch succeeds
    // the cookies aren't fully warmed on first request — the extranet redirects
    // through /login → /admin, and the scraper sees an empty reservations list
    // instead of the real data. Give the profile a beat, then retry up to twice
    // with a growing pause; if either attempt returns without a session-expired
    // error, we take that result.
    const RETRY_WAITS_MS = [2000, 3500];
    let lastRetryErr = null;
    for (let i = 0; i < RETRY_WAITS_MS.length; i++) {
      await new Promise((r) => setTimeout(r, RETRY_WAITS_MS[i]));
      stderrLog('post-refresh retry attempt', { attempt: i + 1, waitedMs: RETRY_WAITS_MS[i] });
      try {
        const result = await fn();
        stderrLog('post-refresh retry succeeded', { attempt: i + 1 });
        return result;
      } catch (retryErr) {
        lastRetryErr = retryErr;
        const rmsg = String(retryErr?.message || retryErr);
        stderrLog('post-refresh retry failed', { attempt: i + 1, msgHead: rmsg.slice(0, 200) });
        // If it's not a session issue, bail — no point re-hitting for a real error.
        if (!/session expired/i.test(rmsg)) throw retryErr;
      }
    }
    throw new Error(
      `Session was refreshed but reservations still failed after two retries: ` +
      `${lastRetryErr?.message ?? lastRetryErr}. Try re-running the tool.`
    );
  }
}

function wrapAddCookies(context) {
  const _real = context.addCookies.bind(context);
  context.addCookies = async (arg) => {
    if (Array.isArray(arg)) return _real(arg);

    if (arg && typeof arg === 'object' && Array.isArray(arg.cookies)) {
      bookingLog('addCookies intercepted cause #1 — storageState object; extracting .cookies', {
        cookieCount: arg.cookies.length,
      });
      return _real(arg.cookies);
    }

    if (arg && typeof arg === 'object' && 'name' in arg && 'value' in arg) {
      bookingLog('addCookies intercepted cause #2 — single cookie object; wrapping in array', {
        cookieName: arg.name,
      });
      return _real([arg]);
    }

    const shape = `type=${typeof arg}, keys=[${Object.keys(arg ?? {}).slice(0, 8).join(',')}]`;
    bookingLog('addCookies unexpected shape', { shape });
    throw new Error(`[booking] addCookies received unexpected non-array argument: ${shape}`);
  };
}

function withSesParam(sourceUrl, destUrl) {
  try {
    const src = new URL(sourceUrl);
    const dest = new URL(destUrl);
    // hotel_id ties the URL to the right property — carry it alongside ses/lang
    for (const key of ['ses', 'lang', 'hotel_id']) {
      const val = src.searchParams.get(key);
      if (val) dest.searchParams.set(key, val);
    }
    return dest.toString();
  } catch {
    return destUrl;
  }
}

async function getBrowserContext() {
  const profileExists = fs.existsSync(PROFILE_DIR);
  const sessionExists = fs.existsSync(SESSION_FILE);
  bookingLog('getBrowserContext', { profileExists, sessionExists });

  if (!profileExists && !sessionExists) {
    throw new Error('No Booking.com session found — run: node save-session.js booking (or call the refresh_booking_session MCP tool)');
  }

  const userAgent = getPinnedUserAgent();
  const proxy = getProxyConfig();
  const launchArgs = [...STEALTH_LAUNCH_ARGS];

  if (profileExists) {
    bookingLog('launching persistent context (plain chromium, no playwright-extra)', { PROFILE_DIR });
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      args: launchArgs,
      viewport: { width: 1440, height: 900 },
      userAgent,
      ...(proxy ? { proxy } : {}),
    });
    bookingLog('persistent context launched');
    context.setDefaultNavigationTimeout(60_000);
    wrapAddCookies(context);
    const page = context.pages()[0] ?? (await context.newPage());
    bookingLog('page ready (profile path)', { pageUrl: page.url() });
    return { context, page, isPersistent: true };
  }

  const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  const cookiesOk = Array.isArray(sessionData?.cookies);
  bookingLog('session file fallback selected', { cookiesIsArray: cookiesOk, cookieCount: sessionData?.cookies?.length });

  if (!cookiesOk) {
    throw new Error(
      'booking-session.json cookies is not an array — run: node save-session.js booking (or call the refresh_booking_session MCP tool)'
    );
  }

  bookingLog('launching browser (session file, plain chromium)');
  const browser = await chromium.launch({
    headless: true,
    args: launchArgs,
    ...(proxy ? { proxy } : {}),
  });
  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });
  context.setDefaultNavigationTimeout(60_000);
  wrapAddCookies(context);
  bookingLog('calling context.addCookies', { count: sessionData.cookies.length });
  await context.addCookies(sessionData.cookies);
  bookingLog('cookies added — restoring localStorage');
  const adminOrigin = sessionData.origins?.find(
    (o) => o.origin === 'https://admin.booking.com'
  );
  if (adminOrigin?.localStorage?.length) {
    await context.addInitScript(({ items }) => {
      for (const { name, value } of items) {
        try { localStorage.setItem(name, value); } catch { /* quota */ }
      }
    }, { items: adminOrigin.localStorage });
  }
  const page = await context.newPage();
  bookingLog('page ready (session file fallback)');
  return { context, page, browser, isPersistent: false };
}

async function closeBrowserContext(ctx) {
  if (!ctx) return;
  const { context, browser, isPersistent } = ctx;
  if (isPersistent) {
    await context.close();
  } else {
    await context.close();
    await browser?.close();
  }
}

// Returns { hotelId, hotelName } from the saved property config file, or nulls.
function getPropertyConfig() {
  if (fs.existsSync(PROPERTY_FILE)) {
    try { return JSON.parse(fs.readFileSync(PROPERTY_FILE, 'utf-8')); } catch { /* ignore */ }
  }
  return { hotelId: null, hotelName: null };
}

// After login the Booking.com admin homepage shows a property picker table.
// This function detects that state and clicks the saved target property.
// On success it also writes the hotel_id back to PROPERTY_FILE for future runs.
async function selectPropertyIfNeeded(page) {
  const url = page.url();
  // Already navigated into a property-specific admin context — nothing to do.
  if (
    url.includes('/hotel/hoteladmin/') ||
    new URL(url).searchParams.get('hotel_id')
  ) return;

  bookingLog('selectPropertyIfNeeded: on root admin page — looking for property picker');

  const { hotelId, hotelName } = getPropertyConfig();

  const clicked = await page.evaluate(({ hotelId, hotelName }) => {
    // 1. Match by hotel_id in link href or data attribute
    if (hotelId) {
      const byId = document.querySelector(
        `a[href*="hotel_id=${hotelId}"], [data-hotel-id="${hotelId}"], a[href*="/${hotelId}/"], a[href*="/${hotelId}?"]`
      );
      if (byId) { byId.click(); return `id:${hotelId}`; }
    }
    // 2. Match by hotel name text (first two significant words)
    if (hotelName) {
      const words = hotelName.split(/\s+/).filter(w => w.length > 3).slice(0, 2).join(' ');
      const allLinks = [...document.querySelectorAll('a, button, td, [role="row"]')];
      for (const el of allLinks) {
        if (words && el.textContent?.includes(words)) { el.click(); return `name:${words}`; }
      }
    }
    // 3. Click the first property link in any visible table (single-property accounts)
    const firstLink = document.querySelector(
      'table a[href*="hotel_id"], table a[href*="hoteladmin"], [class*="property"] a, [class*="hotel-list"] a'
    );
    if (firstLink) { firstLink.click(); return 'first-table-link'; }
    return null;
  }, { hotelId, hotelName });

  if (!clicked) {
    bookingLog('selectPropertyIfNeeded: no property link found on page');
    return;
  }

  bookingLog('selectPropertyIfNeeded: clicked property', { via: clicked });
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
  await page.waitForLoadState('networkidle',    { timeout: 15_000 }).catch(() => {});
  bookingLog('selectPropertyIfNeeded: after selection', { url: page.url() });

  // Persist the hotel_id so future runs skip the picker automatically
  if (!fs.existsSync(PROPERTY_FILE)) {
    try {
      const detectedId = new URL(page.url()).searchParams.get('hotel_id');
      if (detectedId) {
        fs.writeFileSync(PROPERTY_FILE, JSON.stringify({ hotelId: detectedId }, null, 2), 'utf-8');
        bookingLog('selectPropertyIfNeeded: saved hotel_id to property file', { hotelId: detectedId });
      }
    } catch { /* non-critical */ }
  }
}


function isLoginUrl(url) {
  return (
    url.includes('sign-in') ||
    url.includes('/login') ||
    url.startsWith('https://account.booking.com') ||
    !url.includes('admin.booking.com')
  );
}

function normalizeStatus(raw) {
  const s = (raw ?? '').toLowerCase();
  if (/cancel/i.test(s))              return 'cancelled';
  if (/no[\s_-]?show/i.test(s))       return 'no_show';
  if (/pending|waiting|process/i.test(s)) return 'pending';
  if (/ok|confirm|valid|booking\.com|guaranteed|paid/i.test(s)) return 'confirmed';
  return raw.trim() || null;
}

function assertNotLoginPage(url) {
  bookingLog('assertNotLoginPage check', { url });
  if (isLoginUrl(url)) {
    throw new Error(`Session expired (landed on: ${url}) — run: node save-session.js booking (or call the refresh_booking_session MCP tool)`);
  }
}

// ─── FIX: interceptApiResponse now accepts an optional requestId so multiple
// concurrent intercepts don't cross-resolve each other. It also resets its
// listener on every call so stale responses from a previous page load never
// satisfy a new intercept set up after navigation.
async function interceptApiResponse(page, urlPattern, timeout = 20_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      bookingLog('interceptApiResponse timed out', { pattern: urlPattern.toString() });
      resolve(null);
    }, timeout);

    const handler = async (response) => {
      try {
        const url = response.url();
        if (!urlPattern.test(url)) return;
        if (!response.ok()) return;

        const contentType = response.headers()['content-type'] ?? '';
        if (!contentType.includes('application/json')) return;

        clearTimeout(timer);
        page.off('response', handler); // detach immediately to avoid double-resolve
        const json = await response.json().catch(() => null);
        bookingLog('interceptApiResponse matched', { url: url.slice(0, 120) });
        resolve(json);
      } catch {
        // non-JSON or already resolved — ignore
      }
    };

    page.on('response', handler);
  });
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// One week before today, in YYYY-MM-DD. Used as the default startDate so
// currently-in-house guests (who checked in a few days ago and haven't checked
// out yet) still appear — Booking's default arrival-date filter otherwise
// excludes them the moment their check-in day passes.
function oneWeekAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function oneYearFromNow() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function toDisplayDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

// Click/select "Check-in" in the "Date of" dropdown on the reservations page.
// Three strategies — native <select>, custom button-driven dropdown, or DOM
// scan for any clickable bearing the text "Check-in" inside the filter row.
async function selectDateOfCheckIn(page) {
  // Strategy 1: native <select> — most reliable when present
  try {
    const sel = page.locator('select').filter({ hasText: 'Check-in' }).first();
    if (await sel.count()) {
      await sel.selectOption({ label: 'Check-in' });
      bookingLog('date-of: selected via native <select>');
      await page.waitForTimeout(400);
      return true;
    }
  } catch (err) {
    bookingLog('date-of: select strategy failed', { msg: err?.message });
  }

  // Strategy 2: Booking's bui-input-dropdown / custom button trigger.
  // Click the button currently showing "Reservation", then click "Check-in".
  try {
    const triggerSelectors = [
      'button:has-text("Reservation")',
      '[data-test-id*="date-of"]',
      '[aria-label*="Date of" i]',
      'button[role="combobox"]',
    ];
    let opened = false;
    for (const s of triggerSelectors) {
      const btn = page.locator(s).first();
      if (await btn.count()) {
        try {
          await btn.click({ timeout: 2_000 });
          opened = true;
          bookingLog('date-of: opened dropdown', { sel: s });
          break;
        } catch {}
      }
    }
    if (opened) {
      await page.waitForTimeout(300);
      // Click the Check-in option. Restrict to listbox/menu to avoid clicking
      // the column heading "Check-in" in the table below.
      const optionSelectors = [
        '[role="option"]:has-text("Check-in")',
        '[role="menuitem"]:has-text("Check-in")',
        'li:has-text("Check-in")',
        'button:has-text("Check-in"):not([role="tab"])',
      ];
      for (const s of optionSelectors) {
        const opt = page.locator(s).first();
        if (await opt.count()) {
          try {
            await opt.click({ timeout: 2_000 });
            bookingLog('date-of: selected Check-in', { sel: s });
            await page.waitForTimeout(300);
            return true;
          } catch {}
        }
      }
      bookingLog('date-of: option click failed');
    }
  } catch (err) {
    bookingLog('date-of: dropdown strategy failed', { msg: err?.message });
  }

  // Strategy 3: DOM scan — find any text node "Check-in" in the filter form
  // header area and click its closest interactable ancestor.
  try {
    const ok = await page.evaluate(() => {
      const headerArea = document.querySelector('form, [class*="filter"], [class*="search-form"]') || document.body;
      const all = headerArea.querySelectorAll('*');
      for (const el of all) {
        if (el.children.length > 0) continue;
        const text = el.textContent?.trim() ?? '';
        if (text !== 'Check-in') continue;
        const clickable = el.closest('button, a, li, [role="option"], [role="menuitem"]');
        if (clickable) { clickable.click(); return true; }
      }
      return false;
    });
    bookingLog('date-of: DOM scan result', { clicked: ok });
    if (ok) await page.waitForTimeout(300);
    return ok;
  } catch (err) {
    bookingLog('date-of: DOM scan failed', { msg: err?.message });
    return false;
  }
}

async function applyDateFilter(page, startDate, endDate) {
  const RANGE_INPUT = '#peg-reservations-ranged, [data-test-id="peg-reservations-date-range"]';

  const allInputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(el => ({
      id: el.id || '',
      name: el.name || '',
      value: el.value || '',
      dt: el.getAttribute('data-test-id') || el.getAttribute('data-testid') || '',
    }))
  );
  bookingLog('inputs on page', { count: allInputs.length, inputs: allInputs.slice(0, 20) });

  // Switch the "Date of" dropdown to "Check-in" BEFORE applying the range.
  // Default is "Reservation" (booking-date) — searching for stays with check-ins
  // in 2026 returns 0 because most were booked in 2025 by booking-date filter.
  await selectDateOfCheckIn(page);

  const displayStart = toDisplayDate(startDate);
  const displayEnd   = toDisplayDate(endDate);
  const EN_DASH = '–';
  const displayRange = `${displayStart} ${EN_DASH} ${displayEnd}`;
  const altFormats = [
    `${startDate} ${EN_DASH} ${endDate}`,
    `${displayStart} - ${displayEnd}`,
  ];

  const input = page.locator(RANGE_INPUT).first();
  if ((await input.count()) === 0) {
    bookingLog('range input not found on page — skipping filter');
    return { hitStart: false, hitEnd: false };
  }

  async function inputMatches() {
    const v = await input.inputValue().catch(() => '');
    const startOk = v.includes(displayStart) || v.includes(startDate);
    const endOk   = v.includes(displayEnd)   || v.includes(endDate);
    return startOk && endOk;
  }

  // Stable match: value still reflects our requested range AFTER a delay.
  // The bug we caught: programmatic fill() / native-setter changes the visible
  // value, but Booking's widget reverts to its internal state ~1s later. So
  // an immediate inputMatches() lies. We must wait long enough to detect the
  // revert before declaring success.
  async function stableInputMatches() {
    if (!(await inputMatches())) return false;
    await page.waitForTimeout(1_500);
    return await inputMatches();
  }

  // ── Primary: calendar clicks ─────────────────────────────────────────────
  // This is the ONLY approach that reliably updates the widget's internal
  // state. fill() / native setter visually update the input but the widget
  // reverts on form submit, sending old dates and returning no reservations.
  bookingLog('attempting calendar click navigation as primary');
  const calendarResult = await applyDateFilterByCalendar(page, input, startDate, endDate);
  if (calendarResult.success) {
    if (await stableInputMatches()) {
      bookingLog('filter applied + stable via calendar clicks');
      await commitAndWait(page);
      return { hitStart: true, hitEnd: true };
    }
    bookingLog('calendar clicks reported success but value did not stabilise');
  }

  // ── Fallback A: Playwright fill() + Enter, with stability check ──────────
  for (const candidate of [displayRange, ...altFormats]) {
    try {
      await input.fill(candidate, { timeout: 4_000 });
      await input.press('Enter');
      await page.waitForTimeout(400);
      if (await stableInputMatches()) {
        bookingLog('filter applied + stable via fill()+Enter', { format: candidate });
        await commitAndWait(page);
        return { hitStart: true, hitEnd: true };
      }
      bookingLog('fill()+Enter reverted', { format: candidate, current: await input.inputValue().catch(() => '') });
    } catch (err) {
      bookingLog('fill()+Enter failed', { format: candidate, msg: err?.message });
    }
  }

  // ── Fallback B: React-aware native value setter ──────────────────────────
  for (const candidate of [displayRange, ...altFormats]) {
    try {
      await page.evaluate(({ sel, val }) => {
        const el = document.querySelector(sel);
        if (!el) return;
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        nativeSetter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }, { sel: '#peg-reservations-ranged', val: candidate });
      await page.waitForTimeout(400);
      if (await stableInputMatches()) {
        bookingLog('filter applied + stable via native setter', { format: candidate });
        await commitAndWait(page);
        return { hitStart: true, hitEnd: true };
      }
      bookingLog('native-setter reverted', { format: candidate, current: await input.inputValue().catch(() => '') });
    } catch (err) {
      bookingLog('native-setter failed', { format: candidate, msg: err?.message });
    }
  }

  bookingLog('all date filter approaches failed', { finalValue: await input.inputValue().catch(() => '') });
  return { hitStart: false, hitEnd: false };
}

// ─── FIX: commitAndWait fully rewritten ────────────────────────────────────
//
// Three bugs fixed vs the original:
//
//   Bug 1 — Race condition: Escape + 500ms was not enough time for the
//            calendar popover to fully close. The button click was landing on
//            the overlay, not the button, and getting swallowed silently.
//            Fix: wait for the popover element to reach state:'hidden' in the
//            DOM before attempting any click.
//
//   Bug 2 — force:true bypassed Playwright's actionability checks, meaning
//            it clicked even when the button was covered by the popover.
//            Fix: removed force:true — Playwright now verifies the button is
//            unobstructed before clicking.
//
//   Bug 3 — The JS fallback btn.click() fires a synthetic event that React's
//            SyntheticEvent system may ignore depending on the React version.
//            Fix: JS fallback now uses form.requestSubmit(btn) first (which
//            triggers React's submit handler), then falls back to btn.click()
//            only if requestSubmit is unavailable. The Playwright click path
//            is always tried first and is preferred.
//
async function commitAndWait(page) {
  // ── Step 1: Press Escape to close the calendar popover ──────────────────
  await page.keyboard.press('Escape').catch(() => {});

  // ── Step 2: Wait for the popover to fully disappear from the DOM ─────────
  // Do NOT proceed to click until the overlay is gone — clicking while it's
  // visible will hit the overlay, not the button behind it.
  const overlaySelectors = [
    '[role="dialog"]',
    '[class*="popover"]',
    '[class*="datepicker"][class*="open"]',
    '[class*="picker"][class*="visible"]',
    '[class*="calendar"][class*="dropdown"]',
  ];

  for (const sel of overlaySelectors) {
    try {
      const overlayCount = await page.locator(sel).count();
      if (overlayCount > 0) {
        bookingLog('waiting for overlay to close', { sel });
        await page.waitForSelector(sel, { state: 'hidden', timeout: 5_000 });
        bookingLog('overlay closed', { sel });
        break;
      }
    } catch {
      // overlay wasn't there or already gone — continue
    }
  }

  // Extra buffer after popover closes for React state to flush
  await page.waitForTimeout(800);

  // ── Step 3: Locate the button — wait until it's visible and enabled ───────
  const submitSelectors = [
    '[data-test-id="search-reservations-btn"]',
    '[data-testid="search-reservations-btn"]',
    'button[data-test-id*="search-reservations"]',
    'button[data-testid*="search-reservations"]',
    'button:has-text("Show reservations")',
    'button:has-text("Search reservations")',
    'button:has-text("Search")',
    'form button[type="submit"]',
  ];

  let buttonLocator = null;
  let matchedSel = null;

  for (const sel of submitSelectors) {
    try {
      const loc = page.locator(sel).first();
      // waitFor state:'visible' ensures it's in DOM, painted, and not hidden
      await loc.waitFor({ state: 'visible', timeout: 4_000 });
      buttonLocator = loc;
      matchedSel = sel;
      bookingLog('found Show reservations button', { sel });
      break;
    } catch { continue; }
  }

  // If nothing matched, emit a full button dump so you can find the real selector
  if (!buttonLocator) {
    const visibleButtons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, input[type="submit"]'))
        .filter(b => b.offsetParent !== null)
        .map(b => ({
          text:    b.textContent?.trim().slice(0, 80),
          testId:  b.getAttribute('data-test-id') || b.getAttribute('data-testid') || null,
          type:    b.getAttribute('type'),
          classes: b.className?.slice(0, 100),
          disabled: b.disabled,
        }))
    );
    bookingLog('BUTTON NOT FOUND — dumping all visible buttons', { visibleButtons });
    throw new Error(
      `[booking] Could not find "Show reservations" button after trying ${submitSelectors.length} selectors.\n` +
      `Visible buttons on page:\n${JSON.stringify(visibleButtons, null, 2)}\n` +
      `Add the correct selector to the top of submitSelectors in commitAndWait().`
    );
  }

  // ── Step 4: Scroll into view, then click WITHOUT force:true ─────────────
  // No force:true — Playwright must confirm the button is unobstructed.
  // If it throws "element is obscured", the popover is still open — increase
  // the waitForTimeout above or add the correct overlay selector.
  await buttonLocator.scrollIntoViewIfNeeded();
  await buttonLocator.click({ timeout: 8_000 });
  bookingLog('clicked Show reservations button', { matchedSel });

  // ── Step 5: Wait for the SPA to fire its data request and settle ─────────
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await randomDelay(800, 1_500);
}

async function applyDateFilterByCalendar(page, input, startDate, endDate) {
  const [sy, sm] = startDate.split('-').map(Number);
  const [ey, em] = endDate.split('-').map(Number);
  const targetStartIdx = sy * 12 + (sm - 1);
  const targetEndIdx   = ey * 12 + (em - 1);

  try {
    await input.click({ timeout: 3_000 });
  } catch (err) {
    bookingLog('could not click range input to open picker', { msg: err?.message });
    return { success: false };
  }
  await page.waitForTimeout(700);

  async function readHeader() {
    try {
      const text = await page.evaluate((monthNames) => {
        const re = new RegExp(`^(${monthNames.join('|')})\\s+(\\d{4})\\s*$`);
        const containers = [
          ...document.querySelectorAll(
            '[role="dialog"], [role="presentation"], [class*="popover"], ' +
            '[class*="dropdown"], [class*="datepicker"], [class*="calendar"], ' +
            '[class*="picker"], [data-test-id*="datepicker"], [data-test-id*="calendar"]'
          ),
          document.body,
        ];
        const seen = new Set();
        for (const root of containers) {
          if (!root || seen.has(root)) continue;
          seen.add(root);
          const all = root.querySelectorAll('*');
          for (const el of all) {
            if (el.offsetParent === null && el !== document.documentElement) continue;
            if (el.children.length > 1) continue;
            const t = el.textContent?.trim();
            if (t && re.test(t)) return t;
          }
        }
        return null;
      }, MONTH_NAMES);

      if (!text) return null;
      const m = text.match(/(\w+)\s+(\d{4})/);
      if (!m) return null;
      const monthIdx = MONTH_NAMES.indexOf(m[1]);
      if (monthIdx < 0) return null;
      return { monthIdx, year: parseInt(m[2], 10), text };
    } catch (err) {
      bookingLog('readHeader threw', { msg: err?.message });
      return null;
    }
  }

  async function clickNext() {
    try {
      const ok = await page.evaluate(() => {
        const containers = document.querySelectorAll(
          '[role="dialog"], [class*="popover"], [class*="datepicker"], ' +
          '[class*="calendar"], [class*="picker"]'
        );
        for (const c of containers) {
          const buttons = c.querySelectorAll('button, [role="button"]');
          for (const b of buttons) {
            const label = (b.getAttribute('aria-label') || '').toLowerCase();
            const text  = (b.textContent || '').trim();
            const cls   = (b.className || '').toLowerCase();
            const isNext =
              label.includes('next') ||
              text === '›' || text === '>' || text === '→' ||
              cls.includes('next');
            const isPrev =
              label.includes('prev') ||
              text === '‹' || text === '<' || text === '←' ||
              cls.includes('prev');
            if (isNext && !isPrev) {
              b.click();
              return true;
            }
          }
        }
        return false;
      });
      return ok;
    } catch {
      return false;
    }
  }

  async function clickDay(dateISO) {
    const day = parseInt(dateISO.split('-')[2], 10);
    try {
      const clicked = await page.evaluate(({ iso, dayNum }) => {
        const exact = document.querySelector(
          `[data-date="${iso}"], td[data-date="${iso}"], button[data-date="${iso}"]`
        );
        if (exact) { exact.click(); return 'data-date'; }

        const containers = document.querySelectorAll(
          '[class*="datepicker"], [class*="calendar"], [class*="picker"], [role="dialog"]'
        );
        for (const c of containers) {
          const cells = c.querySelectorAll(
            'td, button, [class*="day"], [class*="date"], [role="gridcell"]'
          );
          for (const el of cells) {
            const cls = (el.className || '').toLowerCase();
            if (cls.includes('disabled') || cls.includes('outside') || cls.includes('muted')) continue;
            if (el.offsetParent === null) continue;
            const t = el.textContent?.trim();
            if (t && parseInt(t, 10) === dayNum) {
              el.click();
              return 'text-match';
            }
          }
        }
        return null;
      }, { iso: dateISO, dayNum: day });
      return clicked;
    } catch {
      return null;
    }
  }

  async function navigateToMonth(targetIdx) {
    let header = await readHeader();
    if (!header) {
      bookingLog('could not read calendar header');
      return false;
    }
    bookingLog('calendar header read', { header: header.text });
    let curIdx = header.year * 12 + header.monthIdx;
    let safety = 0;
    while (curIdx !== targetIdx && safety++ < 36) {
      if (curIdx > targetIdx) break;
      if (!(await clickNext())) {
        bookingLog('next-month button not found', { curIdx, targetIdx });
        return false;
      }
      await page.waitForTimeout(220);
      header = await readHeader();
      if (!header) return false;
      curIdx = header.year * 12 + header.monthIdx;
    }
    return curIdx === targetIdx;
  }

  if (!(await navigateToMonth(targetStartIdx))) return { success: false };
  const startClick = await clickDay(startDate);
  if (!startClick) {
    bookingLog('failed to click start day', { startDate });
    return { success: false };
  }
  bookingLog('clicked start day', { startDate, via: startClick });
  await page.waitForTimeout(400);

  if (targetEndIdx !== targetStartIdx) {
    if (!(await navigateToMonth(targetEndIdx))) return { success: false };
  }
  const endClick = await clickDay(endDate);
  if (!endClick) {
    bookingLog('failed to click end day', { endDate });
    return { success: false };
  }
  bookingLog('clicked end day', { endDate, via: endClick });
  await page.waitForTimeout(400);

  const finalValue = await input.inputValue().catch(() => '');
  bookingLog('input after calendar clicks', { finalValue });
  const displayStart = toDisplayDate(startDate);
  const displayEnd   = toDisplayDate(endDate);
  const ok =
    (finalValue.includes(startDate)    || finalValue.includes(displayStart)) &&
    (finalValue.includes(endDate)      || finalValue.includes(displayEnd));
  return { success: ok };
}

export async function getBookingReservations(args = {}) {
  return _bookingSerialize(() => _autoRefreshOnExpiry(() => _getBookingReservations(args)));
}
async function _getBookingReservations({ startDate, endDate, useSearchUrl = false } = {}) {
  const start = startDate || today();
  const end   = endDate   || oneYearFromNow();
  resetDiag();
  bookingLog('getBookingReservations', { start, end, useSearchUrl });

  let ctx;
  try {
    ctx = await getBrowserContext();
  } catch (err) {
    throw diagError(err);
  }

  const { page } = ctx;

  try {
    // ── Warm-up nav ─────────────────────────────────────────────────────────
    await page.goto('https://admin.booking.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    bookingLog('after warm-up nav', { url: page.url() });

    if (isLoginUrl(page.url())) {
      throw new Error(`Session expired at warm-up (landed on: ${page.url()}) — run: node save-session.js booking (or call the refresh_booking_session MCP tool)`);
    }

    await randomDelay(2_000, 4_000);
    await selectPropertyIfNeeded(page);

    // Extract current hotel_id — needed when we build the direct search URL
    // (search_reservations.html requires it in the query string).
    let hotelId = null;
    try { hotelId = new URL(page.url()).searchParams.get('hotel_id'); } catch {}
    if (!hotelId) hotelId = getPropertyConfig().hotelId;

    let apiPromise;

    if (useSearchUrl) {
      // ── Direct nav to search_reservations.html with date+status filters ───
      const searchUrl = new URL('https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/search_reservations.html');
      searchUrl.searchParams.set('upcoming_reservations', '1');
      searchUrl.searchParams.set('source', 'nav');
      searchUrl.searchParams.set('lang', 'en');
      if (hotelId) searchUrl.searchParams.set('hotel_id', hotelId);
      searchUrl.searchParams.set('reservation_status', 'ok');
      searchUrl.searchParams.set('date_from', start);
      searchUrl.searchParams.set('date_to', end);
      searchUrl.searchParams.set('date_type', 'arrival');
      const finalSearchUrl = withSesParam(page.url(), searchUrl.toString());
      bookingLog('search_reservations: navigating', { url: finalSearchUrl });

      // Collect ALL JSON API responses that fire during navigation so we can
      // pick out the one that actually contains reservations (Booking's page
      // fires several XHRs — saved-searches, filters, then reservations).
      const _allApiResponses = [];
      const _apiCollector = async (response) => {
        try {
          const url = response.url();
          if (!/admin\.booking\.com|fresa|extranet/i.test(url)) return;
          const ct = response.headers()['content-type'] ?? '';
          if (!ct.includes('json')) return;
          if (!response.ok()) return;
          const json = await response.json().catch(() => null);
          if (json) _allApiResponses.push({ url, json });
        } catch { /* ignore */ }
      };
      page.on('response', _apiCollector);

      await page.goto(finalSearchUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      // Extra settling time — some Booking data loads after networkidle
      await page.waitForTimeout(3_000);
      bookingLog('search_reservations: loaded', { url: page.url() });
      assertNotLoginPage(page.url());

      // Detach collector, then log every intercepted URL + array structure
      page.off('response', _apiCollector);
      bookingLog('search_reservations: intercepted API count', { count: _allApiResponses.length });

      // Special: log the raw payload of any `list_request` / reservations URLs
      // — those are the primary suspects for containing the reservation data.
      for (const r of _allApiResponses) {
        if (/list_request|reservations\/list|search_reservations|extranet\/reservations/i.test(r.url)) {
          const raw = JSON.stringify(r.json).slice(0, 1500);
          bookingLog('search_reservations: candidate raw', { url: r.url.slice(0, 150), payload: raw });
        }
      }
      let chosen = null;
      for (const r of _allApiResponses) {
        const arrays = [];
        const walk = (n, path, depth) => {
          if (!n || depth > 6) return;
          if (Array.isArray(n)) {
            if (n.length > 0 && typeof n[0] === 'object' && n[0] !== null) {
              const firstKeys = Object.keys(n[0]).slice(0, 20);
              arrays.push({ path, count: n.length, firstKeys });
            }
            return;
          }
          if (typeof n === 'object') {
            for (const [k, v] of Object.entries(n)) walk(v, path ? path + '.' + k : k, depth + 1);
          }
        };
        walk(r.json, '', 0);
        bookingLog('search_reservations: API', { url: r.url.slice(0, 120), topKeys: Object.keys(r.json).slice(0, 10), arrays: arrays.slice(0, 8) });
        // Score by reservation-ish keys
        for (const a of arrays) {
          const kstr = a.firstKeys.join(',').toLowerCase();
          // Reservations should have DATES + AMOUNT + GUEST-ish
          const hasDate = /check[_-]?in|arrival|checkin_date|arrival_date|dt_in/.test(kstr);
          const hasAmount = /amount|price|total|revenue|room_price/.test(kstr);
          const hasGuest = /guest_name|booker_name|guest_first|customer|guest\.|room_name/.test(kstr);
          if (hasDate && (hasAmount || hasGuest)) {
            // pick the largest matching array
            if (!chosen || a.count > chosen.array.count) chosen = { array: a, response: r };
          }
        }
      }
      if (chosen) {
        bookingLog('search_reservations: chosen array', { path: chosen.array.path, count: chosen.array.count, firstKeys: chosen.array.firstKeys, url: chosen.response.url.slice(0, 120) });
        const arr = chosen.array.path.split('.').reduce((o, k) => o?.[k], chosen.response.json);
        if (Array.isArray(arr) && arr.length > 0) {
          bookingLog('search_reservations: first record', { sample: JSON.stringify(arr[0]).slice(0, 500) });
          return arr.map(r => ({
            guest:     r.guest_name ?? r.booker_name ?? r.customer_name ?? (r.guest && r.guest.name) ?? '',
            checkin:   r.checkin ?? r.check_in ?? r.arrival ?? r.arrival_date ?? r.dt_in ?? r.checkin_date ?? '',
            checkout:  r.checkout ?? r.check_out ?? r.departure ?? r.departure_date ?? r.dt_out ?? r.checkout_date ?? '',
            status:    normalizeStatus(r.status ?? r.reservation_status ?? r.state ?? r.booking_status ?? ''),
            total:     r.total_price ?? r.price ?? r.amount ?? r.total ?? r.revenue ?? r.room_price ?? '',
            bookingId: r.id ?? r.booking_id ?? r.reservation_id ?? r.booking_number ?? r.reservation_number ?? '',
          }));
        }
      }
      bookingLog('search_reservations: no matching array found — falling through to DOM scrape');
      apiPromise = Promise.resolve(null); // signal existing code to skip API path
      await randomDelay(500, 1_000);
    } else {
      // ── Navigate to Reservations page (existing default path) ────────────
      const reservationsLinkSelectors = [
        'nav a[href*="/groups/reservations/"]',
        'a[href*="/groups/reservations/"]:visible',
        'header a:has-text("Reservations")',
        'nav a:has-text("Reservations")',
        'a[data-test-id*="reservations"]',
        'a:has-text("Reservations")',
      ];

      let clickedNav = false;
      for (const sel of reservationsLinkSelectors) {
        try {
          await page.click(sel, { timeout: 3_000 });
          bookingLog('clicked Reservations menu link', { sel });
          clickedNav = true;
          break;
        } catch {}
      }

      if (!clickedNav) {
        const { reservationsUrl: baseReservationsUrl } = getSavedUrls();
        const fallbackUrl = withSesParam(page.url(), baseReservationsUrl);
        bookingLog('reservations link not found — falling back to direct nav', { fallbackUrl });
        await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded' });
      }

      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      bookingLog('after reservations nav', { url: page.url() });

      assertNotLoginPage(page.url());

      await randomDelay(1_500, 3_500);

      apiPromise = interceptApiResponse(
        page,
        /booking-list|reservations|bookings/i
      );

      // ── Apply date filter — this now calls the fixed commitAndWait() ─────
      const filterResult = await applyDateFilter(page, start, end);
      bookingLog('date filter attempt', filterResult);
    }

    // Snapshot the input value AFTER applyDateFilter — confirms whether the
    // date range actually stuck on the widget (not just visibly). Skip on the
    // useSearchUrl path since the date-range widget isn't rendered there.
    if (!useSearchUrl) {
      const postFilterInputValue = await page
        .locator('#peg-reservations-ranged')
        .first()
        .inputValue()
        .catch(() => '');
      bookingLog('post-filter input value', { value: postFilterInputValue, expected: `${start} … ${end}` });
    }

    // ── Try API interception first (fastest, most reliable) ──────────────────
    // Register a persistent collector that captures EVERY matching API response
    // so we can aggregate paginated results (Booking returns 30 per page).
    const _paginatedApiResponses = [];
    const _paginationHandler = async (response) => {
      try {
        const url = response.url();
        if (!/booking-list|reservations|bookings/i.test(url)) return;
        const ct = response.headers()['content-type'] ?? '';
        if (!ct.includes('json')) return;
        if (!response.ok()) return;
        const json = await response.json().catch(() => null);
        if (json) _paginatedApiResponses.push(json);
      } catch { /* ignore */ }
    };
    page.on('response', _paginationHandler);

    const apiData = await apiPromise;
    if (apiData) {
      const items =
        apiData?.data?.reservations ??
        apiData?.reservations ??
        apiData?.data ??
        (Array.isArray(apiData) ? apiData : null);

      bookingLog('API intercept returned data', {
        topKeys: typeof apiData === 'object' ? Object.keys(apiData ?? {}).slice(0, 15) : typeof apiData,
        itemsIsArray: Array.isArray(items),
        itemCount: Array.isArray(items) ? items.length : null,
      });

      // Scroll-paginate: if the first response returned exactly 30 rows (or
      // any suspicious "full page"), scroll to trigger additional API calls
      // and collect all responses.
      if (Array.isArray(items) && items.length >= 30) {
        bookingLog('API returned full page, scrolling for more pages');
        const SCROLL_MAX_MS = 30_000;
        const scrollStart = Date.now();
        let prevRespCount = _paginatedApiResponses.length;
        let stableScrolls = 0;
        for (let iter = 0; iter < 20; iter++) {
          if (Date.now() - scrollStart > SCROLL_MAX_MS) {
            bookingLog('pagination scroll: time budget exhausted', { iter });
            break;
          }
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(1_500);
          const curRespCount = _paginatedApiResponses.length;
          if (curRespCount === prevRespCount) {
            stableScrolls++;
            if (stableScrolls >= 2) { bookingLog('pagination scroll: no new API responses', { iter, curRespCount }); break; }
          } else {
            stableScrolls = 0;
            bookingLog('pagination scroll: got more responses', { iter, curRespCount });
          }
          prevRespCount = curRespCount;
        }
        page.off('response', _paginationHandler);

        // Merge all collected pages
        const seen = new Set();
        const merged = [];
        for (const resp of _paginatedApiResponses) {
          const pageItems =
            resp?.data?.reservations ?? resp?.reservations ?? resp?.data ??
            (Array.isArray(resp) ? resp : null);
          if (!Array.isArray(pageItems)) continue;
          for (const r of pageItems) {
            const id = r.id ?? r.booking_id ?? r.reservation_id ?? '';
            if (!id) { merged.push(r); continue; }
            if (seen.has(id)) continue;
            seen.add(id);
            merged.push(r);
          }
        }
        bookingLog('pagination scroll: merged pages', { pages: _paginatedApiResponses.length, total: merged.length });
        if (merged.length > items.length) {
          diagInfo('get_booking_reservations');
          return merged.map(r => ({
            guest:     r.guest_name ?? r.booker_name ?? r.guest?.name ?? '',
            checkin:   r.checkin ?? r.arrival ?? r.check_in ?? '',
            checkout:  r.checkout ?? r.departure ?? r.check_out ?? '',
            status:    normalizeStatus(r.status ?? r.reservation_status ?? ''),
            total:     r.total_price ?? r.price ?? r.amount ?? '',
            bookingId: r.id ?? r.booking_id ?? r.reservation_id ?? '',
          }));
        }
      } else {
        page.off('response', _paginationHandler);
      }

      // Deep inspect: find array fields anywhere in the response for adapters
      if (!Array.isArray(items) || items.length === 0) {
        const _foundArrays = [];
        const _walk = (node, path, depth) => {
          if (!node || depth > 6) return;
          if (Array.isArray(node)) {
            if (node.length > 0 && typeof node[0] === 'object') {
              _foundArrays.push({ path, count: node.length, firstKeys: Object.keys(node[0]).slice(0, 15) });
            }
            return;
          }
          if (typeof node === 'object') {
            for (const [k, v] of Object.entries(node)) _walk(v, path ? path + '.' + k : k, depth + 1);
          }
        };
        _walk(apiData, '', 0);
        bookingLog('API intercept — no items array matched; found these arrays:', {
          arrays: _foundArrays.slice(0, 10),
          fullTopKeys: typeof apiData === 'object' ? Object.keys(apiData ?? {}) : typeof apiData,
        });
        // Also try the arrays that look like they might be reservations
        for (const found of _foundArrays) {
          const keysStr = found.firstKeys.join(',').toLowerCase();
          if (/guest|booker|check|arrival|departure|amount|price|status|book/.test(keysStr)) {
            const arr = found.path.split('.').reduce((o, k) => o?.[k], apiData);
            if (Array.isArray(arr) && arr.length > 0) {
              bookingLog('API intercept — using auto-detected array', { path: found.path, count: arr.length, firstItem: JSON.stringify(arr[0]).slice(0, 400) });
              return arr.map(r => ({
                guest:     r.guest_name ?? r.booker_name ?? r.guest?.name ?? r.name ?? '',
                checkin:   r.checkin ?? r.check_in ?? r.arrival ?? r.arrival_date ?? '',
                checkout:  r.checkout ?? r.check_out ?? r.departure ?? r.departure_date ?? '',
                status:    normalizeStatus(r.status ?? r.reservation_status ?? r.state ?? ''),
                total:     r.total_price ?? r.price ?? r.amount ?? r.total ?? r.revenue ?? '',
                bookingId: r.id ?? r.booking_id ?? r.reservation_id ?? r.booking_number ?? '',
              }));
            }
          }
        }
      }

      if (Array.isArray(items) && items.length > 0) {
        bookingLog('API first item keys', { sample: JSON.stringify(items[0]).slice(0, 400) });
        bookingLog('returning data from API intercept', { count: items.length });
        diagInfo('get_booking_reservations');
        return items.map(r => ({
          guest:     r.guest_name ?? r.booker_name ?? r.guest?.name ?? '',
          checkin:   r.checkin ?? r.arrival ?? r.check_in ?? '',
          checkout:  r.checkout ?? r.departure ?? r.check_out ?? '',
          status:    normalizeStatus(r.status ?? r.reservation_status ?? ''),
          total:     r.total_price ?? r.price ?? r.amount ?? '',
          bookingId: r.id ?? r.booking_id ?? r.reservation_id ?? '',
        }));
      }
    } else {
      bookingLog('API intercept produced no JSON response in window');
      page.off('response', _paginationHandler);
    }

    // ── DOM fallback ─────────────────────────────────────────────────────────
    bookingLog('API intercept returned no data — falling back to DOM scrape');
    // Detach listener defensively if still attached
    try { page.off('response', _paginationHandler); } catch { /* ignore */ }

    // Paginate: scroll + click "Load more" / "Show more" until row count stabilises.
    // Booking.com uses infinite scroll or a "Load more" button — try both.
    //
    // Termination:
    //   • Hard cap of PAGINATE_MAX_MS wall-clock so the MCP client (which times
    //     out around 60s) always gets a response.
    //   • Also break after two consecutive iterations with no new rows and no
    //     load-more click — the page has clearly stabilised.
    const ROW_SELS_FOR_COUNT = [
      '[data-testid="reservation-row"]', '[data-test-id="reservation-row"]',
      '[data-test-id*="reservation-list-item"]', 'main table tbody tr',
    ];
    const PAGINATE_MAX_MS = 25_000;
    const paginateStart = Date.now();
    let prevRowCount = -1;
    let stableIterations = 0;
    for (let page_i = 0; page_i < 10; page_i++) {
      if (Date.now() - paginateStart > PAGINATE_MAX_MS) {
        bookingLog('pagination time budget exhausted', { page_i, elapsedMs: Date.now() - paginateStart });
        break;
      }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1_000);

      const loadMoreSelectors = [
        'button:has-text("Show more")', 'button:has-text("Load more")',
        '[data-test-id*="load-more"]', '[data-test-id*="show-more"]',
        '[class*="load-more"]', '[class*="pagination"] a[rel="next"]',
      ];
      let loadMoreClicked = false;
      for (const sel of loadMoreSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
          try { await btn.click({ timeout: 2_000 }); await page.waitForTimeout(1_500); loadMoreClicked = true; break; } catch {}
        }
      }

      const curCount = await page.evaluate((sels) => {
        for (const s of sels) { const r = document.querySelectorAll(s); if (r.length) return r.length; }
        return 0;
      }, ROW_SELS_FOR_COUNT);
      bookingLog('pagination step', { page_i, curCount, prevRowCount, loadMoreClicked });
      if (curCount === prevRowCount && !loadMoreClicked) {
        stableIterations++;
        if (stableIterations >= 2) break; // two stable iterations in a row → done
      } else {
        stableIterations = 0;
      }
      prevRowCount = curCount;
    }

    const scrapeResult = await page.evaluate(() => {
      // Try every known row pattern AND record which one matched + how many.
      const patterns = [
        { name: 'data-testid=reservation-row', sel: '[data-testid="reservation-row"]' },
        { name: 'tr[data-reservation-id]',     sel: 'tr[data-reservation-id]' },
        { name: 'tr[data-id]',                 sel: 'tr[data-id]' },
        { name: 'reservation/booking item/row/card class', sel: '[class*="reservation"][class*="item"], [class*="booking"][class*="row"], [class*="booking"][class*="card"]' },
        // Booking groups extranet new-gen patterns we've seen elsewhere
        { name: 'data-test-id=reservation-row',sel: '[data-test-id="reservation-row"]' },
        { name: 'data-test-id*=reservation-list-item', sel: '[data-test-id*="reservation-list-item"]' },
        { name: 'tbody tr (peg list table)',   sel: 'table[class*="peg-reservations"] tbody tr' },
        { name: 'tbody tr (any list table)',   sel: 'main table tbody tr' },
      ];
      const counts = {};
      let matched = null;
      let rows = [];
      for (const p of patterns) {
        const r = [...document.querySelectorAll(p.sel)];
        counts[p.name] = r.length;
        if (!matched && r.length) { matched = p.name; rows = r; }
      }

      const cellByHeading = (row, ...fragments) => {
        for (const frag of fragments) {
          const el = row.querySelector(`td[data-heading*="${frag}"]`);
          if (el) return el.textContent?.trim() ?? '';
        }
        return null;
      };

      const data = rows.map(row => ({
        guest: (
          cellByHeading(row, 'Guest', 'Booker', 'Name') ??
          row.querySelector('[data-testid="guest-name"], [data-testid="booker-name"], .guest-name, [class*="guest"][class*="name"]')
            ?.textContent?.trim() ?? ''
        ),
        checkin: (
          cellByHeading(row, 'Check-in', 'Check in', 'Arrival') ??
          row.querySelector('[data-testid="checkin-date"], [class*="checkin"], [class*="check-in"], [class*="arrival"]')
            ?.textContent?.trim() ?? ''
        ),
        checkout: (
          cellByHeading(row, 'Check-out', 'Check out', 'Departure') ??
          row.querySelector('[data-testid="checkout-date"], [class*="checkout"], [class*="check-out"], [class*="departure"]')
            ?.textContent?.trim() ?? ''
        ),
        status: (
          cellByHeading(row, 'Status') ??
          row.querySelector('[data-testid="status"], [class*="status"], [class*="badge"]')
            ?.textContent?.trim() ?? ''
        ),
        total: (
          cellByHeading(row, 'Total', 'Price', 'Revenue', 'Amount') ??
          row.querySelector('[data-testid="total-price"], [class*="price"], [class*="amount"], [class*="total"]')
            ?.textContent?.trim() ?? ''
        ),
        bookingId: (
          cellByHeading(row, 'Booking', 'Reservation', 'Reference') ??
          row.getAttribute('data-reservation-id') ??
          row.getAttribute('data-id') ??
          row.querySelector('[data-testid="booking-id"], [class*="booking"][class*="id"]')
            ?.textContent?.trim() ?? ''
        ),
      }));

      // Fallback: if the primary extraction produced empty fields (as happens
      // on search_reservations.html which lacks data-heading attributes),
      // extract positionally by reading the <thead>/<th> column names on the
      // same table. Uses Booking's export column names as the source of truth.
      const allFieldsEmpty = data.length > 0 && data.every(r =>
        !r.guest && !r.checkin && !r.checkout && !r.total && !r.bookingId);
      let headerData = null;
      let headerNames = [];
      if (allFieldsEmpty && rows.length > 0) {
        const table = rows[0].closest('table');
        if (table) {
          const headerCells = [
            ...table.querySelectorAll('thead th, thead td'),
            ...(table.querySelector('thead') ? [] :
                [...table.querySelectorAll('tr:first-child th, tr:first-child td')]),
          ];
          headerNames = headerCells.map(h => (h.textContent || '').trim());
          const findIdx = (...needles) => {
            for (const n of needles) {
              const idx = headerNames.findIndex(h => h.toLowerCase().includes(n.toLowerCase()));
              if (idx >= 0) return idx;
            }
            return -1;
          };
          const iGuest    = findIdx('guest name', 'guest(s)', 'guest', 'booker', 'name');
          const iCheckin  = findIdx('check-in', 'check in', 'arrival');
          const iCheckout = findIdx('check-out', 'check out', 'departure');
          const iStatus   = findIdx('status');
          const iPrice    = findIdx('price', 'total', 'revenue', 'amount');
          const iBookNum  = findIdx('book number', 'booking id', 'reservation', 'reference');
          const cellText = (row, i) => (i >= 0 && row.children[i]) ? (row.children[i].textContent || '').trim() : '';
          // Rows to iterate: prefer table.tbody tr; if not present, all tr except the first (header)
          const bodyRows = table.querySelector('tbody')
            ? [...table.querySelectorAll('tbody tr')]
            : [...table.querySelectorAll('tr')].slice(1);
          headerData = bodyRows.map(row => ({
            guest:     cellText(row, iGuest),
            checkin:   cellText(row, iCheckin),
            checkout:  cellText(row, iCheckout),
            status:    cellText(row, iStatus),
            total:     cellText(row, iPrice),
            bookingId: cellText(row, iBookNum),
          }));
        }
      }

      return {
        counts,
        matched,
        data,
        headerData,
        headerNames,
        firstRowHtml: rows[0]?.innerHTML?.slice(0, 3000) ?? '',
        columnHeadings: [...new Set([...document.querySelectorAll('td[data-heading]')].map(td => td.getAttribute('data-heading')))],
        bodyExcerpt: document.body?.innerText?.slice(0, 800) ?? '',
        // Spot-check whether the page is showing the empty-state message
        isEmptyState:
          /no reservations/i.test(document.body?.innerText ?? '') ||
          !!document.querySelector('[class*="empty"], [class*="no-reservations"]'),
      };
    });

    bookingLog('DOM scrape patterns tried', scrapeResult.counts);
    bookingLog('DOM first row HTML', { html: scrapeResult.firstRowHtml });
    bookingLog('DOM column headings', { headings: scrapeResult.columnHeadings });
    bookingLog('DOM header names', { headers: scrapeResult.headerNames });
    bookingLog('DOM scrape outcome', {
      matchedPattern: scrapeResult.matched,
      rowCount: scrapeResult.data.length,
      headerFallbackCount: scrapeResult.headerData ? scrapeResult.headerData.length : null,
      isEmptyState: scrapeResult.isEmptyState,
    });

    // Prefer the header-fallback data when the primary extractor returned
    // empty rows (e.g. on search_reservations.html which has no data-heading
    // attributes but has proper <thead>/<th> column names).
    const finalData = (scrapeResult.headerData && scrapeResult.headerData.length > 0)
      ? scrapeResult.headerData
      : scrapeResult.data;

    if (finalData.length > 0) {
      diagInfo('get_booking_reservations');
      return finalData.map(r => ({ ...r, status: normalizeStatus(r.status) }));
    }

    // No rows AND no API data — return the raw page excerpt for debugging
    // and emit the diagnostic to the main log so we can see why.
    bookingLog('no rows found anywhere; returning _raw fallback', {
      bodyExcerpt: scrapeResult.bodyExcerpt.slice(0, 300),
    });
    diagInfo('get_booking_reservations');
    return [{ _raw: scrapeResult.bodyExcerpt }];

  } catch (err) {
    throw diagError(err);
  } finally {
    await closeBrowserContext(ctx);
  }
}

export async function getBookingMessages() {
  return _bookingSerialize(() => _autoRefreshOnExpiry(() => _getBookingMessages()));
}
async function _getBookingMessages() {
  resetDiag();
  let ctx;
  try {
    ctx = await getBrowserContext();
  } catch (err) {
    throw diagError(err);
  }

  const { page } = ctx;

  try {
    await page.goto('https://admin.booking.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    bookingLog('messages: after warm-up nav', { url: page.url() });

    if (isLoginUrl(page.url())) {
      throw new Error(`Session expired at warm-up (landed on: ${page.url()}) — run: node save-session.js booking (or call the refresh_booking_session MCP tool)`);
    }

    await randomDelay(2_000, 4_000);
    await selectPropertyIfNeeded(page);

    const apiPromise = interceptApiResponse(page, /inbox|messages|conversations/i);

    const inboxLinkSelectors = [
      'nav a[href*="/inbox/"]',
      'nav a[href*="/messages/"]',
      'a[href*="/inbox/"]:visible',
      'header a:has-text("Inbox")',
      'nav a:has-text("Inbox")',
      'nav a:has-text("Messages")',
      'a[data-test-id*="inbox"]',
      'a[data-test-id*="messages"]',
      'a:has-text("Inbox")',
    ];

    let clickedNav = false;
    for (const sel of inboxLinkSelectors) {
      try {
        await page.click(sel, { timeout: 3_000 });
        bookingLog('clicked Inbox menu link', { sel });
        clickedNav = true;
        break;
      } catch {}
    }

    if (!clickedNav) {
      const inboxUrl = withSesParam(
        page.url(),
        'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/inbox/'
      );
      bookingLog('inbox link not found — falling back to direct nav', { inboxUrl });
      await page.goto(inboxUrl, { waitUntil: 'domcontentloaded' });
    }

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    bookingLog('messages: after nav', { url: page.url() });

    assertNotLoginPage(page.url());
    await randomDelay(1_500, 3_000);

    const apiData = await apiPromise;
    if (apiData) {
      const items =
        apiData?.data?.messages ??
        apiData?.messages ??
        apiData?.data?.conversations ??
        apiData?.conversations ??
        apiData?.data ??
        (Array.isArray(apiData) ? apiData : null);

      if (Array.isArray(items) && items.length > 0) {
        bookingLog('returning messages from API intercept', { count: items.length });
        diagInfo('get_booking_messages');
        return items.map(m => ({
          guest:     m.guest_name ?? m.booker_name ?? m.guest?.name ?? m.sender_name ?? '',
          preview:   m.last_message ?? m.preview ?? m.message_preview ?? m.body ?? '',
          unread:    !!(m.unread ?? m.is_unread ?? false),
          time:      m.last_message_time ?? m.created_at ?? m.timestamp ?? '',
          bookingId: m.booking_id ?? m.reservation_id ?? m.id ?? '',
        }));
      }
    }

    bookingLog('messages API intercept returned no data — falling back to DOM scrape');

    try {
      await page.waitForSelector(
        '[data-testid="message-thread"], [class*="conversation"], [class*="message-item"], [class*="inbox-item"]',
        { timeout: 10_000 }
      );
    } catch {
      // inbox may be empty or selectors changed
    }

    const messages = await page.evaluate(() => {
      const threadSelectors = [
        '[data-testid="message-thread"]',
        '[data-test-id="message-thread"]',
        '[class*="conversation-item"]',
        '[class*="message-item"]',
        '[class*="inbox-item"]',
        '[class*="thread-item"]',
        'li[class*="conversation"]',
        'li[class*="message"]',
      ];

      let threads = [];
      for (const sel of threadSelectors) {
        const found = [...document.querySelectorAll(sel)];
        if (found.length > 0) { threads = found; break; }
      }

      return threads.slice(0, 20).map(thread => {
        const getText = (...sels) => {
          for (const s of sels) {
            const el = thread.querySelector(s);
            if (el?.textContent?.trim()) return el.textContent.trim();
          }
          return '';
        };
        return {
          guest:     getText('[data-testid="guest-name"]', '[class*="guest-name"]', '[class*="sender"]', '[class*="booker"]'),
          preview:   getText('[data-testid="message-preview"]', '[class*="preview"]', '[class*="last-message"]', '[class*="message-body"]', 'p'),
          unread:    !!(thread.querySelector('[class*="unread"]') || thread.querySelector('[data-testid="unread-badge"]')),
          time:      getText('[data-testid="message-time"]', '[class*="time"]', '[class*="date"]', 'time'),
          bookingId: thread.getAttribute('data-booking-id') ?? thread.getAttribute('data-reservation-id') ?? '',
        };
      });
    });

    bookingLog('DOM scrape messages result', { count: messages.length });
    diagInfo('get_booking_messages');
    return messages;

  } catch (err) {
    throw diagError(err);
  } finally {
    await closeBrowserContext(ctx);
  }
}

export async function getBookingEarnings({ year, month } = {}) {
  return _bookingSerialize(() => _autoRefreshOnExpiry(() => _getBookingEarnings({ year, month })));
}

async function _getBookingEarnings({ year, month } = {}) {
  resetDiag();
  let ctx;
  try {
    ctx = await getBrowserContext();
  } catch (err) {
    throw diagError(err);
  }

  const { page } = ctx;

  try {
    // ── Step 1: Go to home and establish property context ─────────────────────
    await page.goto('https://admin.booking.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    bookingLog('earnings: home page loaded', { url: page.url() });

    if (isLoginUrl(page.url())) {
      throw new Error(`Session expired (landed on: ${page.url()}) — run: node save-session.js booking (or call the refresh_booking_session MCP tool)`);
    }

    await randomDelay(1_500, 3_000);
    await selectPropertyIfNeeded(page);
    bookingLog('earnings: after property selection', { url: page.url() });

    // Extract hotel_id from post-selection URL; fall back to saved property file.
    let hotelId = null;
    try { hotelId = new URL(page.url()).searchParams.get('hotel_id'); } catch {}
    if (!hotelId) hotelId = getPropertyConfig().hotelId;

    if (hotelId && !fs.existsSync(PROPERTY_FILE)) {
      try {
        fs.writeFileSync(PROPERTY_FILE, JSON.stringify({ hotelId }, null, 2), 'utf-8');
        bookingLog('earnings: saved hotel_id', { hotelId });
      } catch { /* non-critical */ }
    }

    // ── Step 2: Set up API intercept JUST BEFORE payouts navigation ───────────
    // Starting the 30s timer here (not at function entry) ensures it's still
    // live when the payouts page fires its XHR calls.
    const apiPromise = interceptApiResponse(
      page,
      /payout|payment|invoice|finance|transaction|revenue|commission|earning/i,
      30_000
    );

    // ── Step 3: Navigate to the payouts page ─────────────────────────────────
    // Use the base payouts URL with NO query params. The session cookie carries
    // the property context (hotel_id), so adding it to the URL causes the SPA
    // to re-initialize as a property-switch, which redirects to the dashboard.
    // Confirmed working URL from the Booking.com admin panel:
    //   https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/payouts.html
    const BASE_PAYOUTS = 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/payouts.html';

    // Build payouts URL with ses + hotel_id + lang from current page. Direct
    // nav to BASE_PAYOUTS without these gets redirected to home for groups
    // accounts (confirmed from prior debug log: payouts → home redirect).
    let payoutsUrl = withSesParam(page.url(), BASE_PAYOUTS);
    // Force hotel_id even if not in current URL (extranet_ng requires it)
    try {
      const u = new URL(payoutsUrl);
      if (hotelId && !u.searchParams.get('hotel_id')) u.searchParams.set('hotel_id', hotelId);
      if (!u.searchParams.get('lang')) u.searchParams.set('lang', 'en');
      payoutsUrl = u.toString();
    } catch {}

    bookingLog('earnings: navigating to payouts', { url: payoutsUrl });
    const payoutsResp = await page.goto(payoutsUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
    const payoutsStatus = payoutsResp?.status() ?? 0;
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    bookingLog('earnings: payouts page loaded', { url: page.url(), httpStatus: payoutsStatus });

    // Fallback: redirected away — re-fetch a fresh ses from current page
    // (warm-up token may have expired or been invalidated by the redirect).
    if (!page.url().includes('payouts') && hotelId) {
      const fallbackUrl = withSesParam(
        page.url(),
        `${BASE_PAYOUTS}?hotel_id=${hotelId}&lang=en`
      );
      bookingLog('earnings: payouts redirected — retrying with hotel_id+ses', { url: fallbackUrl, redirectedTo: page.url() });
      await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      bookingLog('earnings: fallback payouts loaded', { url: page.url() });
    }

    if (payoutsStatus >= 400) {
      throw new Error(`Payouts page returned HTTP ${payoutsStatus} — re-run: node save-session.js booking (or call the refresh_booking_session MCP tool)`);
    }
    assertNotLoginPage(page.url());
    bookingLog('earnings: confirmed on payouts page', { url: page.url() });

    // Scroll to trigger lazy-loaded payment history rows.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1_200);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    // ── API intercept (fastest path) ─────────────────────────────────────────
    const apiData = await apiPromise;
    if (apiData) {
      bookingLog('earnings API intercept hit', { topKeys: Object.keys(apiData ?? {}).slice(0, 8) });

      const invoices =
        apiData?.data?.payouts      ?? apiData?.payouts      ??
        apiData?.data?.invoices     ?? apiData?.invoices     ??
        apiData?.data?.transactions ?? apiData?.transactions ??
        (Array.isArray(apiData?.data) ? apiData.data : null) ??
        (Array.isArray(apiData)       ? apiData       : null);

      const summary =
        apiData?.data?.summary ?? apiData?.summary ??
        apiData?.data?.totals  ?? apiData?.totals  ?? null;

      if (invoices || summary) {
        diagInfo('get_booking_earnings');
        return {
          year: year ?? new Date().getFullYear(),
          month: month ?? null,
          summary: summary ?? {},
          transactions: (invoices ?? []).slice(0, 50).map(p => ({
            date:   p.payout_date  ?? p.date         ?? p.invoice_date ?? p.period ?? '',
            amount: p.amount       ?? p.payout_amount ?? p.total       ?? p.revenue ?? '',
            period: p.period       ?? p.coverage_period ?? p.booking_period ?? '',
            type:   p.type         ?? p.invoice_type ?? 'payout',
            status: p.status       ?? p.payout_status ?? '',
            id:     p.payout_id    ?? p.id           ?? p.invoice_id  ?? '',
          })),
          _source: 'api',
        };
      }
    }

    // ── DOM fallback ──────────────────────────────────────────────────────────
    bookingLog('earnings: API returned no data — DOM scrape');

    const scraped = await page.evaluate(() => {
      // ── Summary — real fields, not class-name keys ───────────────────────────
      const bodyText = document.body?.innerText ?? '';
      const amtRe = /[£€$]\s*[\d,]+\.?\d*/g;
      const amtMatches = [...bodyText.matchAll(amtRe)].map(m => m[0]);
      const currency = amtMatches[0]?.match(/[£€$]/)?.[0] ?? '£';
      // Look for labelled amounts first
      const labelledAmt = (label) => {
        const re = new RegExp(label + '[\\s\\S]{0,30}?([£€$]\\s*[\\d,]+\\.?\\d*)', 'i');
        return (re.exec(bodyText) ?? [])[1] ?? null;
      };
      const summary = {
        totalPaid:       labelledAmt('total|balance|amount paid') ?? amtMatches[0] ?? null,
        lastPayoutDate:  (bodyText.match(/\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}/) ?? [])[0] ?? null,
        currency,
      };

      // ── Payment history rows ────────────────────────────────────────────────
      // Try progressively broader selectors. The payment history section lives
      // below the "You're all settled up!" outstanding-invoices header.
      const rowSelectors = [
        '[data-test-id*="payout-row"]',
        '[data-testid*="payout-row"]',
        '[class*="PayoutRow"]',
        '[class*="payout-row"]',
        '[class*="payout-item"]',
        '[data-test-id*="payment-row"]',
        '[class*="PaymentRow"]',
        '[class*="payment-row"]',
        '[class*="payment-item"]',
        '[data-test-id*="invoice-row"]',
        '[class*="InvoiceRow"]',
        '[class*="invoice-row"]',
        '[class*="transaction-row"]',
        // Generic table rows — filter below by content
        'table tbody tr',
        // Booking.com sometimes uses list items for payment history
        '[class*="payout"] li',
        '[class*="payment"] li',
      ];

      let rows = [];
      let matchedSel = null;
      for (const sel of rowSelectors) {
        const found = [...document.querySelectorAll(sel)];
        if (found.length) { rows = found; matchedSel = sel; break; }
      }

      // For table rows, require a monetary value so we skip header/status rows.
      // For semantic payout/payment selectors we trust the selector is specific enough.
      const needsMonetaryFilter = matchedSel === 'table tbody tr';
      const transactions = rows.slice(0, 100)
        .filter(row => {
          const text = row.textContent?.trim() ?? '';
          if (!text) return false;
          if (needsMonetaryFilter && !/[£€$¥]|[\d]+[.,]\d{2}/.test(text)) return false;
          return true;
        })
        .slice(0, 50)
        .map(row => {
          const tds = [...row.querySelectorAll('td')];
          const td  = (i) => tds[i]?.textContent?.trim() ?? '';
          const raw = row.textContent?.trim() ?? '';

          // Detect amount cell: contains currency symbol
          const amtCell = tds.find(c => /[£€$]/.test(c.textContent ?? ''));
          const amount  = amtCell?.textContent?.trim() ?? '';

          // Detect status cell: short text like "Sent", "Pending", "Paid"
          const statusCell = tds.find(c => {
            const t = c.textContent?.trim() ?? '';
            return /^(sent|paid|pending|cancelled|failed|processing)$/i.test(t);
          });
          const statusRaw = statusCell?.textContent?.trim() ?? '';

          // Detect booking ID: alphanumeric 8-16 chars, no spaces
          const idCell  = tds.find(c => /^[A-Za-z0-9]{8,20}$/.test(c.textContent?.trim() ?? ''));
          const id      = idCell?.textContent?.trim()
                       ?? row.getAttribute('data-payout-id')
                       ?? row.getAttribute('data-id') ?? '';

          // Detect period: contains " - " date range
          const periodCell = tds.find(c => / - /.test(c.textContent ?? '') && /\w{3}/.test(c.textContent ?? ''));
          const period     = periodCell?.textContent?.trim() ?? '';
          const periodParts = period.match(/^(.+?)\s*-\s*(.+)$/);

          // Payout date: first td that looks like a date but is NOT the period range
          const dateCells = tds.filter(c => {
            const t = c.textContent?.trim() ?? '';
            return /\d{1,2}\s+[A-Za-z]{3}/.test(t) && !t.includes(' - ') && t.length < 30;
          });
          const payoutDate = dateCells[0]?.textContent?.trim() ?? td(0);

          return {
            payoutDate,
            periodStart: periodParts ? periodParts[1].trim() : period,
            periodEnd:   periodParts ? periodParts[2].trim() : '',
            id,
            status:      statusRaw,
            amount,
          };
        });

      // Only include the raw body excerpt when we didn't manage to parse
      // structured transaction rows — saves ~2KB per response otherwise.
      const _bodyExcerpt = transactions.length === 0
        ? (document.body?.innerText?.slice(0, 2000) ?? '')
        : undefined;

      return {
        summary, transactions, matchedSel,
        ...(_bodyExcerpt !== undefined && { _bodyExcerpt })
      };
    });

    bookingLog('earnings DOM result', {
      matchedSel: scraped.matchedSel,
      txCount: scraped.transactions.length,
      summaryKeys: Object.keys(scraped.summary ?? {}).length,
    });

    // ── Year sanity check ────────────────────────────────────────────────────
    // The Booking Extranet payouts page ignores query-string year filtering —
    // it always shows current payout history. If the caller asked for a
    // different year, filter the scraped transactions to that year's payouts
    // (using payoutDate → year) so downstream consumers don't get mixed data.
    const requestedYear = year ?? new Date().getFullYear();
    let filteredTx = scraped.transactions;
    let yearFiltered = false;
    if (year != null && Array.isArray(scraped.transactions)) {
      const inYear = (t) => {
        const d = t && t.payoutDate ? new Date(String(t.payoutDate).replace('Sept', 'Sep')) : null;
        return d && !isNaN(d) && d.getFullYear() === requestedYear;
      };
      filteredTx = scraped.transactions.filter(inYear);
      yearFiltered = filteredTx.length !== scraped.transactions.length;
      if (yearFiltered) {
        bookingLog('earnings: filtered transactions to requested year', {
          requestedYear, before: scraped.transactions.length, after: filteredTx.length,
        });
      }
    }
    diagInfo('get_booking_earnings');

    return {
      year: requestedYear,
      month: month ?? null,
      ...scraped,
      transactions: filteredTx,
      ...(yearFiltered && { _yearFiltered: true }),
      _source: 'dom',
    };

  } catch (err) {
    throw diagError(err);
  } finally {
    await closeBrowserContext(ctx);
  }
}

export async function getBookingCalendar(months = 3) {
  return _bookingSerialize(() => _autoRefreshOnExpiry(() => _getBookingCalendar(months)));
}
async function _getBookingCalendar(months = 3) {
  resetDiag();
  let ctx;
  try {
    ctx = await getBrowserContext();
  } catch (err) {
    throw diagError(err);
  }

  const { page } = ctx;

  try {
    await page.goto('https://admin.booking.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    bookingLog('calendar: after warm-up nav', { url: page.url() });

    if (isLoginUrl(page.url())) {
      throw new Error(`Session expired at warm-up (landed on: ${page.url()}) — run: node save-session.js booking (or call the refresh_booking_session MCP tool)`);
    }

    await randomDelay(2_000, 4_000);
    await selectPropertyIfNeeded(page);

    // ── FIX: API intercept set up after navigation, not before ───────────────
    const apiPromise = interceptApiResponse(page, /calendar|availability/i);

    const calendarLinkSelectors = [
      'nav a[href*="/groups/calendar/"]',
      'a[href*="/calendar/"]:visible',
      'header a:has-text("Calendar")',
      'nav a:has-text("Calendar")',
      'a[data-test-id*="calendar"]',
      'a:has-text("Calendar")',
    ];

    let clickedNav = false;
    for (const sel of calendarLinkSelectors) {
      try {
        await page.click(sel, { timeout: 3_000 });
        bookingLog('clicked Calendar menu link', { sel });
        clickedNav = true;
        break;
      } catch {}
    }

    if (!clickedNav) {
      const { calendarUrl: baseCalendarUrl } = getSavedUrls();
      const fallbackUrl = withSesParam(page.url(), baseCalendarUrl);
      bookingLog('calendar link not found — falling back to direct nav', { fallbackUrl });
      await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded' });
    }

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    bookingLog('calendar: after nav', { url: page.url() });

    assertNotLoginPage(page.url());

    await randomDelay(1_500, 3_500);

    const apiData = await apiPromise;
    if (apiData) {
      const days =
        apiData?.data?.days ??
        apiData?.days ??
        apiData?.data ??
        (Array.isArray(apiData) ? apiData : null);

      if (Array.isArray(days) && days.length > 0) {
        const available = [];
        const blocked = [];
        const reservedDates = [];

        for (const d of days) {
          const date = d.date ?? d.day ?? '';
          if (!date) continue;
          const avail = d.available ?? d.availability ?? d.status;
          if (avail === true || avail === 'available' || avail === 1) available.push(date);
          else if (avail === false || avail === 'blocked' || avail === 0) blocked.push(date);
          else if (avail === 'reserved' || d.booked) reservedDates.push(date);
        }

        bookingLog('returning calendar from API intercept', { available: available.length, blocked: blocked.length, reservedDates: reservedDates.length });
        return { available, blocked, reservedDates };
      }
    }

    // DOM fallback
    bookingLog('calendar API intercept returned no data — falling back to DOM scrape');
    const calendar = await page.evaluate(() => {
      const available = [];
      const blocked = [];
      const reservedDates = [];

      const getDate = el =>
        el.getAttribute('data-date') ??
        el.getAttribute('data-day') ??
        el.getAttribute('aria-label') ??
        el.textContent?.trim();

      const availableSelectors = [
        '[data-testid="calendar-day-available"]',
        '[data-availability="available"]',
        '[data-status="available"]',
        '[class*="available"]:not([class*="un"])',
        '.bui-calendar__date--available',
      ];
      const blockedSelectors = [
        '[data-testid="calendar-day-blocked"]',
        '[data-availability="blocked"]',
        '[data-status="blocked"]',
        '[class*="blocked"]',
        '[class*="closed"]',
        '.bui-calendar__date--blocked',
      ];
      const reservedSelectors = [
        '[data-testid="calendar-day-reserved"]',
        '[data-availability="reserved"]',
        '[data-status="booked"]',
        '[class*="reserved"]',
        '[class*="booked"]',
        '.bui-calendar__date--booked',
      ];

      for (const sel of availableSelectors) {
        document.querySelectorAll(sel).forEach(el => {
          const d = getDate(el);
          if (d && !available.includes(d)) available.push(d);
        });
      }
      for (const sel of blockedSelectors) {
        document.querySelectorAll(sel).forEach(el => {
          const d = getDate(el);
          if (d && !blocked.includes(d)) blocked.push(d);
        });
      }
      for (const sel of reservedSelectors) {
        document.querySelectorAll(sel).forEach(el => {
          const d = getDate(el);
          if (d && !reservedDates.includes(d)) reservedDates.push(d);
        });
      }

      return { available, blocked, reservedDates };
    });

    bookingLog('calendar DOM scrape result', { available: calendar.available.length, blocked: calendar.blocked.length, reservedDates: calendar.reservedDates.length });
    return calendar;

  } catch (err) {
    throw diagError(err);
  } finally {
    await closeBrowserContext(ctx);
  }
}

// ─── Monthly gross revenue by check-in month ─────────────────────────────
// Aggregates confirmed reservation totals for a whole year, grouped by
// check-in month. This is the "gross" figure that matches Booking Extranet's
// Reservations export (guest-paid amount, before Booking's commission), and
// is what most hosts consider "monthly revenue".
//
// Implementation: wraps _getBookingReservations with startDate=YYYY-01-01 /
// endDate=YYYY-12-31 and buckets by check-in month. Any reservation the
// underlying scraper doesn't return (e.g. very old past stays Booking hides)
// simply won't be counted — the response includes rawReservationCount so
// callers can detect when the API dropped stays vs actually returning zero.
export async function getBookingMonthlyGross(year) {
  return _bookingSerialize(() => _autoRefreshOnExpiry(() => _getBookingMonthlyGross(year)));
}
async function _getBookingMonthlyGross(year) {
  const y = year ?? new Date().getFullYear();
  const startDate = `${y}-01-01`;
  const endDate   = `${y}-12-31`;
  resetDiag();
  bookingLog('getBookingMonthlyGross', { year: y, startDate, endDate });

  // Reuse the reservations scraper directly (skip the outer serialize wrapper
  // — we're already inside _bookingSerialize). Use search_reservations.html
  // so past + future stays are both included (the default reservations page
  // only shows current+upcoming).
  const reservations = await _getBookingReservations({ startDate, endDate, useSearchUrl: true });
  bookingLog('monthlyGross: raw reservation count', { count: Array.isArray(reservations) ? reservations.length : 0 });

  const MONTH_NAMES_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthly = MONTH_NAMES_SHORT.map((m, i) => ({
    month: m, monthNumber: i + 1, gross: 0, count: 0, reservations: [],
  }));

  const parseAmount = (s) => {
    if (s == null) return 0;
    if (typeof s === 'number') return s;
    const m = String(s).match(/[\d,]+(?:\.\d+)?/);
    return m ? parseFloat(m[0].replace(/,/g, '')) : 0;
  };
  const parseDate = (s) => {
    if (!s) return null;
    const d = new Date(String(s).replace('Sept', 'Sep'));
    return isNaN(d) ? null : d;
  };

  let confirmedTotal = 0, confirmedCount = 0, dropped = 0;
  const rows = Array.isArray(reservations) ? reservations : [];
  for (const r of rows) {
    // Skip the debug _raw shell returned when the scraper found no rows
    if (r && r._raw && Object.keys(r).length === 1) { dropped++; continue; }
    const status = String(r.status || '').toLowerCase();
    if (status !== 'confirmed' && !/^ok/.test(status)) { dropped++; continue; }
    const d = parseDate(r.checkin);
    if (!d || d.getFullYear() !== y) { dropped++; continue; }
    const amt = parseAmount(r.total);
    if (amt <= 0) { dropped++; continue; }
    const idx = d.getMonth();
    monthly[idx].gross += amt;
    monthly[idx].count++;
    monthly[idx].reservations.push({
      guest: r.guest || '',
      checkin: r.checkin,
      checkout: r.checkout,
      total: amt,
      bookingId: r.bookingId || '',
    });
    confirmedTotal += amt;
    confirmedCount++;
  }

  monthly.forEach(m => { m.gross = Math.round(m.gross * 100) / 100; });

  const result = {
    year: y,
    currency: '£',
    monthly,
    summary: {
      totalGross: Math.round(confirmedTotal * 100) / 100,
      confirmedReservations: confirmedCount,
      rawReservationCount: rows.length,
      droppedCount: dropped,
    },
    // Include a small sample of the raw records when everything gets dropped
    // — helps diagnose field-shape mismatches on the search_reservations page.
    ...(dropped > 0 && confirmedCount === 0 && rows.length > 0 && {
      _sampleRawRecords: rows.slice(0, 3).map(r => ({
        keys: r ? Object.keys(r) : [],
        preview: r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 80) : v])) : null,
      })),
      _rawReservationsDebug: 'call get_booking_reservations with the same date range for more DOM detail',
    }),
  };
  bookingLog('getBookingMonthlyGross result', {
    year: y, totalGross: result.summary.totalGross,
    confirmed: confirmedCount, raw: rows.length, dropped,
  });
  diagInfo('get_booking_monthly_gross');
  return result;
}