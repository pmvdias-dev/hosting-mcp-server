// Shared stealth-browser plumbing for the Booking.com scraper.
//
// Uses playwright-extra + puppeteer-extra-plugin-stealth (the Node equivalent of
// undetected-chromedriver). Pins a single UA per saved session so the WAF token
// stays valid across scrape runs. Supports a residential proxy via env var.

import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// One stealth instance, shared across calls.
chromiumExtra.use(StealthPlugin());

const UA_FILE = join(__dirname, '../sessions/booking-ua.txt');

/**
 * Generate a fresh desktop-Chrome User-Agent (call when SAVING a session).
 * Stores it to disk so every subsequent scrape uses the SAME UA — Booking.com
 * binds the WAF token to the original UA, so changing it breaks the session.
 */
export function generateAndPinUserAgent() {
  const ua = new UserAgent({ deviceCategory: 'desktop', platform: 'Win32' });
  const value = ua.toString();
  fs.mkdirSync(dirname(UA_FILE), { recursive: true });
  fs.writeFileSync(UA_FILE, value, 'utf-8');
  return value;
}

/**
 * Read the UA pinned at session-save time. Falls back to a current-Chrome UA
 * if no file exists (shouldn't happen if save-session.js ran).
 */
export function getPinnedUserAgent() {
  if (fs.existsSync(UA_FILE)) {
    return fs.readFileSync(UA_FILE, 'utf-8').trim();
  }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
}

/**
 * Sleep a random amount of time within [minMs, maxMs]. Use BEFORE navigation
 * and BETWEEN page actions to mimic a human and dodge timing-based bot scoring.
 */
export function randomDelay(minMs = 3000, maxMs = 7000) {
  const ms = Math.floor(minMs + Math.random() * (maxMs - minMs));
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse BOOKING_PROXY_URL env var — expected format (any of):
 *   http://USER:PASS@HOST:PORT
 *   https://USER:PASS@HOST:PORT
 *   socks5://USER:PASS@HOST:PORT
 * Returns null if unset (no proxy used).
 */
export function getProxyConfig() {
  const raw = process.env.BOOKING_PROXY_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return {
      server: `${u.protocol}//${u.host}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    console.warn('[booking] BOOKING_PROXY_URL is malformed — running without proxy');
    return null;
  }
}

/**
 * Base launch args — kept identical between save-session and scraper so the
 * browser fingerprint matches. Do NOT add window-position/window-size flags
 * here; they alter screenX/innerWidth which the WAF watches.
 */
export const STEALTH_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-infobars',
];

export { chromiumExtra };
