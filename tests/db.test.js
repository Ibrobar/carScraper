// Storage invariants. These two are load-bearing for the whole project:
//   - hidden/interested are sticky (Ibrahim's call outranks the filters)
//   - a run that saw zero listings is a FAILURE, never `ok`

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb, closeDb, upsertListing, getListing, setListingStatus, startRun,
  finishRun, latestRuns, queryListings, countListings, priceHistory,
  descriptionSeenElsewhere, clearSharedDescriptions, SORTS,
} from '../lib/db.js';

let dir;
let db;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'carscraper-test-'));
  db = openDb(join(dir, 'test.db'));
});

after(() => {
  // Windows won't unlink an open SQLite file — close before removing.
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const listing = (over = {}) => ({
  fb_id: '1001',
  url: 'https://www.facebook.com/marketplace/item/1001/',
  title: '2010 Toyota Camry',
  price_cents: 200000,
  metro: 'dfw',
  status: 'passed',
  ...over,
});

describe('upsertListing', () => {
  test('inserts and records the opening price', () => {
    const result = upsertListing(db, listing());
    assert.equal(result.isNew, true);

    const row = getListing(db, '1001');
    assert.equal(row.price_cents, 200000);
    assert.equal(row.first_price_cents, 200000);
    assert.equal(priceHistory(db, row.id).length, 1);
  });

  test('a re-sighting updates but does not duplicate', () => {
    const result = upsertListing(db, listing());
    assert.equal(result.isNew, false);
    assert.equal(result.priceChanged, false);
  });

  test('a price drop is recorded, first_price_cents is preserved', () => {
    const result = upsertListing(db, listing({ price_cents: 170000 }));
    assert.equal(result.priceChanged, true);

    const row = getListing(db, '1001');
    assert.equal(row.price_cents, 170000);
    // The drop badge depends on this never being overwritten.
    assert.equal(row.first_price_cents, 200000);
    assert.equal(priceHistory(db, row.id).length, 2);
  });

  test('price history only grows on an actual change', () => {
    const row = getListing(db, '1001');
    const before = priceHistory(db, row.id).length;
    upsertListing(db, listing({ price_cents: 170000 }));
    upsertListing(db, listing({ price_cents: 170000 }));
    assert.equal(priceHistory(db, row.id).length, before);
  });

  test('first_seen_at survives re-sightings', () => {
    const before = getListing(db, '1001').first_seen_at;
    upsertListing(db, listing({ price_cents: 165000 }));
    assert.equal(getListing(db, '1001').first_seen_at, before);
  });

  test('a card-only re-sighting cannot wipe detail we already have', () => {
    upsertListing(db, listing({
      fb_id: '1002', description: 'Cold ac, clean title', mileage: 140000,
      detail_fetched_at: new Date().toISOString(),
    }));
    // Later scrape sees only the search card — no description in the payload.
    upsertListing(db, { fb_id: '1002', price_cents: 195000 });

    const row = getListing(db, '1002');
    assert.equal(row.description, 'Cold ac, clean title');
    assert.equal(row.mileage, 140000);
  });
});

describe('sticky statuses', () => {
  test('a scrape cannot un-hide a listing', () => {
    upsertListing(db, listing({ fb_id: '2001' }));
    setListingStatus(db, '2001', 'hidden');

    upsertListing(db, listing({ fb_id: '2001', status: 'passed' }));
    assert.equal(getListing(db, '2001').status, 'hidden');
  });

  test('a filter change cannot drop an interested listing', () => {
    upsertListing(db, listing({ fb_id: '2002' }));
    setListingStatus(db, '2002', 'interested');

    upsertListing(db, listing({ fb_id: '2002', status: 'rejected' }));
    assert.equal(getListing(db, '2002').status, 'interested');
  });
});

describe('scrape runs', () => {
  test('a normal run is ok', () => {
    const id = startRun(db, { provider: 'facebook', metro: 'dfw' });
    const status = finishRun(db, id, { status: 'ok', listingsSeen: 40, listingsNew: 12 });
    assert.equal(status, 'ok');
  });

  test('zero listings is downgraded to no_listings', () => {
    // The core anti-footgun: a broken scraper must never look like a quiet market.
    const id = startRun(db, { provider: 'facebook', metro: 'houston' });
    const status = finishRun(db, id, { status: 'ok', listingsSeen: 0, listingsNew: 0 });
    assert.equal(status, 'no_listings');
  });

  test('an explicit failure status is preserved', () => {
    const id = startRun(db, { provider: 'facebook', metro: 'houston' });
    const status = finishRun(db, id, {
      status: 'login_wall', listingsSeen: 0, error: 'session expired',
    });
    assert.equal(status, 'login_wall');
  });

  test('latestRuns returns one row per metro', () => {
    const runs = latestRuns(db);
    const metros = runs.map((r) => r.metro);
    assert.equal(new Set(metros).size, metros.length);
  });
});

describe('queryListings', () => {
  test('shows only cars still awaiting a decision', () => {
    // Not `interested` (moved to the board) and not `hidden` (dismissed).
    const rows = queryListings(db, {});
    assert.ok(rows.every((r) => r.status === 'passed'));
  });

  test('a car marked interested drops off the listings page', () => {
    upsertListing(db, listing({ fb_id: '4001', title: '2010 Toyota Camry leaves' }));
    assert.ok(queryListings(db, { q: 'leaves' }).length === 1);
    setListingStatus(db, '4001', 'interested');
    assert.equal(queryListings(db, { q: 'leaves' }).length, 0);
  });

  test('the rejected view returns only rejected', () => {
    upsertListing(db, listing({ fb_id: '3001', status: 'rejected' }));
    const rows = queryListings(db, { rejected: true });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.status === 'rejected'));
  });

  test('filters by metro and price', () => {
    upsertListing(db, listing({ fb_id: '3002', metro: 'houston', price_cents: 90000 }));
    const rows = queryListings(db, { metro: 'houston', maxCents: 100000 });
    assert.ok(rows.every((r) => r.metro === 'houston' && r.price_cents <= 100000));
  });

  test('search matches the title', () => {
    const rows = queryListings(db, { q: 'camry' });
    assert.ok(rows.every((r) => /camry/i.test(r.title)));
  });
});

describe('sidebar-bleed descriptions', () => {
  // 39% of real descriptions turned out to be some other seller's ad, scraped
  // from the "similar listings" sidebar. Defect detection ran on those.
  const AD = 'LA PULGA DE DALLAS, NORTH DALLAS, MESQUITE, GARLAND Y TODO EL METROPLEX';

  before(() => {
    upsertListing(db, listing({
      fb_id: 'bleed1', description: AD, status: 'passed',
      detail_fetched_at: new Date().toISOString(),
    }));
    upsertListing(db, listing({
      fb_id: 'bleed2', description: AD, status: 'passed',
      detail_fetched_at: new Date().toISOString(),
    }));
    upsertListing(db, listing({
      fb_id: 'unique1', description: 'Genuinely this car: cold ac, 140k, clean title.',
      status: 'passed', detail_fetched_at: new Date().toISOString(),
    }));
  });

  test('detects a description already used by another listing', () => {
    assert.equal(descriptionSeenElsewhere(db, 'bleed3', AD), true);
  });

  test('a listing does not collide with itself', () => {
    assert.equal(descriptionSeenElsewhere(db, 'unique1', 'Genuinely this car: cold ac, 140k, clean title.'), false);
  });

  test('ignores trivially short text', () => {
    assert.equal(descriptionSeenElsewhere(db, 'x', 'as is'), false);
  });

  test('the repair pass clears shared descriptions and re-queues them', () => {
    const { cleared } = clearSharedDescriptions(db);
    assert.ok(cleared >= 2, `expected at least 2 cleared, got ${cleared}`);

    for (const id of ['bleed1', 'bleed2']) {
      const row = getListing(db, id);
      assert.equal(row.description, null);
      assert.equal(row.detail_fetched_at, null, 'must be re-queued for a fresh fetch');
      assert.equal(row.status, 'pending_detail', 'must be hidden until re-checked');
    }
  });

  test('it leaves genuine one-off descriptions alone', () => {
    const row = getListing(db, 'unique1');
    assert.match(row.description, /Genuinely this car/);
    assert.equal(row.status, 'passed');
  });

  test('the repair pass never overrides your own decisions', () => {
    upsertListing(db, listing({ fb_id: 'bleedH', description: 'shared text shared text', detail_fetched_at: new Date().toISOString() }));
    upsertListing(db, listing({ fb_id: 'bleedI', description: 'shared text shared text', detail_fetched_at: new Date().toISOString() }));
    setListingStatus(db, 'bleedH', 'interested');

    clearSharedDescriptions(db);
    assert.equal(getListing(db, 'bleedH').status, 'interested');
  });
});

describe('sorting', () => {
  const ago = (n) => new Date(Date.now() - n * 3_600_000).toISOString();

  before(() => {
    const rows = [
      // fb_id,     posted hours ago, price,  firstPrice
      ['sort_a', 1, 200000, 200000],
      ['sort_b', 50, 100000, 100000],
      ['sort_c', null, 150000, 300000],  // no posted date, biggest drop
    ];
    for (const [id, hours, price, firstPrice] of rows) {
      upsertListing(db, listing({ fb_id: id, title: `2010 Toyota Camry sortcase ${id}`, price_cents: firstPrice, status: 'passed' }));
      db.prepare('UPDATE listings SET posted_at = ?, price_cents = ?, first_price_cents = ? WHERE fb_id = ?')
        .run(hours === null ? null : ago(hours), price, firstPrice, id);
    }
  });

  const ids = (sort) => queryListings(db, { q: 'sortcase', sort, limit: 50 }).map((r) => r.fb_id);

  test('"most recent" puts the newest POSTED car first', () => {
    assert.equal(ids('posted')[0], 'sort_a');
  });

  test('it is the default — no sort given means most recent', () => {
    assert.deepEqual(queryListings(db, { q: 'sortcase', limit: 50 }).map((r) => r.fb_id), ids('posted'));
  });

  test('listings with no posted date sort to the bottom, not the top', () => {
    // Most listings have no readable posted date; floating them to the top
    // would bury the genuinely fresh ones.
    assert.equal(ids('posted').at(-1), 'sort_c');
  });

  test('cheapest first', () => {
    assert.equal(ids('price')[0], 'sort_b');
  });

  test('biggest price drop first', () => {
    assert.equal(ids('drop')[0], 'sort_c');
  });

  test('an unknown sort falls back to most recent instead of breaking', () => {
    assert.doesNotThrow(() => queryListings(db, { q: 'sortcase', sort: 'nonsense' }));
    assert.deepEqual(ids('nonsense'), ids('posted'));
  });

  test('the scraper-order sort is gone', () => {
    // Sorting by when WE found a car clustered everything into two buckets a
    // day, since scrapes run twice daily.
    assert.equal(SORTS.seen, undefined);
    assert.deepEqual(ids('seen'), ids('posted'), 'should fall back, not order by first_seen_at');
  });

  test('sorting never changes which listings match', () => {
    const counts = ['posted', 'price', 'drop'].map((s) => ids(s).length);
    assert.equal(new Set(counts).size, 1);
  });
});

describe('age window', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

  before(() => {
    for (const [id, age, status] of [
      ['age_fresh', 0, 'passed'],
      ['age_1d', 1, 'passed'],
      ['age_5d', 5, 'passed'],
      ['age_30d', 30, 'passed'],
      ['age_old_interested', 45, 'passed'],
    ]) {
      upsertListing(db, listing({ fb_id: id, title: `2010 Toyota Camry agewin ${id}`, status }));
      db.prepare('UPDATE listings SET first_seen_at = ? WHERE fb_id = ?').run(daysAgo(age), id);
    }
    setListingStatus(db, 'age_old_interested', 'interested');
  });

  const ids = (rows) => rows.map((r) => r.fb_id);
  const win = (days) => queryListings(db, { q: 'agewin', days, limit: 100 });

  test('a 2-day window keeps only recent cars', () => {
    const got = ids(win(2));
    assert.ok(got.includes('age_fresh'));
    assert.ok(got.includes('age_1d'));
    assert.ok(!got.includes('age_5d'), '5-day-old car should have aged off');
    assert.ok(!got.includes('age_30d'));
  });

  test('interested cars leave the listings page entirely', () => {
    // They move to the Flips board. Showing them in both places means
    // reviewing the same car twice.
    assert.ok(!ids(win(60)).includes('age_old_interested'));
  });

  test('widening the window brings the old ones back — nothing was deleted', () => {
    const got = ids(win(60));
    assert.ok(got.includes('age_5d'));
    assert.ok(got.includes('age_30d'));
  });

  test('days = 0 means no limit', () => {
    assert.ok(ids(win(0)).includes('age_30d'));
  });

  test('the count respects the window too', () => {
    assert.equal(countListings(db, { q: 'agewin', days: 2 }), win(2).length);
    assert.ok(countListings(db, { q: 'agewin', days: 60 }) > countListings(db, { q: 'agewin', days: 2 }));
  });
});

describe('pagination', () => {
  before(() => {
    // Same timestamp and price on purpose — this is the case that needs a
    // unique tiebreaker in the ORDER BY.
    for (let i = 0; i < 25; i++) {
      upsertListing(db, listing({
        fb_id: `page${i}`, title: `2010 Toyota Camry page ${i}`,
        price_cents: 150000, metro: 'dfw', status: 'passed',
      }));
    }
  });

  const pageFilters = { q: 'page', limit: 10 };

  test('returns exactly one page', () => {
    assert.equal(queryListings(db, { ...pageFilters, offset: 0 }).length, 10);
  });

  test('countListings ignores paging', () => {
    assert.equal(countListings(db, pageFilters), 25);
  });

  test('offset walks forward without repeating or skipping', () => {
    const seen = new Set();
    for (let offset = 0; offset < 25; offset += 10) {
      for (const row of queryListings(db, { ...pageFilters, offset })) {
        assert.ok(!seen.has(row.fb_id), `${row.fb_id} appeared on two pages`);
        seen.add(row.fb_id);
      }
    }
    assert.equal(seen.size, 25);
  });

  test('the last page returns the remainder', () => {
    assert.equal(queryListings(db, { ...pageFilters, offset: 20 }).length, 5);
  });

  test('past the end returns empty, not an error', () => {
    assert.deepEqual(queryListings(db, { ...pageFilters, offset: 500 }), []);
  });

  test('ordering is stable across identical timestamps and prices', () => {
    // Without the id tiebreaker these rows could swap between queries, so a car
    // would show on two pages or none.
    const first = queryListings(db, { ...pageFilters, offset: 0 }).map((r) => r.fb_id);
    const again = queryListings(db, { ...pageFilters, offset: 0 }).map((r) => r.fb_id);
    assert.deepEqual(first, again);
  });

  test('hiding a listing removes it from the count', () => {
    const before = countListings(db, pageFilters);
    setListingStatus(db, 'page0', 'hidden');
    assert.equal(countListings(db, pageFilters), before - 1);
  });
});
