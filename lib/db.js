// SQLite access. Schema and semantics are documented in docs/DATA.md — read that
// before changing anything here.
//
// Two invariants this file enforces, both of which exist because breaking them
// silently destroys the project's usefulness:
//   1. Listings are never deleted, and `hidden`/`interested` outrank the filters.
//   2. A run that saw zero listings is a FAILURE, never `ok`.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH } from './config.js';

// node:sqlite emits an ExperimentalWarning on import. It's suppressed by
// `--disable-warning=ExperimentalWarning` in the npm scripts (see package.json)
// rather than here, because ESM hoists this import above any code in the module
// body — a runtime filter installed here would always run too late.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  fb_id             TEXT NOT NULL UNIQUE,
  url               TEXT,
  title             TEXT,
  price_cents       INTEGER,
  first_price_cents INTEGER,
  metro             TEXT,
  location_text     TEXT,
  image_url         TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  posted_at         TEXT,
  year              INTEGER,
  make_raw          TEXT,
  make_norm         TEXT,
  model             TEXT,
  origin            TEXT,
  mileage           INTEGER,
  transmission      TEXT,
  title_status      TEXT,
  description       TEXT,
  language          TEXT,
  description_en    TEXT,
  seller_name       TEXT,
  seller_url        TEXT,
  detail_fetched_at TEXT,
  status            TEXT NOT NULL DEFAULT 'pending_detail',
  reject_reasons    TEXT NOT NULL DEFAULT '[]',
  defect_flags      TEXT NOT NULL DEFAULT '[]',
  ai_verdict        TEXT,
  ai_evidence       TEXT,
  ai_confidence     REAL,
  offer_price_cents INTEGER,
  raw_json          TEXT
);

CREATE INDEX IF NOT EXISTS idx_listings_status_seen ON listings(status, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_metro       ON listings(metro);
CREATE INDEX IF NOT EXISTS idx_listings_seen        ON listings(first_seen_at DESC);

CREATE TABLE IF NOT EXISTS price_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id  INTEGER NOT NULL REFERENCES listings(id),
  price_cents INTEGER NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_price_history_listing ON price_history(listing_id);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  provider        TEXT,
  metro           TEXT,
  listings_seen   INTEGER NOT NULL DEFAULT 0,
  listings_new    INTEGER NOT NULL DEFAULT 0,
  details_fetched INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'running',
  error           TEXT,
  debug_path      TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_metro_started ON scrape_runs(metro, started_at DESC);

-- One car you're chasing or have bought. The CRM half of the project.
CREATE TABLE IF NOT EXISTS flips (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id          INTEGER REFERENCES listings(id),
  owner               TEXT NOT NULL DEFAULT 'me',
  status              TEXT NOT NULL DEFAULT 'interested',
  purchase_price_cents INTEGER,
  purchase_date       TEXT,
  sale_price_cents    INTEGER,
  sale_date           TEXT,
  notes               TEXT,
  -- Messenger thread, once matched. Matching is heuristic the first time and
  -- exact forever after, which is what keeps reply detection from being
  -- fragile: we only have to get it right once per car.
  thread_id           TEXT,
  thread_url          TEXT,
  thread_matched_by   TEXT,
  last_reply_at       TEXT,
  replies_checked_at  TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
-- One flip per listing. Clicking Interested twice must not open a second file
-- on the same car.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flips_listing ON flips(listing_id);
CREATE INDEX IF NOT EXISTS idx_flips_status ON flips(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_flips_owner  ON flips(owner);

-- Parts for one car. A part is a shopping-list item until its status is bought.
CREATE TABLE IF NOT EXISTS flip_parts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  flip_id    INTEGER NOT NULL REFERENCES flips(id) ON DELETE CASCADE,
  owner      TEXT NOT NULL DEFAULT 'me',
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'needed',
  cost_cents INTEGER,
  vendor     TEXT,
  notes      TEXT,
  bought_at  TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_parts_flip ON flip_parts(flip_id);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id      TEXT PRIMARY KEY,
  applied TEXT NOT NULL
);
`;

// Append-only. NEVER edit an existing entry — databases that already applied it
// will silently skip your change. Add a new one instead.
const MIGRATIONS = [
  { id: '001-language', sql: 'ALTER TABLE listings ADD COLUMN language TEXT' },
  { id: '002-description-en', sql: 'ALTER TABLE listings ADD COLUMN description_en TEXT' },
  { id: '003-flip-thread-id', sql: 'ALTER TABLE flips ADD COLUMN thread_id TEXT' },
  { id: '004-flip-thread-url', sql: 'ALTER TABLE flips ADD COLUMN thread_url TEXT' },
  { id: '005-flip-thread-matched-by', sql: 'ALTER TABLE flips ADD COLUMN thread_matched_by TEXT' },
  { id: '006-flip-last-reply', sql: 'ALTER TABLE flips ADD COLUMN last_reply_at TEXT' },
  { id: '007-flip-replies-checked', sql: 'ALTER TABLE flips ADD COLUMN replies_checked_at TEXT' },
];

/** Statuses the filters are not allowed to overwrite — your call beats the rules. */
const STICKY_STATUSES = new Set(['hidden', 'interested']);

let cached = null;

export function openDb(path = DB_PATH) {
  if (cached && cached.path === path) return cached.db;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL lets the dashboard read while a scrape writes, so listings appear
  // mid-run instead of only after it finishes.
  db.exec('PRAGMA journal_mode = WAL');
  // Two processes DO write concurrently in normal use: the scrape upserts
  // listings while you click Hide on the dashboard. Without a busy timeout the
  // loser of that race fails instantly with SQLITE_BUSY. Wait instead.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    try {
      db.exec(migration.sql);
    } catch (err) {
      // Columns added here also live in SCHEMA above, so they already exist on
      // a freshly created database. That's the expected case for a new install,
      // not a failure — anything else is real and should surface.
      if (!/duplicate column name/i.test(err.message)) throw err;
    }
    db.prepare('INSERT INTO schema_migrations (id, applied) VALUES (?, ?)')
      .run(migration.id, new Date().toISOString());
  }

  cached = { path, db };
  return db;
}

/**
 * Release the file handle. Windows will not let you delete or move an open
 * SQLite file (WAL mode keeps it locked), so tests and any tooling that cleans
 * up after itself must call this.
 */
export function closeDb() {
  if (!cached) return;
  try {
    cached.db.close();
  } catch {
    // Already closed — nothing to do.
  }
  cached = null;
}

const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? []);

/**
 * Insert or update a listing by fb_id.
 *
 * On update: `first_seen_at` and `first_price_cents` are never overwritten (they
 * anchor day-grouping and the price-drop badge), detail fields are only written
 * when the incoming value is non-null (so a later card-only sighting can't wipe
 * detail we already have), and a sticky status is preserved.
 *
 * @returns {{ id: number, isNew: boolean, priceChanged: boolean }}
 */
export function upsertListing(db, row) {
  const timestamp = now();
  const existing = db
    .prepare('SELECT * FROM listings WHERE fb_id = ?')
    .get(row.fb_id);

  if (!existing) {
    const info = db
      .prepare(
        `INSERT INTO listings (
           fb_id, url, title, price_cents, first_price_cents, metro, location_text,
           image_url, first_seen_at, last_seen_at, posted_at, year, make_raw,
           make_norm, model, origin, mileage, transmission, title_status,
           description, seller_name, seller_url, detail_fetched_at, status,
           reject_reasons, defect_flags, ai_verdict, ai_evidence, ai_confidence,
           offer_price_cents, raw_json, language, description_en
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.fb_id, row.url ?? null, row.title ?? null,
        row.price_cents ?? null, row.price_cents ?? null,
        row.metro ?? null, row.location_text ?? null, row.image_url ?? null,
        timestamp, timestamp, row.posted_at ?? null,
        row.year ?? null, row.make_raw ?? null, row.make_norm ?? null,
        row.model ?? null, row.origin ?? null, row.mileage ?? null,
        row.transmission ?? null, row.title_status ?? null,
        row.description ?? null, row.seller_name ?? null, row.seller_url ?? null,
        row.detail_fetched_at ?? null, row.status ?? 'pending_detail',
        json(row.reject_reasons), json(row.defect_flags),
        row.ai_verdict ?? null, row.ai_evidence ?? null, row.ai_confidence ?? null,
        row.offer_price_cents ?? null,
        row.raw_json ? JSON.stringify(row.raw_json) : null,
        row.language ?? null, row.description_en ?? null,
      );

    const id = Number(info.lastInsertRowid);
    if (Number.isFinite(row.price_cents)) {
      db.prepare(
        'INSERT INTO price_history (listing_id, price_cents, observed_at) VALUES (?,?,?)',
      ).run(id, row.price_cents, timestamp);
    }
    return { id, isNew: true, priceChanged: false };
  }

  const priceChanged =
    Number.isFinite(row.price_cents) && row.price_cents !== existing.price_cents;

  // COALESCE(new, old) so a card-only re-sighting can't null out detail fields.
  const status = STICKY_STATUSES.has(existing.status)
    ? existing.status
    : (row.status ?? existing.status);

  db.prepare(
    `UPDATE listings SET
       url               = COALESCE(?, url),
       title             = COALESCE(?, title),
       price_cents       = COALESCE(?, price_cents),
       metro             = COALESCE(?, metro),
       location_text     = COALESCE(?, location_text),
       image_url         = COALESCE(?, image_url),
       last_seen_at      = ?,
       posted_at         = COALESCE(?, posted_at),
       year              = COALESCE(?, year),
       make_raw          = COALESCE(?, make_raw),
       make_norm         = COALESCE(?, make_norm),
       model             = COALESCE(?, model),
       origin            = COALESCE(?, origin),
       mileage           = COALESCE(?, mileage),
       transmission      = COALESCE(?, transmission),
       title_status      = COALESCE(?, title_status),
       description       = COALESCE(?, description),
       seller_name       = COALESCE(?, seller_name),
       seller_url        = COALESCE(?, seller_url),
       detail_fetched_at = COALESCE(?, detail_fetched_at),
       language          = COALESCE(?, language),
       description_en    = COALESCE(?, description_en),
       status            = ?,
       reject_reasons    = ?,
       defect_flags      = ?,
       ai_verdict        = COALESCE(?, ai_verdict),
       ai_evidence       = COALESCE(?, ai_evidence),
       ai_confidence     = COALESCE(?, ai_confidence),
       offer_price_cents = COALESCE(?, offer_price_cents),
       raw_json          = COALESCE(?, raw_json)
     WHERE id = ?`,
  ).run(
    row.url ?? null, row.title ?? null, row.price_cents ?? null,
    row.metro ?? null, row.location_text ?? null, row.image_url ?? null,
    timestamp, row.posted_at ?? null, row.year ?? null,
    row.make_raw ?? null, row.make_norm ?? null, row.model ?? null,
    row.origin ?? null, row.mileage ?? null, row.transmission ?? null,
    row.title_status ?? null, row.description ?? null,
    row.seller_name ?? null, row.seller_url ?? null,
    row.detail_fetched_at ?? null,
    row.language ?? null, row.description_en ?? null,
    status,
    json(row.reject_reasons ?? JSON.parse(existing.reject_reasons)),
    json(row.defect_flags ?? JSON.parse(existing.defect_flags)),
    row.ai_verdict ?? null, row.ai_evidence ?? null, row.ai_confidence ?? null,
    row.offer_price_cents ?? null,
    row.raw_json ? JSON.stringify(row.raw_json) : null,
    existing.id,
  );

  // One row per actual change, not one per scrape — otherwise this table grows
  // by (listings x runs) forever and tells you nothing new.
  if (priceChanged) {
    db.prepare(
      'INSERT INTO price_history (listing_id, price_cents, observed_at) VALUES (?,?,?)',
    ).run(existing.id, row.price_cents, timestamp);
  }

  return { id: existing.id, isNew: false, priceChanged };
}

export function getListing(db, fbId) {
  return db.prepare('SELECT * FROM listings WHERE fb_id = ?').get(fbId);
}

export function knownFbIds(db) {
  return new Set(db.prepare('SELECT fb_id FROM listings').all().map((r) => r.fb_id));
}

export function setListingStatus(db, fbId, status) {
  return db
    .prepare('UPDATE listings SET status = ? WHERE fb_id = ?')
    .run(status, fbId);
}

export function updateListingVerdict(db, id, { status, reasons, flags, derived, ai }) {
  db.prepare(
    `UPDATE listings SET
       status = CASE WHEN status IN ('hidden','interested') THEN status ELSE ? END,
       reject_reasons = ?, defect_flags = ?,
       year = COALESCE(?, year), make_raw = COALESCE(?, make_raw),
       make_norm = COALESCE(?, make_norm), model = COALESCE(?, model),
       origin = COALESCE(?, origin), offer_price_cents = COALESCE(?, offer_price_cents),
       ai_verdict = COALESCE(?, ai_verdict), ai_evidence = COALESCE(?, ai_evidence),
       ai_confidence = COALESCE(?, ai_confidence)
     WHERE id = ?`,
  ).run(
    status, json(reasons), json(flags),
    derived?.year ?? null, derived?.make_raw ?? null, derived?.make_norm ?? null,
    derived?.model ?? null, derived?.origin ?? null, derived?.offer_price_cents ?? null,
    ai?.verdict ?? null, ai?.evidence ?? null, ai?.confidence ?? null,
    id,
  );
}

export function allListings(db) {
  return db.prepare('SELECT * FROM listings').all();
}

/** Listings whose detail page hasn't been fetched yet, newest first. */
export function pendingDetail(db, metro, limit) {
  return db
    .prepare(
      `SELECT * FROM listings
       WHERE detail_fetched_at IS NULL AND status = 'pending_detail'
         AND (? IS NULL OR metro = ?)
       ORDER BY first_seen_at DESC LIMIT ?`,
    )
    .all(metro ?? null, metro ?? null, limit);
}

export function startRun(db, { provider, metro }) {
  const info = db
    .prepare('INSERT INTO scrape_runs (started_at, provider, metro, status) VALUES (?,?,?,?)')
    .run(now(), provider, metro, 'running');
  return Number(info.lastInsertRowid);
}

/**
 * Close out a run. Enforces the "zero listings is a failure" rule: a real search
 * for cars under $3,200 in Dallas is never empty, so `ok` with nothing seen is
 * downgraded to `no_listings`. Reporting "0 new cars today" when the truth is
 * "broken since Tuesday" is the worst thing this project can do.
 */
export function finishRun(db, runId, { status, listingsSeen, listingsNew, detailsFetched, error, debugPath }) {
  let finalStatus = status ?? 'ok';
  if (finalStatus === 'ok' && !listingsSeen) finalStatus = 'no_listings';

  db.prepare(
    `UPDATE scrape_runs SET finished_at = ?, listings_seen = ?, listings_new = ?,
       details_fetched = ?, status = ?, error = ?, debug_path = ? WHERE id = ?`,
  ).run(
    now(), listingsSeen ?? 0, listingsNew ?? 0, detailsFetched ?? 0,
    finalStatus, error ?? null, debugPath ?? null, runId,
  );
  return finalStatus;
}

/**
 * Record the detail-fetch count after the fact.
 *
 * The search phase closes the run row before the detail phase starts, so
 * without this the column reported 0 on every run — which hid the fact that
 * only 54 of 219 listings had ever had their description read.
 */
export function recordRunDetails(db, runId, detailsFetched) {
  db.prepare('UPDATE scrape_runs SET details_fetched = ? WHERE id = ?')
    .run(detailsFetched ?? 0, runId);
}

/**
 * Most recent run per metro — what the dashboard health strip renders.
 *
 * Keyed on MAX(id), not MAX(started_at): timestamps are ISO strings with
 * millisecond resolution, so two runs of the same metro starting in the same
 * millisecond both matched the join and the metro appeared twice in the health
 * strip. Row ids are monotonic and unique, so they can't tie.
 */
export function latestRuns(db) {
  return db
    .prepare(
      `SELECT r.* FROM scrape_runs r
       JOIN (SELECT metro, MAX(id) AS m FROM scrape_runs GROUP BY metro) x
         ON r.metro = x.metro AND r.id = x.m
       ORDER BY r.metro`,
    )
    .all();
}

/**
 * Shared WHERE for the dashboard query and its count, so a page's rows and its
 * total can never disagree about what's being filtered.
 */
function listingFilterSql(filters = {}) {
  const where = [];
  const params = [];

  if (filters.rejected) {
    where.push("status IN ('rejected')");
  } else {
    // `interested` is deliberately NOT here. Marking a car Interested moves it
    // to the Flips board; leaving it on the listings page too means reviewing
    // the same car twice. One car, one place.
    where.push("status = 'passed'");
  }
  if (filters.metro) { where.push('metro = ?'); params.push(filters.metro); }
  if (filters.origin) { where.push('origin = ?'); params.push(filters.origin); }
  if (Number.isFinite(filters.minCents)) { where.push('price_cents >= ?'); params.push(filters.minCents); }
  if (Number.isFinite(filters.maxCents)) { where.push('price_cents <= ?'); params.push(filters.maxCents); }
  if (filters.q) {
    where.push('(LOWER(title) LIKE ? OR LOWER(model) LIKE ? OR LOWER(make_norm) LIKE ?)');
    const like = `%${filters.q.toLowerCase()}%`;
    params.push(like, like, like);
  }
  // Age window. Cars you're actively chasing don't need an exemption here any
  // more — they live on the Flips board, which has no age window at all.
  //
  // The cutoff is computed in JS rather than with SQLite's datetime('now'), so
  // it's the exact same ISO format as the stored value. Comparing
  // '2026-07-27T14:03:11.123Z' against SQLite's '2026-07-25 14:03:11' is a
  // string comparison across two different formats, and it only happens to work.
  if (Number.isFinite(filters.days) && filters.days > 0) {
    const cutoff = new Date(Date.now() - filters.days * 86_400_000).toISOString();
    where.push('first_seen_at >= ?');
    params.push(cutoff);
  }

  return { sql: where.join(' AND '), params };
}

/** How many listings match, ignoring paging. Drives the pager. */
export function countListings(db, filters = {}) {
  const { sql, params } = listingFilterSql(filters);
  return db.prepare(`SELECT COUNT(*) AS c FROM listings WHERE ${sql}`).get(...params).c;
}

/**
 * Sort orders the dashboard offers.
 *
 * Every one ends with `id DESC` as a unique tiebreaker. Without it, rows that
 * tie on the sort key can swap places between queries, and with paging a car
 * then shows up on two pages or on none.
 *
 * `posted` uses `posted_at IS NULL` first rather than `NULLS LAST` — same
 * result, and it doesn't depend on the bundled SQLite version. It matters here
 * because only ~38% of listings have a parseable posted date; the rest would
 * otherwise bunch at the top and bury the genuinely fresh ones.
 */
export const SORTS = {
  posted: 'posted_at IS NULL, posted_at DESC, first_seen_at DESC, id DESC',
  price: 'price_cents ASC, posted_at IS NULL, posted_at DESC, id DESC',
  drop: '(first_price_cents - price_cents) DESC, posted_at IS NULL, posted_at DESC, id DESC',
};

/** Applied when no sort is given, or when an unknown one is. */
export const DEFAULT_SORT = 'posted';

/**
 * The column each sort groups by on the dashboard, so headings match the order.
 *
 * `first_seen_at` is still the age-window column (see listingFilterSql) — that's
 * about whether a car is new *to you*, which is a different question from when
 * the seller posted it. It is no longer offered as a sort: scrapes run twice a
 * day, so ordering by it just clusters every car into two buckets.
 */
export const SORT_GROUP_FIELD = {
  posted: 'posted_at',
  price: 'posted_at',
  drop: 'posted_at',
};

/** One page of dashboard results. All filters optional, combined with AND. */
export function queryListings(db, filters = {}) {
  const { sql, params } = listingFilterSql(filters);
  const limit = Number.isFinite(filters.limit) ? filters.limit : 400;
  const offset = Number.isFinite(filters.offset) ? Math.max(0, filters.offset) : 0;
  const orderBy = SORTS[filters.sort] ?? SORTS[DEFAULT_SORT];

  return db
    .prepare(
      `SELECT * FROM listings WHERE ${sql}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
}

/**
 * Listings whose description has never been read.
 *
 * These are deliberately NOT shown on the dashboard: defect detection needs the
 * description, so displaying one means showing a car nobody checked for engine
 * or transmission trouble. The dashboard shows the count instead, so a growing
 * backlog is visible rather than silent.
 */
export function countUnchecked(db) {
  // Keyed on status alone, not on detail_fetched_at: a listing whose detail
  // page was fetched but yielded no usable description is still unchecked, and
  // is deliberately parked here rather than shown as good.
  return db
    .prepare("SELECT COUNT(*) AS c FROM listings WHERE status = 'pending_detail'")
    .get().c;
}

/**
 * Is this exact description already stored against a different listing?
 *
 * Two cars almost never share a description word for word. When they do it
 * means the scraper picked up page furniture — a sidebar ad, a "similar
 * listings" block — and attributed it to the car. Treat that as no description
 * at all: the listing stays hidden and gets re-fetched, which is safe. Storing
 * it would mark the car checked when the check ran on someone else's ad.
 */
export function descriptionSeenElsewhere(db, fbId, description) {
  if (!description || description.trim().length < 20) return false;
  const row = db
    .prepare('SELECT 1 FROM listings WHERE description = ? AND fb_id <> ? LIMIT 1')
    .get(description, fbId);
  return Boolean(row);
}

/**
 * Repair pass: drop descriptions shared by more than one listing and re-queue
 * those listings for a fresh detail fetch.
 *
 * @returns {{ cleared: number, blocks: number }}
 */
export function clearSharedDescriptions(db) {
  const shared = db
    .prepare(
      `SELECT description FROM listings
       WHERE description IS NOT NULL AND LENGTH(TRIM(description)) >= 20
       GROUP BY description HAVING COUNT(*) > 1`,
    )
    .all();

  let cleared = 0;
  const update = db.prepare(
    `UPDATE listings
     SET description = NULL, detail_fetched_at = NULL,
         status = CASE WHEN status IN ('hidden','interested') THEN status ELSE 'pending_detail' END
     WHERE description = ?`,
  );
  for (const { description } of shared) {
    cleared += update.run(description).changes;
  }
  return { cleared, blocks: shared.length };
}

/**
 * Clear seller names that are actually page headings.
 *
 * An early selector stored the literal "Seller details" for every listing, and
 * the dashboard printed it as though it were a person. Null is the honest
 * value — it shows nothing instead of nonsense.
 */
export function clearJunkSellerNames(db, isJunk) {
  const rows = db
    .prepare("SELECT id, seller_name FROM listings WHERE seller_name IS NOT NULL AND TRIM(seller_name) <> ''")
    .all();
  const update = db.prepare('UPDATE listings SET seller_name = NULL WHERE id = ?');
  let cleared = 0;
  for (const row of rows) {
    if (isJunk(row.seller_name)) { update.run(row.id); cleared++; }
  }
  return cleared;
}

/**
 * Re-queue listings whose detail page was fetched but yielded no description.
 *
 * For repairing after an extraction bug. When `extractDescription` stopped
 * matching Facebook's "Seller's description" heading, 500 fetches in a row
 * stored nothing, and because `detail_fetched_at` was set those listings were
 * never retried — they sat unchecked and invisible.
 *
 * Not automatic: some sellers genuinely write nothing, and re-queuing those on
 * every run would burn detail budget forever. Run it deliberately after fixing
 * an extractor.
 */
export function requeueDetailless(db) {
  const info = db.prepare(
    `UPDATE listings
     SET detail_fetched_at = NULL,
         status = CASE WHEN status IN ('hidden','interested') THEN status ELSE 'pending_detail' END
     WHERE detail_fetched_at IS NOT NULL AND description IS NULL`,
  ).run();
  return info.changes;
}

/** Backfill the detected language on stored listings. Offline, no API needed. */
export function backfillLanguages(db, detect) {
  const rows = db
    .prepare('SELECT id, description FROM listings WHERE description IS NOT NULL AND language IS NULL')
    .all();
  const update = db.prepare('UPDATE listings SET language = ? WHERE id = ?');
  const tally = {};
  for (const row of rows) {
    const language = detect(row.description);
    if (!language) continue;
    update.run(language, row.id);
    tally[language] = (tally[language] ?? 0) + 1;
  }
  return tally;
}

export function priceHistory(db, listingId) {
  return db
    .prepare('SELECT price_cents, observed_at FROM price_history WHERE listing_id = ? ORDER BY observed_at')
    .all(listingId);
}

// --- CRM ------------------------------------------------------------------
// One flip = one car you're chasing or own. See docs/CRM.md.

/**
 * Open a flip for a listing, or return the one that already exists.
 *
 * Idempotent by `listing_id`: clicking Interested twice must not open a second
 * file on the same car. An existing flip is returned untouched — re-clicking
 * must never reset a car that's already `bought` back to `interested`.
 */
export function openFlip(db, listingId, { owner = 'me', status = 'interested' } = {}) {
  const existing = db.prepare('SELECT * FROM flips WHERE listing_id = ?').get(listingId);
  if (existing) return { flip: existing, created: false };

  const timestamp = now();
  const info = db
    .prepare(
      `INSERT INTO flips (listing_id, owner, status, created_at, updated_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(listingId, owner, status, timestamp, timestamp);

  return {
    flip: db.prepare('SELECT * FROM flips WHERE id = ?').get(Number(info.lastInsertRowid)),
    created: true,
  };
}

export function getFlip(db, id) {
  return db.prepare('SELECT * FROM flips WHERE id = ?').get(id);
}

export function getFlipByListing(db, listingId) {
  return db.prepare('SELECT * FROM flips WHERE listing_id = ?').get(listingId);
}

/**
 * Advance a flip, optionally recording the money that goes with the stage.
 * Callers should run `validateTransition` from lib/flips.js first — this
 * writes what it's given.
 */
/** Flips that are waiting on a seller — the ones worth checking for replies. */
export function flipsAwaitingReply(db) {
  return db
    .prepare(
      `SELECT f.*, l.fb_id, l.title, l.year, l.seller_name
       FROM flips f LEFT JOIN listings l ON l.id = f.listing_id
       WHERE f.status IN ('interested','contacted')
       ORDER BY f.updated_at DESC`,
    )
    .all();
}

/** Pin a thread to a flip so later checks are an exact lookup, not a guess. */
export function linkThread(db, flipId, { threadId, threadUrl, matchedBy }) {
  db.prepare(
    'UPDATE flips SET thread_id = ?, thread_url = ?, thread_matched_by = ?, updated_at = ? WHERE id = ?',
  ).run(threadId, threadUrl ?? null, matchedBy ?? null, now(), flipId);
  return getFlip(db, flipId);
}

/** Record that a seller replied. Advances `contacted` -> `replied`. */
export function recordReply(db, flipId, when = now()) {
  db.prepare(
    `UPDATE flips SET
       last_reply_at = ?,
       status = CASE WHEN status IN ('interested','contacted') THEN 'replied' ELSE status END,
       updated_at = ?
     WHERE id = ?`,
  ).run(when, now(), flipId);
  return getFlip(db, flipId);
}

export function markRepliesChecked(db, flipIds, when = now()) {
  if (!flipIds.length) return;
  const stmt = db.prepare('UPDATE flips SET replies_checked_at = ? WHERE id = ?');
  for (const id of flipIds) stmt.run(when, id);
}

export function updateFlip(db, id, fields = {}) {
  const timestamp = now();
  db.prepare(
    `UPDATE flips SET
       status               = COALESCE(?, status),
       purchase_price_cents = COALESCE(?, purchase_price_cents),
       purchase_date        = COALESCE(?, purchase_date),
       sale_price_cents     = COALESCE(?, sale_price_cents),
       sale_date            = COALESCE(?, sale_date),
       notes                = COALESCE(?, notes),
       updated_at           = ?
     WHERE id = ?`,
  ).run(
    fields.status ?? null,
    fields.purchase_price_cents ?? null,
    // Stamp the date automatically when the money lands, so the timeline is
    // right without asking for a date every time.
    fields.purchase_date ?? (fields.purchase_price_cents ? timestamp : null),
    fields.sale_price_cents ?? null,
    fields.sale_date ?? (fields.sale_price_cents ? timestamp : null),
    fields.notes ?? null,
    timestamp,
    id,
  );
  return getFlip(db, id);
}

/** Flips with their listing joined on, for the CRM board. */
export function queryFlips(db, { status = null, owner = null } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('f.status = ?'); params.push(status); }
  if (owner) { where.push('f.owner = ?'); params.push(owner); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return db
    .prepare(
      `SELECT f.*,
              l.fb_id, l.url, l.title, l.price_cents AS asking_price_cents,
              l.year, l.make_norm, l.model, l.image_url, l.metro, l.location_text
       FROM flips f
       LEFT JOIN listings l ON l.id = f.listing_id
       ${clause}
       ORDER BY f.updated_at DESC, f.id DESC`,
    )
    .all(...params);
}

export function addPart(db, flipId, { name, costCents = null, vendor = null, notes = null, owner = 'me' }) {
  const info = db
    .prepare(
      `INSERT INTO flip_parts (flip_id, owner, name, status, cost_cents, vendor, notes, created_at)
       VALUES (?,?,?,'needed',?,?,?,?)`,
    )
    .run(flipId, owner, name, costCents, vendor, notes, now());
  touchFlip(db, flipId);
  return db.prepare('SELECT * FROM flip_parts WHERE id = ?').get(Number(info.lastInsertRowid));
}

/** Mark a part bought at a price. The price is the point — it feeds profit. */
export function markPartBought(db, partId, costCents) {
  const part = db.prepare('SELECT * FROM flip_parts WHERE id = ?').get(partId);
  if (!part) return null;
  db.prepare(
    'UPDATE flip_parts SET status = ?, cost_cents = COALESCE(?, cost_cents), bought_at = ? WHERE id = ?',
  ).run('bought', costCents ?? null, now(), partId);
  touchFlip(db, part.flip_id);
  return db.prepare('SELECT * FROM flip_parts WHERE id = ?').get(partId);
}

export function deletePart(db, partId) {
  const part = db.prepare('SELECT * FROM flip_parts WHERE id = ?').get(partId);
  if (!part) return false;
  db.prepare('DELETE FROM flip_parts WHERE id = ?').run(partId);
  touchFlip(db, part.flip_id);
  return true;
}

/**
 * Remove a flip and its parts.
 *
 * Also returns the listing to `passed`. Without that the car would be
 * invisible everywhere: `interested` keeps it off the listings page, and with
 * no flip it isn't on the board either. Deleting is usually "I clicked
 * Interested by mistake", and the car should go back where it came from.
 * A dead deal is better recorded by setting the status to `dead` than by
 * deleting — that keeps the history.
 *
 * @returns {{ deleted: boolean, listingId: number|null }}
 */
export function deleteFlip(db, flipId) {
  const flip = getFlip(db, flipId);
  if (!flip) return { deleted: false, listingId: null };

  db.prepare('DELETE FROM flip_parts WHERE flip_id = ?').run(flipId);
  db.prepare('DELETE FROM flips WHERE id = ?').run(flipId);

  if (flip.listing_id) {
    db.prepare("UPDATE listings SET status = 'passed' WHERE id = ? AND status = 'interested'")
      .run(flip.listing_id);
  }
  return { deleted: true, listingId: flip.listing_id };
}

export function partsForFlip(db, flipId) {
  return db
    .prepare('SELECT * FROM flip_parts WHERE flip_id = ? ORDER BY created_at, id')
    .all(flipId);
}

/** All parts for a set of flips, grouped by flip id — avoids a query per card. */
export function partsForFlips(db, flipIds) {
  if (!flipIds.length) return new Map();
  const placeholders = flipIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM flip_parts WHERE flip_id IN (${placeholders}) ORDER BY created_at, id`)
    .all(...flipIds);

  const grouped = new Map(flipIds.map((id) => [id, []]));
  for (const row of rows) grouped.get(row.flip_id)?.push(row);
  return grouped;
}

/** Keep a flip's updated_at honest when its parts change — it drives ordering. */
function touchFlip(db, flipId) {
  db.prepare('UPDATE flips SET updated_at = ? WHERE id = ?').run(now(), flipId);
}
