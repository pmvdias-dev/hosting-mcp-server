import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { getAirbnbReservations, getAirbnbMessages, getAirbnbCalendar, getAirbnbEarnings } from './scrapers/airbnb.js';
import { getBookingReservations, getBookingCalendar, getBookingMessages, getBookingEarnings, getBookingMonthlyGross } from './scrapers/booking.js';
import { saveBookingSession, saveAirbnbSession } from './save-session.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, 'mcp-server.log');

function log(level, toolName, message, extra) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    tool: toolName ?? null,
    message,
    ...(extra ?? {}),
  });
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ─── In-memory scraper cache ─────────────────────────────────────────────
// The dashboard fires 3-4 tool calls per Reload; the calendar-regen tool
// then calls the same scrapers again to build the .ics. Without caching,
// each Reload double-scrapes both Airbnb + Booking. With a short TTL cache
// keyed by (fn, args), back-to-back calls in the same Reload reuse the
// result. Cache is invalidated by process restart or TTL expiry — always
// safe (worst case we serve slightly stale data for 60s).
const SCRAPER_CACHE_TTL_MS = 60_000;
const _scraperCache = new Map(); // key → { at, promise }
async function memoize(fnName, args, fn) {
  const key = fnName + ':' + JSON.stringify(args ?? {});
  const now = Date.now();
  const hit = _scraperCache.get(key);
  if (hit && now - hit.at < SCRAPER_CACHE_TTL_MS) {
    log('debug', fnName, 'cache hit', { ageMs: now - hit.at });
    return hit.promise;
  }
  const promise = fn();
  _scraperCache.set(key, { at: now, promise });
  // If it rejects, evict so a future retry actually re-runs
  promise.catch(() => _scraperCache.delete(key));
  return promise;
}

const server = new Server(
  { name: 'hosting-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_airbnb_reservations',
      description: 'Get upcoming Airbnb reservations',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', default: 30 },
        },
      },
    },
    {
      name: 'get_booking_reservations',
      description: 'Get Booking.com reservations for a date range. By default returns the next 12 months of reservations (today → today + 1 year). Only pass startDate/endDate when the user explicitly asks for a narrower or different window.',
      inputSchema: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'First arrival date to include, YYYY-MM-DD. OMIT this field unless the user explicitly specified a start date — the default (today) covers the common case.' },
          endDate:   { type: 'string', description: 'Last arrival date to include, YYYY-MM-DD. OMIT this field unless the user explicitly specified an end date — the default is today + 1 year, which is what you want for "show my reservations".' },
        },
      },
    },
    {
      name: 'get_airbnb_messages',
      description: 'Get recent Airbnb guest messages from inbox',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_airbnb_calendar',
      description: 'Get Airbnb calendar availability and blocked dates',
      inputSchema: {
        type: 'object',
        properties: {
          months: { type: 'number', default: 3 },
        },
      },
    },
    {
      name: 'get_booking_calendar',
      description: 'Get Booking.com calendar availability',
      inputSchema: {
        type: 'object',
        properties: {
          months: { type: 'number', default: 3 },
        },
      },
    },
    {
      name: 'get_booking_messages',
      description: 'Get recent Booking.com guest messages from the inbox',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_unified_calendar',
      description: 'Get a merged calendar combining Airbnb and Booking.com availability. Highlights conflicts where the same date is reserved or blocked on both platforms.',
      inputSchema: {
        type: 'object',
        properties: {
          months: { type: 'number', default: 3 },
        },
      },
    },
    {
      name: 'refresh_booking_session',
      description: 'Opens a visible browser window to log into Booking.com and refresh the saved session. Call this whenever a Booking.com tool (get_booking_reservations, get_booking_calendar, get_booking_messages, get_earnings_summary) fails with a "Session expired" error. The user logs in on the window that opens; the session is detected and saved automatically once valid (no need to press Enter or run any command), and the browser closes itself. Takes up to 10 minutes — only returns once the user has logged in, the browser was closed early, or it times out. Avoid calling any other Booking.com tool while this is in progress, since it uses the same browser profile.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'refresh_airbnb_session',
      description: 'Opens a visible browser window to log into Airbnb and refresh the saved session. Call this whenever an Airbnb tool (get_airbnb_reservations, get_airbnb_messages, get_airbnb_calendar, get_earnings_summary) fails with a "session expired" error. The user logs in on the window that opens; cookies are saved automatically once the hosting dashboard is detected (no need to press Enter or run any command). It then optionally waits for the user to click through to Earnings > Paid (needed for payout data, including any 2FA code) — the browser closes itself once that\'s done, or the user can just close it early to skip that step. Takes up to 15 minutes.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_earnings_summary',
      description: 'Get revenue and earnings summary from Airbnb and Booking.com. Returns total earnings, payouts, and recent transactions. Defaults to the current year. Optionally filter by year or month.',
      inputSchema: {
        type: 'object',
        properties: {
          year:  { type: 'number', description: 'Year to fetch earnings for (e.g. 2025). Defaults to current year.' },
          month: { type: 'number', description: 'Month to filter by, 1–12. Optional — omit to get the full year view.' },
        },
      },
    },
    {
      name: 'get_booking_monthly_gross',
      description: 'Get Booking.com gross revenue per month for a whole year, aggregated from the Reservations table (filtered by check-in date). Returns monthly totals with reservation counts and a per-month list of confirmed stays. This is the "gross" figure (guest-paid amount before Booking commission) — matches what the Booking Extranet Reservations export shows. Defaults to the current year.',
      inputSchema: {
        type: 'object',
        properties: {
          year: { type: 'number', description: 'Year to fetch (e.g. 2026). Defaults to current year.' },
        },
      },
    },
    {
      name: 'regenerate_cleaner_calendar',
      description: 'Regenerate the cleaner-facing reservations.ics file from live Airbnb + Booking reservations, then commit and push it to the GitHub repo so the cleaner\'s Google Calendar subscription picks up the change. Fires the local generator script (generate-calendar.js) followed by git add/commit/push. Safe to call repeatedly — git commit is a no-op if nothing changed. Returns stdout/stderr from each step for debugging.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  log('info', name, 'tool called', { args });
  try {
    let result;

    switch (name) {
      case 'get_airbnb_reservations':
        result = await memoize('get_airbnb_reservations', { days: args?.days ?? 30 },
          () => getAirbnbReservations(args?.days ?? 30));
        break;
      case 'get_booking_reservations':
        result = await memoize('get_booking_reservations', { startDate: args?.startDate, endDate: args?.endDate },
          () => getBookingReservations({ startDate: args?.startDate, endDate: args?.endDate }));
        break;
      case 'get_airbnb_messages':
        result = await getAirbnbMessages();
        break;
      case 'get_airbnb_calendar':
        result = await getAirbnbCalendar(args?.months ?? 3);
        break;
      case 'get_booking_calendar':
        result = await getBookingCalendar(args?.months ?? 3);
        break;
      case 'get_booking_messages':
        result = await getBookingMessages();
        break;
      case 'refresh_booking_session':
        result = await saveBookingSession();
        break;
      case 'refresh_airbnb_session':
        result = await saveAirbnbSession();
        break;
      case 'get_unified_calendar': {
        const months = args?.months ?? 3;
        const [airbnbResult, bookingResult] = await Promise.allSettled([
          getAirbnbCalendar(months),
          getBookingCalendar(months),
        ]);
        const airbnb  = airbnbResult.status  === 'fulfilled' ? airbnbResult.value  : null;
        const booking = bookingResult.status === 'fulfilled' ? bookingResult.value : null;
        const errors  = [];
        if (airbnbResult.status  === 'rejected') errors.push(`Airbnb: ${airbnbResult.reason?.message}`);
        if (bookingResult.status === 'rejected') errors.push(`Booking.com: ${bookingResult.reason?.message}`);

        const dateMap = {};
        const addDates = (dates, status, source) => {
          for (const date of (dates ?? [])) {
            if (!dateMap[date]) dateMap[date] = { date, airbnb: null, booking: null };
            dateMap[date][source] = status;
          }
        };
        if (airbnb)  { addDates(airbnb.available,  'available', 'airbnb');  addDates(airbnb.blocked,  'blocked',  'airbnb');  addDates(airbnb.reservedDates,  'reserved', 'airbnb');  }
        if (booking) { addDates(booking.available, 'available', 'booking'); addDates(booking.blocked, 'blocked',  'booking'); addDates(booking.reservedDates, 'reserved', 'booking'); }

        const allDates = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
        for (const entry of allDates) {
          entry.conflict =
            (entry.airbnb  === 'reserved' || entry.airbnb  === 'blocked') &&
            (entry.booking === 'reserved' || entry.booking === 'blocked');
        }

        result = {
          months,
          summary: {
            airbnbReserved:  allDates.filter(d => d.airbnb  === 'reserved').length,
            airbnbBlocked:   allDates.filter(d => d.airbnb  === 'blocked').length,
            bookingReserved: allDates.filter(d => d.booking === 'reserved').length,
            bookingBlocked:  allDates.filter(d => d.booking === 'blocked').length,
            conflicts:       allDates.filter(d => d.conflict).length,
          },
          conflicts: allDates.filter(d => d.conflict),
          calendar:  allDates,
          ...(errors.length ? { errors } : {}),
        };
        break;
      }
      case 'get_earnings_summary': {
        const year  = args?.year  ?? null;
        const month = args?.month ?? null;
        result = await memoize('get_earnings_summary', { year, month }, async () => {
          const [airbnbResult, bookingResult] = await Promise.allSettled([
            getAirbnbEarnings({ year, month }),
            getBookingEarnings({ year, month }),
          ]);
          const airbnb  = airbnbResult.status  === 'fulfilled' ? airbnbResult.value  : null;
          const booking = bookingResult.status === 'fulfilled' ? bookingResult.value : null;
          const errors  = [];
          if (airbnbResult.status  === 'rejected') errors.push(`Airbnb: ${airbnbResult.reason?.message}`);
          if (bookingResult.status === 'rejected') errors.push(`Booking.com: ${bookingResult.reason?.message}`);
          return {
            period: { year: year ?? new Date().getFullYear(), month: month ?? null },
            airbnb,
            booking,
            ...(errors.length ? { errors } : {}),
          };
        });
        break;
      }
      case 'get_booking_monthly_gross':
        result = await getBookingMonthlyGross(args?.year);
        break;
      case 'regenerate_cleaner_calendar': {
        // In-process: fetch reservations via the memoized scrapers (so if the
        // artifact just fetched them a few seconds ago, we hit cache instead
        // of re-scraping), build the .ics string, write the file, then git
        // add/commit/push. Only git is a child process now.
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const exec = promisify(execFile);
        const cwd = __dirname;
        const steps = [];
        const runGit = async (label, args, opts) => {
          try {
            const r = await exec('git', args, { cwd, timeout: 60_000, ...opts });
            steps.push({ step: label, ok: true, stdout: (r.stdout || '').slice(0, 2000), stderr: (r.stderr || '').slice(0, 1000) });
            return r;
          } catch (e) {
            steps.push({ step: label, ok: false, error: e.message, stdout: (e.stdout || '').slice(0, 2000), stderr: (e.stderr || '').slice(0, 1000), code: e.code ?? null });
            throw e;
          }
        };

        // 1. Fetch reservations (memoized — reuses artifact's fresh fetch if <60s old)
        let airbnbRaw, bookingRaw;
        try {
          [airbnbRaw, bookingRaw] = await Promise.all([
            memoize('get_airbnb_reservations', { days: 500 }, () => getAirbnbReservations(500)),
            memoize('get_booking_reservations', { startDate: undefined, endDate: undefined }, () => getBookingReservations({})),
          ]);
        } catch (e) {
          steps.push({ step: 'fetch-reservations', ok: false, error: e.message });
          result = { ok: false, phase: 'fetch', steps };
          break;
        }
        steps.push({ step: 'fetch-reservations', ok: true, airbnbRows: airbnbRaw?.length ?? 0, bookingRows: bookingRaw?.length ?? 0 });

        // 2. Build the .ics in-process (no child process, no re-scrape)
        let ics, eventCount;
        try {
          const mod = await import('./generate-calendar.js');
          ({ ics, eventCount } = mod.buildIcsFromReservations({ airbnbRaw, bookingRaw }));
        } catch (e) {
          steps.push({ step: 'build-ics', ok: false, error: e.message });
          result = { ok: false, phase: 'build', steps };
          break;
        }

        // 3. Write to reservations.ics
        const outPath = join(__dirname, 'reservations.ics');
        try {
          fs.writeFileSync(outPath, ics, 'utf-8');
          steps.push({ step: 'write-ics', ok: true, bytes: ics.length, events: eventCount, path: outPath });
        } catch (e) {
          steps.push({ step: 'write-ics', ok: false, error: e.message });
          result = { ok: false, phase: 'write', steps };
          break;
        }

        // 4. git add
        try { await runGit('git-add', ['add', 'reservations.ics']); }
        catch { result = { ok: false, phase: 'git-add', steps }; break; }

        // 5. git commit — allowed to no-op if nothing changed
        const commitMsg = `Auto-update calendar ${new Date().toISOString()}`;
        try {
          await runGit('git-commit', ['commit', '-m', commitMsg]);
        } catch (e) {
          const out = (e.stdout || '') + (e.stderr || '');
          if (/nothing to commit|no changes added/i.test(out)) {
            result = { ok: true, unchanged: true, steps };
            break;
          }
          result = { ok: false, phase: 'git-commit', steps };
          break;
        }

        // 6. git push
        try { await runGit('git-push', ['push']); }
        catch { result = { ok: false, phase: 'git-push', steps }; break; }

        result = { ok: true, pushed: true, steps };
        break;
      }
      default:
        throw new Error(`Unknown tool: "${name}"`);
    }

    log('info', name, 'tool succeeded', { resultCount: Array.isArray(result) ? result.length : typeof result });
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } catch (err) {
    const msg = err?.message ?? String(err);
    const stack = err?.stack ?? '(no stack)';
    log('error', name, msg, { stack });
    console.error(`[hosting-mcp] tool "${name}" failed:`, msg, '\n', stack);
    return {
      content: [{ type: 'text', text: `ERROR: ${msg}\n\nStack:\n${stack}` }],
      isError: true,
    };
  }
});

try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (err) {
  console.error('[hosting-mcp] fatal error:', err);
  process.exit(1);
}
