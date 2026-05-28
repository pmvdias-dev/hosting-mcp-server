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
    throw new Error(`Airbnb session expired (redirected to: ${url}). Run: node save-session.js airbnb`);
  }
}

export async function getAirbnbReservations(days = 30) {
  return _airbnbSerialize(() => _getAirbnbReservations(days));
}
async function _getAirbnbReservations(days = 30) {
  const { browser, page } = await getBrowserPage();
  try {
    await page.goto('https://www.airbnb.com/hosting/reservations', { waitUntil: 'domcontentloaded' });
    assertAirbnbNotLoginPage(page.url());

    try {
      // update this selector if Airbnb changes their UI
      await page.waitForSelector('[data-testid="host-reservations-table-row"]', { timeout: 15000 });
    } catch {
      // no rows found — calendar may be empty
    }

    return await page.evaluate(() => {
      // update this selector if Airbnb changes their UI
      const rows = document.querySelectorAll('[data-testid="host-reservations-table-row"]');
      return Array.from(rows).map(row => {
        const cells = row.querySelectorAll('td');
        // columns: Status | Guest | Phone | Check-in | Checkout | Booked | Listing | Code | Total | Action
        const guestLines = (cells[1]?.innerText ?? '').split('\n').map(l => l.trim()).filter(Boolean);
        const guestsLine = guestLines.find(l => /\d+\s+guest/i.test(l)) ?? '';
        const guestsMatch = guestsLine.match(/(\d+)\s+guest/i);
        return {
          status:           cells[0]?.innerText?.trim() ?? '',
          guest:            guestLines[0] ?? '',
          guests:           guestsMatch ? parseInt(guestsMatch[1], 10) : '',
          phone:            cells[2]?.innerText?.trim() ?? '',
          checkin:          cells[3]?.innerText?.trim() ?? '',
          checkout:         cells[4]?.innerText?.trim() ?? '',
          booked:           cells[5]?.innerText?.split('\n')[0].trim() ?? '',
          listing:          cells[6]?.innerText?.trim() ?? '',
          confirmationCode: cells[7]?.innerText?.trim() ?? '',
          total:            cells[8]?.innerText?.trim() ?? '',
        };
      });
    });
  } finally {
    await browser.close();
  }
}

export async function getAirbnbMessages() {
  return _airbnbSerialize(() => _getAirbnbMessages());
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
  return _airbnbSerialize(() => _getAirbnbEarnings({ year, month }));
}
async function _getAirbnbEarnings({ year, month } = {}) {
  resetAirbnbDiag();
  airbnbLog('getAirbnbEarnings', { year, month });
  const { browser, page } = await getBrowserPage();
  try {
    const y = year ?? new Date().getFullYear();

    // Capture all JSON API responses — Airbnb's charts and transaction list
    // are both powered by API calls; intercepting them is more reliable than DOM.
    const apiData = [];
    page.on('response', async (response) => {
      const ct = response.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;
      const url = response.url();
      if (/locale|translation|i18n|manifest|config|static|chunk/i.test(url)) return;
      try {
        const json = await response.json();
        const preview = JSON.stringify(json).slice(0, 600);
        if (/amount|earning|payout|revenue|transaction|gross|net|disbursement/i.test(preview)) {
          apiData.push({ endpoint: url.replace(/\?.*/, ''), data: json });
        }
      } catch { /* not JSON or body already consumed */ }
    });

    // Warm up on a page we know works before hitting 2FA-gated earnings pages.
    await page.goto('https://www.airbnb.com/hosting/reservations', {
      waitUntil: 'domcontentloaded', timeout: 30_000,
    }).catch(() => {});

    // ── Step 1: Performance / overview page ─────────────────────────────────
    // /users/transaction_history (no user ID) auto-redirects to the correct user.
    // This page has the monthly bar chart + the grid icon that opens a table popup.
    await page.goto('https://www.airbnb.com/users/transaction_history', {
      waitUntil: 'networkidle', timeout: 45_000,
    }).catch(() => {});
    const overviewFinalUrl = page.url();
    airbnbLog('overview page loaded', { url: overviewFinalUrl });
    assertAirbnbNotLoginPage(overviewFinalUrl);

    // Extract embedded __NEXT_DATA__ — Airbnb SSR embeds full page data here.
    const nextData = await page.evaluate(() => {
      try {
        const el = document.getElementById('__NEXT_DATA__');
        return el ? JSON.parse(el.textContent) : null;
      } catch { return null; }
    });

    // Click the grid/table-view icon (top-right of the Summary chart area).
    // It switches from bar chart to a table with month-by-month totals.
    // Strategy: find the "Summary" / "Monthly view" header → look for the FIRST
    // button immediately after that text. Confirmed from user-supplied DOM
    // path: the grid button sits in the same toolbar row.
    let tableClickedOk = false;
    try {
      const clickResult = await page.evaluate(() => {
        // 1. Find the toolbar containing "Summary" + "Monthly view" labels.
        const allEls = [...document.querySelectorAll('h1,h2,h3,h4,span,div,p')];
        const summaryEl = allEls.find(el => /^summary$/i.test(el.textContent?.trim() ?? ''));
        if (!summaryEl) return { ok: false, reason: 'no Summary header' };

        // Walk up until we find a container that holds a button (the toolbar row).
        let container = summaryEl;
        for (let i = 0; i < 6 && container; i++) {
          if (container.querySelector('button svg')) break;
          container = container.parentElement;
        }
        if (!container) return { ok: false, reason: 'no toolbar container' };

        // 2. Click the FIRST button in that container that has an SVG icon
        //    (grid view). The second is filters (sliders).
        const btns = [...container.querySelectorAll('button')].filter(b => b.querySelector('svg'));
        if (!btns.length) return { ok: false, reason: 'no svg buttons' };
        btns[0].click();
        return { ok: true, btnText: btns[0].getAttribute('aria-label') ?? '' };
      });
      airbnbLog('grid view click attempt', clickResult);

      if (clickResult.ok) {
        await page.waitForTimeout(1_500);
        // Verify a table or row-listing appeared.
        const hasTable = await page.$('table, [role="grid"], [role="table"], [role="dialog"] tbody');
        tableClickedOk = !!hasTable;
        airbnbLog('grid view table appeared', { tableClickedOk });
      }

      // Old-style data-testid fallback (kept in case Airbnb adds these).
      if (!tableClickedOk) {
        const iconSelectors = [
          '[data-testid*="table-view"]',
          '[data-testid*="grid-view"]',
          '[aria-label*="table" i]',
          '[aria-label*="grid" i]',
        ];
        for (const sel of iconSelectors) {
          const el = await page.$(sel);
          if (el) {
            await el.click();
            await page.waitForTimeout(1_500);
            tableClickedOk = true;
            airbnbLog('grid view clicked via fallback selector', { sel });
            break;
          }
        }
      }
    } catch (err) {
      airbnbLog('grid view click error', { msg: err?.message });
    }

    // Scrape the monthly table (visible after icon click) and __NEXT_DATA__.
    const overviewResult = await page.evaluate(({ targetYear }) => {
      // ── Monthly table rows (from the grid-view popup) ────────────────────
      const monthly = [];
      const tableRows = [
        ...document.querySelectorAll('table tbody tr'),
        ...document.querySelectorAll('[role="row"]:not([role="columnheader"])'),
      ];
      for (const row of tableRows) {
        const cells = [...row.querySelectorAll('td,[role="cell"]')];
        const texts = cells.map(c => c.textContent?.trim() ?? '');
        const hasMonth = /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(texts.join(' '));
        const hasAmount = /[£$€]/.test(texts.join(' '));
        if (hasMonth || hasAmount) monthly.push(texts.filter(Boolean));
      }

      // ── Chart-bar scrape (works without button click) ────────────────────
      // Each bar typically has an aria-label like "May 2026: £1,234" or
      // "January, £500". Match anything with month + currency.
      const monthRe = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i;
      const amountRe = /[£$€]\s*[\d.,]+/;
      const chartBars = [];
      const candidates = document.querySelectorAll('[aria-label], [data-month], [data-period]');
      for (const el of candidates) {
        const label =
          el.getAttribute('aria-label') ||
          el.getAttribute('data-tooltip') ||
          el.textContent?.trim() ||
          '';
        if (!label) continue;
        const m = monthRe.exec(label);
        const a = amountRe.exec(label);
        if (m && a) {
          chartBars.push({ month: m[1], amount: a[0], label: label.slice(0, 120) });
        }
      }

      // ── Currency lines from full page text ───────────────────────────────
      const bodyText = document.body?.innerText ?? '';
      const currencyLines = bodyText
        .split('\n')
        .map(l => l.trim())
        .filter(l => /[£$€][\d,]+/.test(l) && l.length < 120);

      return { monthly, chartBars, currencyLines: currencyLines.slice(0, 40), bodyExcerpt: bodyText.slice(0, 2000) };
    }, { targetYear: y });

    // ── Step 2: /paid tab — scroll to load ALL paginated payout rows ─────────
    let savedEarningsUrl = null;
    try {
      savedEarningsUrl = JSON.parse(fs.readFileSync(EARNINGS_URL_FILE, 'utf-8')).url ?? null;
    } catch {}
    // Derive /paid URL: prefer saved (has correct domain+userId), else append to redirect target.
    const basePaidUrl = savedEarningsUrl
      ?? overviewFinalUrl.replace(/\/(performance|upcoming|future|reports)\/?$/, '/paid');

    // Append ?year=YYYY (and optional &month=M) so /paid returns the requested
    // period instead of just the most recent rows. Without these the page
    // returns a small recent slice (~10 rows = current month only).
    let paidUrl = basePaidUrl;
    try {
      const u = new URL(basePaidUrl);
      u.searchParams.set('year', String(y));
      if (month) u.searchParams.set('month', String(month));
      paidUrl = u.toString();
    } catch {}

    airbnbLog('navigating to paid url', { url: paidUrl });
    await page.goto(paidUrl, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => null);
    const paidFinalUrl = page.url();
    airbnbLog('paid page loaded', { url: paidFinalUrl });

    if (!paidFinalUrl.includes('/login') && !paidFinalUrl.includes('/signup')) {
      for (let i = 0; i < 10; i++) {
        const before = await page.evaluate(() => document.body.scrollHeight);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1_800);
        const after = await page.evaluate(() => document.body.scrollHeight);
        if (after === before) break;
      }
    }

    // Scrape all payout rows now that infinite scroll has loaded everything.
    const paidResult = await page.evaluate(() => {
      const rowSels = [
        '[data-testid="transaction-row"]',
        '[data-testid*="payout-row"]',
        '[data-testid*="payment-row"]',
        'tr[class*="transaction"]',
        '[class*="TransactionRow"]',
        '[class*="PayoutRow"]',
        '[class*="PaymentRow"]',
        'table tbody tr',
      ];
      let rows = [];
      let sel = null;
      for (const s of rowSels) {
        const found = [...document.querySelectorAll(s)];
        if (found.length) { rows = found; sel = s; break; }
      }
      return {
        matchedSel: sel,
        transactions: rows.map(row => {
          const cells = [...row.querySelectorAll('td')];
          const ct    = cells.map(c => c.textContent?.trim() ?? '');
          return {
            date:   row.getAttribute('data-date') ?? cells[0]?.querySelector('time')?.getAttribute('datetime') ?? ct[0] ?? '',
            amount: row.querySelector('[class*="amount"],[class*="price"],[data-testid*="amount"]')?.textContent?.trim()
                    ?? ct[ct.length - 1] ?? '',
            status: row.querySelector('[class*="status"],[class*="badge"]')?.textContent?.trim() ?? '',
          };
        }),
      };
    });

    airbnbLog('overview scrape result', {
      monthlyRowCount: overviewResult.monthly.length,
      chartBarCount:   overviewResult.chartBars?.length ?? 0,
      sampleBar:       overviewResult.chartBars?.[0] ?? null,
      tableClickedOk,
    });
    airbnbLog('paid scrape result', {
      matchedSel: paidResult.matchedSel,
      txCount: paidResult.transactions.length,
      apiResponseCount: apiData.length,
    });

    // ── Aggregate total from /paid rows ──────────────────────────────────────
    const paidTx = paidResult.transactions.filter(t => /[£$€]/.test(t.amount ?? ''));
    const currency = (overviewResult.currencyLines[0] ?? paidTx[0]?.amount ?? '').match(/[£$€]/)?.[0] ?? '£';
    const totalPaid = paidTx.reduce((sum, t) => {
      const n = parseFloat((t.amount ?? '').replace(/[^0-9.]/g, ''));
      return sum + (isNaN(n) ? 0 : n);
    }, 0);

    const result = {
      year: y,
      month: month ?? null,
      summary: {
        totalPaid:        totalPaid > 0 ? `${currency}${totalPaid.toFixed(2)}` : null,
        transactionCount: paidTx.length,
        currency,
      },
      monthlyBreakdown: overviewResult.monthly,
      chartBars:        overviewResult.chartBars,
      transactions: paidResult.transactions,
      _tableClickedOk:  tableClickedOk,
      _overviewUrl:     overviewFinalUrl,
      _paidUrl:         paidFinalUrl,
      _currencyLines:   overviewResult.currencyLines,
      _bodyExcerpt:     paidTx.length ? '' : overviewResult.bodyExcerpt,
      _nextDataKeys:    nextData ? Object.keys(nextData?.props?.pageProps ?? {}) : [],
      _apiResponses:    apiData.slice(0, 6),
    };
    airbnbLog('returning earnings', {
      totalPaid: result.summary.totalPaid,
      txCount: result.transactions.length,
      hasMonthlyBreakdown: result.monthlyBreakdown?.length ?? 0,
    });
    airbnbDiagInfo('get_airbnb_earnings');
    return result;
  } catch (err) {
    throw airbnbDiagError(err);
  } finally {
    await browser.close();
  }
}

export async function getAirbnbCalendar(months = 3) {
  return _airbnbSerialize(() => _getAirbnbCalendar(months));
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
