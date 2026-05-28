/**
 * Run with:  node debug-booking.js
 * Opens Booking.com admin with your saved session, dumps data-testid attributes
 * and page structure so you can identify the correct selectors for booking.js.
 */
import { chromium } from 'playwright';
import fs from 'fs';

const PROFILE_DIR = './sessions/booking-profile';
const SESSION_FILE = './sessions/booking-session.json';
const URL = 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/booking-list.html';

if (!fs.existsSync(PROFILE_DIR) && !fs.existsSync(SESSION_FILE)) {
  console.error('No session found. Run: node save-session.js booking');
  process.exit(1);
}

// Debug runs headed and maximized so you can inspect the page visually
let context;
if (fs.existsSync(PROFILE_DIR)) {
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled', '--no-first-run'],
    viewport: null,
  });
} else {
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  context = await browser.newContext({
    storageState: SESSION_FILE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
}

const page = context.pages()[0] ?? await context.newPage();
console.log(`Navigating to ${URL} ...`);
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});

console.log(`\nFinal URL: ${page.url()}\n`);

if (
  page.url().includes('sign-in') ||
  page.url().includes('/login') ||
  page.url().startsWith('https://account.booking.com') ||
  !page.url().includes('admin.booking.com')
) {
  console.error('Redirected to login — session expired. Run: node save-session.js booking');
  await context.close();
  process.exit(1);
}

await page.screenshot({ path: 'debug-booking.png', fullPage: true });
console.log('Screenshot saved to debug-booking.png\n');

// Dump all elements with data-testid
const testIds = await page.evaluate(() => {
  return [...document.querySelectorAll('[data-testid]')]
    .slice(0, 60)
    .map(el => ({
      tag: el.tagName.toLowerCase(),
      testId: el.getAttribute('data-testid'),
      text: el.innerText?.trim().replace(/\n+/g, ' | ').slice(0, 80) ?? '',
    }));
});

console.log(`--- data-testid elements found (first 60) ---`);
testIds.forEach(({ tag, testId, text }) =>
  console.log(`  <${tag} data-testid="${testId}"> | "${text}"`)
);

// Also dump first 3 table rows
const rows = await page.evaluate(() => {
  const rowEls = document.querySelectorAll('tr');
  return [...rowEls].slice(0, 5).map(row => ({
    attrs: [...row.attributes].map(a => `${a.name}="${a.value}"`).join(' '),
    text: row.innerText?.trim().replace(/\n+/g, ' | ').slice(0, 120) ?? '',
  }));
});

console.log(`\n--- First 5 <tr> elements ---`);
rows.forEach(({ attrs, text }, i) =>
  console.log(`  tr[${i}] ${attrs} | "${text}"`)
);

// Also dump intercepted XHR/fetch calls (first 10 JSON responses)
console.log('\n--- Intercepting API responses (next 10s) ---');
const captured = [];
page.on('response', async (res) => {
  if (!res.headers()['content-type']?.includes('application/json')) return;
  if (captured.length >= 10) return;
  try {
    const json = await res.json();
    captured.push({ url: res.url().slice(0, 100), status: res.status(), preview: JSON.stringify(json).slice(0, 200) });
  } catch { /* ignore */ }
});
await page.waitForTimeout(10_000);
captured.forEach(({ url, status, preview }) =>
  console.log(`  [${status}] ${url}\n         ${preview}\n`)
);

console.log('\nBrowser staying open for manual inspection. Close the window to exit.');
await page.waitForTimeout(60_000);
await context.close();
