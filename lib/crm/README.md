# lib/crm/ — the flip pipeline, as a removable module

Everything the CRM owns on the data side. The scraper and the listings dashboard
do not import from this directory; if it were deleted, they would still run.

That property is the point. This started as 89 references inside `lib/db.js` and
30 inside `dashboard/server.js`, which meant "ship the scraper without the CRM"
was a rewrite of both files rather than a deletion.

## Files

| File | Does | Read first |
|---|---|---|
| `schema.js` | `flips` + `flip_parts` DDL and migrations 003-007 | `docs/DATA.md` |
| `db.js` | Flip and part queries. Takes an open handle from `openDb()`. | `docs/CRM.md` |
| `flips.js` | Statuses, transition rules, per-car and portfolio money math. Pure. | `docs/CRM.md` |
| `matching.js` | Scores a Messenger thread against a car. Pure. | `docs/REPLIES.md` |

The rendering and HTTP halves live in `dashboard/crm/`.

## The seams — all four of them

The core touches this module in exactly four places. Removing the CRM means
deleting this directory, `dashboard/crm/`, and these:

| Where | What | Without it |
|---|---|---|
| `lib/db.js` | imports `CRM_SCHEMA` + `CRM_MIGRATIONS`, appends both | The flip tables are never created |
| `dashboard/server.js` | imports `./crm/routes.js`, mounts `handleCrmRequest` | `/crm` 404s |
| `dashboard/server.js` | calls `onListingMarkedInterested` from `/api/status` | Interested still hides the car; it just opens no file |
| `dashboard/render.js` | takes `navLinks`, given `NAV_LINK` by the server | The "Flips →" header link is absent |

`tests/crm-module.test.js` asserts each of these, including that the listings
page renders with no CRM link when nothing contributes one.

## Conventions that matter here

- **Money is integer cents.** Same as the rest of `lib/`. A profit figure built
  on a float eventually rounds wrong.
- **Migration ids are frozen at 003-007.** Databases in the wild have already
  recorded them in `schema_migrations`. Renumbering re-runs them. `lib/db.js`
  concatenates core-then-CRM, which reproduces the original single-list order.
- **Deleting a flip returns its listing to `passed`.** Otherwise the car is
  invisible in both places — `interested` keeps it off the listings page, and
  with no flip it isn't on the board either.
- **Nothing here writes to Facebook.** Reply detection *reads* the Marketplace
  inbox and nothing else. Core rule 1 in `CLAUDE.md`.

## Known rough edge

`carName()` in `dashboard/crm/render.js` builds from year + make + model and
only falls back to the raw title if all three are empty. A car whose make didn't
parse still has a year, so it renders as a bare "2004" on the board. Cosmetic,
and it only shows on cars the make parser missed — but that set is deliberately
kept (Core rule 6), so it does happen.
