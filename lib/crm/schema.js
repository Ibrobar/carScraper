// The CRM's own tables, kept out of lib/db.js so the module can be lifted out
// in one piece. lib/db.js appends these to the core schema at open time; that
// import is the single seam between the two halves.
//
// Documented in docs/DATA.md alongside the core tables — the split is physical,
// not conceptual, and the same database file holds both.

export const CRM_SCHEMA = `
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
`;

// Append-only, and these ids keep their original numbers (003-007) because
// databases in the wild have already recorded them in schema_migrations.
// Renumbering would re-run them. lib/db.js concatenates core then CRM, which
// reproduces the original order exactly.
export const CRM_MIGRATIONS = [
  { id: '003-flip-thread-id', sql: 'ALTER TABLE flips ADD COLUMN thread_id TEXT' },
  { id: '004-flip-thread-url', sql: 'ALTER TABLE flips ADD COLUMN thread_url TEXT' },
  { id: '005-flip-thread-matched-by', sql: 'ALTER TABLE flips ADD COLUMN thread_matched_by TEXT' },
  { id: '006-flip-last-reply', sql: 'ALTER TABLE flips ADD COLUMN last_reply_at TEXT' },
  { id: '007-flip-replies-checked', sql: 'ALTER TABLE flips ADD COLUMN replies_checked_at TEXT' },
];
