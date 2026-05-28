import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { getAirbnbReservations, getAirbnbMessages, getAirbnbCalendar, getAirbnbEarnings } from './scrapers/airbnb.js';
import { getBookingReservations, getBookingCalendar, getBookingMessages, getBookingEarnings } from './scrapers/booking.js';

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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  log('info', name, 'tool called', { args });
  try {
    let result;

    switch (name) {
      case 'get_airbnb_reservations':
        result = await getAirbnbReservations(args?.days ?? 30);
        break;
      case 'get_booking_reservations':
        result = await getBookingReservations({ startDate: args?.startDate, endDate: args?.endDate });
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
        const [airbnbResult, bookingResult] = await Promise.allSettled([
          getAirbnbEarnings({ year, month }),
          getBookingEarnings({ year, month }),
        ]);
        const airbnb  = airbnbResult.status  === 'fulfilled' ? airbnbResult.value  : null;
        const booking = bookingResult.status === 'fulfilled' ? bookingResult.value : null;
        const errors  = [];
        if (airbnbResult.status  === 'rejected') errors.push(`Airbnb: ${airbnbResult.reason?.message}`);
        if (bookingResult.status === 'rejected') errors.push(`Booking.com: ${bookingResult.reason?.message}`);
        result = {
          period: { year: year ?? new Date().getFullYear(), month: month ?? null },
          airbnb,
          booking,
          ...(errors.length ? { errors } : {}),
        };
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
