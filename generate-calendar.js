// Generate a cleaning-schedule iCal (.ics) file from live Airbnb + Booking
// reservations. Each stay becomes a cleaning event on the checkout day.
//
// Usage:
//   node generate-calendar.js            → writes ./reservations.ics
//   node generate-calendar.js /path/foo  → writes to that path
//
// Wire into Windows Task Scheduler (or run manually) to regenerate. Host the
// resulting .ics somewhere publicly readable (GitHub Gist / repo, Cloudflare
// R2, self-hosted) and subscribe to that URL from Google Calendar.

import fs from 'fs';
import path from 'path';
import { getAirbnbReservations } from './scrapers/airbnb.js';
import { getBookingReservations } from './scrapers/booking.js';

// ─── Config ───────────────────────────────────────────────────────────────
const CLEANING_START = '11:00'; // local time
const CLEANING_END   = '15:00';
const TIMEZONE       = 'Europe/London';
const PROPERTY_NAME  = 'Central & Cosy — Belfast';
const CAL_NAME       = 'Belfast Apt — Cleaning Schedule';
const OUT_PATH       = process.argv[2] || path.join(process.cwd(), 'reservations.ics');

// ─── Date helpers ─────────────────────────────────────────────────────────
// Both scrapers return checkin/checkout as free-form strings ("Aug 20, 2026"
// or "20 Aug 2026" etc). Parse to a stable YYYY-MM-DD.
function toIso(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function icsDateTime(iso, hhmm) {
  // Returns a "floating" local datetime with TZID reference.
  const [y, m, d] = iso.split('-');
  const [h, min] = hhmm.split(':');
  return `${y}${m}${d}T${h}${min}00`;
}

function icsUtcNow() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}T${h}${mi}${s}Z`;
}

// iCalendar text-escape per RFC 5545 §3.3.11
function icsEscape(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// iCalendar lines longer than 75 octets should be folded (CRLF + space)
function foldLine(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let i = 0;
  while (i < line.length) {
    const chunk = line.slice(i, i + (i === 0 ? 75 : 74));
    parts.push((i === 0 ? '' : ' ') + chunk);
    i += (i === 0 ? 75 : 74);
  }
  return parts.join('\r\n');
}

// Booking.com's raw `guest` cell often looks like "Ann Pruce2 adults" or
// "Alžběta Slavíčková2 adults, 2 children (8 and 13 years old)" — the guest
// name and headcount are jammed together. Extract the numeric headcount here.
function parseBookingGuestsFromString(str) {
  if (!str) return null;
  const adultsM = str.match(/(\d+)\s+adult/i);
  const childM  = str.match(/(\d+)\s+child(?:ren)?/i);
  const infantM = str.match(/(\d+)\s+infant/i);
  const a = adultsM ? parseInt(adultsM[1], 10) : 0;
  const c = childM  ? parseInt(childM[1], 10)  : 0;
  const i = infantM ? parseInt(infantM[1], 10) : 0;
  const t = a + c + i;
  return t > 0 ? t : null;
}

// ─── Reservation extraction ──────────────────────────────────────────────
function normalizeReservation(r, source) {
  const checkin = toIso(r.checkin);
  const checkout = toIso(r.checkout);
  if (!checkout) return null;
  // Skip cancelled/expired regardless of platform naming
  const status = String(r.status || '').toLowerCase();
  if (/cancel|declin|expir|no.?show/.test(status)) return null;

  const guestsFromField =
    r.guests ??
    r.guestCount ??
    (r.guestBreakdown ? Object.values(r.guestBreakdown).reduce((s, v) => s + (Number(v) || 0), 0) : null);
  const guestsFromString = source === 'Booking.com' ? parseBookingGuestsFromString(r.guest) : null;
  const guests = guestsFromField ?? guestsFromString ?? null;

  // UID keyed on checkout date so back-to-back same-day turnovers still dedupe
  // to a single cleaning event (see the dedupe pass below).
  return {
    uid: `cleaning-${checkout}@belfast-str`,
    source,
    guests,
    checkin,
    checkout,
  };
}

function buildEvent(res) {
  // Privacy: no guest names, no totals. Title includes guest count so cleaner
  // knows the turnover size at a glance.
  const gLabel = res.guests != null
    ? `${res.guests} guest${res.guests === 1 ? '' : 's'}`
    : 'guest count unknown';
  const summary = `Cleaning — ${gLabel} (${res.source})`;
  const descLines = [
    res.guests != null ? `Number of guests: ${res.guests}` : null,
    `Check-in:  ${res.checkin ?? 'unknown'}`,
    `Check-out: ${res.checkout}`,
    `Platform: ${res.source}`,
  ].filter(Boolean).join('\n');

  const dtStart = icsDateTime(res.checkout, CLEANING_START);
  const dtEnd   = icsDateTime(res.checkout, CLEANING_END);

  return [
    'BEGIN:VEVENT',
    foldLine(`UID:${res.uid}`),
    `DTSTAMP:${icsUtcNow()}`,
    `DTSTART;TZID=${TIMEZONE}:${dtStart}`,
    `DTEND;TZID=${TIMEZONE}:${dtEnd}`,
    foldLine(`SUMMARY:${icsEscape(summary)}`),
    foldLine(`DESCRIPTION:${icsEscape(descLines)}`),
    foldLine(`LOCATION:${icsEscape(PROPERTY_NAME)}`),
    'STATUS:CONFIRMED',
    'END:VEVENT',
  ].join('\r\n');
}

// ─── Timezone VTIMEZONE block (Europe/London) ─────────────────────────────
// Some calendar clients (including Google) prefer an inline VTIMEZONE
// definition rather than a bare TZID reference to an unknown zone. This is
// the standard London DST rule as of writing.
const TZ_BLOCK = [
  'BEGIN:VTIMEZONE',
  `TZID:${TIMEZONE}`,
  'BEGIN:STANDARD',
  'DTSTART:19701025T020000',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0000',
  'TZNAME:GMT',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700329T010000',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
  'TZOFFSETFROM:+0000',
  'TZOFFSETTO:+0100',
  'TZNAME:BST',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
].join('\r\n');

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  // We must have BOTH Airbnb and Booking reservations to produce a trustworthy
  // cleaner calendar — a one-platform-only file would silently omit cleanings
  // and mislead the cleaner. If either fetch throws, exit non-zero so the
  // caller (MCP tool / batch script) leaves the previous .ics untouched.
  console.log('[calendar] fetching Airbnb reservations…');
  const airbnbP = getAirbnbReservations(500);
  console.log('[calendar] fetching Booking reservations…');
  const bookingP = getBookingReservations({});
  const [airRes, bkRes] = await Promise.allSettled([airbnbP, bookingP]);

  if (airRes.status === 'rejected' || bkRes.status === 'rejected') {
    const errs = [];
    if (airRes.status === 'rejected') errs.push('Airbnb: ' + (airRes.reason?.message || airRes.reason));
    if (bkRes.status  === 'rejected') errs.push('Booking: ' + (bkRes.reason?.message || bkRes.reason));
    console.error('[calendar] refusing to write file — one or more fetches failed:');
    errs.forEach(e => console.error('  -', e));
    console.error('[calendar] previous ' + OUT_PATH + ' left untouched.');
    process.exit(2);
  }

  const airbnbRaw = airRes.value;
  const bookingRaw = bkRes.value;
  console.log('[calendar] Airbnb rows:', airbnbRaw.length);
  console.log('[calendar] Booking rows:', bookingRaw.length);

  const all = [
    ...airbnbRaw.map(r => normalizeReservation(r, 'Airbnb')),
    ...bookingRaw.map(r => normalizeReservation(r, 'Booking.com')),
  ].filter(Boolean);

  // Dedupe by UID (safety net if the same reservation appears twice)
  const byUid = new Map();
  all.forEach(r => { if (!byUid.has(r.uid)) byUid.set(r.uid, r); });
  const events = [...byUid.values()].sort((a, b) => a.checkout.localeCompare(b.checkout));
  console.log('[calendar] cleaning events to emit:', events.length);

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//airbnb-mcp-server//cleaning-calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(CAL_NAME)}`,
    `X-WR-TIMEZONE:${TIMEZONE}`,
    TZ_BLOCK,
    ...events.map(buildEvent),
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n';

  fs.writeFileSync(OUT_PATH, ics, 'utf-8');
  console.log('[calendar] wrote', OUT_PATH, `(${ics.length} bytes)`);
}

main().catch(err => {
  console.error('[calendar] fatal:', err);
  process.exit(1);
});
