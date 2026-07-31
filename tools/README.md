# tools/ — the CLI pipeline

Four entry points. Everything you actually run lives here.

| Command | File | Does |
|---|---|---|
| `npm run login` | `login.js` | Opens a browser, you log into Facebook by hand, saves the session |
| `npm run scrape` | `scrape.js` | The two-phase scrape + filter + store |
| `npm run reprocess` | `reprocess.js` | Re-runs filters over stored listings. No network. |
| `npm run requeue` | `requeue_details.js` | Re-queues listings whose detail fetch produced no description |
| `npm run replies` | `check_replies.js` | Reads the Marketplace inbox, flips `contacted` -> `replied`. READ ONLY. |
| `npm run backfill:flips` | `backfill_flips.js` | Rescues Interested cars that never got onto the board |
| — | `register_task.ps1` | Registers the twice-daily Windows scheduled task |

## `login.js`
Launches a visible Chromium, waits for you to log in (2FA and all), then saves Playwright's
`storageState` to `data/session/storage_state.json`. **No password is ever typed by the script or
stored anywhere.** Re-run every few weeks when the session expires — you'll know because a scrape
fails with `login_wall`.

## `scrape.js`
```
npm run scrape            # both metros
npm run scrape:dfw        # one metro
npm run scrape:test       # small run: DFW, 20 listings

# any other flags — call node directly
node tools/scrape.js --metro houston --limit 20 --no-detail
```

> **Don't write `npm run scrape -- --metro dfw`.** PowerShell strips npm's `--` separator, so the
> flags never reach the script and it silently scrapes *both* metros. Named scripts or direct `node`.

Order of operations per metro:
1. Search each city slug, dedupe by `fbId`
2. `evaluateCard()` — price + make/origin, on card data alone
3. Upsert everything (rejected included — that's the point, see `docs/DATA.md`)
4. Fetch detail pages **only** for new listings that passed step 2, up to the budget
5. `evaluateFull()` — defects, then final verdict

Prints a table: Metro | Seen | New | Details | Status. Exits non-zero if any metro didn't come back
`ok`, so the scheduled task's log shows failures clearly.

**Stops the whole run on `blocked`.** That's intentional — see `docs/OPERATIONS.md`.

## `reprocess.js`
```
npm run reprocess       # apply
npm run reprocess:dry   # report only, write nothing
```
Re-runs the filters over every stored listing. Instant, free, no Facebook traffic. Reports what
changed verdict **in both directions** and samples ten of each — a filter change that newly *rejects*
cars you were seeing matters as much as one that surfaces new ones, and it's the direction you'd
never otherwise notice.

Skips `hidden` and `interested` listings: your call outranks the rules.

**Run this after any change to `lib/makes.js`, `lib/defects.js`, or `lib/filters.js`.**

## `register_task.ps1`
```
powershell -ExecutionPolicy Bypass -File tools/register_task.ps1
```
Twice daily, 07:00 and 18:00. Generates `run_scheduled.cmd` (gitignored side effect) and logs to
`data/logs/`. The machine has to be awake — this is a desktop, not a server. Missed runs aren't
backfilled, which is fine because listings live for days.

Remove with `schtasks /Delete /TN CarScraper /F`.

## `backfill_flips.js`
Opens flips for listings marked `interested` that don't have one.

Such a car is invisible in both places: the sticky status keeps it off the listings page, and with
no flip it isn't on the board either. This is not hypothetical — while the CRM lived on its own
branch, `main` set the status but had no `openFlip` to call, so clicking Interested made two cars
silently disappear. `npm run backfill:flips:dry` shows what it would rescue without writing.

Safe to run any time; it only touches listings that have no flip, and `openFlip` is idempotent.

## What is NOT here, and won't be

There is no `message.js`, no `send.js`, no `respond.js`. Nothing in this project contacts a seller.
The dashboard drafts offer text and copies it to the clipboard; Ibrahim sends it himself. See Core
rule 1 in `CLAUDE.md`.

