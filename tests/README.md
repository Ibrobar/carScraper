# tests/ — node:test, zero dependencies

```
npm test              # everything
node --test tests/defects.test.js    # one file
```

Node 22's builtin test runner. No jest, no vitest, no config file.

## What's covered

| File | Covers | Why it exists |
|---|---|---|
| `defects.test.js` | Engine/transmission scanning, **negation** | The fiddliest logic in the repo, and its failures are invisible |
| `makes.test.js` | Make -> origin, aliases, fuzzy limits, title parsing | A German car misclassified is the expensive mistake |
| `filters.test.js` | `evaluateCard` / `evaluateFull`, reason codes | The contract the dashboard and reprocess depend on |
| `offers.test.js` | Offer math, rounding, message drafting | Money math, and the round-DOWN rule |
| `parsing.test.js` | `scrapers/base.js` helpers, search URL, failure classification | Pure, so testable without Playwright |
| `db.test.js` | Upsert semantics, sticky statuses, zero-listing rule | Two invariants the project's usefulness rests on |
| `render.test.js` | Dashboard HTML, escaping, grouping, paging | Listing titles are hostile text from strangers |
| `flips.test.js` | CRM pipeline rules and money math | A wrong profit number is worse than no number |
| `crm-db.test.js` | Flip/parts storage, idempotent `openFlip` | Clicking Interested twice must not open two files on one car |
| `lang.test.js` | Spanish/English detection | ~31% of listings are Spanish |
| `matching.test.js` | Thread-to-car matching and its refusals | A wrong match moves the wrong car and fakes a reply |

Nothing here touches the network or launches a browser. `db.test.js` uses a throwaway SQLite file in
the OS temp dir. The whole suite runs in about a second, which is what makes the
add-a-case-then-fix loop practical.

## The rule for filter changes

**Add the failing case here before changing `lib/`.** Not after.

Most of `defects.test.js` is a list of phrasings that a naive keyword match gets wrong — that list is
the actual specification, and it only stays useful if it grows every time reality surprises us. When
you spot a car the filters handled badly:

1. Add it to `defects.test.js` (or `makes.test.js`) as a failing case
2. Fix the rule in `lib/`
3. `npm test`
4. `npm run reprocess` to see what the change did to real stored listings

## `fixtures/` — saved Marketplace HTML

Real search and detail pages, saved so the parsers have a regression test that doesn't require
hitting Facebook.

Naming: `<what>_<yyyymmdd>.html`, e.g. `search_dfw_20260727.html`. **Dated on purpose** — when a
parser test starts failing you need to know immediately whether you're looking at a stale fixture or
a real regression.

The folder starts empty because fixtures have to come from live pages. Grab one the first time you
debug a break:

```powershell
$env:HEADFUL=1; node tools/scrape.js --metro dfw --limit 5
```

then copy the snapshot out of `data/debug/` into here with a proper name. Doing that while you're
already debugging is what turns the *next* break into a 20-minute job.

> Fixtures are full Facebook pages and may contain your account's name or profile photo in the
> chrome. Skim one before committing it.
