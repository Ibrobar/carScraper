# Data — SQLite schema, status flow, upsert semantics

Everything lives in one SQLite file, `data/carscraper.db`, via Node's builtin `node:sqlite`. No ORM,
no migrations framework — `lib/db.js` creates tables with `CREATE TABLE IF NOT EXISTS` on open and
that's the whole story. Schema changes are hand-written `ALTER TABLE` guarded by a check; see
"Changing the schema" at the bottom.

## The central idea: nothing is ever deleted

Every listing we see is stored, **including ones the filters reject**, with the reasons why. This is
deliberate and it buys three things:

1. You can see what got cut and tell whether the filters are eating good cars.
2. `npm run reprocess` can re-run changed filters over real historical data instantly, with no
   Facebook traffic.
3. Price history works. A car listed at $2,900 that drops to $2,300 is a motivated seller — the most
   valuable signal in the whole dataset — and you only get it by keeping the out-of-range listing.

So: scrapes **upsert**, never insert-or-skip and never delete.

## `listings`

The one table that matters.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | internal only |
| `fb_id` | TEXT UNIQUE | the numeric id from the Marketplace URL. **The dedup key.** |
| `url` | TEXT | canonical `https://www.facebook.com/marketplace/item/<fb_id>/` |
| `title` | TEXT | seller's title, raw |
| `price_cents` | INTEGER | current asking price. Cents to avoid float money. |
| `first_price_cents` | INTEGER | price the first time we saw it. Drives the drop badge. |
| `metro` | TEXT | `dfw` \| `houston` |
| `location_text` | TEXT | whatever Facebook shows, e.g. "Arlington, TX" |
| `image_url` | TEXT | thumbnail |
| `first_seen_at` | TEXT | ISO. **This is what the dashboard groups by**, not `posted_at`. |
| `last_seen_at` | TEXT | ISO. Updated every scrape that sees it. |
| `posted_at` | TEXT | ISO, approximate — derived from Facebook's fuzzy "2 days ago". Nullable. |
| `year` | INTEGER | nullable |
| `make_raw` | TEXT | as scraped/parsed, before normalization |
| `make_norm` | TEXT | canonical make, e.g. `chevrolet` |
| `model` | TEXT | nullable |
| `origin` | TEXT | `american\|japanese\|korean\|german\|other\|unknown` |
| `mileage` | INTEGER | nullable |
| `transmission` | TEXT | nullable |
| `title_status` | TEXT | `clean\|salvage\|rebuilt\|unknown` |
| `description` | TEXT | full body text. Only present once the detail page is fetched. |
| `seller_name` | TEXT | nullable |
| `seller_url` | TEXT | nullable |
| `detail_fetched_at` | TEXT | ISO, null until the detail page is fetched. See below. |
| `status` | TEXT | see status flow |
| `reject_reasons` | TEXT | JSON array of reason codes |
| `defect_flags` | TEXT | JSON array, e.g. `["bad_transmission"]` |
| `ai_verdict` | TEXT | `good\|questionable\|bad`, null when the AI stage is off |
| `ai_evidence` | TEXT | the quoted phrase the AI based it on |
| `offer_price_cents` | INTEGER | computed, not scraped |
| `raw_json` | TEXT | the full scraped payload, so reprocess can re-derive fields |

Indexes: `fb_id` (unique), `(status, first_seen_at)`, `metro`, `first_seen_at`.

### Why `first_seen_at` and not `posted_at` for grouping
Facebook only gives a fuzzy relative time ("about 3 days ago"), and it changes as you re-scrape.
`first_seen_at` is exact, monotonic, and answers the question you actually care about — *is this new
to me* — which is not the same as *is this new to Marketplace*. `posted_at` is still stored and shown
on the card as context, it just isn't the grouping key.

### `detail_fetched_at` is the two-phase scrape marker
Search pages give us title, price, location, thumbnail, and the id — enough for the cheap filters.
Detail pages give description, mileage, seller, title status — expensive and the traffic Facebook
actually notices. `detail_fetched_at` being null means "we've only seen the card." The orchestrator
only fetches a detail page when the listing is new **and** already passed the cheap filters. See
`docs/SCRAPER.md`.

Consequence worth knowing: **a listing with `detail_fetched_at IS NULL` has not had defect detection
run on it**, because defect detection needs the description. Those sit in status `pending_detail`.

## Status flow

```
                    cheap filters (price, make/origin)
  scraped ──────────┬──> rejected            (fails price or origin — no detail fetch, saves traffic)
                    │
                    └──> pending_detail ──> detail fetched ──> defect + full filters
                                                                  ├──> passed    (shows on dashboard)
                                                                  └──> rejected  (behind the toggle)

  passed ──(you click)──> interested | hidden
```

- `pending_detail` — card seen, passed cheap filters, detail page not fetched yet. Normal transient
  state; a listing sits here at most until the next run.

  > **The search phase must never move a listing back into this state.** It used to: the cheap pass
  > returns `pending_detail` for anything that clears price and origin, and re-scraping wrote that
  > over an existing verdict. Since the detail queue only selects rows with `detail_fetched_at IS
  > NULL`, a downgraded listing was stranded — invisible on the dashboard and never re-queued.
  > `tools/scrape.js` now leaves status and reject reasons alone for any listing that already has
  > detail.
- `passed` — survived everything. This is the dashboard's default view.
- `rejected` — `reject_reasons` says why. Visible behind **Show rejected**.
- `interested` / `hidden` — set by you in the dashboard. **Both are sticky:** re-scraping never
  moves a listing out of them, so hiding a car makes it stay hidden and marking one interested keeps
  it visible even if a filter change would now reject it.

### Reject reason codes
Stable strings — the dashboard renders them as chips and the tests assert on them.

`price_too_high` · `price_too_low` · `origin_not_allowed` · `too_far` · `defect_engine` ·
`defect_transmission` · `defect_not_running` · `defect_parts_only` · `ai_flagged` · `not_a_car`

`too_far` is ours, not Facebook's — see `docs/FILTERS.md` §3. Facebook ignores the search radius, so
a DFW search returns Houston and Oklahoma listings unless we cut them.

`origin_unknown` is **retired**. Origin filtering is a blocklist now, so an unparseable make is kept
rather than rejected (see `docs/FILTERS.md` §2). Old rows may still carry the code; the dashboard
still renders it, but nothing emits it.

### A listing with no description can never be `passed`
Enforced in both `tools/scrape.js` and `tools/reprocess.js`: if `description` is null, the verdict is
held at `pending_detail` even when nothing else rejects it. `passed` is a claim that the car was
vetted, and with no description defect detection had nothing to scan.

This is gated on `description`, **not** on `detail_fetched_at` — a detail page can be fetched and
still yield no usable description, and that listing is just as unchecked.

### Descriptions shared between listings are discarded
Two cars essentially never share a description word for word. When they do, the scraper picked up
page furniture — a sidebar ad, a "similar listings" block — and attributed it to the car. On the
first real dataset **113 of 291 descriptions (39%) were this**, 85 of them the same flea-market ad,
and defect detection had been running engine and transmission checks against them.

Two defenses: `descriptionSeenElsewhere()` rejects the text at write time, and
`clearSharedDescriptions()` (run by `npm run reprocess`) repairs stored rows by nulling the
description, clearing `detail_fetched_at`, and re-queueing the listing. Sticky statuses survive both.

### `pending_detail` listings are hidden from the dashboard
Not a bug. Defect detection needs the description, so a listing with `detail_fetched_at IS NULL` has
never been checked for engine or transmission trouble. Showing one would put an unvetted car in front
of you. The dashboard shows the *count* instead (`countUnchecked`), so a backlog is visible.

## `price_history`

| Column | Type |
|---|---|
| `id` | INTEGER PK |
| `listing_id` | INTEGER FK -> listings.id |
| `price_cents` | INTEGER |
| `observed_at` | TEXT ISO |

One row on first sight, then one row **only when the price actually changes** — not every scrape.
Otherwise this table grows by every listing times every run forever for no information gain.

The dashboard's price-drop badge compares `price_cents` to `first_price_cents` on the listing itself;
`price_history` is for seeing the shape of the drop over time.

## `scrape_runs`

Without this table a broken scraper is indistinguishable from a slow market. That's the failure mode
this project most needs to avoid.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `started_at` / `finished_at` | TEXT ISO | |
| `provider` | TEXT | `facebook` \| `apify` |
| `metro` | TEXT | one row per metro per run |
| `listings_seen` | INTEGER | cards parsed off search pages |
| `listings_new` | INTEGER | first-time `fb_id`s |
| `details_fetched` | INTEGER | detail pages actually hit. Written by `recordRunDetails()` **after** the run row is closed, because the detail phase runs after the search phase finishes. Before that existed the column reported 0 on every run, which hid the fact that only 54 of 219 listings had ever had a description read. |
| `status` | TEXT | `ok` \| `no_listings` \| `login_wall` \| `blocked` \| `error` |
| `error` | TEXT | message, nullable |
| `debug_path` | TEXT | path under `data/debug/`, set on failure |

**`listings_seen = 0` is always a failure**, never `ok`. A real Marketplace search for cars under
$3,200 in Dallas is never empty. `lib/db.js` enforces this — `finishRun()` downgrades a status of
`ok` with zero listings to `no_listings`.

## Upsert semantics

`upsertListing(row)` in `lib/db.js`:

- **New `fb_id`** → insert; `first_seen_at` = `last_seen_at` = now; `first_price_cents` =
  `price_cents`; one `price_history` row.
- **Existing `fb_id`** → update `last_seen_at`, and price if it changed (adding a `price_history`
  row). `first_seen_at` and `first_price_cents` are **never** overwritten.
- Detail fields (`description`, `mileage`, `seller_*`, `title_status`) are only written when the new
  value is non-null, so a later card-only sighting can't wipe detail we already have.
- `status` is **not** touched if it's `hidden` or `interested` — your decisions outrank the filters.

## Changing the schema

There's no migration tool and it doesn't need one at this size. Add a column by adding an
`ALTER TABLE` line to the `MIGRATIONS` array in `lib/db.js`; each entry is `{ id, sql }` and applied
once, tracked in a `schema_migrations` table. Never edit an existing entry — append a new one, or
existing databases silently skip your change.

Adding a **derived** field (something computable from `raw_json`) means adding the column, then
running `npm run reprocess` to backfill it. That's the whole reason `raw_json` is stored.
