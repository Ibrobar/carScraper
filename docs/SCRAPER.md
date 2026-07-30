# Scraper — auth, URLs, the two-phase fetch, and what to do when it breaks

Code: `scrapers/facebook.js` (the real one), `scrapers/base.js` (the contract), `scrapers/apify.js`
(paid fallback, stubbed). Orchestration lives in `tools/scrape.js`.

**This is the fragile part of the project.** Facebook changes their markup regularly and there is no
version of this that never breaks. The design below is about making breakage *cheap to fix* rather
than pretending it won't happen.

---

## Authentication — session, never password

`npm run login` launches a visible Chromium, navigates to Facebook, and waits. You log in by hand,
including 2FA. Press Enter in the terminal and it writes Playwright's `storageState` to
`data/session/storage_state.json`. Every subsequent scrape loads that file.

Why by hand:
- **No password is stored anywhere.** Nothing to leak.
- Scripted password login is one of the strongest bot signals Facebook has. A human login from your
  real machine and IP is not.
- 2FA and the occasional checkpoint just work, because a human is there.

The session lasts weeks, not forever. When it expires a run fails with `login_wall` — re-run
`npm run login`. **Never try to log in programmatically as a recovery step**; that converts an
expired session into a flagged account.

`data/` is gitignored. The session file is functionally a password. Don't print it, don't copy it
into chat, don't commit it.

---

## Search URLs

Marketplace vehicle search is driven entirely by query parameters, which is what makes this tractable:

```
https://www.facebook.com/marketplace/<city>/vehicles
  ?minPrice=300
  &maxPrice=3200
  &topLevelVehicleType=car_truck
  &sortBy=creation_time_descend
  &radiusKM=97
  &exact=false
```

| Param | Why |
|---|---|
| `topLevelVehicleType=car_truck` | Drops boats, trailers, RVs, motorcycles, powersports at the source |
| `sortBy=creation_time_descend` | Newest first — the entire point |
| `maxPrice` | `SCRAPE_MAX_PRICE`, above your real cap on purpose (see `docs/FILTERS.md`) |
| `radiusKM` | miles × 1.609. Facebook wants km even on US locales. |
| `exact=false` | Include nearby/loose matches |

City slugs: `dallas`, `fortworth`, `houston`. Defined in `lib/config.js` under `METROS` — `dfw` fans
out to two searches, `houston` is one. Results dedupe by `fb_id`.

---

## The two-phase fetch — the most important design decision here

Search result pages are cheap and unremarkable: one page, many listings, the kind of traffic a normal
browsing human generates. **Individual listing detail pages are the expensive, conspicuous traffic** —
hitting 200 of them back to back is what a person never does and a scraper always does.

So:

**Phase 1 — search pages.** Page through results, extract card data: `fb_id`, title, price, location,
thumbnail. Cheap.

**Phase 2 — detail pages, selectively.** Apply the cheap filters (price, make/origin — see
`docs/FILTERS.md`) to the card data first. Fetch a detail page only when the listing is **new** *and*
**already passed** those filters. Everything else is stored from card data alone and never costs a
detail hit.

In practice this cuts detail fetches by roughly 80%: most listings are the wrong make or over the
price cap, and we now know that without ever opening them. It's simultaneously the biggest
anti-detection lever and the biggest speed win.

`MAX_DETAIL_FETCHES` (default 120) hard-caps phase 2 per run regardless. If a run hits the cap it
finishes normally and picks up the rest next run — listings stay in `pending_detail`.

---

## Never guess at a description

`extractDescription()` slices between the "Description"/"Details" heading and the seller block. If
that heading isn't present it returns **null** — deliberately.

It used to fall back to "the longest paragraph on the page", which sounds reasonable and was the
worst bug in the project: it grabbed the sidebar, so 113 of 291 listings stored some other seller's
ad (85 of them the same flea-market listing), and defect detection ran engine and transmission checks
against a Star Trek figurine ad before marking the car good.

The rule that came out of it: **wrong data is worse than no data here.** A null description leaves
the listing hidden and re-queued, which costs a fetch. A wrong description marks a car vetted when
nothing was vetted, which costs you a trip to look at a car with a blown transmission.

## Parsing — JSON first, DOM second

Facebook ships listing data as JSON embedded in `<script>` tags, and *also* renders it into
obfuscated, frequently-changing CSS classes. Parse the JSON.

`extractEmbeddedJson()` scans script contents for objects with marketplace listing shapes
(`marketplace_listing_title`, `listing_price`, a numeric `id`) and pulls fields by key. Key names
change far less often than the class-name soup, and when they do change the failure is loud rather
than silently returning empty strings.

DOM selectors are the fallback, kept narrow and structural (anchor `href` matching
`/marketplace/item/<digits>/`) rather than class-based. Class names in Facebook's build output are
generated and change without notice — never select on them.

---

## Stealth and pacing

- `playwright` Chromium with a realistic viewport, `America/Chicago` timezone and locale (matching
  the metros — a Texas Marketplace search from a UTC browser is a mismatch worth avoiding)
- Randomized delays between every navigation: search pages `SEARCH_DELAY_MIN_MS`–`MAX_MS`
  (4–8s), detail pages `DETAIL_DELAY_MIN_MS`–`MAX_MS` (6–15s)
- Pagination by scrolling with jitter, not by URL offset
- `MAX_SEARCH_PAGES` (6) per city per run

**Do not raise these to make runs faster.** Two slow runs a day is the design. The pacing is the
main thing standing between you and a restriction, and there's no spare account to fall back on — a
ban takes the scraper, reply detection, and your own Facebook with it.

Set `HEADFUL=1` in `.env` to watch the browser work — the only practical way to debug a selector.

---

## Failure detection — a zero-listing run is a failure

The worst possible behavior for this project is reporting "0 new cars today" when the truth is
"scraper broken since Tuesday." A real search for cars under $3,200 in Dallas is never empty.

Every run therefore classifies into a `scrape_runs.status`:

| Status | Trigger | What to do |
|---|---|---|
| `ok` | Listings parsed | — |
| `no_listings` | Zero cards parsed from a search that should have some | Selectors broke. Read the snapshot. |
| `login_wall` | Redirected to login / `login` in URL / password field present | `npm run login` |
| `blocked` | Checkpoint, captcha, or "temporarily blocked" interstitial | **Stop for 24h.** Do not retry in a loop. |
| `error` | Anything thrown | Read `error` and the snapshot |

On any non-`ok` status the scraper writes `data/debug/<ts>_<metro>_<stage>.html` and `.png`. Fixing a
selector against a saved snapshot is a 20-minute job; fixing it by re-scraping blind is an afternoon
and more suspicious traffic.

`blocked` deserves emphasis: the correct response is to stop, not to back off and retry. Retrying
through a block is how a temporary restriction becomes a permanent one.

---

## Providers — swapping in a paid scraper

`scrapers/base.js` defines the contract every provider implements:

```js
{
  name: string,
  async searchListings({ metro, citySlug, maxPages, signal }) -> RawCard[],
  async fetchDetail(fbId) -> RawDetail | null,
  async close()
}
```

`RawCard` = `{ fbId, url, title, priceCents, locationText, imageUrl, raw }`.
`RawDetail` = `{ description, mileage, transmission, titleStatus, sellerName, sellerUrl, year, make, model, postedAt, raw }`.

`scrapers/facebook.js` implements it with Playwright. `scrapers/apify.js` is a stub with the input
mapping already written for Apify's Facebook Marketplace Vehicle Scraper actor — when Facebook breaks
us badly enough that maintaining selectors isn't worth it, fill in the fetch call and set
`PROVIDER=apify`. Nothing above the provider layer changes: same filters, same schema, same dashboard.

That's the actual insurance policy. Not "our scraper won't break" but "when it breaks, there's a
paid option that's a config flag away."

---

## When Facebook changes their HTML

1. Run `$env:HEADFUL=1; node tools/scrape.js --metro dfw --limit 5` and watch.
2. Open the failure snapshot in `data/debug/`.
3. Check whether the embedded JSON still exists and just moved keys (usually) or is gone (rarely).
   Fix `extractEmbeddedJson()` key names first — that's the cheap fix.
4. Save the new page into `tests/fixtures/` with today's date and update the parser test. This is
   what turns the *next* break into a 20-minute job.
5. If the page shape changed fundamentally, that's the signal to evaluate `scrapers/apify.js`.

Fixtures are dated (`search_dfw_20260727.html`) so that when a parser test fails you immediately know
whether you're looking at a stale fixture or a real regression.
