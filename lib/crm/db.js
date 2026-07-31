// Flip and part queries. Moved out of lib/db.js so the CRM is one directory
// rather than 89 references scattered through the core.
//
// These take an open `db` handle like every other query in the project — the
// handle comes from `openDb()` in lib/db.js, and both halves live in the same
// SQLite file. Nothing here touches listings except to hand a car back when a
// flip is deleted.
//
// See docs/CRM.md for the pipeline and the money rules.

const now = () => new Date().toISOString();

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

/**
 * Open flips for cars marked Interested that never got one.
 *
 * A listing marked `interested` with no flip is stranded: the sticky status
 * keeps it off the listings page, and with no flip it isn't on the board
 * either, so it is invisible everywhere. That happened for real while the CRM
 * lived on its own branch — `main` set the status but had no `openFlip` to
 * call, so those cars silently disappeared when clicked.
 *
 * Safe to run repeatedly: it only touches listings that have no flip, and
 * `openFlip` is itself idempotent.
 *
 * @returns {Array<{ listingId: number, fbId: string, title: string|null }>} what it opened
 */
export function backfillMissingFlips(db, { dryRun = false } = {}) {
  const stranded = db
    .prepare(
      `SELECT l.id, l.fb_id, l.title, l.price_cents
       FROM listings l
       WHERE l.status = 'interested'
         AND NOT EXISTS (SELECT 1 FROM flips f WHERE f.listing_id = l.id)
       ORDER BY l.first_seen_at`,
    )
    .all();

  if (!dryRun) {
    for (const row of stranded) openFlip(db, row.id);
  }
  return stranded.map((r) => ({
    listingId: r.id, fbId: r.fb_id, title: r.title, priceCents: r.price_cents,
  }));
}

export function getFlip(db, id) {
  return db.prepare('SELECT * FROM flips WHERE id = ?').get(id);
}

export function getFlipByListing(db, listingId) {
  return db.prepare('SELECT * FROM flips WHERE listing_id = ?').get(listingId);
}

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

/**
 * Advance a flip, optionally recording the money that goes with the stage.
 * Callers should run `validateTransition` from ./flips.js first — this writes
 * what it's given.
 */
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
