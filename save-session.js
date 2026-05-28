import { chromium } from 'playwright';
import fs from 'fs';
import readline from 'readline';
import {
  chromiumExtra,
  generateAndPinUserAgent,
  getProxyConfig,
  STEALTH_LAUNCH_ARGS,
} from './scrapers/stealth-browser.js';

const PLATFORMS = {
  airbnb: {
    loginUrl: 'https://www.airbnb.com/login',
    cookieFile: './sessions/airbnb-session.json',
  },
  booking: {
    loginUrl: 'https://admin.booking.com',
    // Persistent profile dir — session stays valid across scraper runs
    profileDir: './sessions/booking-profile',
  },
};

const platform = process.argv[2];

if (!platform || !PLATFORMS[platform]) {
  console.error('Usage: node save-session.js <platform>');
  console.error('');
  console.error('  node save-session.js airbnb');
  console.error('  node save-session.js booking');
  process.exit(1);
}

const { loginUrl, cookieFile, profileDir } = PLATFORMS[platform];

function waitForEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

fs.mkdirSync('./sessions', { recursive: true });

if (platform === 'booking') {
  if (profileDir) fs.mkdirSync(profileDir, { recursive: true });

  // Generate + pin a fresh desktop Chrome UA for this session. The scraper
  // will read the same value from sessions/booking-ua.txt — keeping the UA
  // identical between login and scrape is what keeps Booking.com's WAF token
  // valid. Rotating per-scrape would invalidate the session.
  const pinnedUA = generateAndPinUserAgent();
  console.log('Generated UA for this session: ' + pinnedUA);

  const proxy = getProxyConfig();
  if (proxy) console.log('Using proxy: ' + proxy.server);

  const context = await chromiumExtra.launchPersistentContext(profileDir, {
    headless: false,
    args: ['--start-maximized', ...STEALTH_LAUNCH_ARGS],
    viewport: null,
    userAgent: pinnedUA,
    ...(proxy ? { proxy } : {}),
  });

  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(loginUrl);

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BOOKING.COM SESSION SAVE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('Steps (read carefully):');
  console.log('  1. Log in with your Booking.com partner credentials.');
  console.log('  2. Complete any 2FA / verification steps.');
  console.log('  3. Select your property if prompted.');
  console.log('  4. Navigate to the RESERVATIONS LIST page:');
  console.log('     Reservations → Booking details → (wait for the list to load)');
  console.log('  5. Confirm you can SEE your bookings in the list.');
  console.log('  6. ONLY THEN press Enter here.');
  console.log('');
  console.log('  ⚠  Do NOT press Enter while on the sign-in page or');
  console.log('     while the page is still loading — the session will be invalid.');
  console.log('');

  // Keep prompting until we get a valid session
  while (true) {
    console.log('Press Enter when you can see your reservations list...');
    await waitForEnter();

    const currentUrl = page.url();

    // Must be on admin.booking.com, not on any auth/login page
    const onAuthPage =
      currentUrl.includes('sign-in') ||
      currentUrl.includes('/login') ||
      currentUrl.startsWith('https://account.booking.com') ||
      !currentUrl.includes('admin.booking.com');

    if (onAuthPage) {
      console.error('');
      console.error('  ✗ Still on the login/auth page.');
      console.error('    URL: ' + currentUrl.slice(0, 100));
      console.error('    Complete the login and navigate to the reservations list first.');
      console.error('');
      continue;
    }

    // Validate the auth-bearing cookies are populated.
    // Booking.com sets multiple session cookies; the meaningful ones for the
    // extranet are `bkng_sso_auth` (~150 chars) and `esadm` (~80 chars).
    // `bkng_sso_session` is often "e30" (base64 of {}) even when fully logged in.
    const state = await context.storageState();
    const ssoAuth = state.cookies?.find(c => c.name === 'bkng_sso_auth');
    const esadm  = state.cookies?.find(c => c.name === 'esadm');

    const hasAuth = (ssoAuth?.value?.length ?? 0) >= 50;
    const hasExtranet = (esadm?.value?.length ?? 0) >= 30;

    if (!hasAuth) {
      console.error('');
      console.error('  ✗ Booking.com auth cookie missing — login not complete.');
      console.error('    Make sure you fully signed in (past 2FA), then press Enter.');
      console.error('');
      continue;
    }

    if (!hasExtranet) {
      console.error('');
      console.error('  ✗ Extranet session cookie (esadm) missing — you may not have');
      console.error('    selected a property yet. Pick your property in the extranet,');
      console.error('    open the reservations list, then press Enter.');
      console.error('');
      continue;
    }

    // Session looks valid — save it, plus capture the URL the user is on so
    // the scraper navigates to the SAME extranet variant (groups/, extranet_ng/,
    // etc. — these are different products and using the wrong one redirects
    // to login regardless of session validity).
    const sessionFile = './sessions/booking-session.json';
    const urlsFile = './sessions/booking-urls.json';
    const propertyFile = './sessions/booking-property.json';

    // Keep hotel_id and lang in the saved URL — only strip the ses token
    // (it's a one-time CSRF/auth nonce that expires; keeping it in the file
    // would make every scrape use a stale nonce and get redirected to login).
    const parsedUrl = new URL(currentUrl);
    parsedUrl.searchParams.delete('ses');
    const reservationsUrl = parsedUrl.toString();

    // Derive a likely calendar URL by swapping the last path segment.
    // Works for both groups/reservations → groups/calendar and
    // extranet_ng/manage/booking-list.html → extranet_ng/manage/calendar.html
    const calendarUrl = reservationsUrl
      .replace(/reservations(\/index\.html)?(\?|$)/, 'calendar$1$2')
      .replace(/booking-list\.html(\?|$)/, 'calendar.html$1');

    // Capture hotel_id so selectPropertyIfNeeded() can target the right property
    // without having to fall back to "click the first table row".
    const hotelId = parsedUrl.searchParams.get('hotel_id') ?? null;

    fs.writeFileSync(sessionFile, JSON.stringify(state, null, 2), 'utf-8');
    fs.writeFileSync(
      urlsFile,
      JSON.stringify({ reservationsUrl, calendarUrl }, null, 2),
      'utf-8'
    );
    if (hotelId) {
      fs.writeFileSync(
        propertyFile,
        JSON.stringify({ hotelId, hotelName: 'Central & Cosy - Easy Access Ground Floor Flat' }, null, 2),
        'utf-8'
      );
    }
    await context.close();

    console.log('');
    console.log('  ✓ Session saved successfully!');
    console.log('    Reservations URL:    ' + reservationsUrl);
    console.log('    Calendar URL (derived): ' + calendarUrl);
    if (hotelId) console.log('    Hotel ID:            ' + hotelId);
    console.log('    bkng_sso_auth:       ' + ssoAuth.value.length + ' chars');
    console.log('    esadm (extranet):    ' + esadm.value.length + ' chars');
    console.log('    Files: ' + sessionFile + ' + ' + urlsFile + ' + ' + profileDir);
    console.log('');
    console.log('  ⓘ If the calendar fails, navigate to YOUR calendar page first,');
    console.log('    then re-run this command — it will save that URL too.');
    console.log('');
    break;
  }

} else {
  // Airbnb: plain cookie file
  // --disable-blink-features=AutomationControlled removes navigator.webdriver so
  // Airbnb's login page doesn't flag the session as automated. Avoid playwright-extra
  // stealth here — its font-fingerprint injector leaves visible artifacts on the page.
  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
      ],
    });
    const ctx = await browser.newContext({
      viewport: null,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();
    await page.goto(loginUrl);

    console.log('');
    console.log('Browser opened. Log in to Airbnb.');
    console.log('');
    console.log('  • Complete login (email / Google / phone + any 2FA).');
    console.log('  • The session saves automatically once the hosting');
    console.log('    dashboard is detected, OR press Enter at any time');
    console.log('    if you are already on the hosting dashboard.');
    console.log('');

    // Single shared readline — avoids dangling listeners when the auto-detect
    // and manual-Enter promises race and the losing leg is abandoned.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let _enterResolve = null;
    rl.on('line', () => {
      if (_enterResolve) {
        const r = _enterResolve;
        _enterResolve = null;
        r();
      }
    });
    const waitForEnterOnce = () => new Promise(resolve => { _enterResolve = resolve; });

    async function trySave() {
      const url = page.url();
      if (!url.includes('airbnb.com/hosting')) return false;
      // Brief pause so all auth cookies have been written by Airbnb.
      await page.waitForTimeout(1_500);
      const cookies = await ctx.cookies();
      fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2), 'utf-8');
      console.log('');
      console.log('  ✓ Session saved! (' + cookies.length + ' cookies → ' + cookieFile + ')');
      console.log('');
      return true;
    }

    // Race: auto-detect hosting redirect vs manual Enter press.
    let saved = false;
    while (!saved) {
      // Wait up to 5 min for Airbnb to redirect to hosting after login.
      const autoDetect = page
        .waitForURL(/airbnb\.com\/hosting/, { timeout: 300_000 })
        .then(() => 'auto')
        .catch(() => 'timeout');
      const manual = waitForEnterOnce().then(() => 'manual');

      const trigger = await Promise.race([autoDetect, manual]);

      if (trigger === 'timeout') {
        console.error('  ✗ Timed out (5 min). Session not saved. Try again.');
        rl.close();
        break;
      }

      saved = await trySave();
      if (!saved) {
        console.error('');
        console.error('  ✗ Not on the hosting dashboard yet.');
        console.error('    Current URL: ' + page.url());
        console.error('    Log in, switch to hosting mode, then press Enter.');
        console.error('');
      }
    }

    if (saved) {
      // ── Step 2: earnings URL + 2FA cookie capture ─────────────────────────
      // Airbnb's transaction history page (/users/transaction_history/{id}/paid)
      // requires a separate 2FA verification. Navigating there during setup and
      // completing the code means the saved cookies carry the unlocked state,
      // so the scraper can access it without prompting for a code each time.
      console.log('  ════════════════════════════════════════════════════════');
      console.log('  Step 2 of 2 — Earnings access (REQUIRED for payment data)');
      console.log('  ════════════════════════════════════════════════════════');
      console.log('');
      console.log('  1. In the browser, click "Earnings" in the left sidebar.');
      console.log('  2. Click the "Paid" tab.');
      console.log('  3. If Airbnb asks for a verification code, enter it now.');
      console.log('  4. Wait until you can see your payout list.');
      console.log('  5. Press Enter here.');
      console.log('');
      console.log('  (Ctrl+C to skip — earnings scraping won\'t work until this is done)');
      console.log('');

      await waitForEnterOnce();

      const earningsUrl = page.url();
      const onEarnings =
        earningsUrl.includes('transaction_history') ||
        earningsUrl.includes('earning')            ||
        earningsUrl.includes('payout')             ||
        earningsUrl.includes('finances');

      if (onEarnings) {
        // Re-save cookies — they now carry the 2FA-unlocked state for the earnings page.
        await page.waitForTimeout(1_000);
        const updatedCookies = await ctx.cookies();
        fs.writeFileSync(cookieFile, JSON.stringify(updatedCookies, null, 2), 'utf-8');
        fs.writeFileSync(
          './sessions/airbnb-earnings-url.json',
          JSON.stringify({ url: earningsUrl }, null, 2),
          'utf-8'
        );
        console.log('');
        console.log('  ✓ Earnings URL saved: ' + earningsUrl);
        console.log('  ✓ Cookies updated with 2FA state (' + updatedCookies.length + ' cookies).');
      } else {
        console.log('');
        console.log('  ⚠  Not on the earnings/paid page (URL: ' + earningsUrl.slice(0, 80) + ').');
        console.log('     Earnings scraping may not work. Re-run to try again.');
      }

      console.log('');
      console.log('  Press Enter to close the browser...');
      await waitForEnterOnce();
      rl.close();
    }

    await browser.close();
  } catch (err) {
    console.error('');
    console.error(`Error saving session for ${platform}:`);
    console.error(err.message ?? err);
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }
}
