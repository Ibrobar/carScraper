# Car Scraper — Daily Use

Finds cheap flippable cars on Facebook Marketplace around Dallas-Fort Worth, twice a day, and puts
them on a dashboard so you're not browsing by hand.

**What it keeps:** $2,500 or less, **within 150 miles of Irving**, with no engine/motor/transmission
trouble mentioned.

> Facebook ignores the radius you ask for and serves whatever your account's Marketplace location
> says — that's why a "Dallas" search returns Houston and Oklahoma. The 150 miles is enforced by the
> scraper itself, not by Facebook. Change it with `DFW_RADIUS_MILES`.

Makes work as a **blocklist** — German cars (BMW, Mercedes, Audi, VW, Porsche, Mini) are cut, and
anything else is kept, *including* cars whose make we couldn't parse. Rejecting unparseable titles
turned out to throw away far more good cars than junk, so now you get to eyeball them.

Everything rejected is still stored, behind a "show rejected" toggle.

Houston is built and one line away (`METROS=dfw,houston` in `.env`) but off by default.

**What it will never do:** message a seller. It drafts the offer text and copies it to your
clipboard — you paste and send it yourself.

---

## One-time setup

```
npm install
npx playwright install chromium
copy .env.example .env
npm run login
```

`npm run login` opens a real Chrome window. Log into Facebook, finish any 2FA, then come back to the
terminal and press Enter. That saves the session to `data/session/storage_state.json`. Your password
is never stored or typed by the script.

You'll need to redo `npm run login` every few weeks when the session expires. You'll know because a
scrape fails with `login_wall`.

---

## The loop

1. **Scrape** — `npm run scrape` (or let the scheduled task do it twice a day)
2. **Review** — `npm run dashboard`, open http://localhost:5174
3. **Offer** — click **Copy offer** on a car you like, paste it into Messenger yourself
4. **Clear** — click **Hide** on cars you're done with, **Interested** on ones you're chasing
5. **Track** — clicking Interested puts the car on the **Flips** board (`/crm`), where you follow it
   through to sold and see what you actually made

### 1. Scrape
```
npm run scrape             # both metros
npm run scrape:dfw         # just DFW
npm run scrape:houston     # just Houston
npm run scrape:test        # small run, DFW, 20 listings
```
Prints a table per metro: Seen / New / Details / Status. Anything other than `ok` in the Status
column means that metro didn't actually work — see Troubleshooting.

For any other flag combination, call the script directly:
```
node tools/scrape.js --metro dfw --limit 5 --no-detail
```
> PowerShell eats npm's `--` separator, so `npm run scrape -- --metro dfw` silently runs *both*
> metros. Use the named scripts above or call `node` directly.

### 2. Dashboard
```
npm run dashboard
```
http://localhost:5174. **Ten cars at a time**, grouped by day, newest first.

It works as a queue: **Hide** the ones you don't want and the page refills with the next car, so you
clear ten, refresh, get ten more. **Next** pages forward if you'd rather browse. Change the ten with
`DASHBOARD_PAGE_SIZE` in `.env`.

**Only the last 2 days show by default**, so cars you never got to age off instead of piling up.
Nothing is deleted — the day-range dropdown (or `?days=30`) brings them back whenever you want.
Anything you marked **Interested** stays forever, however old. Change the window with
`DASHBOARD_MAX_AGE_DAYS`.

**Spanish listings** (about a third of them) are labelled, and the filters understand Spanish — "no
arranca", "motor malo" and "para partes" get cut the same as their English equivalents. Set
`ANTHROPIC_API_KEY` to also see them translated on the card, with the seller's original one click
away; without a key you still get the label and the filtering, just not the translation.

**Sort dropdown** at the top left:

| Option | What it means |
|---|---|
| **Most recent** *(default)* | When the seller posted it on Facebook |
| Cheapest first | |
| Biggest price drop | Motivated sellers |

Only some listings show a readable "Listed X ago" on Facebook. Those without one sort to the bottom
under "Posted date unknown", and the page tells you how many — rather than letting them pretend to
be fresh.

Filter bar across the top for metro, origin, price, and a search box — filters stick as you page.
Toggle **Show rejected** to see what got cut and why; that's how you catch the filter being too
aggressive.

Each card shows the photo, year/make/model, price (struck through if it dropped), mileage, location,
how long ago it posted, and badges for anything flagged (salvage title, price drop, weak defect signal).

### 3. Copy offer
The **Copy offer** button computes 15% below asking, rounds it down to the nearest $25, and copies a
ready-to-send message to your clipboard. Paste it into Messenger. Nothing is sent automatically.

Change the 15% in `.env` with `OFFER_DISCOUNT_PCT`.

### 4. Scheduling (optional)
```
powershell -ExecutionPolicy Bypass -File tools/register_task.ps1
```
Registers a Windows task that scrapes at 7am and 6pm. Remove it with
`schtasks /Delete /TN CarScraper /F`.

---

## Tracking a flip

**http://localhost:5174/crm** — the "Flips →" link at the top of the listings page.

Clicking **Interested** on a car puts it on the board **and takes it off the listings page** — one
car, one place. From there you move it along:

```
Interested -> Offer sent -> They replied -> Bought -> Repairing -> Ready to sell -> Sold
```

Order isn't enforced — jump straight to Bought if you bought it on the spot, or mark anything Dead
if it falls through.

- **Bought** asks what you paid. **Sold** asks what it went for. Neither will save without the
  number, because a profit figure built on a missing price is worse than no figure.
- **Parts** get their own list per car. Add what it needs with an estimate, then mark each one
  bought with what you actually paid. Only bought parts count against profit — a shopping list
  shouldn't make a car look like it's losing money.
- **Ready to sell** gets its own column — those are the ones needing action today.
- `npm run replies` checks your Marketplace inbox and moves cars to **They replied** when a seller
  writes back. It only reads, never sends, and never touches your personal inbox. See
  `docs/REPLIES.md` — this one isn't proven against real conversations yet.
- **Remove** deletes a car from the board and puts it back on your listings page. Use it for a
  misclick; for a deal that died, set the status to **Dead** instead so you keep the history.
- Top of the page: total invested, **how much is tied up in unsold cars** (the number that decides
  whether you can afford the next one), sales, and realized profit.

Nothing on this page messages or posts anything to Facebook — it just links out.

## Sharing it — https://fitra.us

You and 2 other people log in with your email and see the **same** dashboard, from anywhere,
including a phone. No per-person views.

Your computer keeps running everything. `cloudflared` makes an outgoing connection to Cloudflare, so
nothing is opened on your router and the dashboard is never directly on the internet. Cloudflare
holds a login page in front of it.

The scraper deliberately does not move to a rented server: Facebook is far more suspicious of logins
from data centres, and that's the likeliest way to lose the account.

Three lines in `.env` once it's set up:

```
REQUIRE_AUTH=1
ACCESS_AUD=...
ACCESS_TEAM_DOMAIN=...
```

Leave `REQUIRE_AUTH` off while you're only using localhost. With it off the dashboard trusts anyone
who reaches it — fine on your own machine, wrong the moment it's reachable. With it on but the other
two blank, the server refuses to start rather than serve unprotected.

**Step-by-step setup: `docs/DEPLOY.md`.** About 30 minutes. Note that the old fitra.us website and
its email stop working.

Your PC has to be on for anyone to browse. The scrape schedule is unaffected.

## After you change a filter

```
npm run reprocess
```
Re-runs all the filters over listings already in the database — no Facebook traffic, instant, free.
Do this instead of re-scraping whenever you tweak the make list, the defect keywords, or the price
caps. It tells you how many listings changed verdict.

---

## Troubleshooting

| Status / symptom            | What it means                          | Fix                                        |
|-----------------------------|----------------------------------------|--------------------------------------------|
| `login_wall`                | Session expired                        | `npm run login`                            |
| `no_listings`               | Parsed zero — Facebook changed the page| See `data/debug/`, then `docs/SCRAPER.md`   |
| `blocked`                   | Facebook is rate-limiting the account  | Stop for 24h. Don't retry in a loop.        |
| Good cars showing as rejected| Filter too aggressive                  | Check the reason chip, edit `lib/defects.js`, `npm run reprocess` |
| Junk getting through        | Filter too loose                       | Same, opposite direction                   |
| Dashboard empty             | No scrape has run yet                  | `npm run scrape`                           |
| "N awaiting check" is large | Descriptions not read yet — those cars are hidden until they are | `npm run scrape` again; raise `MAX_DETAIL_FETCHES` if it never clears |

Failed runs drop the raw HTML and a screenshot into `data/debug/` so the page can be inspected
after the fact.

---

## Quick reference
| I want to…                        | Do this                                        |
|-----------------------------------|------------------------------------------------|
| Find today's cars                 | `npm run scrape`                               |
| Look at what it found             | `npm run dashboard` -> http://localhost:5174   |
| Test a filter change              | `npm run reprocess` (preview: `npm run reprocess:dry`) |
| Re-authenticate to Facebook       | `npm run login`                                |
| See why a car was rejected        | Toggle **Show rejected** on the dashboard      |
| Change the offer percentage       | `OFFER_DISCOUNT_PCT` in `.env`                 |
| Also cut Korean cars              | `BLOCKED_ORIGINS=german,korean` in `.env`, then `npm run reprocess` |
| Change how far you'll drive       | `DFW_RADIUS_MILES` in `.env`, then `npm run reprocess` |
| Turn Houston back on              | `METROS=dfw,houston` in `.env`                 |
| See more cars per page            | `DASHBOARD_PAGE_SIZE=25` in `.env`             |
| See older cars again              | Day-range dropdown, or `?days=30` / `?days=0`  |
| Find the freshest listings        | Default sort — **Most recent** (posted date)   |
| Keep a car around indefinitely    | Click **Interested** — it never ages off       |
| Speed up detail fetching          | `DETAIL_CONCURRENCY` in `.env` (default 5)     |
| Track a car I'm buying            | Click **Interested**, then work it on `/crm`   |
| Check if sellers replied          | `npm run replies` (preview: `npm run replies:dry`) |
| See what I actually made          | `/crm` — realized profit, top right            |
| See how much cash is tied up      | `/crm` — "tied up in N unsold"                 |
| Share it with 1-2 people          | `docs/DEPLOY.md` — put it on https://fitra.us  |
| Check the dashboard is locked     | `curl.exe -i http://127.0.0.1:5174/` → 403     |
| Add or remove someone             | Cloudflare Zero Trust → Access → Policies      |
| Run the tests                     | `npm test`                                     |

Port: dashboard **5174**.

> Scraping Marketplace is against Facebook's Terms of Service. The realistic risk is that the
> account gets restricted or banned, and there's no spare to fall back on — which is why the pacing
> is deliberately slow and jittered, and why nothing here sends messages or posts listings.
> **Don't raise the rate limits.** If you ever need less exposure, `PROVIDER=apify` scrapes without
> your login at all.
