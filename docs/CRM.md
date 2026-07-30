# CRM — tracking a car from lead to sold

The business half of the project. The scraper only exists to feed this: which cars you're chasing,
what you paid, what you put into them, and what you actually made.

`npm run dashboard` → **http://localhost:5174/crm** (or the "Flips →" link at the top of the
listings page).

Code: everything the CRM owns lives under `lib/crm/` (pipeline, storage, schema, thread matching)
and `dashboard/crm/` (rendering, routes). It is a **removable module** — the scraper and listings
dashboard don't import from either directory. The four seams that connect it to the core are listed
in `lib/crm/README.md` and asserted by `tests/crm-module.test.js`.

## Nothing here touches Facebook

No auto-messaging, no auto-posting. Core rule 1 in `CLAUDE.md` still holds: this project has no code
path that writes to Facebook. The CRM links out to the listing and to Messenger; you send and post
by hand.

"Offer sent" and "They replied" are statuses **you set**, not something we detect by reading your
inbox.

## The pipeline

| Status | Means | Money required |
|---|---|---|
| `interested` | In the pipeline, no offer sent | — |
| `contacted` | You sent an offer, waiting on the seller | — |
| `replied` | They wrote back; your move | — |
| `bought` | You own it | **purchase price** |
| `repairing` | Parts going in | — |
| `ready_to_sell` | Repaired, ready to list | — |
| `sold` | Gone | **sale price** (and a purchase price on record) |
| `dead` | Fell through, or you passed | — |

`contacted` and `replied` map to how Ibrahim described it: after you send an offer the ball is with
the seller ("unanswered"); once they write back it's with you ("waiting for response" — *your*
response).

**Order is not enforced.** A car can go straight from `interested` to `bought` if you met the seller
at a gas station, and a deal can die from any stage. What *is* enforced is that money-bearing stages
carry money — see below.

## Two rules the pipeline won't let you break

**You can't mark a car `bought` without a purchase price**, and **you can't mark it `sold` without
both a sale price and a purchase price on record.** `validateTransition()` refuses, and the server
returns 400.

That's deliberate. The entire point of this CRM is knowing whether you made money; a profit figure
computed from a missing purchase price isn't a rough estimate, it's fiction — and it'd be a number
you'd go on to make decisions with.

**Recording a price implies the stage.** The update form carries the status dropdown and the price
fields together, so it's easy to type what you paid and leave the dropdown alone. `inferStatus()`
moves the car to `bought` when a purchase price is present and the status is still a chasing stage —
otherwise you get cars sitting at "Interested" with money against them, which happened for real. It
only ever moves *forward* out of chasing; it won't touch a car already `repairing`, `sold`, or `dead`,
and an explicit move to `dead` always wins.

## Removing a car

The **Remove** button on a card deletes the flip and its parts, and **returns the listing to
`passed`** so it reappears on the listings page.

That last part isn't a nicety. `interested` keeps a car off the listings page, so a flip deleted
without resetting the listing would leave the car invisible in both places.

Remove is for "I clicked Interested by mistake". For a deal that died, set the status to `dead`
instead — that keeps the history and the money you'd already recorded.

## Parts

Each car has its own parts list. A part is `needed` (a shopping-list item) until you mark it
`bought` with what you actually paid.

**Only bought parts count as spend.** Planned parts are shown separately and excluded from the
totals — otherwise every in-progress car would look like it's losing money on parts you haven't
purchased yet.

Marking a part bought with a price overwrites the estimate; marking it bought with the price field
empty keeps the estimate.

## The money

Per car (`flipTotals`):

```
invested = purchase price + parts marked bought
profit   = sale price - invested        (null until sold)
margin   = profit / sale price          (null until sold)
```

Across the board (`portfolioTotals`):

| Number | Means |
|---|---|
| **total invested** | Everything you've put in, sold and unsold |
| **tied up** | Money in cars that haven't sold — what actually limits your next buy |
| **sales** | Gross from sold cars |
| **realized profit** | Profit on sold cars only. Losses show as negative. |

Realized profit deliberately ignores unsold inventory. A car you paid $1,500 for is not a $1,500
loss and it's not a profit either — it's `tied up`, which is its own number.

## The board

Four columns, defined once in `BOARD_COLUMNS` (`lib/crm/flips.js`):

| Column | Statuses |
|---|---|
| Chasing | `interested`, `contacted`, `replied` |
| In progress | `bought`, `repairing` |
| **Ready to sell** | `ready_to_sell` |
| Closed | `sold`, `dead` |

`ready_to_sell` gets its own column because it's the one stage that needs an action from you today.
It's still counted in `ACTIVE_STATUSES` for the money, though — a repaired car you haven't sold is
still your cash tied up. The board layout and the money grouping are deliberately separate constants;
a test asserts every status lands in exactly one column, so a new stage can't silently vanish.

## How a car gets in

Clicking **Interested** on the listings dashboard opens a flip, and **removes the car from the
listings page** — one car, one place. That's the only automatic entry point.

`openFlip()` is **idempotent by `listing_id`**, and this matters: clicking Interested twice must not
open a second file on the same car, and re-marking a car that's already `bought` must never rewind
it to `interested`. There's a unique index on `flips.listing_id` backing that up.

## Schema

`flips` — `listing_id` (unique, FK), `owner`, `status`, `purchase_price_cents`, `purchase_date`,
`sale_price_cents`, `sale_date`, `notes`, `created_at`, `updated_at`.

`flip_parts` — `flip_id` (FK, cascade delete), `owner`, `name`, `status`, `cost_cents`, `vendor`,
`notes`, `bought_at`, `created_at`.

Money is integer cents everywhere, same as listings. Dates are stamped automatically when the
corresponding amount is recorded.

**`owner` exists but isn't enforced yet.** It's on both tables from day one because retrofitting
per-user scoping onto tables full of real data is a migration that goes wrong quietly. When logins
arrive (1–2 trusted people), the queries already have the column to filter on.

## Adding a stage or a field

1. Add the status to `FLIP_STATUSES` in `lib/crm/flips.js`, with a label in `FLIP_STATUS_LABELS`.
2. If it needs money attached, add it to `REQUIRES_AMOUNT` — that's the single place the rule lives.
3. If it belongs in a board column, add it to `CHASING_STATUSES` / `ACTIVE_STATUSES` or the columns
   list in `dashboard/crm/render.js`.
4. New columns go in the `MIGRATIONS` array in `lib/db.js` — append, never edit an applied entry.

## Not built

- **Auto-posting to Marketplace when a car hits `ready_to_sell`.** It's a Facebook write action, so
  it's out under Core rule 1. If it's ever wanted, the safer shape is filling the form in a headed
  browser and letting you press Post — you're at the machine picking photos anyway.
- **Reply detection.** Flipping `contacted` → `replied` automatically means polling Messenger, which
  is a second scraping surface. Set it by hand for now.
- **Per-user auth.** The `owner` column is ready; nothing reads it yet.
