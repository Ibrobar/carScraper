# scrapers/ — everything that touches Facebook

The fragile half of the project, deliberately quarantined behind one interface so the rest of the
codebase doesn't know or care where listings came from.

Full mechanics, URL parameters, and the recovery procedure: **`docs/SCRAPER.md`**. Read it before
changing anything here.

## Files

| File | Does |
|---|---|
| `base.js` | The provider contract + the pure parsing helpers (`parsePriceToCents`, `parseMileage`, `parseRelativeTime`, `classifyPageProblem`, `buildSearchUrl`). No Playwright — so it's unit-testable. |
| `facebook.js` | The real scraper. Playwright + saved session. |
| `apify.js` | Paid fallback. **Stub** — input mapping written, fetch calls not. |

## The contract

```js
{
  name: string,
  async searchListings({ metro, citySlug, maxPages }) -> RawCard[],
  async fetchDetail(fbId)                             -> RawDetail | null,
  async close()
}
```

`RawCard` = `{ fbId, url, title, priceCents, locationText, imageUrl, raw }`
`RawDetail` = `{ description, mileage, transmission, titleStatus, sellerName, sellerUrl, year, make, model, postedAt, raw }`

Anything above this layer (`tools/scrape.js`, `lib/`, `dashboard/`) is provider-agnostic. Swapping to
the paid scraper is `PROVIDER=apify` in `.env` and nothing else. That's the insurance policy — not
"our scraper won't break," but "when it breaks, there's a paid option a config flag away."

## Rules for code in this folder

1. **Never select on CSS class names.** Facebook's are build-generated and change without notice.
   Match structurally: `a[href*="/marketplace/item/"]`, and the embedded JSON by key name.
2. **JSON first, DOM second.** Facebook ships listing data as JSON in `<script>` tags. Key names
   change far less often than the class soup, and when they do the failure is loud instead of
   silently returning empty strings.
3. **Zero parsed listings throws `ScrapeProblem('no_listings')`.** A real search for cars under
   $3,200 in Dallas is never empty. Returning `[]` would let a broken scraper masquerade as a slow
   market, which is the worst outcome this project has.
4. **Every failure writes a snapshot** to `data/debug/` (HTML + PNG). Fixing a selector against a
   saved page is 20 minutes; fixing it by re-scraping blind is an afternoon and more suspicious
   traffic.
5. **Never log in programmatically.** Auth is the saved session from `npm run login`, always. On
   `login_wall`, stop and tell Ibrahim — a scripted login turns an expired session into a flagged
   account.
6. **On `blocked`, stop.** Don't back off and retry. Retrying through a block is how a temporary
   restriction becomes a permanent ban.
7. **Don't speed anything up.** The jittered delays in `lib/config.js` are the design.

## Debugging a broken scraper

```powershell
$env:HEADFUL=1; node tools/scrape.js --metro dfw --limit 5
```

Watch the browser, then read the snapshot in `data/debug/`. Usually the embedded JSON still exists
and just moved keys — fix `extractEmbeddedListings()` first, it's the cheap fix. Save the new page
into `tests/fixtures/` with today's date while you're in there; that's what makes the *next* break
a 20-minute job.
