import { chromium } from 'playwright';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIE_FILE        = join(__dirname, '../sessions/airbnb-session.json');
const EARNINGS_URL_FILE  = join(__dirname, '../sessions/airbnb-earnings-url.json');
const LOG_FILE           = join(__dirname, '..', 'mcp-server.log');

// ─── Diagnostic logging ────────────────────────────────────────────────────
// Accumulates events during a run; flushed to mcp-server.log either as a debug
// entry (success) or wrapped into an Error (failure). Mirrors booking.js so
// the same log-tailing workflow works for both scrapers.
let _airbnbDiag = [];
function airbnbLog(msg, extra) {
  _airbnbDiag.push(extra ? `${msg} ${JSON.stringify(extra)}` : msg);
}
function resetAirbnbDiag() { _airbnbDiag = []; }
function airbnbDiagPrefix() {
  return _airbnbDiag.length
    ? '\n--- airbnb.js diagnostic log ---\n' + _airbnbDiag.map((l, i) => `  [${i + 1}] ${l}`).join('\n') + '\n---\n'
    : '';
}
function airbnbDiagInfo(toolName) {
  const prefix = airbnbDiagPrefix();
  if (!prefix) return;
  try {
    fs.appendFileSync(
      LOG_FILE,
      JSON.stringify({ ts: new Date().toISOString(), level: 'debug', tool: toolName, message: prefix }) + '\n'
    );
  } catch { /* never break scrape on log failure */ }
}
function airbnbDiagError(err) {
  const prefix = airbnbDiagPrefix();
  if (!prefix) return err;
  const wrapped = new Error(prefix + err.message);
  wrapped.stack = prefix + (err.stack ?? err.message);
  return wrapped;
}

// ─── Concurrency mutex ────────────────────────────────────────────────────
// Airbnb scrapers share the cookie file + module-level _airbnbDiag. Two
// parallel calls (e.g. when get_earnings_summary fires twice in quick
// succession) interleave diag entries and may race on cookie state.
// Serialize through one promise queue.
let _airbnbQueue = Promise.resolve();
function _airbnbSerialize(fn) {
  const next = _airbnbQueue.then(() => fn(), () => fn());
  _airbnbQueue = next.catch(() => {});
  return next;
}

// ─── Auto session refresh ────────────────────────────────────────────────
// When any scraper call throws "session expired", auto-trigger the browser
// login (saveAirbnbSession) and retry once.
async function _autoRefreshOnExpiry(fn) {
  try {
    return await fn();
  } catch (err) {
    const msg = String(err?.message || err);
    if (!/session expired/i.test(msg)) throw err;
    airbnbLog('auto-refresh: session expired — opening browser for re-login');
    await new Promise((r) => setTimeout(r, 500));
    let refreshResult;
    try {
      const mod = await import('../save-session.js');
      refreshResult = await mod.saveAirbnbSession();
    } catch (refreshErr) {
      const rmsg = refreshErr?.message ?? String(refreshErr);
      throw new Error(
        `Airbnb session was expired and auto-refresh failed: ${rmsg}. ` +
        `Try running "node save-session.js airbnb" manually.`
      );
    }
    airbnbLog('auto-refresh: session refresh completed', { success: !!refreshResult?.success });
    return await fn();
  }
}

async function getBrowserPage() {
  // Match the fingerprint used in save-session.js so Airbnb doesn't detect
  // a different browser environment and invalidate the saved cookies.
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
    ],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  if (fs.existsSync(COOKIE_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
    // Handle both plain-array and Playwright storageState { cookies: [] } formats.
    const cookies = Array.isArray(parsed) ? parsed : (parsed.cookies ?? []);
    if (cookies.length > 0) await context.addCookies(cookies);
  }

  const page = await context.newPage();
  return { browser, page };
}

function assertAirbnbNotLoginPage(url) {
  if (url.includes('/login') || url.includes('/signup') || !url.includes('airbnb.com')) {
    throw new Error(`Airbnb session expired (redirected to: ${url}). Run: node save-session.js airbnb (or call the refresh_airbnb_session MCP tool)`);
  }
}

export async function getAirbnbReservations(days = 30) {
  return _airbnbSerialize(() => _autoRefreshOnExpiry(() => _getAirbnbReservations(days)));
}
async function _getAirbnbReservations(days = 30) {
  resetAirbnbDiag();
  airbnbLog('getAirbnbReservations', { days });
  const { browser, page } = await getBrowserPage();
  try {
    // Broad API capture — Airbnb removed the /hosting/reservations table; everything
    // now loads through the /hosting dashboard. The endpoint names changed too,
    // so filter by content instead of URL keyword.
    const apiReservations = new Map(); // confirmationCode → full reservation object
    const capturedEndpoints = [];
    page.on('response', async (response) => {
      const ct = response.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;
      const url = response.url();
      if (/locale|translation|i18n|manifest|\.js|\.css|static|chunk|font/i.test(url)) return;
      try {
        const json = await response.json();
        const str  = JSON.stringify(json);
        if (!/confirm|reservation|checkin|checkout|guest|booking/i.test(str)) return;
        capturedEndpoints.push(url.replace(/\?.*/, '').slice(-80));

        const walk = (node, depth = 0) => {
          if (!node || typeof node !== 'object' || depth > 12) return;
          if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
          const code = node.confirmation_code ?? node.confirmationCode ?? node.reservationCode;
          if (code && typeof code === 'string' && code.length >= 6 && !apiReservations.has(code)) {
            const adults   = node.adults   ?? node.num_adults   ?? node.adultCount   ?? 0;
            const children = node.children ?? node.num_children ?? node.childrenCount ?? 0;
            const infants  = node.infants  ?? node.num_infants  ?? node.infantCount   ?? 0;
            const pets     = node.pets     ?? node.num_pets     ?? node.petCount      ?? 0;
            const total    = node.guest_count ?? node.numGuests ?? node.guestsCount
                             ?? node.number_of_guests ?? ((adults + children + infants) || null);
            apiReservations.set(code, {
              confirmationCode: code,
              guest:    node.guest_name ?? node.guestName ?? node.guest?.name ?? node.booker_name ?? '',
              checkin:  node.checkin  ?? node.check_in  ?? node.checkin_date  ?? node.arrival_date   ?? '',
              checkout: node.checkout ?? node.check_out ?? node.checkout_date ?? node.departure_date ?? '',
              status:   node.status   ?? node.reservation_status ?? node.state ?? '',
              total:    node.total_price != null ? String(node.total_price) : (node.amount != null ? String(node.amount) : ''),
              guests:   total ?? null,
              adults, children, infants, pets,
              listing:  node.listing_name ?? node.listing?.name ?? node.property_name ?? '',
            });
          }
          Object.values(node).forEach(v => walk(v, depth + 1));
        };
        walk(json);
      } catch { /* ignore */ }
    });

    // /hosting/reservations/* all redirect to /hosting — navigate there directly.
    await page.goto('https://www.airbnb.com/hosting', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const landedUrl = page.url();
    airbnbLog('hosting nav', { landed: landedUrl });
    assertAirbnbNotLoginPage(landedUrl);

    // Wait up to 15s for Upcoming section dates to appear without clicking anything.
    // The section renders asynchronously after initial page load.
    // Browser-serializable predicate (must not reference outer Node.js variables).
    const hasDates = () => /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d/.test(document.body?.innerText ?? '');
    const datesAlready = await page.evaluate(hasDates);
    if (!datesAlready) {
      // Try clicking the Upcoming section tab (not nav links — those redirect away).
      // The section tabs sit inside the main content area, not the side nav.
      try {
        // Use role=tab or a button/heading inside main that says "Upcoming".
        // Avoid <a href> elements — those are nav links that redirect.
        const upcomingTab = page.locator(
          'main button:has-text("Upcoming"), [role="tab"]:has-text("Upcoming"), [role="tablist"] :has-text("Upcoming")'
        ).first();
        if (await upcomingTab.count()) {
          await upcomingTab.click({ timeout: 4_000 });
          airbnbLog('clicked Upcoming section tab');
        } else {
          airbnbLog('Upcoming tab not found in main — waiting for auto-render');
        }
      } catch (e) { airbnbLog('Upcoming tab click failed', { msg: e?.message }); }

      // Wait for dates to appear (up to 15s).
      try {
        await page.waitForFunction(
          () => /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d/.test(document.body?.innerText ?? ''),
          { timeout: 15_000 }
        );
        airbnbLog('reservation dates appeared in DOM');
      } catch { airbnbLog('waitForFunction timeout — reading body anyway'); }
    } else {
      airbnbLog('reservation dates already in DOM on load');
    }
    airbnbLog('api capture', { endpointCount: capturedEndpoints.length, reservationCount: apiReservations.size });

    // Scroll + click "Show more" to load all upcoming reservations.
    for (let i = 0; i < 10; i++) {
      try {
        const more = page.locator('button:has-text("Show more"), a:has-text("Show more")').first();
        if (await more.count()) { await more.click({ timeout: 3_000 }); await page.waitForTimeout(1_200); }
        else break;
      } catch { break; }
    }

    // ── Strategy 1: __NEXT_DATA__ (SSR-embedded full reservation objects) ──
    // Airbnb hosting is a Next.js app; the initial page props (including full
    // reservation lists) are embedded as JSON in a <script id="__NEXT_DATA__"> tag.
    // This avoids needing to intercept XHR since the data is already in the DOM.
    if (apiReservations.size === 0) {
      const nextDataJson = await page.evaluate(() => document.getElementById('__NEXT_DATA__')?.textContent ?? '');
      if (nextDataJson) {
        try {
          const nextData = JSON.parse(nextDataJson);
          const walk = (node, depth = 0) => {
            if (!node || typeof node !== 'object' || depth > 20) return;
            if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
            const code = node.confirmation_code ?? node.confirmationCode ?? node.reservationCode;
            if (code && typeof code === 'string' && code.length >= 6 && !apiReservations.has(code)) {
              const adults   = node.adults   ?? node.num_adults   ?? node.adultCount   ?? 0;
              const children = node.children ?? node.num_children ?? node.childrenCount ?? 0;
              const infants  = node.infants  ?? node.num_infants  ?? node.infantCount   ?? 0;
              const pets     = node.pets     ?? node.num_pets     ?? node.petCount      ?? 0;
              const total    = node.guest_count ?? node.numGuests ?? node.guestsCount
                               ?? node.number_of_guests ?? ((adults + children + infants) || null);
              apiReservations.set(code, {
                confirmationCode: code,
                guest:    node.guest_name ?? node.guestName ?? node.guest?.name ?? '',
                checkin:  node.checkin  ?? node.check_in  ?? node.checkin_date  ?? node.arrival_date   ?? '',
                checkout: node.checkout ?? node.check_out ?? node.checkout_date ?? node.departure_date ?? '',
                status:   node.status   ?? node.reservation_status ?? node.state ?? '',
                total:    node.total_price != null ? String(node.total_price) : '',
                guests:   total ?? null,
                adults, children, infants, pets,
                listing:  node.listing_name ?? node.listing?.name ?? '',
              });
            }
            Object.values(node).forEach(v => walk(v, depth + 1));
          };
          walk(nextData);
          airbnbLog('__NEXT_DATA__ parse', { reservationCount: apiReservations.size });
        } catch (e) { airbnbLog('__NEXT_DATA__ parse failed', { msg: e?.message }); }
      }
    }

    if (apiReservations.size > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + days);
      const now = new Date();
      const result = [...apiReservations.values()]
        .filter(r => {
          if (!r.checkout) return true;
          const co = new Date(r.checkout);
          return !isNaN(co) && co >= now && co <= cutoff;
        })
        .map(r => ({
          confirmationCode: r.confirmationCode,
          guest:            r.guest,
          checkin:          r.checkin,
          checkout:         r.checkout,
          status:           r.status,
          total:            r.total,
          listing:          r.listing,
          guests:           r.guests ?? null,
          guestBreakdown:   Object.fromEntries(
            [['adults', r.adults], ['children', r.children], ['infants', r.infants], ['pets', r.pets]]
              .filter(([, v]) => v > 0)
          ),
        }));
      airbnbLog('returning reservations from __NEXT_DATA__/XHR', { total: apiReservations.size, filtered: result.length });
      airbnbDiagInfo('get_airbnb_reservations');
      return result;
    }

    // ── Strategy 2: Body-text card parser ────────────────────────────────────
    // The Upcoming section renders reservation cards as plain text in a predictable
    // pattern: date-range line → optional "+N" → "N other" → "Guest's group of N".
    // No confirmation codes, but enough for the calendar (checkin/checkout/guests).
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
    // Log raw unicode codepoints of first date-like line for debugging
    const firstDateLine = bodyText.split('\n').find(l => /Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/.test(l));
    airbnbLog('body-text fallback', {
      bodyLen: bodyText.length,
      firstDateLine: firstDateLine ?? '(none)',
      firstDateLineCodepoints: firstDateLine ? [...firstDateLine].slice(0, 30).map(c => c.codePointAt(0).toString(16)).join(' ') : null,
    });

    const MONTH = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
    // Match "Sep 7 — 10" or "Oct 28 — Nov 1" (thin-space   before/after em-dash)
    const DATE_RANGE_RE = new RegExp(
      `^(${MONTH})[\\s ]+(\\d{1,2})[\\s ]*[—–—–-][\\s ]*(?:(${MONTH})[\\s ]+)?(\\d{1,2})$`
    );
    // Match "Kathy's group of 2" — apostrophe may be curly ’ or straight '
    const GUEST_RE = /^(.+?)[’']s\s+group\s+of\s+(\d+)$/i;
    // "Show more" line ends the visible list
    const STOP_RE = /^show more$/i;

    const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
    // Find "Upcoming" header then parse until "Show more" or page footer
    const upcomingIdx = lines.findIndex(l => /^Upcoming$/i.test(l));
    const slice = upcomingIdx >= 0 ? lines.slice(upcomingIdx + 1) : lines;

    const textReservations = [];
    let pendingDate = null;
    const currentYear = new Date().getFullYear();
    for (const line of slice) {
      if (STOP_RE.test(line)) break;
      if (/^(Site Footer|Support|Help Center)/i.test(line)) break;

      const dateM = DATE_RANGE_RE.exec(line);
      if (dateM) {
        // dateM[1]=startMonth, [2]=startDay, [3]=endMonth(optional), [4]=endDay
        const startMonth = dateM[1];
        const startDay   = dateM[2];
        const endMonth   = dateM[3] ?? startMonth;
        const endDay     = dateM[4];
        const today = new Date(); today.setHours(0, 0, 0, 0);
        let   ci  = new Date(`${startMonth} ${startDay}, ${currentYear}`);
        let   co  = new Date(`${endMonth} ${endDay}, ${currentYear}`);
        // All Upcoming reservations are in the future — if checkout < today, bump year.
        if (!isNaN(co) && co < today) {
          ci.setFullYear(ci.getFullYear() + 1);
          co.setFullYear(co.getFullYear() + 1);
        }
        // Handle cross-month ranges within same slot (e.g. Oct 28 → Nov 1 → checkout before checkin)
        if (!isNaN(ci) && !isNaN(co) && co < ci) co.setFullYear(co.getFullYear() + 1);
        pendingDate = { checkin: isNaN(ci) ? `${startMonth} ${startDay}, ${currentYear}` : ci.toISOString().slice(0, 10),
                        checkout: isNaN(co) ? `${endMonth} ${endDay}, ${currentYear}` : co.toISOString().slice(0, 10) };
        continue;
      }
      if (!pendingDate) continue;

      const guestM = GUEST_RE.exec(line);
      if (guestM) {
        textReservations.push({
          confirmationCode: '',
          guest:    guestM[1].trim(),
          checkin:  pendingDate.checkin,
          checkout: pendingDate.checkout,
          status:   'confirmed',
          total:    '',
          listing:  '',
          guests:   parseInt(guestM[2], 10),
          guestBreakdown: {},
        });
        pendingDate = null;
      }
    }

    airbnbLog('body-text parse result', { count: textReservations.length });
    airbnbDiagInfo('get_airbnb_reservations');
    return textReservations;
  } catch (err) {
    throw airbnbDiagError(err);
  } finally {
    airbnbDiagInfo('get_airbnb_reservations');
    await browser.close();
  }
}

export async function getAirbnbMessages() {
  return _airbnbSerialize(() => _autoRefreshOnExpiry(() => _getAirbnbMessages()));
}
async function _getAirbnbMessages() {
  const { browser, page } = await getBrowserPage();
  try {
    await page.goto('https://www.airbnb.com/hosting/inbox', { waitUntil: 'domcontentloaded' });
    assertAirbnbNotLoginPage(page.url());

    try {
      await page.waitForSelector('[data-testid="message-thread"]', { timeout: 15000 });
    } catch {
      // inbox may be empty
    }

    return await page.evaluate(() => {
      // update this selector if Airbnb changes their UI
      const threads = document.querySelectorAll('[data-testid="message-thread"]');
      return Array.from(threads).slice(0, 10).map(thread => ({
        // update this selector if Airbnb changes their UI
        guest:   thread.querySelector('[data-testid="guest-name"]')?.textContent?.trim() ?? '',
        // update this selector if Airbnb changes their UI
        preview: thread.querySelector('[data-testid="message-preview"]')?.textContent?.trim() ?? '',
        // update this selector if Airbnb changes their UI
        unread:  thread.querySelector('[data-testid="unread-badge"]') !== null,
        // update this selector if Airbnb changes their UI
        time:    thread.querySelector('[data-testid="message-time"]')?.textContent?.trim() ?? '',
      }));
    });
  } finally {
    await browser.close();
  }
}

export async function getAirbnbEarnings({ year, month } = {}) {
  return _airbnbSerialize(() => _autoRefreshOnExpiry(() => _getAirbnbEarnings({ year, month })));
}
async function _getAirbnbEarnings({ year, month } = {}) {
  resetAirbnbDiag();
  airbnbLog('getAirbnbEarnings', { year, month });
  const { browser, page } = await getBrowserPage();
  try {
    const y = year ?? new Date().getFullYear();

    // Broad API capture — Performance chart data comes from a generic endpoint,
    // not one with "earning" in the URL. Capture all non-static JSON and filter
    // by content instead.
    const apiData = [];
    page.on('response', async (response) => {
      const ct = response.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;
      const url = response.url();
      if (/locale|translation|i18n|manifest|\.js|\.css|static|chunk|font/i.test(url)) return;
      try {
        const json = await response.json();
        const preview = JSON.stringify(json).slice(0, 800);
        if (/amount|earning|gross|net|revenue|month|period/i.test(preview)) {
          apiData.push({ endpoint: url.replace(/\?.*/, ''), data: json });
        }
      } catch { /* body consumed or not JSON */ }
    });

    // Warm up on a known-good page first.
    await page.goto('https://www.airbnb.com/hosting/reservations', {
      waitUntil: 'domcontentloaded', timeout: 30_000,
    }).catch(() => {});

    // ── Performance page (the bar chart, grouped by CHECK-IN month) ──────────
    // This is the authoritative source — not the /paid tab which groups by
    // payout date. ?year= scopes the chart to the requested year.
    await page.goto(`https://www.airbnb.com/users/transaction_history?year=${y}`, {
      waitUntil: 'networkidle', timeout: 45_000,
    }).catch(() => {});
    const finalUrl = page.url();
    airbnbLog('performance page loaded', { url: finalUrl });
    assertAirbnbNotLoginPage(finalUrl);

    // ── Ensure the correct year is actually selected in the UI ───────────────
    // Airbnb's ?year= URL parameter doesn't always take effect (especially for
    // future years). If a year picker on the page is showing a different year,
    // click it and pick the target year from the dropdown.
    let yearSwitchOk = false;
    try {
      const initial = await page.evaluate(({ targetYear }) => {
        const yr = /\b(20\d{2})\b/;
        // Prefer buttons/dropdowns that look like a year picker (short text)
        const candidates = [...document.querySelectorAll(
          'button, [role="combobox"], [role="button"], select'
        )].filter(el => {
          const t = (el.textContent ?? el.value ?? '').trim();
          return t.length <= 12 && yr.test(t);
        });
        for (const btn of candidates) {
          const t = (btn.textContent ?? btn.value ?? '').trim();
          const shown = parseInt(yr.exec(t)[1], 10);
          if (shown === targetYear) return { ok: true, alreadyOn: shown };
          try { btn.click(); } catch { continue; }
          return { needsFollowup: true, current: shown, text: t.slice(0, 40) };
        }
        return { ok: false, reason: 'no year-shaped picker found' };
      }, { targetYear: y });
      airbnbLog('year picker: initial state', initial);

      if (initial.needsFollowup) {
        await page.waitForTimeout(600);
        const clicked = await page.evaluate(({ targetYear }) => {
          const items = [...document.querySelectorAll(
            '[role="option"], [role="menuitem"], [role="menuitemradio"], li, button, a'
          )];
          for (const item of items) {
            const t = (item.textContent ?? '').trim();
            if (t === String(targetYear) || /^\s*20\d{2}\s*$/.test(t) && parseInt(t, 10) === targetYear) {
              try { item.click(); return true; } catch { continue; }
            }
          }
          return false;
        }, { targetYear: y });
        airbnbLog('year picker: option click', { clicked, targetYear: y });
        if (clicked) {
          await page.waitForTimeout(1_500);
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
          yearSwitchOk = true;
        }
      } else if (initial.ok) {
        yearSwitchOk = true;
      }
    } catch (e) { airbnbLog('year picker: error', { msg: e?.message }); }

    // ── Click the grid/table icon to switch from bar chart → data table ──────
    // The icon is the first SVG-button in the "Summary / Monthly view" toolbar.
    let tableClickedOk = false;
    try {
      const clicked = await page.evaluate(() => {
        const allText = [...document.querySelectorAll('h1,h2,h3,h4,span,div,p')];
        const summaryEl = allText.find(el => /^summary$/i.test(el.textContent?.trim() ?? ''));
        if (!summaryEl) return { ok: false, reason: 'no Summary header' };
        let container = summaryEl;
        for (let i = 0; i < 8 && container; i++) {
          if (container.querySelector('button svg')) break;
          container = container.parentElement;
        }
        if (!container) return { ok: false, reason: 'no toolbar' };
        const btns = [...container.querySelectorAll('button')].filter(b => b.querySelector('svg'));
        if (!btns.length) return { ok: false, reason: 'no svg buttons' };
        btns[0].click();
        return { ok: true, label: btns[0].getAttribute('aria-label') ?? '' };
      });
      airbnbLog('grid icon click', clicked);
      if (clicked.ok) {
        await page.waitForTimeout(2_000);
        tableClickedOk = !!(await page.$('table, [role="grid"], [role="table"]'));
      }
      // testid/aria fallback
      if (!tableClickedOk) {
        for (const sel of ['[data-testid*="table-view"]','[data-testid*="grid-view"]','[aria-label*="table" i]','[aria-label*="grid" i]']) {
          const el = await page.$(sel);
          if (el) { await el.click(); await page.waitForTimeout(1_500); tableClickedOk = true; break; }
        }
      }
    } catch (e) { airbnbLog('grid icon error', { msg: e?.message }); }
    airbnbLog('tableClickedOk', { tableClickedOk });

    // ── Scrape monthly table + chart bars from Performance page ──────────────
    const pageResult = await page.evaluate(({ targetYear }) => {
      const MONTH_NAMES = ['January','February','March','April','May','June',
                           'July','August','September','October','November','December'];
      const MONTH_RE = /jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?/i;
      // Strict grouping: requires proper 3-digit groups after comma (e.g. £1,012 not £1,).
      // Prevents split-line "£1," from parsing as 1.0 when £1,012 wraps across lines.
      const AMT_RE   = /[£$€]\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/;

      const parseAmt = str => {
        const s = str ?? '';
        const m = AMT_RE.exec(s);
        if (!m) return null;
        // Reject chart-axis abbreviations like "£1.2K", "£2.4M", "£3.2B" — these
        // are Y-axis ticks on the comparison chart and pollute month amounts.
        const after = s.slice(m.index + m[0].length);
        if (/^\s*[KMB]\b/i.test(after)) return null;
        return parseFloat(m[1].replace(/,/g, ''));
      };
      const normMonth = str => {
        const idx = MONTH_NAMES.findIndex(mn => mn.toLowerCase().startsWith((str ?? '').toLowerCase().slice(0, 3)));
        return idx >= 0 ? MONTH_NAMES[idx] : null;
      };

      // 1. Table rows (after grid-icon click)
      const tableMonthly = {};
      const tableRows = [
        ...document.querySelectorAll('table tbody tr'),
        ...document.querySelectorAll('[role="row"]:not([role="columnheader"],[role="row"] [role="columnheader"])'),
      ];
      for (const row of tableRows) {
        const cells = [...row.querySelectorAll('td,[role="cell"]')];
        const texts = cells.map(c => c.textContent?.trim() ?? '');
        const joinedText = texts.join(' ');
        const monthMatch = MONTH_RE.exec(joinedText);
        if (!monthMatch) continue;
        const mn = normMonth(monthMatch[0]);
        if (!mn) continue;
        // Columns vary — collect all currency amounts in the row
        const amounts = texts.map(parseAmt).filter(n => n !== null);
        if (!amounts.length) continue;
        // Heuristic: last amount = total, first amount = earned (if 2+ columns)
        tableMonthly[mn] = {
          earned:   amounts.length >= 2 ? amounts[0]   : amounts[0],
          upcoming: amounts.length >= 2 ? amounts[1]   : null,
          total:    amounts.length >= 3 ? amounts[2]   : amounts[amounts.length - 1],
          _raw: texts,
        };
      }

      // 2. Bar chart aria-labels (works even without clicking the icon)
      const barMonthly = {};
      for (const el of document.querySelectorAll('[aria-label],[data-month],[data-period]')) {
        const label = el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '';
        if (!label) continue;
        const mn = normMonth((MONTH_RE.exec(label) ?? [])[0]);
        const amt = parseAmt(label);
        if (mn && amt !== null && !barMonthly[mn]) {
          barMonthly[mn] = { total: amt, _label: label.slice(0, 100) };
        }
      }

      // 3. Body text line parser — month name line followed by currency lines
      // Catches cases where table + aria-label scraping both fail (most common).
      const bodyText = document.body?.innerText ?? '';
      // Pre-join lines split mid-number: "£1," + "012.37" → "£1,012.37"
      const rawLines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
      const lines = [];
      for (let i = 0; i < rawLines.length; i++) {
        if (/[£$€]\d{1,3},$/.test(rawLines[i]) && i + 1 < rawLines.length && /^\d{3}/.test(rawLines[i + 1])) {
          lines.push(rawLines[i] + rawLines[i + 1]);
          i++;
        } else {
          lines.push(rawLines[i]);
        }
      }
      const currencyLines = lines.filter(l => /[£$€][\d,]+/.test(l) && l.length < 120);

      // Anchor: only look at content after "Monthly earnings" heading. Before
      // it the page has the earnings-comparison chart (Y-axis labels like £800,
      // £1.6K) and Next Year / Previous Year sections that list month names
      // followed by prior-year values — both pollute month totals if scanned.
      const anchorIdx = lines.findIndex(l => /^Monthly earnings\s*$/i.test(l));
      const startIdx  = anchorIdx >= 0 ? anchorIdx + 1 : lines.length; // skip body parsing entirely if anchor missing
      const bodyMonthly = {};
      for (let i = startIdx; i < lines.length; i++) {
        const monthMatch = MONTH_RE.exec(lines[i]);
        if (!monthMatch) continue;
        // Line must be *just* a month (maybe with year), not a sentence
        if (lines[i].length > 20) continue;
        const mn = normMonth(monthMatch[0]);
        if (!mn || bodyMonthly[mn]) continue;
        // Collect up to 3 currency amounts from the next 6 lines
        const amounts = [];
        for (let j = i + 1; j < Math.min(i + 7, lines.length) && amounts.length < 3; j++) {
          const a = parseAmt(lines[j]);
          if (a !== null) amounts.push(a);
          // Stop if we hit another month name
          else if (MONTH_RE.test(lines[j]) && lines[j].length <= 20) break;
        }
        if (!amounts.length) continue;
        // The monthly earnings table renders three cells per row in the order
        // (paid, upcoming, total). Trust that order when paid+upcoming ≈ total
        // — otherwise one of the amounts is spurious (chart axis leaked in,
        // percentage number, unrelated line) and we fall back to using max.
        let earned = null, upcoming = null, total = null;
        if (amounts.length >= 3) {
          const [p, u, t] = amounts.slice(0, 3);
          if (Math.abs(p + u - t) < 0.02) {
            earned = p; upcoming = u; total = t;
          } else {
            // Position order didn't validate — try to find a triple where the
            // largest = sum of the other two.
            let found = false;
            for (let k = 0; k < 3 && !found; k++) {
              const t2 = amounts[k];
              const rest = amounts.filter((_, j) => j !== k).slice(0, 2);
              if (rest.length === 2 && Math.abs(rest[0] + rest[1] - t2) < 0.02) {
                total = t2;
                earned = rest[0];
                upcoming = rest[1];
                found = true;
              }
            }
            if (!found) total = Math.max(...amounts);
          }
        } else if (amounts.length === 2) {
          const [a, b] = amounts;
          total = Math.max(a, b);
          upcoming = Math.min(a, b);
        } else {
          total = amounts[0];
        }
        bodyMonthly[mn] = { earned, upcoming, total };
      }

      return { tableMonthly, barMonthly, bodyMonthly, currencyLines: currencyLines.slice(0, 30), bodyExcerpt: bodyText.slice(0, 2000), _anchorFound: anchorIdx >= 0 };
    }, { targetYear: y });

    // ── Parse API responses for monthly data ─────────────────────────────────
    const MONTH_NAMES_FULL = ['January','February','March','April','May','June',
                              'July','August','September','October','November','December'];
    const apiMonthly = {};
    const walk = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 10) return;
      if (Array.isArray(node)) {
        // Array of month-keyed objects?
        if (node.length >= 3 && node.length <= 13) {
          for (const item of node) {
            if (!item || typeof item !== 'object') continue;
            const mn = item.month_name ?? item.monthName ?? item.month ?? item.period ?? item.label;
            const earned   = item.earned   ?? item.gross_amount   ?? item.amount   ?? item.earnings ?? item.net;
            const upcoming = item.upcoming  ?? item.future_amount  ?? item.pending;
            const total    = item.total     ?? item.total_amount   ?? earned;
            if (mn && (earned != null || total != null)) {
              const key = typeof mn === 'number'
                ? MONTH_NAMES_FULL[mn - 1]
                : MONTH_NAMES_FULL.find(n => n.toLowerCase().startsWith(String(mn).toLowerCase().slice(0, 3)));
              if (key) apiMonthly[key] = { earned: earned ?? null, upcoming: upcoming ?? null, total: total ?? earned ?? null };
            }
          }
        }
        node.forEach(n => walk(n, depth + 1));
      } else {
        Object.values(node).forEach(v => walk(v, depth + 1));
      }
    };
    apiData.forEach(r => walk(r.data));
    airbnbLog('api monthly extracted', { count: Object.keys(apiMonthly).length });

    // ── Merge: API > table > bar chart > body text (in priority order) ─────────
    airbnbLog('body monthly parsed', { count: Object.keys(pageResult.bodyMonthly).length, sample: Object.entries(pageResult.bodyMonthly).slice(0, 2) });
    const currency = (pageResult.currencyLines[0] ?? '').match(/[£$€]/)?.[0] ?? '£';
    const merged = {};
    for (const mn of MONTH_NAMES_FULL) {
      const api   = apiMonthly[mn];
      const table = pageResult.tableMonthly[mn];
      const bar   = pageResult.barMonthly[mn];
      const body  = pageResult.bodyMonthly[mn];
      const source = api ? 'api' : table ? 'table' : bar ? 'bar' : body ? 'body' : null;
      if (!source) continue;
      const raw = api ?? table ?? bar ?? body;
      merged[mn] = {
        month:    mn,
        earned:   raw.earned   != null ? raw.earned   : (raw.total ?? null),
        upcoming: raw.upcoming != null ? raw.upcoming : null,
        total:    raw.total    != null ? raw.total    : raw.earned ?? null,
        _source:  source,
      };
    }

    const monthly = MONTH_NAMES_FULL
      .filter(mn => merged[mn])
      .map(mn => ({
        month:            merged[mn].month,
        earned:           merged[mn].earned   != null ? `${currency}${Number(merged[mn].earned).toFixed(2)}`   : null,
        upcoming:         merged[mn].upcoming != null ? `${currency}${Number(merged[mn].upcoming).toFixed(2)}` : null,
        total:            merged[mn].total    != null ? `${currency}${Number(merged[mn].total).toFixed(2)}`    : null,
        earnedRaw:        merged[mn].earned,
        _source:          merged[mn]._source,
      }));

    const totalEarned   = monthly.reduce((s, m) => s + (m.earnedRaw ?? 0), 0);
    const totalUpcoming = monthly.reduce((s, m) => s + (typeof m.upcoming === 'string' ? parseFloat(m.upcoming.replace(/[^0-9.]/g,'')) : 0), 0);

    // ── Year sanity check ────────────────────────────────────────────────────
    // If the requested year is in the future, no stays can have completed yet
    // — every month's "earned" (paid-out) amount should be £0. If any earned
    // amount is > 0, the ?year= URL param didn't switch the actual displayed
    // year and we're looking at current-year data mislabelled. Discard the
    // monthly rows in that case so consumers fall back to reservation data
    // instead of showing phantom values.
    const _currentYear = new Date().getFullYear();
    let yearMismatch = false;
    if (y > _currentYear && monthly.some(m => (m.earnedRaw ?? 0) > 0)) {
      airbnbLog('year mismatch: future year returned earned amounts — discarding monthly', {
        requestedYear: y, currentYear: _currentYear, totalEarned, yearSwitchOk,
      });
      yearMismatch = true;
    }

    const result = {
      year: y,
      month: month ?? null,
      currency,
      summary: {
        totalEarned:   yearMismatch ? null : (totalEarned   > 0 ? `${currency}${totalEarned.toFixed(2)}`   : null),
        totalUpcoming: yearMismatch ? null : (totalUpcoming > 0 ? `${currency}${totalUpcoming.toFixed(2)}` : null),
        monthsReturned: yearMismatch ? 0 : monthly.length,
      },
      monthly: yearMismatch ? [] : monthly,
      _tableClickedOk: tableClickedOk,
      _finalUrl:       finalUrl,
      _apiResponseCount: apiData.length,
      _apiEndpoints:   apiData.map(r => r.endpoint),
      ...(yearMismatch && {
        _yearMismatch: true,
        _yearMismatchNote: `Requested year ${y} but Airbnb Performance page returned current-year data. Year selector click didn't take effect. monthly[] cleared to avoid returning wrong data.`,
      }),
      ...((yearMismatch || monthly.length === 0) && { _bodyExcerpt: pageResult.bodyExcerpt }),
    };
    airbnbLog('earnings result', { monthsReturned: monthly.length, totalEarned: result.summary.totalEarned });
    airbnbDiagInfo('get_airbnb_earnings');
    return result;
  } catch (err) {
    throw airbnbDiagError(err);
  } finally {
    await browser.close();
  }
}

export async function getAirbnbCalendar(months = 3) {
  return _airbnbSerialize(() => _autoRefreshOnExpiry(() => _getAirbnbCalendar(months)));
}
async function _getAirbnbCalendar(months = 3) {
  const { browser, page } = await getBrowserPage();
  try {
    await page.goto('https://www.airbnb.com/hosting/calendar', { waitUntil: 'domcontentloaded' });
    assertAirbnbNotLoginPage(page.url());

    try {
      await page.waitForSelector('[data-testid^="calendar-day-"]', { timeout: 15000 });
    } catch {
      // calendar may have no days visible
    }

    return await page.evaluate(() => {
      const available = [];
      const blocked = [];
      const reservedDates = [];

      // update this selector if Airbnb changes their UI
      document.querySelectorAll('[data-testid="calendar-day-available"]').forEach(day => {
        const date = day.getAttribute('data-date') ?? day.textContent?.trim();
        if (date) available.push(date);
      });

      // update this selector if Airbnb changes their UI
      document.querySelectorAll('[data-testid="calendar-day-blocked"]').forEach(day => {
        const date = day.getAttribute('data-date') ?? day.textContent?.trim();
        if (date) blocked.push(date);
      });

      // update this selector if Airbnb changes their UI
      document.querySelectorAll('[data-testid="calendar-day-reserved"]').forEach(day => {
        const date = day.getAttribute('data-date') ?? day.textContent?.trim();
        if (date) reservedDates.push(date);
      });

      return { available, blocked, reservedDates };
    });
  } finally {
    await browser.close();
  }
}
