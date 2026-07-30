# Filters — what survives, what gets cut, and why

This is the heart of the project. The scraper is replaceable plumbing; these rules are the actual
product. Code: `lib/makes.js`, `lib/defects.js`, `lib/filters.js`, `lib/offers.js`.

Four requirements, in the order they're cheapest to evaluate:

| # | Rule | Where | Needs detail page? |
|---|---|---|---|
| 1 | Price at or under $2,500 | `filters.js` | no |
| 2 | American or Japanese make, never German | `makes.js` | no |
| 3 | DFW or Houston | search URL | no |
| 4 | No engine / motor / transmission trouble | `defects.js` | **yes** |

Rules 1–3 run on search-card data, which is why the scraper can skip most detail fetches. Rule 4
needs the description, so it runs after.

---

## 1. Price

Two separate ceilings, and the split matters:

- `SCRAPE_MAX_PRICE` (default **$3,200**) — what goes into the Facebook search URL.
- `FILTER_MAX_PRICE` (default **$2,500**) — your real cap. Anything above shows as
  `price_too_high`.

We scrape above the cap on purpose. A car listed at $2,900 that drops to $2,400 next week is a
motivated seller and one of the best leads the system produces — but you only catch that drop if the
$2,900 version was already in the database. Scraping at the cap makes those invisible.

`FILTER_MIN_PRICE` (default **$300**) cuts the bottom: sub-$300 "cars" are parts listings, scams, or
someone's typo. Rejected as `price_too_low`.

Prices are stored in **cents, as integers**. Never floats — money and floating point don't mix, and
`2499.9999` sorting under `2500` is a bug waiting to happen.

---

## 2. Make and origin

`lib/makes.js` maps a make string to one of `american | japanese | korean | german | other | unknown`,
then `BLOCKED_ORIGINS` (default `german`) decides.

### This is a blocklist, and that was a correction

It started as an allowlist (`american,japanese`, everything else rejected). On the first real run
that rejected **142 of 219 listings as `origin_unknown`** — and most of them were real cars whose
title we simply failed to parse. A chunk had titles scraped as the literal string `"Just listed"`,
because the card parser was grabbing Facebook's badge text instead of the title.

The lesson generalizes: an allowlist converts every parsing failure into a silently dropped car, and
dropped cars are invisible — you never learn what you missed. A blocklist converts a parsing failure
into a car you glance at and dismiss in one second.

So: **only cut what we positively identified as blocked.** `unknown` stays in. If you want to tighten
later, `BLOCKED_ORIGINS=german,korean,other` and `npm run reprocess`.

The cost is real and accepted — trailers, ATVs, and RVs with unparseable titles now reach the
dashboard. `not_a_car` catches the obvious ones; the rest you dismiss by eye.

**American:** Ford, Chevrolet, GMC, Dodge, Ram, Chrysler, Jeep, Buick, Cadillac, Lincoln, Pontiac,
Saturn, Mercury, Oldsmobile, Plymouth, Hummer, Tesla, Eagle

**Japanese:** Toyota, Honda, Nissan, Mazda, Subaru, Mitsubishi, Lexus, Acura, Infiniti, Scion,
Suzuki, Isuzu, Datsun

**German (always blocked):** BMW, Mercedes-Benz, Audi, Volkswagen, Porsche, Mini, Smart, Opel, Maybach

**Korean** (Hyundai, Kia, Genesis) is recognized as its own origin and **kept** by default — it's the
category most likely to be worth flipping after American and Japanese.

Everything else recognized (Volvo, Land Rover, Fiat, Jaguar, Alfa Romeo) → `other`, also kept.
Unrecognized → `unknown`, **kept**.

### Normalization — the part that actually does the work
Sellers do not type "Chevrolet." They type `chevy`, `chev`, `Chevorlet`, `VW`, `Volkswagon`, `benz`,
`Mercedes Benz`, `mecedes`, `merc`. Matching literal make names would silently drop good cars and,
worse, silently let German cars through as `unknown`.

Three passes, in order:
1. **Normalize the string** — lowercase, strip punctuation and hyphens, collapse whitespace.
2. **Alias table** — an explicit map of known nicknames and common misspellings to canonical makes
   (`chevy`→`chevrolet`, `vw`→`volkswagen`, `benz`/`merc`→`mercedes-benz`, `toyta`→`toyota`, …).
   Explicit beats clever; add to this table when you spot a new one in the wild.
3. **Fuzzy fallback** — Levenshtein against the canonical list, accepting only a close match
   (distance ≤ 2 and ≥ 0.82 similarity) and only for strings ≥ 4 chars. Short strings fuzzy-match
   garbage — "ram" is 1 edit from "raM"/"ran"/"rav" — so they're alias-or-nothing.

The fallback threshold is deliberately tight. A **false `unknown` is cheap** — under the blocklist it
just means the car shows up and you judge it yourself. A **false match is expensive**: a Mercedes
silently classified as a Mercury is exactly the kind of car you don't want to buy. When in doubt,
don't match.

German makes carry the most alias weight for that reason. `benz`, `merc`, `mecedes`, `mercedez`,
`Volkswagon`, `beemer`, `bimmer` all resolve, because a German car that falls through to `unknown`
now gets *kept* rather than rejected. Under the blocklist, a missing German alias is the one
normalization failure that actually costs you.

### Where the make comes from
1. Facebook's structured vehicle fields, when the listing has them (most car listings do).
2. Otherwise, parse the title: the near-universal pattern is `<year> <make> <model...>`, e.g.
   "2008 Chevy Silverado 1500 — runs great". `parseTitle()` pulls a 4-digit year in 1960–(current+1)
   and takes the next token as the make, with a second-token retry for two-word makes ("Land Rover",
   "Alfa Romeo", "Mercedes Benz").

### Non-cars
Vehicle searches are pinned to `topLevelVehicleType=car_truck`, so boats/trailers/RVs/motorcycles
mostly don't appear. Anything that slips through and matches a non-car keyword list (`trailer`,
`camper`, `atv`, `jet ski`, `golf cart`, `motorcycle`, `scooter`, `dirt bike`) is rejected as
`not_a_car`.

---

## 3. Distance — and why Facebook's radius is useless

`dfw` fans out to two city searches, `dallas` and `fortworth`; `houston` is one. Results dedupe by
`fb_id`.

**Facebook ignores the radius in the search URL.** It serves whatever your account's saved
Marketplace location says — for this account, "Irving, Texas · within 250 mi". A DFW search asking
for 60 miles came back with:

| Location | Listings |
|---|---|
| Houston | 148 |
| San Antonio | 146 |
| Austin | 91 |
| **Dallas** | **83** |
| Oklahoma City | 53 |

Plus 297 from Oklahoma, 76 from Arkansas and 40 from Louisiana. Roughly 60% of a "Dallas" search was
hours away.

So distance is enforced **on our side**, in `lib/geo.js`. Each metro has a centre and a radius
(`METROS` in `lib/config.js`): DFW measures from **Irving** at 150 miles, Houston from downtown
Houston at 150. Both are configurable (`DFW_RADIUS_MILES`, `HOUSTON_RADIUS_MILES`). Out-of-range
cars are rejected as `too_far`.

### How, given no coordinates

The search payload carries `reverse_geocode: {city, state}` per listing but **no per-listing
coordinates** — the only lat/long on the page is the search centre (confirmed by
`tools/probe_search.js`). So `lib/geo.js` holds a table of city coordinates for the places that
actually appear in these searches and measures great-circle distance from the metro centre.

**The table has to be nearly complete or the filter silently doesn't run.** The first version had
118 cities and missed 497 towns covering 899 listings — so New Braunfels, Kyle, Sallisaw and Van
Buren all sailed onto the dashboard as "unknown". It now carries ~590 towns across TX, OK, AR, LA
and NM, and one listing in the whole database fails to match. Coordinates are town centres good to a
couple of miles, which is all a 150-mile threshold needs.

**Facebook sometimes omits the state** — "Oklahoma City", "Fort Smith", "Tulsa" arrive bare.
Assuming Texas would put those 200 miles from where they are, so a bare name resolves to the one
state it exists in when that's unambiguous. Names living in several states (Cleveland, Paris,
Converse, Chandler) keep the Texas assumption, which is the better guess on a Texas-centred search.

**An unknown city is kept, not rejected.** A town missing from the table is more likely to be a
nearby suburb than a distant city, and rejecting what we can't identify is exactly how the origin
allowlist once cut 142 of 219 listings. If junk from an unlisted city starts showing up, add it to
`CITY_COORDS` rather than loosening the rule.

### It runs before the detail fetch

The distance check is part of `evaluateCard`, so a Houston car is cut from search-card data alone.
With ~60% of a DFW search out of range, that stops most of the detail budget being spent on cars
four hours away.

---

## 4. Engine, motor, and transmission defects

The hard one, because it's free text written by people who are not trying to be parsed.

### Stage 1 — deterministic phrase scan (always on)

`lib/defects.js` scans title + description. Three classes of signal, evaluated in a specific order:

**Positive overrides** — phrases that mean the drivetrain is *fine*, checked **first**:
`no engine issues`, `no mechanical issues`, `runs great`, `runs and drives`, `motor runs strong`,
`new engine`, `engine replaced`, `rebuilt transmission`, `new transmission`, `transmission
recently replaced`, `recently serviced`, `no leaks`, `drives perfect`…

**Strong negative patterns** — regexes, for families a fixed phrase list can't cover. "needs
transmission", "needs a new transmission", "just needs an engine", "need another motor" are one idea
with a dozen spellings, and enumerating them by hand is how `NEEDS TRANSMISSION` reached the
dashboard on the first real run. These match `needs?` + optional filler + `engine|motor|transmission|
trans|tranny`, plus `<part> work`, and slips/slipping in either word order.

**Strong negatives** — fixed phrases, reject outright:
`needs engine`, `needs a motor`, `blown motor`, `blown engine`, `engine knock`, `rod knock`,
`seized`, `bad transmission`, `transmission slipping`, `slips gears`, `no reverse`, `wont start`,
`doesn't start`, `no start`, `not running`, `non running`, `for parts`, `parts only`,
`mechanic special`, `needs head gasket`, `blown head gasket`, `overheats`

**Weak negatives** — flagged as a badge but not an automatic reject:
`check engine light`, `as is`, `needs work`, `needs tlc`, `smokes`, `leaks oil`, `timing chain`,
`transmission issue` (vague), `engine light on`

### Negation is the whole problem

A naive keyword match rejects every one of these, and they are all cars you want:

| Text | Naive match | Correct verdict |
|---|---|---|
| "runs great, **no engine issues**" | `engine issues` → reject | **pass** |
| "**new transmission** installed last month" | `transmission` → reject | **pass** |
| "motor **recently rebuilt**, drives perfect" | `motor` → reject | **pass** |
| "**no** rod knock, **no** leaks" | `rod knock` → reject | **pass** |
| "sold as is but **runs and drives** great" | `as is` → flag | pass, no flag |

So the scan works like this:

1. Find every negative phrase and record its character offset.
2. For each hit, look at the **~40 characters before it** for a negator (`no`, `not`, `never`,
   `without`, `doesn't`, `does not`, `zero`) or a repair verb (`new`, `rebuilt`, `replaced`,
   `serviced`, `fixed`, `changed`, `installed`). If one is present, the hit is **cancelled**.

   > **`just` used to be in that repair list and it was a bug.** "runs great, just needs
   > transmission" was cancelled as though the transmission had been replaced, and the car reached
   > the dashboard. `just` minimizes a problem, it doesn't fix one. Nothing was lost by removing it:
   > a genuine "just replaced the transmission" still cancels on `replaced`.
3. A cancelled hit doesn't just get ignored — it counts as a mild positive, because someone who
   volunteers "no transmission problems" is usually telling the truth about a car that drives.
4. If any **uncancelled strong negative** survives → reject, with the matching reason code.
5. Uncancelled weak negatives → `defect_flags`, shown as a badge, **not** a rejection.

The 40-character window is a heuristic and it will occasionally be wrong in both directions. It is
tested heavily (`tests/defects.test.js`) precisely because it's the fiddliest logic in the repo. When
you find a phrasing it gets wrong, **add it to the test file first**, then fix the rule.

### Bias: prefer false positives over false negatives
A junk car that slips through costs you 30 seconds of reading a listing. A good car wrongly rejected
costs you the deal, and you never even know it happened. So weak signals flag rather than reject,
and the reject list is kept to phrases that are unambiguous.

### A listing with no description has NOT been checked
Defect detection reads the description, so it can only run after the detail page is fetched. Until
then a listing sits in `pending_detail` and is **deliberately kept off the dashboard** — showing one
would mean showing a car nobody checked for engine or transmission trouble. The dashboard shows the
backlog count instead, so it's visible rather than silent. If that number stays high run after run,
raise `MAX_DETAIL_FETCHES`.

### Spanish

**About a third of DFW listings are in Spanish**, and until the Spanish rules existed every one of
them bypassed defect detection completely — "no prende", "motor malo" and "para partes" were all
sitting on the dashboard marked good.

`normalizeText()` strips accents, so "transmisión" and "transmision" fold together and each phrase is
written once, unaccented. The Spanish sets mirror the English ones: strong negatives ("no arranca",
"motor fundido", "para partes"), a `necesita <part>` pattern, weak flags, positive overrides ("corre
y camina bien", "motor nuevo"), negators (`sin`, `nunca`, `ningún`), and repair verbs (`nuevo`,
`reconstruido`, `reparado`).

Two Spanish phrases are deliberately **not** strong negatives:

- **`no funciona` / `no sirve`** — attach to the AC or the radio at least as often as the drivetrain.
  They flag instead, per the false-positives-are-cheaper bias above.
- **`patina`** (slips) — it's also an English noun, and "great patina" is a selling point on a
  classic. Only the transmission-qualified forms count.

Filtering reads the **original** text, never a translation. If it depended on the optional Claude API
being configured, turning the key off would silently stop catching "necesita transmisión".

### Negation distance: 3 words, within a clause

Two real listings drove the current rule, and both were cars being sold for parts that showed as good:

| Listing text | What went wrong |
|---|---|
| "Detalles en el motor**,** se calentó y ya **no** la moví**,** se va completa o **por partes**" | The comma wasn't a clause break, so `no` reached forward two clauses |
| "…y **no** frena lo vendo así **para partes**" | `no` belongs to *frena*; a 40-character window still spanned it |

So a negator must be **within 3 words** of the phrase it cancels **and** in the same clause, where
clauses break on `. ! ? ; , ·` and on contrast words (`but`, `pero`, `however`, `aunque`). Measuring
in words rather than characters is what separates "no engine issues" (one word) from "no frena lo
vendo así para partes" (four).

### Stage 2 — AI description review (optional, off by default)

Keyword rules will always miss creative phrasing ("she'll go in reverse if you're patient"). When
`ANTHROPIC_API_KEY` is set, listings that pass Stage 1 but have a description long enough to be
ambiguous get a second look from the Claude API (`lib/ai.js`), returning structured JSON:

```json
{ "drivetrain_condition": "good|questionable|bad", "evidence": "...", "confidence": 0.0-1.0 }
```

Only `bad` with confidence ≥ 0.7 rejects (as `ai_flagged`); `questionable` becomes a badge. The
verdict and the quoted evidence are stored on the listing so you can see *why* — an AI rejection you
can't audit is worse than no AI at all.

Model defaults to `claude-opus-5`. At ~50–150 listings a day this is cents. If you want it cheaper,
`AI_MODEL=claude-haiku-4-5` in `.env` — it's a short classification task and Haiku handles it well.
That's a cost decision, so it's yours to make, not a default.

The stage is skipped entirely with no key set. Everything else works the same.

### Translation (optional, same key)

Spanish descriptions are translated to English for **display only** and stored in
`listings.description_en`; the dashboard shows the translation with the seller's original one click
away. Language is detected offline by `lib/lang.js` (stopword frequency — no network, no key), so
Spanish listings are labelled even with the API off; only the translation itself needs the key.

Filtering never reads `description_en`. See the Spanish section above for why.

---

## Offer math

`lib/offers.js`. Offer = asking price − `OFFER_DISCOUNT_PCT` (default 15%), then **rounded down** to
the nearest `OFFER_ROUND_TO` (default $25).

Rounding down, not to nearest: $2,000 × 0.85 = $1,700 exactly, but $1,895 × 0.85 = $1,610.75, and
offering "$1,610.75" reads like a robot. $1,600 reads like a person who thought about it.

The drafted message is a plain template with the year/make/model and the number filled in. It's
deliberately short and boring — long, friendly, over-explained messages read as scripted, which is
what you're trying not to look like.

**The message is copied to your clipboard. Nothing sends it.** See Core rule 1 in `CLAUDE.md`.

---

## Tuning workflow

Every filter change follows the same loop, and it never touches Facebook:

1. Add a failing case to `tests/defects.test.js` or `tests/makes.test.js`.
2. Change the rule in `lib/`.
3. `npm test` — confirm the case passes and nothing else broke.
4. `npm run reprocess` — re-runs filters over every stored listing and reports how many changed
   verdict, in both directions.
5. Check the dashboard's rejected view to eyeball the new cuts.

Step 4 is the point of storing rejected listings. You get to test a filter change against months of
real listings in about a second, instead of guessing and waiting for tomorrow's scrape.
