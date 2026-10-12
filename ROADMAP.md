# Roadmap — database caching & cloud access

Honest answers to two architecture questions the dashboard has reached:

## 1. Database caching — yes, big win

### Benefits

- Instant artifact load (0 wait, read from local SQLite).
- Only future/current data gets re-scraped on Reload — past is immutable.
- Fewer Airbnb/Booking requests → much lower fraud-flag risk.
- Resilient to session expiry — the dashboard stays usable with last-good data.
- Historical trends preserved even if a platform API breaks tomorrow.

### Shape

- SQLite file in `sessions/` or `data/` folder (one dep: `better-sqlite3`).
- Tables: `reservations`, `earnings_monthly`, `scrape_log`.
- Boot flow:
  1. Query DB, render instantly.
  2. Kick off background scrape for `today-7d → today+2y`.
  3. UPSERT by `(platform, confirmation_code)`.
  4. Re-render.
- Past data stays untouched. Cancellations of future bookings handled by re-scraping the forward window.

### Effort

~2 days focused work. Schema + UPSERT wrappers + a tiny migration from the current baked historical values.

### Caveat

Cancellations of *past* bookings technically happen (rare — Booking lets guests cancel last-minute). The forward window needs to include ~7 days back for safety. Already matches the current `oneWeekAgo` pattern.

### Recommendation

**Do it.** Low-risk, high-payoff. Would eliminate most of the "waiting for Booking windows to open" friction.

---

## 2. Cloud / mobile access — bigger architecture shift

The current stack is **tightly local**:

- MCP server runs on the laptop (Node + Playwright).
- Sessions, cookies, `.env` live on disk.
- Claude Desktop runs the MCP; mobile Claude doesn't support MCPs.
- The artifact runs *inside* Claude Desktop, bound to the local MCP.

For mobile access, three realistic architectures:

### A. Host the MCP in the cloud (full-cloud)

- Deploy to a VPS / Fly.io / Railway (~$5–15/mo).
- Credentials, cookies, Playwright all run in cloud.
- Any Claude client connects to the same remote MCP.
- **Pros**: single source of truth, mobile just works.
- **Cons**: Airbnb/Booking flag cloud IPs more aggressively (datacenter ASN → higher CAPTCHA/OTP rate). Credentials in cloud = bigger blast radius if breached. Not ideal.

### B. Local scraper → cloud DB → public dashboard (recommended)

- Scraper stays on the laptop (same as today, same residential IP → low fraud risk).
- Each scrape UPSERTs to a cloud DB (Supabase or Neon free tier, 500 MB).
- The artifact becomes a **standalone static web app** on Vercel / Netlify / GitHub Pages that reads from the cloud DB.
- Add simple auth (Supabase Auth magic-link email).
- **Pros**: $0 cost, mobile browser works, laptop can be off (data cached), scraper footprint unchanged.
- **Cons**: laptop must be on when fresh data is needed; dashboard shows "last synced X hours ago".
- **Setup effort**: ~1 week.

### C. Hybrid — laptop pushes snapshots to cloud (minimal viable)

- After each successful scrape, laptop uploads a JSON blob to a public URL (same mechanism as `reservations.ics` → GitHub).
- Simple static HTML dashboard fetches the JSON on any device.
- No DB, no auth (data is public via obscure URL).
- **Pros**: 1 day of work. Same model already used for the cleaner calendar.
- **Cons**: no auth = anyone with URL sees the data. No per-device filters. No history queries.

---

## Suggested path

1. **Now (0 days)**: enjoy the current working state for a week; see if anything else surfaces.
2. **Next (2 days)**: add SQLite caching (section 1). Dashboard becomes instant. Nothing else changes.
3. **After that (1 day)**: option **C** — push a sanitized data snapshot to GitHub alongside the `.ics`. Build a tiny static mobile view of the calendar + Upcoming list. Not a full dashboard, just the operational view wanted on the phone.
4. **If productizing** (~2 weeks): option **B** — Supabase + Vercel + auth, so other hosts can use it with their own accounts.
