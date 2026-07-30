# dashboard/ — the local review page

```
npm run dashboard     # http://localhost:5174
```

Behavior, endpoints, and the card layout: **`docs/DASHBOARD.md`**.

## Files

| File | Does |
|---|---|
| `render.js` | Pure HTML rendering for the listings page. No I/O, no DB — a function of rows, so it's unit-testable without a browser. |
| `server.js` | `node:http` server. Queries SQLite, calls the renderers, handles the POST routes. |

Same split as the resume-tailoring dashboard: shared pure render logic, thin server on top. No React,
no bundler, no build step. One inline `<style>` block, no external requests of any kind — the page
works with the network off (thumbnails hotlink Facebook's CDN and will break; that's cosmetic).

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Listings. Query params: `sort`, `days`, `metro`, `origin`, `min`, `max`, `q`, `rejected`, `page` |
| POST | `/api/status` | `{ fbId, status }` -> `interested` \| `hidden` \| `passed`. `interested` also opens a flip. |
| GET | `/api/health` | Run status per metro as JSON |

CRM routes are plain form posts that redirect back with 303, so refreshing never re-submits.

Filters are plain query params, so a filtered view is a bookmarkable URL and each request is a fresh
SQL query rather than client-side filtering of a giant blob.

Binds `127.0.0.1` only. Nothing is authenticated because nothing should ever be reachable off this
machine. Don't put it behind a tunnel.

## Two things the layout is deliberate about

**The health strip is first on the page.** A broken scraper looks exactly like a slow market if you
only read the listings, so run status has to be impossible to miss. Non-`ok` renders red with the
path to its debug snapshot.

**Price drops are the loudest thing on a card.** A car that dropped from $2,900 to $2,300 is a
motivated seller — the strongest buy signal in the dataset — so it gets a badge and a struck-through
original rather than being buried in the metadata line.

## Copy offer

`navigator.clipboard.writeText`. That is the entire mechanism. **Nothing is sent.** There is no
server route here that talks to Facebook and there won't be one without an explicit ask — see Core
rule 1 in `CLAUDE.md`.

It's the intentional seed of Phase 2: when the offer-review queue gets built, the drafting and the
approval UI already exist and only a per-message send step is added.

## Show rejected

The toggle that makes the filters trustworthy. Rejected listings render dimmed with their reason
chips. Skim it occasionally — a wrongly-rejected car is invisible by definition, so this view is the
only way you'd ever catch the filters being too aggressive.
