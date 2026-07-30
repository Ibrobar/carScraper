# Operations — scheduling, failures, and keeping the account alive

## Scheduling

Two runs a day: morning and evening. Cheap cars move within hours, so a single daily run misses
things; more than two doesn't find meaningfully more and does add risk.

```
powershell -ExecutionPolicy Bypass -File tools/register_task.ps1
```

Registers a Windows Scheduled Task named `CarScraper` at 07:00 and 18:00. It runs whether or not
you're logged in only if the machine is awake — this is a desktop, not a server, so **a scrape
doesn't happen while the machine is asleep**. Missed runs aren't backfilled; the next run picks up
whatever is still listed. That's fine in practice: listings live for days.

```
schtasks /Query /TN CarScraper          # check it
schtasks /Run   /TN CarScraper          # run now
schtasks /Delete /TN CarScraper /F      # remove it
```

Logs go to `data/logs/scrape-<date>.log`.

When this eventually moves to a VPS, the runs become a cron entry and the sleep problem goes away.
Nothing else changes — that's why the project has no Windows-specific code outside this one script.

## Reading a run

Every run writes one `scrape_runs` row per metro. The dashboard's health strip is the fast view;
`GET /api/health` is the same data as JSON.

| Status | Meaning | Action |
|---|---|---|
| `ok` | Worked | none |
| `no_listings` | Parsed zero. **Not a quiet market** — a real search is never empty. | Selectors broke → `docs/SCRAPER.md` |
| `login_wall` | Session expired | `npm run login` |
| `blocked` | Facebook is rate-limiting or checkpointing the account | **Stop. See below.** |
| `error` | Exception | Read `error` + the snapshot |

Failures drop `data/debug/<ts>_<metro>_<stage>.html` and `.png`.

## If you get `blocked`

Stop scraping for at least 24 hours. Do not retry, do not lower the delays, do not "just try one
more time" — retrying through a block is the single most reliable way to turn a temporary restriction
into a permanent ban.

Then:
1. Open Facebook normally in your browser as that account. Clear any checkpoint it shows you.
2. `npm run login` to refresh the session.
3. Resume with one small run: `npm run scrape:test`.
4. If it blocks again immediately, the account is burned for this purpose. Switch to
   `scrapers/apify.js` (see `docs/SCRAPER.md` → Providers). That's the only real fallback — there is
   no spare account to move to.

## Account risk — the honest version

Scraping Marketplace violates Facebook's Terms of Service. Nobody is going to sue you over it; the
realistic consequence is the **account** gets restricted or banned.

**There is exactly one account, and it's your real one.** Facebook won't let you create a second, so
a ban isn't "lose the scraper and start over" — it's losing the account you actually use, along with
the scraper, the reply detection, and every conversation with a seller you're mid-deal with. Plan
around that rather than around a spare that doesn't exist.

What that means in practice:

- **The pacing in `.env` is deliberately slow. Leave it alone.** It's the main thing standing between
  you and a restriction.
- Two runs a day, not continuous polling.
- Sessions are human-created, never scripted logins.
- Nothing in this project sends messages or posts listings. That's not squeamishness — bulk automated
  messaging is the behavior Meta most reliably bans for, and it's the automation you can least
  afford here.
- If you ever need to reduce exposure, `PROVIDER=apify` scrapes from someone else's infrastructure
  with no login of yours involved. That's the only real escape hatch.

## Maintenance

**Expect selector breakage every few months.** That's normal and not a sign anything is wrong with
the design. The recovery path is in `docs/SCRAPER.md`; budget an hour, and save a fresh fixture into
`tests/fixtures/` while you're in there so the next break is faster.

**Re-login every few weeks** when the session expires.

**Database growth** is negligible — a few thousand rows a month, text only. There's no cleanup job
and there shouldn't be: old listings are the historical data that makes `npm run reprocess` useful,
and rejected listings are how you audit the filters. Don't add a purge.

**Backups**: `data/carscraper.db` is the only irreplaceable file (the session can be recreated by
logging in again). Copy it somewhere occasionally if the history starts mattering to you.

## Cost

Zero, unless you turn on the AI review stage. That's a few cents a day at 50–150 listings — see
`docs/FILTERS.md` → Stage 2. The paid Apify fallback, if you ever switch to it, is roughly $20–60/mo
at this volume.
