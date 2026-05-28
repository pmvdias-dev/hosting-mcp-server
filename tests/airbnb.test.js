import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAirbnbReservations, getAirbnbMessages, getAirbnbCalendar } from '../scrapers/airbnb.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = join(__dirname, '../sessions/airbnb-session.json');
const HAS_SESSION = fs.existsSync(SESSION_FILE);
const SKIP_REASON = 'no airbnb session — run: node save-session.js airbnb';

describe('Airbnb scraper', () => {
  it('getAirbnbReservations returns an array of reservation objects', {
    skip: !HAS_SESSION ? SKIP_REASON : false,
    timeout: 90_000,
  }, async () => {
    const result = await getAirbnbReservations();

    assert.ok(Array.isArray(result), 'result should be an array');

    for (const r of result) {
      assert.ok('status'           in r, 'reservation missing status');
      assert.ok('guest'            in r, 'reservation missing guest');
      assert.ok('phone'            in r, 'reservation missing phone');
      assert.ok('checkin'          in r, 'reservation missing checkin');
      assert.ok('checkout'         in r, 'reservation missing checkout');
      assert.ok('booked'           in r, 'reservation missing booked');
      assert.ok('listing'          in r, 'reservation missing listing');
      assert.ok('confirmationCode' in r, 'reservation missing confirmationCode');
      assert.ok('total'            in r, 'reservation missing total');
    }
  });

  it('getAirbnbMessages returns an array of message thread objects', {
    skip: !HAS_SESSION ? SKIP_REASON : false,
    timeout: 90_000,
  }, async () => {
    const result = await getAirbnbMessages();

    assert.ok(Array.isArray(result), 'result should be an array');

    for (const m of result) {
      assert.ok('guest'   in m, 'message missing guest');
      assert.ok('preview' in m, 'message missing preview');
      assert.ok('unread'  in m, 'message missing unread');
      assert.ok('time'    in m, 'message missing time');
      assert.equal(typeof m.unread, 'boolean', 'unread should be a boolean');
    }
  });

  it('getAirbnbCalendar returns object with available / blocked / reservedDates arrays', {
    skip: !HAS_SESSION ? SKIP_REASON : false,
    timeout: 90_000,
  }, async () => {
    const result = await getAirbnbCalendar();

    assert.ok(result !== null && typeof result === 'object', 'result should be an object');
    assert.ok(Array.isArray(result.available),     'available should be an array');
    assert.ok(Array.isArray(result.blocked),        'blocked should be an array');
    assert.ok(Array.isArray(result.reservedDates),  'reservedDates should be an array');

    for (const date of [...result.available, ...result.blocked, ...result.reservedDates]) {
      assert.equal(typeof date, 'string', 'each date entry should be a string');
      assert.ok(date.length > 0, 'date string should not be empty');
    }
  });
});
