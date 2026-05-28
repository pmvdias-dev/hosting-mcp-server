import { chromium } from 'playwright';
import fs from 'fs';

const TARGETS = {
  airbnb: {
    cookieFile: './sessions/airbnb-session.json',
    url: 'https://www.airbnb.com/hosting/reservations',
  },
};

const { cookieFile, url } = TARGETS.airbnb;

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

if (fs.existsSync(cookieFile)) {
  const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf-8'));
  await context.addCookies(cookies);
}

const page = await context.newPage();
console.log(`Navigating to ${url} ...`);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000); // let JS render the reservations list

console.log(`\nFinal URL: ${page.url()}\n`);

// Dump the first 3 reservation rows in detail
const rows = await page.evaluate(() => {
  const rowEls = document.querySelectorAll('[data-testid="host-reservations-table-row"]');
  return Array.from(rowEls).slice(0, 3).map(row => {
    const cells = Array.from(row.querySelectorAll('td'));
    return {
      cellCount: cells.length,
      cells: cells.map((td, i) => ({
        index: i,
        text: td.innerText?.trim().replace(/\n+/g, ' | ').slice(0, 120) ?? '',
        testId: td.getAttribute('data-testid') ?? '',
        childTestIds: Array.from(td.querySelectorAll('[data-testid]'))
          .map(el => el.getAttribute('data-testid')),
      })),
    };
  });
});

console.log(`Found ${rows.length} reservation rows\n`);
rows.forEach((row, i) => {
  console.log(`--- Row ${i + 1} (${row.cellCount} cells) ---`);
  row.cells.forEach(c =>
    console.log(`  td[${c.index}] testId="${c.testId}" childIds=[${c.childTestIds}] | "${c.text}"`)
  );
  console.log('');
});

console.log('\nBrowser staying open — inspect manually if needed. Close the window to exit.');
// Keep browser open for manual inspection
await page.waitForTimeout(60000);
await browser.close();
