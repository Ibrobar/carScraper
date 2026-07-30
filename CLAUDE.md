# Car Scraper — Project Router

This project scrapes Facebook Marketplace vehicle listings twice a day around Dallas-Fort Worth,
filters them down to cars worth flipping (under $2,500, not German, no engine or transmission
trouble), and shows what's left on a local dashboard grouped by day. It exists so Ibrahim stops
hand-browsing Marketplace every morning. Stack: Node 22 (no build step), Playwright for the scraper,
builtin `node:sqlite` for storage, builtin `node:test` for tests, and a zero-dep `node:http`
dashboard. The only real dependency is Playwright.

Houston is implemented and defined in `lib/config.js` but **off by default** — `METROS=dfw,houston`
in `.env` re-enables it. Don't turn it on unprompted.

**This is the `main` branch — the live product: scrape + filter + dashboard.** The flip CRM is
built and tested but lives on `feature/crm`; it is a removable module, and nothing here imports it.
Don't rebuild it here. See "Branches" and "Roadmap" at the bottom before adding anything.

## How to talk to me — TERSE
Few words. Caveman speak. Say the result, not the journey. No preamble, no recap of steps, no
explaining what a script did. A summary table or a one-line result is enough. I will ASK if I want
more detail -- do not pre-explain. Flag only what needs my attention (a failed run, a filter that
ate a good car, a selector that broke). Example good: "Done. 41 new, 12 passed, 3 price drops.
Houston run failed -- login wall, snapshot in data/debug/." Bad: paragraphs.

## Core rules — never violate
1. **Never send a message, offer, or reply on my behalf.** Not to a seller, not anywhere. The
   dashboard drafts offer text and copies it to my clipboard; *I* paste and send it. There is no
   code path in this repo that writes to Facebook, and none may be added without me asking for it
   in those words. This is the single most important rule here.
   *Reading* is allowed and is how reply detection works (on `feature/crm`) — but only Marketplace
   folders. **Never read the personal Messenger inbox**; no seller thread is in it, and scanning
   years of family conversations for car sellers is both useless and invasive.
2. **Never commit `data/`.** It holds the Facebook session cookies. `.gitignore` covers it — do not
   add exceptions, do not print cookie values into logs or into chat.
3. **Never store my Facebook password.** Auth is a saved browser session only (`npm run login`).
4. **A run that parses zero listings is a FAILURE, not a quiet day.** Mark the run `failed`, save
   the HTML + screenshot to `data/debug/`, and tell me. Silently reporting "0 new cars" is the worst
   thing this project can do.
5. **Never delete or overwrite listing rows.** Rejected listings stay in the DB with their
   `reject_reasons` — that's how I tune the filters and how price-drop history works. Scrapes upsert.
   Related: the search phase must never write `pending_detail` over a listing that already has
   `detail_fetched_at` — that strands it (invisible on the dashboard, never re-queued).
6. **Filter by blocklist, not allowlist.** Only cut what we positively identified as bad. An
   allowlist turns every make-parsing failure into a silently dropped car — it cut 142 of the first
   219 listings, mostly real cars. A car I dismiss by eye costs a second; one I never see costs the
   deal.
7. **Never show a listing whose description was never read.** No description means defect detection
   never ran on it, so it could say NEEDS TRANSMISSION and we'd have no idea. Those stay in
   `pending_detail` and off the dashboard; show the backlog count instead.
8. **Respect the pacing config.** Do not raise the rate limits in `lib/config.js` to make a run
   faster. Getting the account banned costs the whole system. (`MAX_DETAIL_FETCHES` is a budget, not
   a rate — raising it is fine and sometimes necessary; the delays are what must stay.)
9. **There is one Facebook account, and it's the real one.** Scraping Marketplace breaks Facebook's
   ToS and the risk is account-level — a restriction costs the scraper, the CRM's usefulness, and the
   account itself. There is no spare: Facebook won't allow a second one, so don't suggest making one.
   What that changes: keep the pacing in `lib/config.js` as-is, don't add new automated surfaces
   without being asked, and if exposure ever needs to drop, the answer is `PROVIDER=apify`
   (`docs/SCRAPER.md` → Providers), which scrapes without our login at all.

## Folder map
- `CLAUDE.md`            — this file. The router.
- `README.md`            — how I actually run it day to day.
- `.env.example`         — every tunable knob, with defaults and what each one does.
- `docs/SCRAPER.md`      — Playwright mechanics: auth, search URL params, two-phase scrape, stealth,
                           pacing, and what to do when Facebook changes their HTML.
- `docs/FILTERS.md`      — the make taxonomy, the engine/transmission defect rules (incl. negation),
                           price/metro rules, and the offer math. The heart of the project.
- `docs/DATA.md`         — SQLite schema, listing status flow, upsert + price-history semantics.
- `docs/DASHBOARD.md`    — what the dashboard shows, its endpoints, and the offer-copy button.
- `docs/OPERATIONS.md`   — scheduling, troubleshooting a broken run, account-risk practices.
- `docs/DEPLOY.md`       — going live: Cloudflare Tunnel + Access, who can log in, how to verify
                           it's actually locked. The scraper stays on the home IP by design.
- `lib/`                 — pure, zero-dep logic. No I/O, no Playwright. This is what the tests cover.
                           config.js, db.js, makes.js, defects.js, filters.js, offers.js, ai.js,
                           lang.js, geo.js
- `scrapers/`            — anything that touches Facebook. base.js (the provider contract),
                           facebook.js (Playwright), apify.js (paid fallback, stubbed).
- `tools/`               — the CLI pipeline: login.js, scrape.js, reprocess.js
- `dashboard/`           — render.js (listings HTML) + server.js (localhost:5174)
- `tests/`               — node:test specs + `fixtures/` (saved real Marketplace HTML)
- `data/`                — GITIGNORED. carscraper.db, session/storage_state.json, debug/

## Routing table — for the current task, read these and SKIP the rest
| Working on…                          | Read                                        | Skip                          | Tools     |
|--------------------------------------|---------------------------------------------|-------------------------------|-----------|
| Scaffolding / orienting              | this file                                   | all of docs/                  | —         |
| A car got through / was wrongly cut   | docs/FILTERS.md, lib/defects.js, lib/makes.js | docs/SCRAPER.md, docs/DATA.md | node      |
| Scrape returns 0 / selectors broke   | docs/SCRAPER.md, scrapers/facebook.js       | docs/FILTERS.md, dashboard/   | playwright|
| Adding a scraped field               | docs/SCRAPER.md, docs/DATA.md               | docs/FILTERS.md               | node      |
| Schema / migration / query work      | docs/DATA.md, lib/db.js                     | docs/SCRAPER.md, docs/FILTERS.md | node   |
| Dashboard look or behavior           | docs/DASHBOARD.md, dashboard/render.js      | docs/SCRAPER.md, docs/FILTERS.md | node    |
| Flip CRM / replies / parts / profit  | NOT ON THIS BRANCH — switch to `feature/crm` | everything else            | git       |
| Offer price or message wording       | docs/FILTERS.md (Offer math), lib/offers.js | docs/SCRAPER.md, docs/DATA.md | node      |
| Scheduling / a run failed overnight  | docs/OPERATIONS.md                          | docs/FILTERS.md               | schtasks  |
| Going live / auth / tunnel / access  | docs/DEPLOY.md, lib/auth.js                 | docs/FILTERS.md, docs/SCRAPER.md | cloudflared |
| Swapping in the paid scraper         | docs/SCRAPER.md (Providers), scrapers/base.js | docs/FILTERS.md             | node      |
| Phase 2 (offer queue) / Phase 3 (CRM)| docs/DATA.md, this file's Roadmap           | docs/SCRAPER.md               | node      |

Rule: do not open a context file that isn't in the row for the current task.
If a task spans two rows, load both rows' "Read" set and nothing else.

## Naming conventions — so files are findable without grep
- **Listing identity** is `fb_id`, the numeric id from the Marketplace URL
  (`facebook.com/marketplace/item/<fb_id>/`). It is the dedup key everywhere. Never key on title,
  never key on seller — Facebook relists the same car under new ids, and that's a signal we want to
  keep, not collapse.
- **Metro keys** are lowercase short names: `dfw`, `houston`. Defined once in `lib/config.js` as
  `METROS`; a metro may fan out to several city searches (dfw = dallas + fortworth), deduped by `fb_id`.
- **Origins** are lowercase: `american | japanese | korean | german | other | unknown`.
- **Debug snapshots**: `data/debug/<ISO-timestamp>_<metro>_<stage>.{html,png}` e.g.
  `2026-07-27T13-04-11_houston_search.html`. Written only on failure.
- **Fixtures**: `tests/fixtures/<what>_<yyyymmdd>.html` e.g. `search_dfw_20260727.html`. Dated so we
  can tell how stale a fixture is when a parser test starts failing.

## Workflow — when I say "scrape" / "run it" / "go"
1. `npm run scrape` — for each metro: page the search results, apply the cheap filters (price, make)
   to the card data, then fetch detail pages ONLY for listings that are new and already passed. Upsert
   everything, record price history, write a `scrape_runs` row per metro.
2. Relay a summary table: Metro | Seen | New | Passed | Price drops | Status. Flag any metro whose
   status isn't `ok`.
3. If a run failed, say why in one line and point at the snapshot in `data/debug/`. Don't retry a
   login wall automatically — that makes it worse. Tell me to re-run `npm run login`.

`npm run reprocess` re-runs the filters over stored listings without touching Facebook. Use it after
ANY change to `lib/makes.js`, `lib/defects.js`, or `lib/filters.js` — it's free, and it's how we
check a filter change against real historical data instead of guessing.

## Start-of-task ritual
On any new task: state which routing-table row applies, list the exact files you'll read, then proceed.
On "scrape"/"go": confirm the session file exists first (`data/session/storage_state.json`); if it's
missing or stale, STOP and tell me to run `npm run login` — do not try to log in programmatically.
If unsure which row applies, ask — don't read everything.

## Branches
- **`main`** (here) — the live product: scraper, filters, dashboard. This is what gets deployed.
- **`feature/crm`** — main plus the flip CRM module (`lib/crm/`, `dashboard/crm/`, reply detection,
  `docs/CRM.md`, `docs/REPLIES.md`). It carries a revert of main's removal commit, so it sits
  *ahead* of main rather than behind it.

Working rules:
- Scraper, filter, dashboard, and deployment work happens on `main`, and `feature/crm` merges main
  in to stay current. That direction is safe.
- CRM work happens on `feature/crm`. Never re-add CRM files to `main` by hand — merge the branch.
- Going live with the CRM = merge `feature/crm` into `main`. The revert commit brings it all back.

## Roadmap — do not build ahead
- **Phase 1 (done, on `main`):** scrape, filter, dashboard, offer text copied to clipboard.
- **Phase 2 (done, on `feature/crm`):** flip CRM — pipeline, parts, purchase/sale prices, profit,
  and reply detection.
- **Not built, and deliberately:** auto-messaging sellers and auto-posting to Marketplace. Both were
  asked about and dropped. Both are Facebook *write* actions and stay out under Core rule 1.
- **Going live (built):** Cloudflare Tunnel + Access, verified server-side in `lib/auth.js`. The
  scraper deliberately stays on the home IP — a datacenter login is the likeliest way to get the
  Facebook account checkpointed. See `docs/DEPLOY.md`.
- **Next up, when asked:** per-user ownership of flips (the `owner` column already exists on both
  CRM tables, and Access hands us the logged-in email — nothing reads it yet).
Ask before starting one. Don't add its schema "while you're in there."
