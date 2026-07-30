# Dashboard — what it shows and how it's served

A single local page listing the cars that survived the filters, grouped by the day we first saw them.
`node dashboard/server.js` → http://localhost:5174.

Code: `dashboard/render.js` (pure HTML rendering, zero deps, no I/O — same split as the
resume-tailoring dashboard) and `dashboard/server.js` (a `node:http` server that queries SQLite and
calls the renderer). No React, no build step, no bundler. Rendering is a pure function of rows so it
can be unit-tested without a browser or a server.

## Layout

**Health strip** across the top — last run time per metro, its status, and counts. This is first on
the page on purpose: a broken scraper looks exactly like a slow market from the listings alone, so
the run status has to be impossible to miss. A non-`ok` status renders in red with a link to its
debug snapshot.

It also carries an **"N awaiting check"** tile (amber) when listings are sitting in `pending_detail`.
Those are cars whose description has never been read, so defect detection hasn't run on them — they
are deliberately hidden from the list rather than shown unvetted. The count keeps that backlog
visible instead of silent. If it doesn't clear after a run or two, raise `MAX_DETAIL_FETCHES`.

## Sort

| Option | Orders by | Notes |
|---|---|---|
| **Most recent** (default) | `posted_at DESC`, undated last | When the *seller* posted it |
| **Cheapest first** | `price_cents ASC` | |
| **Biggest price drop** | `first_price_cents - price_cents DESC` | The strongest buy signal in the dataset |

Every order ends with `id DESC` as a unique tiebreaker — without it, rows that tie on the sort key
can swap places between queries, and with paging a car then appears on two pages or none. All of
them fall back to `posted_at DESC` before the tiebreaker, and group by `posted_at`.

**There is deliberately no "newest to me" (`first_seen_at`) sort.** Scrapes run twice a day, so
ordering by when *we* found a car just clusters everything into two buckets and tells you nothing
about which listing is fresh. `first_seen_at` is still the column behind the age window — "is this
new to me" is a different question from "when did the seller post it" — but it isn't a sort.

**`posted_at` is partial data.** It comes from Facebook's fuzzy "Listed 3 hours ago" text, and only
some listings show one we can read — roughly 38% before the extraction was broadened to catch
"Posted about a week ago", "an hour ago", and "Just listed". Undated listings sort *last*, group
under "Posted date unknown", and the dashboard prints a note saying how many are on the page.
Silently mixing them in would let most of the data pretend to be freshly posted.

> The `sort` query parameter is validated against `SORTS` before use. It's interpolated into an
> `ORDER BY`, so it must never reach SQL unchecked.

**Filter bar** — sort, day range, metro, origin, price range, free-text search, and a **Show
rejected** toggle.
Filters are plain query params (`?metro=dfw&max=2000&rejected=1`) so a filtered view is a URL you can
bookmark, and every request is a fresh SQL query rather than client-side filtering of a giant blob.

**Listings, grouped by day** — `Today`, `Yesterday`, then dates. Grouped by `first_seen_at` (see
`docs/DATA.md` for why that, not `posted_at`). Newest group first, and newest listing within a group.

## Old cars age off by themselves

Default view is **the last 2 days** (`DASHBOARD_MAX_AGE_DAYS`). Marketplace turns over fast enough
that a backlog you'll never work through is worse than no backlog, so listings age out of the queue
on their own instead of piling up.

Three things make this safe:

- **Nothing is deleted or restatused.** It's a `WHERE` clause. The day-range selector in the filter
  bar — or `?days=30`, or `?days=0` for all time — brings everything straight back.
- **`interested` is exempt.** A car you're actively chasing stays on the dashboard forever, however
  old. That's the whole point of the button.
- **It's time-based, not run-based.** The window is measured against the clock, so what you see
  doesn't depend on when you last ran a scrape.

> A destructive alternative — sweeping non-`interested` cars to `hidden` on every scrape — was
> considered and rejected. It buys nothing over the filter, it can't be undone by changing your mind,
> and it makes the dashboard's contents depend on scrape timing rather than on the date.

**The window is on `first_seen_at`, not `posted_at`** — when *we* first saw it, not when the seller
posted it. A car listed a month ago that we discovered today is new *to you* and gets its full two
days in the queue. See `docs/DATA.md` for why that's the grouping key everywhere.

## It's a queue, not a catalogue

Ten cars a page (`DASHBOARD_PAGE_SIZE`). **Hide** or **Interested** reloads the page, so the slot
refills with the next car — work down the ten, refresh, get ten more. That's the intended loop; a
wall of 200 cards is not something anyone actually reviews.

Mechanics worth knowing:

- Paging is `?page=N` with `LIMIT`/`OFFSET`, and the pager links carry every active filter, so
  narrowing to `metro=dfw&max=2000` and paging forward doesn't silently widen the results.
- Ordering is `(first_seen_at DESC, price_cents ASC, id DESC)`. The trailing `id` is load-bearing:
  without a unique tiebreaker, two listings sharing a timestamp and price can swap order between
  queries, and a car shows up on two pages or none.
- The server clamps a past-the-end `page` back to the last real one — hiding cars shrinks the result
  set underneath you, so a bookmarked page 5 shouldn't strand you on an empty screen.
- The count in the header and the pager position come from `countListings()`, which shares its WHERE
  clause with `queryListings()` so the total and the rows can't disagree about what's filtered.

## The card

Thumbnail, then:

- **Year Make Model** — the normalized make, with the raw title underneath in small text so you can
  see what the seller actually wrote
- **Price** — with the original struck through and a **↓ dropped $X** badge when
  `price_cents < first_price_cents`. A price drop is the single strongest buy signal in the dataset,
  so it's the loudest thing on the card.
- Location, "posted ~3 days ago", metro
- **Spec line** — mileage, transmission, title status, seller name
- **The seller's description**, so you can judge the car without leaving the page. A preview is
  always visible; anything longer sits behind a native `<details>` toggle (no JavaScript) so ten
  cards stay skimmable. **Open on Facebook** is still there when you want photos or to message.
  A card reading "No description scraped" should not normally appear — such listings are held in
  `pending_detail` (see `docs/DATA.md`).
- **Badges** — weak defect flags (`check engine light`, `as is`), `salvage` / `rebuilt` title, and
  the AI verdict when the AI stage is on. Badges are warnings you should read, not rejections.
- **Offer: $1,600** — computed, 15% under asking, rounded down to $25

Buttons: **Open on Facebook** · **Copy offer** · **Interested** · **Hide**

### Copy offer
Copies the drafted message to your clipboard via `navigator.clipboard.writeText`. That's the entire
mechanism. **Nothing is sent.** There is no server route that talks to Facebook, and per Core rule 1
in `CLAUDE.md` there never will be without an explicit ask.

It's the deliberate seed of Phase 2: when the offer-review queue gets built, the drafting and the
approval UI already exist and only the send step is added — behind an explicit per-message click.

### Interested / Hide
`POST /api/status` with `{ fbId, status }`, setting the listing to `interested` or `hidden`. Both are
**sticky** — a later scrape or a filter change never moves a listing out of them. Hiding a car you've
already called about keeps it hidden; marking one interested keeps it visible even if a filter tweak
would now reject it. Your judgment outranks the rules.

## Show rejected

The toggle that makes the filters trustworthy. Rejected listings render dimmed with their
`reject_reasons` as chips (`price_too_high`, `origin_not_allowed`, `defect_transmission`, …).

This is how you catch a filter eating good cars — the failure mode you'd otherwise never see, because
a wrongly-rejected car is invisible by definition. Skim it occasionally. When you spot a bad cut, the
fix loop is in `docs/FILTERS.md` (add a test case → fix the rule → `npm run reprocess`).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | The dashboard. Query params: `metro`, `origin`, `min`, `max`, `q`, `rejected`, `days` |
| POST | `/api/status` | `{ fbId, status }` → `interested` \| `hidden` \| `passed` |
| GET | `/api/health` | JSON run status per metro, for eyeballing without loading the page |

Localhost only — `server.js` binds `127.0.0.1`. Nothing here is authenticated because nothing here
should ever be reachable off your machine. Don't put it behind a tunnel.

## Styling

One inline `<style>` block in `render.js`. Dark by default, system font stack, CSS grid for cards.
No external requests of any kind — including no remote fonts — so the page works with the network
off. Thumbnails are the one exception: they hotlink Facebook's CDN, and will show broken images if
that's blocked. That's cosmetic and not worth proxying.

## Regenerating

There's no generated file to regenerate — the server renders live from SQLite on every request. Data
changes (a scrape, a `reprocess`) show up on refresh. Stop with Ctrl+C.
