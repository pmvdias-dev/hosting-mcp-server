# airbnb-mcp-server

MCP server that lets Claude query your Airbnb and Booking.com hosting data — reservations, earnings, calendar, and messages — via Playwright browser automation.

## Tools exposed

| Tool | Description |
|---|---|
| `get_airbnb_reservations` | Upcoming Airbnb reservations (default: next 30 days) |
| `get_booking_reservations` | Booking.com reservations (default: today → +1 year) |
| `get_airbnb_messages` | Recent Airbnb inbox messages |
| `get_booking_messages` | Recent Booking.com inbox messages |
| `get_airbnb_calendar` | Airbnb availability and blocked dates |
| `get_booking_calendar` | Booking.com availability |
| `get_unified_calendar` | Merged calendar from both platforms, flags conflicts |
| `get_earnings_summary` | Revenue summary from both platforms (default: current year) |

## Requirements

- Node.js 20+
- Playwright browsers installed

```bash
npm install
npx playwright install chromium
```

## Setup — save sessions

Sessions must be saved before the server can scrape. Run once per platform; re-run whenever a session expires.

### Airbnb

```bash
node save-session.js airbnb
```

1. Log in with your Airbnb credentials (email / Google / phone + 2FA).
2. Session auto-saves when the hosting dashboard is detected.
3. **Step 2 (required for earnings):** click **Earnings → Paid** in the sidebar, complete the verification code Airbnb sends, wait for the payout list, then press Enter.
4. Press Enter again to close the browser.

Saves to:
- `sessions/airbnb-session.json` — auth cookies
- `sessions/airbnb-earnings-url.json` — your personal earnings URL (includes user ID)

### Booking.com

```bash
node save-session.js booking
```

1. Log in with your Booking.com partner credentials.
2. Complete any 2FA steps.
3. Navigate to **Reservations → Booking details** and wait for the list to load.
4. Press Enter.

Saves to:
- `sessions/booking-session.json` — auth cookies
- `sessions/booking-profile/` — persistent browser profile
- `sessions/booking-urls.json` — your extranet URLs
- `sessions/booking-property.json` — your hotel ID

## Running the MCP server

```bash
node index.js
```

The server communicates over stdio (MCP protocol). Add it to your Claude Desktop config:

```json
{
  "mcpServers": {
    "hosting": {
      "command": "node",
      "args": ["C:/AIProjects/airbnb-mcp-server/index.js"]
    }
  }
}
```

## Logs

Requests and errors are appended to `mcp-server.log` in the project root. Both scrapers write diagnostic entries to the same file — tail it when debugging:

```bash
# PowerShell
Get-Content mcp-server.log -Wait -Tail 20
```

## Session expiry

Sessions expire periodically. Symptoms:
- Tool returns `"session expired"` error
- Earnings tool returns empty data

Re-run the relevant `save-session.js` command to refresh.

## Project structure

```
index.js               MCP server entry point
save-session.js        Interactive session capture for both platforms
scrapers/
  airbnb.js            Airbnb Playwright scraper
  booking.js           Booking.com Playwright scraper
  stealth-browser.js   Shared stealth launch helpers
sessions/              Saved auth state (git-ignored)
tests/                 Node built-in test suite
dashboard/             React dashboard (Vite)
```

## Tests

```bash
npm test               # both platforms
npm run test:airbnb    # Airbnb only
npm run test:booking   # Booking.com only
```
