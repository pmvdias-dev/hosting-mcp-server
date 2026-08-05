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
const CLEANING_END   = '14:45';
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

// ─── Reservation extraction ──────────────────────────────────────────────
function normalizeReservation(r, source) {
  const checkin = toIso(r.checkin);
  const checkout = toIso(r.checkout);
  if (!checkout) return null;
  // Skip cancelled/expired regardless of platform naming
  const status = String(r.status || '').toLowerCase();
  if (/cancel|declin|expir|no.?show/.test(status)) return null;

  const guest = source === 'Booking.com'
    ? String(r.guest || '').replace(/\n.*$/s, '').trim()
    : String(r.guest || '').trim();

  const guests =
    r.guests ??
    r.guestCount ??
    (r.guestBreakdown ? Object.values(r.guestBreakdown).reduce((s, v) => s + (Number(v) || 0), 0) : null) ??
    null;

  const uidSeed = r.confirmationCode || r.bookingId || `${source}-${guest}-${checkout}`;
  return {
    uid: `${uidSeed}-cleaning@belfast-str`,
    source,
    guest: guest || 'Guest',
    guests,
    checkin,
    checkout,
    total: r.total || '',
  };
}

function buildEvent(res) {
  // Privacy: don't expose guest names or reservation totals in the shared
  // calendar. Cleaner only needs the schedule and headcount.
  const summary = `Cleaning (${res.source})`;
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
  console.log('[calendar] fetching Airbnb reservations…');
  const airbnbRaw = await getAirbnbReservations(500).catch(err => {
    console.error('[calendar] Airbnb fetch failed:', err.message);
    return [];
  });
  console.log('[calendar] Airbnb rows:', airbnbRaw.length);

  console.log('[calendar] fetching Booking reservations…');
  const bookingRaw = await getBookingReservations({}).catch(err => {
    console.error('[calendar] Booking fetch failed:', err.message);
    return [];
  });
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
