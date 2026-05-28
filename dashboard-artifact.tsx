// Hosting Dashboard — Live Artifact
//
// Pattern A (one-shot embedded): all data baked in as DATA const below.
// To refresh: re-ask Claude to fetch + regenerate this file.
//
// To use in Claude Artifacts UI:
//   1. Open a Claude conversation
//   2. Ask: "Render this React component as an artifact:" then paste this whole file
//   3. Click thumbnails / interact
//
// Stack: React + recharts + lucide-react + Tailwind. No external data fetches.

import React, { useState, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import {
  Calendar as CalendarIcon, PoundSterling, BarChart3, ChevronLeft,
  ChevronRight, X, User, Phone, Home,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────
// Data — fetched 2026-05-10 via MCP tools (get_airbnb_reservations,
// get_earnings_summary). Booking reservations were empty because Booking's
// "Date of" filter defaults to booking-date, not check-in (TODO: fix scraper).
// ─────────────────────────────────────────────────────────────────────────

const DATA = {
  fetchedAt: '2026-05-10',
  year: 2026,

  airbnbReservations: [
    { status: 'Confirmed', guest: 'Tom Kemper',         phone: '+1 503-740-7454',  checkin: 'May 13, 2026', checkout: 'May 15, 2026', total: '£174.20', code: 'HMDTNTSX4F', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Sean Black',         phone: '+44 7716 552376',  checkin: 'May 15, 2026', checkout: 'May 17, 2026', total: '£236.06', code: 'HMPQXBKADZ', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Jo-Anne Bell',       phone: '+44 141 316 3879', checkin: 'May 17, 2026', checkout: 'May 19, 2026', total: '£107.84', code: 'HMA2MPHTZC', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Qian Tung Chiew',    phone: '+44 7477 106998',  checkin: 'May 19, 2026', checkout: 'May 21, 2026', total: '£109.15', code: 'HMMJPQNBJQ', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Dean Fairbairn',     phone: '+44 7847 614221',  checkin: 'May 21, 2026', checkout: 'May 22, 2026', total: '£84.25',  code: 'HMAEQQPX5X', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Carol Strong',       phone: '+1 616-498-8903',  checkin: 'May 22, 2026', checkout: 'May 25, 2026', total: '£416.45', code: 'HMWNRHH4K9', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Tony Ablett',        phone: '+44 7917 003407',  checkin: 'May 25, 2026', checkout: 'May 27, 2026', total: '£123.66', code: 'HMK8JZNA54', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Will Freeman',       phone: '+44 7787 133409',  checkin: 'May 27, 2026', checkout: 'May 29, 2026', total: '£143.45', code: 'HM2DBCYX9Q', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Alexander Emery',    phone: '+44 7359 174065',  checkin: 'May 31, 2026', checkout: 'Jun 7, 2026',  total: '£477.66', code: 'HMSCWC5KC2', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Lori Thomas',        phone: '+44 7790 436455',  checkin: 'Jun 8, 2026',  checkout: 'Jun 10, 2026', total: '£119.41', code: 'HM2CFJAQ23', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Sue Vallance',       phone: '+44 7771 616012',  checkin: 'Jun 15, 2026', checkout: 'Jun 19, 2026', total: '£345.11', code: 'HM458PNBC9', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Adam Johnson',       phone: '+44 7498 733332',  checkin: 'Jun 22, 2026', checkout: 'Jun 25, 2026', total: '£241.96', code: 'HMEWXYBAA8', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Dennis Blankenship', phone: '+1 713-855-3342',  checkin: 'Jun 27, 2026', checkout: 'Jun 29, 2026', total: '£198.59', code: 'HM9QNZ4MKD', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Sophie Stace',       phone: '+61 403 628 318',  checkin: 'Jul 6, 2026',  checkout: 'Jul 9, 2026',  total: '£216.53', code: 'HMR8DQZMP3', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Louis Johnson',      phone: '+44 7725 858413',  checkin: 'Jul 10, 2026', checkout: 'Jul 13, 2026', total: '£351.65', code: 'HMY9JREYQR', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Hannah Bayes',       phone: '+44 7762 907855',  checkin: 'Jul 18, 2026', checkout: 'Jul 20, 2026', total: '£277.57', code: 'HM5WFD22AZ', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Ernestine Healy',    phone: '+353 87 289 9254', checkin: 'Aug 4, 2026',  checkout: 'Aug 9, 2026',  total: '£467.54', code: 'HMXD8M9JWA', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Ciara Crumley',      phone: '+44 7526 252985',  checkin: 'Aug 20, 2026', checkout: 'Aug 23, 2026', total: '£285.34', code: 'HMFE3XR5XB', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Kathy Beard',        phone: '+61 450 305 855',  checkin: 'Sep 7, 2026',  checkout: 'Sep 10, 2026', total: '£202.20', code: 'HM35WQRZYT', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Kathryn Hutchinson', phone: '+1 519-270-1794',  checkin: 'Sep 12, 2026', checkout: 'Sep 15, 2026', total: '£253.15', code: 'HMFHWHRK45', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Laura Slate',        phone: '+44 7471 472599',  checkin: 'Sep 19, 2026', checkout: 'Sep 22, 2026', total: '£261.24', code: 'HM8ABQJYCZ', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Carol Taylor',       phone: '+44 7873 354241',  checkin: 'Oct 5, 2026',  checkout: 'Oct 9, 2026',  total: '£246.89', code: 'HMW48RX3TN', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Alice Jackman',      phone: '+44 7845 683129',  checkin: 'Oct 28, 2026', checkout: 'Nov 1, 2026',  total: '£414.65', code: 'HMB2KHFFNE', listing: 'Belfast Apt' },
    { status: 'Confirmed', guest: 'Carrie Chapman',     phone: '+44 7830 015751',  checkin: 'Nov 6, 2026',  checkout: 'Nov 8, 2026',  total: '£177.38', code: 'HMWT3FZ52R', listing: 'Belfast Apt' },
  ],

  // [paid, upcoming, total] in £, indexed by month 0..11.
  airbnbMonthly: [
    { month: 'Jan', paid: 1139.75, upcoming: 0,       total: 1139.75 },
    { month: 'Feb', paid: 1591.19, upcoming: 0,       total: 1591.19 },
    { month: 'Mar', paid: 1353.37, upcoming: 0,       total: 1353.37 },
    { month: 'Apr', paid: 1064.28, upcoming: 0,       total: 1064.28 },
    { month: 'May', paid: 608.01,  upcoming: 1395.06, total: 2003.07 },
    { month: 'Jun', paid: 0,       upcoming: 1382.73, total: 1382.73 },
    { month: 'Jul', paid: 0,       upcoming: 845.75,  total: 845.75 },
    { month: 'Aug', paid: 0,       upcoming: 752.88,  total: 752.88 },
    { month: 'Sep', paid: 0,       upcoming: 716.59,  total: 716.59 },
    { month: 'Oct', paid: 0,       upcoming: 661.54,  total: 661.54 },
    { month: 'Nov', paid: 0,       upcoming: 177.38,  total: 177.38 },
    { month: 'Dec', paid: 0,       upcoming: 0,       total: 0 },
  ],

  // Booking.com weekly payouts. Bucketed below by payout-date month.
  bookingPayouts: [
    { date: '8 Jan 2026',  amount: 135.94, period: '25 Dec 2025 - 7 Jan 2026', id: 'ZNaabdYI9qprUvGs' },
    { date: '5 Feb 2026',  amount: 175.97, period: '8 Jan - 4 Feb',            id: '9sft7FeNKYUO8hrH' },
    { date: '12 Feb 2026', amount: 305.24, period: '5 Feb - 11 Feb',           id: '6Pj3rUZumFiBToQB' },
    { date: '12 Mar 2026', amount: 276.05, period: '12 Feb - 11 Mar',          id: 'MYQyTYDbWldjWMnR' },
    { date: '19 Mar 2026', amount: 241.86, period: '12 Mar - 18 Mar',          id: '1ZxV8I8TMLpNTct5' },
    { date: '2 Apr 2026',  amount: 111.09, period: '19 Mar - 1 Apr',           id: 'mHqDU8avf1XbA1qM' },
    { date: '9 Apr 2026',  amount: 195.16, period: '2 Apr - 8 Apr',            id: 'PdTdXJ948hgqK2w3' },
    { date: '16 Apr 2026', amount: 283.56, period: '9 Apr - 15 Apr',           id: 'ChvxyVnFQ1e9A5ae' },
    { date: '30 Apr 2026', amount: 255.04, period: '16 Apr - 29 Apr',          id: '73NW04fR48yA0mZn' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function parseAmount(s) {
  if (typeof s === 'number') return s;
  if (!s) return 0;
  const n = parseFloat(String(s).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function fmtGBP(n) {
  return '£' + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// "May 13, 2026" → Date
function parseDate(s) {
  return new Date(s);
}

// Bucket booking payouts by payout-date month (1..12).
function bookingMonthly() {
  const buckets = Array.from({ length: 12 }, (_, i) => ({
    month: MONTHS[i], paid: 0, count: 0,
  }));
  for (const p of DATA.bookingPayouts) {
    const d = new Date(p.date);
    if (isNaN(d.getTime())) continue;
    const idx = d.getMonth();
    buckets[idx].paid += p.amount;
    buckets[idx].count += 1;
  }
  return buckets;
}

// Combined per-month series for stacked bar.
function combinedMonthly() {
  const bm = bookingMonthly();
  return DATA.airbnbMonthly.map((a, i) => ({
    month:           a.month,
    airbnbPaid:      a.paid,
    airbnbUpcoming:  a.upcoming,
    bookingPaid:     bm[i].paid,
    total:           a.total + bm[i].paid,
  }));
}

// Build calendar matrix (year, month0-11) → array of {date, day, inMonth}.
function calendarGrid(year, month) {
  const first = new Date(year, month, 1);
  const startWeekday = (first.getDay() + 6) % 7; // ISO: Mon=0
  const lastDay = new Date(year, month + 1, 0).getDate();
  const cells = [];

  // Leading days from previous month
  for (let i = startWeekday - 1; i >= 0; i--) {
    const d = new Date(year, month, -i);
    cells.push({ date: d, day: d.getDate(), inMonth: false });
  }
  // Current month days
  for (let d = 1; d <= lastDay; d++) {
    cells.push({ date: new Date(year, month, d), day: d, inMonth: true });
  }
  // Trailing to fill 6×7
  while (cells.length < 42) {
    const last = cells[cells.length - 1].date;
    const next = new Date(last); next.setDate(last.getDate() + 1);
    cells.push({ date: next, day: next.getDate(), inMonth: false });
  }
  return cells;
}

// Reservations whose [checkin, checkout) overlap a given date.
function reservationsOnDate(date) {
  return DATA.airbnbReservations.filter(r => {
    const ci = parseDate(r.checkin);
    const co = parseDate(r.checkout);
    return date >= startOfDay(ci) && date < startOfDay(co);
  });
}

function startOfDay(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0); return x;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth() &&
         a.getDate()     === b.getDate();
}

// ─────────────────────────────────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────────────────────────────────

function Tabs({ active, onChange }) {
  const tabs = [
    { id: 'calendar', label: 'Calendar', icon: CalendarIcon },
    { id: 'earnings', label: 'Earnings', icon: PoundSterling },
    { id: 'charts',   label: 'Charts',   icon: BarChart3 },
  ];
  return (
    <div className="flex gap-1 border-b border-slate-200 px-4 bg-white sticky top-0 z-10">
      {tabs.map(t => {
        const Icon = t.icon;
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition ${
              isActive
                ? 'border-rose-500 text-rose-600'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Icon size={16} /> {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Calendar tab
// ─────────────────────────────────────────────────────────────────────────

function CalendarTab() {
  const [cursor, setCursor] = useState(new Date(2026, 4, 1)); // start at May 2026
  const [selected, setSelected] = useState(null);

  const grid = calendarGrid(cursor.getFullYear(), cursor.getMonth());
  const today = new Date();

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
          className="p-2 hover:bg-slate-100 rounded-lg"
        >
          <ChevronLeft size={20} />
        </button>
        <h2 className="text-xl font-semibold">
          {MONTH_FULL[cursor.getMonth()]} {cursor.getFullYear()}
        </h2>
        <button
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
          className="p-2 hover:bg-slate-100 rounded-lg"
        >
          <ChevronRight size={20} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-2 text-xs text-slate-500 font-medium">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
          <div key={d} className="p-2 text-center">{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {grid.map((cell, i) => {
          const reservations = reservationsOnDate(cell.date);
          const isToday = sameDay(cell.date, today);
          return (
            <div
              key={i}
              className={`min-h-[88px] p-2 border rounded-lg ${
                cell.inMonth ? 'bg-white' : 'bg-slate-50 text-slate-400'
              } ${isToday ? 'ring-2 ring-rose-400' : 'border-slate-200'}`}
            >
              <div className="text-xs font-medium mb-1">{cell.day}</div>
              <div className="flex flex-col gap-1">
                {reservations.map((r, j) => (
                  <button
                    key={j}
                    onClick={() => setSelected(r)}
                    className="text-left text-[10px] px-1.5 py-1 rounded bg-rose-100 text-rose-700 hover:bg-rose-200 truncate"
                    title={`${r.guest} — ${r.total}`}
                  >
                    {r.guest.split(' ')[0]}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex items-center gap-4 text-xs text-slate-600">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded bg-rose-200"></span> Airbnb reservation
        </div>
        <div className="text-slate-400">
          (Booking.com reservations: scraper currently empty — see note below)
        </div>
      </div>

      {selected && <ReservationModal r={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ReservationModal({ r, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <span className="inline-block px-2 py-0.5 bg-rose-100 text-rose-700 text-xs rounded font-medium mb-1">
              Airbnb · {r.status}
            </span>
            <h3 className="text-lg font-semibold">{r.guest}</h3>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <Row label="Check-in"  value={r.checkin} />
          <Row label="Check-out" value={r.checkout} />
          <Row label="Listing"   value={r.listing} icon={Home} />
          <Row label="Phone"     value={r.phone}   icon={Phone} />
          <Row label="Code"      value={r.code} />
          <div className="pt-3 border-t flex justify-between items-center">
            <span className="text-slate-500">Total payout</span>
            <span className="text-xl font-semibold">{r.total}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, icon: Icon }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-slate-500 flex items-center gap-1.5">
        {Icon && <Icon size={14} />} {label}
      </span>
      <span className="text-slate-900 text-right">{value}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Earnings tab
// ─────────────────────────────────────────────────────────────────────────

function EarningsTab() {
  const airbnbPaid     = DATA.airbnbMonthly.reduce((s, m) => s + m.paid, 0);
  const airbnbUpcoming = DATA.airbnbMonthly.reduce((s, m) => s + m.upcoming, 0);
  const bookingPaid    = DATA.bookingPayouts.reduce((s, p) => s + p.amount, 0);
  const totalPaid      = airbnbPaid + bookingPaid;
  const totalAll       = totalPaid + airbnbUpcoming;

  const pieData = [
    { name: 'Airbnb',   value: airbnbPaid, color: '#fb7185' },
    { name: 'Booking',  value: bookingPaid, color: '#3b82f6' },
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat title="Airbnb paid"     value={fmtGBP(airbnbPaid)}     accent="text-rose-600" />
        <Stat title="Airbnb upcoming" value={fmtGBP(airbnbUpcoming)} accent="text-rose-400" />
        <Stat title="Booking paid"    value={fmtGBP(bookingPaid)}    accent="text-blue-600" />
        <Stat title="Total YTD paid"  value={fmtGBP(totalPaid)}      accent="text-emerald-600" />
      </div>

      <div className="bg-white rounded-2xl p-6 border border-slate-200">
        <h3 className="text-lg font-semibold mb-1">Total incl. upcoming</h3>
        <p className="text-3xl font-bold text-slate-900">{fmtGBP(totalAll)}</p>
        <p className="text-sm text-slate-500 mt-1">
          {fmtGBP(totalPaid)} paid · {fmtGBP(airbnbUpcoming)} upcoming Airbnb
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl p-6 border border-slate-200">
          <h3 className="text-sm font-medium text-slate-500 mb-3">Paid YTD split</h3>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={pieData} dataKey="value" nameKey="name"
                cx="50%" cy="50%" outerRadius={80} innerRadius={45}
                label={(e) => `${e.name}: ${fmtGBP(e.value)}`}
              >
                {pieData.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Pie>
              <Tooltip formatter={(v) => fmtGBP(v)} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-2xl p-6 border border-slate-200">
          <h3 className="text-sm font-medium text-slate-500 mb-3">Booking weekly payouts</h3>
          <div className="space-y-1 text-sm max-h-[220px] overflow-auto">
            {DATA.bookingPayouts.map((p, i) => (
              <div key={i} className="flex justify-between py-1 border-b border-slate-100 last:border-0">
                <div>
                  <div className="font-medium">{p.date}</div>
                  <div className="text-xs text-slate-500">{p.period}</div>
                </div>
                <div className="font-semibold">{fmtGBP(p.amount)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl p-6 border border-slate-200">
        <h3 className="text-lg font-semibold mb-3">Monthly breakdown</h3>
        <table className="w-full text-sm">
          <thead className="text-slate-500 border-b">
            <tr>
              <th className="text-left py-2">Month</th>
              <th className="text-right py-2">Airbnb paid</th>
              <th className="text-right py-2">Airbnb upcoming</th>
              <th className="text-right py-2">Booking paid</th>
              <th className="text-right py-2 font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {combinedMonthly().map(m => (
              <tr key={m.month} className="border-b border-slate-100">
                <td className="py-2 font-medium">{m.month}</td>
                <td className="text-right">{fmtGBP(m.airbnbPaid)}</td>
                <td className="text-right text-slate-500">{fmtGBP(m.airbnbUpcoming)}</td>
                <td className="text-right">{fmtGBP(m.bookingPaid)}</td>
                <td className="text-right font-semibold">{fmtGBP(m.total + m.airbnbUpcoming)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ title, value, accent }) {
  return (
    <div className="bg-white rounded-xl p-4 border border-slate-200">
      <div className="text-xs font-medium text-slate-500">{title}</div>
      <div className={`text-2xl font-bold mt-1 ${accent ?? 'text-slate-900'}`}>{value}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Charts tab — stacked monthly bar
// ─────────────────────────────────────────────────────────────────────────

function ChartsTab() {
  const data = combinedMonthly();
  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="bg-white rounded-2xl p-6 border border-slate-200">
        <h3 className="text-lg font-semibold mb-1">Monthly earnings — paid (stacked)</h3>
        <p className="text-sm text-slate-500 mb-4">
          Airbnb paid + Booking paid per month. Excludes upcoming.
        </p>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={data} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="month" />
            <YAxis tickFormatter={(v) => `£${v}`} />
            <Tooltip formatter={(v) => fmtGBP(v)} />
            <Legend />
            <Bar dataKey="airbnbPaid"  stackId="a" fill="#fb7185" name="Airbnb paid"  radius={[0, 0, 0, 0]} />
            <Bar dataKey="bookingPaid" stackId="a" fill="#3b82f6" name="Booking paid" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-white rounded-2xl p-6 border border-slate-200">
        <h3 className="text-lg font-semibold mb-1">Monthly earnings — paid + upcoming (Airbnb)</h3>
        <p className="text-sm text-slate-500 mb-4">
          Booking has no forward-looking upcoming data (payouts are weekly, retroactive).
        </p>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={data} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="month" />
            <YAxis tickFormatter={(v) => `£${v}`} />
            <Tooltip formatter={(v) => fmtGBP(v)} />
            <Legend />
            <Bar dataKey="airbnbPaid"     stackId="b" fill="#fb7185" name="Airbnb paid" />
            <Bar dataKey="bookingPaid"    stackId="b" fill="#3b82f6" name="Booking paid" />
            <Bar dataKey="airbnbUpcoming" stackId="b" fill="#fda4af" name="Airbnb upcoming" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [tab, setTab] = useState('calendar');

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-white border-b border-slate-200 px-6 py-4">
        <h1 className="text-xl font-bold">Hosting Dashboard — {DATA.year}</h1>
        <p className="text-xs text-slate-500">Data fetched: {DATA.fetchedAt}</p>
      </div>

      <Tabs active={tab} onChange={setTab} />

      {tab === 'calendar' && <CalendarTab />}
      {tab === 'earnings' && <EarningsTab />}
      {tab === 'charts'   && <ChartsTab />}

      <div className="px-6 py-4 text-xs text-slate-400 max-w-5xl mx-auto">
        <strong>Note:</strong> Booking.com reservations endpoint returned empty —
        scraper "Date of" filter defaulted to <em>Reservation</em> (booking date)
        instead of <em>Check-in</em>. Earnings data unaffected (uses payouts page).
      </div>
    </div>
  );
}
