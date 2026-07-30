# lib/ — the rules, with no I/O

Pure logic. Nothing here launches a browser, and only `db.js` touches disk. That's the point: the
rules that decide whether a car is worth your time can be tested in milliseconds without Facebook,
without Playwright, and without a database.

If you're changing *what counts as a good car*, it's in this folder. If you're changing *how we get
the data*, it's in `../scrapers/`.

## Files

| File | Does | Read first |
|---|---|---|
| `config.js` | Reads `.env` once, exposes every tunable. Defines `METROS`. **Nothing else in the repo reads `process.env` directly.** | `.env.example` |
| `makes.js` | Make -> origin (american/japanese/korean/german/other/unknown), alias + fuzzy normalization, `parseTitle()`, non-car detection | `docs/FILTERS.md` §2 |
| `defects.js` | Engine/motor/transmission scanning with negation handling, **English and Spanish**. The fiddliest code in the repo. | `docs/FILTERS.md` §4 |
| `lang.js` | Offline language detection (stopword frequency). No network, no API key. | `docs/FILTERS.md` §Spanish |
| `geo.js` | ~590 city coordinates + distance from each metro centre. Facebook's search radius doesn't work, so this enforces it. Keep the table near-complete: a missing town reads as "unknown" and is kept. | `docs/FILTERS.md` §3 |
| `filters.js` | Combines the rules. `evaluateCard()` (cheap, no description) and `evaluateFull()` (everything). | `docs/FILTERS.md` |
| `offers.js` | Offer price math + the drafted message text | `docs/FILTERS.md` §Offer math |
| `crm/` | The CRM as a removable module: schema, storage, pipeline, thread matching. Core code never imports from here. | `lib/crm/README.md` |
| `db.js` | SQLite: schema, upsert, queries, run bookkeeping | `docs/DATA.md` |
| `auth.js` | Verifies Cloudflare Access tokens so a tunnel misconfiguration isn't an open door. Off by default; localhost needs no login. | `docs/DEPLOY.md` |
| `ai.js` | Optional second-pass description review via the Claude API. No-ops without a key. | `docs/FILTERS.md` §Stage 2 |

## Two entry points, matching the two-phase scrape

```js
evaluateCard(card)   // price + make/origin. Runs on search-result data.
                     // Decides whether a detail fetch is worth spending.
evaluateFull(listing) // everything, including defects. Needs a description.
```

The split exists because detail pages are the expensive, conspicuous traffic (see
`docs/SCRAPER.md`). Rejecting a Volkswagen at $4,000 from its search card costs nothing; opening its
page to learn the same thing costs a page load Facebook notices.

## Conventions

- **Money is integer cents, everywhere.** No floats. `2499.9999` sorting under `2500` is a bug
  waiting to happen, and money-as-float always eventually rounds wrong.
- **Reject reason codes are stable strings** (`price_too_high`, `defect_transmission`, …). The
  dashboard renders them and tests assert on them — renaming one is a breaking change across three
  files. Full list in `docs/DATA.md`.
- **`hidden` and `interested` are sticky.** No filter, scrape, or reprocess may move a listing out of
  them. Ibrahim's judgment outranks the rules; `db.js` enforces this in SQL.
- Prefer **false positives over false negatives**. A junk car that slips through costs 30 seconds of
  reading. A good car wrongly rejected costs the deal, and you never find out it happened.

## Changing a rule

Never edit a rule and call it done — the loop is:

1. Add the failing case to `tests/defects.test.js` or `tests/makes.test.js`
2. Change the rule here
3. `npm test`
4. `npm run reprocess` — re-runs filters over every stored listing and reports what changed verdict,
   in both directions

Step 4 is free and instant. It's the reason rejected listings are kept forever.
