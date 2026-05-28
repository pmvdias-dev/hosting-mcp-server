import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getBookingReservations, getBookingCalendar } from '../scrapers/booking.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(__dirname, '../sessions/booking-profile');
const HAS_SESSION = fs.existsSync(PROFILE_DIR);
const SKIP_REASON = 'no booking profile — run: node save-session.js booking';

describe('Booking.com scraper', () => {
  it('getBookingReservations returns an array of reservation objects', {
    skip: !HAS_SESSION ? SKIP_REASON : false,
    timeout: 90_000,
  }, async (t) => {
    let result;
    try {
      result = await getBookingReservations();
    } catch (err) {
      if (err.message.startsWith('Session expired')) t.skip(err.message);
      else throw err;
      return;
    }

    assert.ok(Array.isArray(result), 'result should be an array');

    for (const r of result) {
      assert.ok('guest'     in r, 'reservation missing guest');
      assert.ok('checkin'   in r, 'reservation missing checkin');
      assert.ok('checkout'  in r, 'reservation missing checkout');
      assert.ok('status'    in r, 'reservation missing status');
      assert.ok('total'     in r, 'reservation missing total');
      assert.ok('bookingId' in r, 'reservation missing bookingId');
    }
  });

  it('getBookingCalendar returns object with available / blocked / reservedDates arrays', {
    skip: !HAS_SESSION ? SKIP_REASON : false,
    timeout: 90_000,
  }, async (t) => {
    let result;
    try {
      result = await getBookingCalendar();
    } catch (err) {
      if (err.message.startsWith('Session expired')) t.skip(err.message);
      else throw err;
      return;
    }

    assert.ok(result !== null && typeof result === 'object', 'result should be an object');
    assert.ok(Array.isArray(result.available),    'available should be an array');
    assert.ok(Array.isArray(result.blocked),       'blocked should be an array');
    assert.ok(Array.isArray(result.reservedDates), 'reservedDates should be an array');

    for (const date of [...result.available, ...result.blocked, ...result.reservedDates]) {
      assert.equal(typeof date, 'string', 'each date entry should be a string');
      assert.ok(date.length > 0, 'date string should not be empty');
    }
  });
});
