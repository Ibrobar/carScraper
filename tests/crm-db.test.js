// Storage side of the CRM: opening flips, parts, and the invariant that
// clicking Interested twice must not open a second file on the same car.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb, closeDb, upsertListing, getListing, setListingStatus,
} from '../lib/db.js';
import {
  openFlip, getFlip, getFlipByListing, updateFlip, queryFlips, deleteFlip,
  addPart, markPartBought, deletePart, partsForFlip, partsForFlips,
  backfillMissingFlips,
} from '../lib/crm/db.js';

let dir;
let db;
let listingId;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'carscraper-crm-'));
  db = openDb(join(dir, 'crm.db'));
  upsertListing(db, {
    fb_id: 'crm1', title: '2010 Toyota Camry', price_cents: 200000,
    metro: 'dfw', status: 'passed',
  });
  listingId = getListing(db, 'crm1').id;
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('openFlip', () => {
  test('opens a flip for a listing', () => {
    const { flip, created } = openFlip(db, listingId);
    assert.equal(created, true);
    assert.equal(flip.status, 'interested');
    assert.equal(flip.listing_id, listingId);
  });

  test('is idempotent — a second Interested click reuses the same flip', () => {
    const { flip, created } = openFlip(db, listingId);
    assert.equal(created, false);
    assert.equal(flip.id, getFlipByListing(db, listingId).id);
  });

  test('re-opening never rewinds a car already in progress', () => {
    // Re-marking a bought car as Interested must not send it back to the start.
    const existing = getFlipByListing(db, listingId);
    updateFlip(db, existing.id, { status: 'bought', purchase_price_cents: 150000 });

    const { flip } = openFlip(db, listingId);
    assert.equal(flip.status, 'bought');
    assert.equal(flip.purchase_price_cents, 150000);
  });

  test('records an owner so per-user scoping is possible later', () => {
    upsertListing(db, { fb_id: 'crm2', title: '2011 Honda Civic', price_cents: 180000, status: 'passed' });
    const { flip } = openFlip(db, getListing(db, 'crm2').id, { owner: 'ibrahim' });
    assert.equal(flip.owner, 'ibrahim');
  });
});

describe('updateFlip', () => {
  test('stamps the purchase date automatically', () => {
    const flip = getFlipByListing(db, listingId);
    const updated = updateFlip(db, flip.id, { purchase_price_cents: 155000 });
    assert.ok(updated.purchase_date, 'purchase_date should be set from the amount');
  });

  test('omitted fields are left alone', () => {
    const flip = getFlipByListing(db, listingId);
    const updated = updateFlip(db, flip.id, { status: 'repairing' });
    assert.equal(updated.purchase_price_cents, 155000);
  });

  test('recording a sale stamps the sale date', () => {
    const flip = getFlipByListing(db, listingId);
    const updated = updateFlip(db, flip.id, { status: 'sold', sale_price_cents: 300000 });
    assert.equal(updated.status, 'sold');
    assert.ok(updated.sale_date);
  });
});

describe('parts', () => {
  let flipId;

  before(() => {
    upsertListing(db, { fb_id: 'crm3', title: '2008 Ford F-150', price_cents: 220000, status: 'passed' });
    flipId = openFlip(db, getListing(db, 'crm3').id).flip.id;
  });

  test('a new part starts as needed, not bought', () => {
    const part = addPart(db, flipId, { name: 'Alternator', costCents: 12000 });
    assert.equal(part.status, 'needed');
    assert.equal(part.cost_cents, 12000);
  });

  test('marking bought records the price actually paid', () => {
    const [part] = partsForFlip(db, flipId);
    const bought = markPartBought(db, part.id, 13500);
    assert.equal(bought.status, 'bought');
    assert.equal(bought.cost_cents, 13500, 'the real price should overwrite the estimate');
    assert.ok(bought.bought_at);
  });

  test('marking bought with no price keeps the estimate', () => {
    const part = addPart(db, flipId, { name: 'Brake pads', costCents: 6000 });
    const bought = markPartBought(db, part.id, null);
    assert.equal(bought.cost_cents, 6000);
  });

  test('parts can be removed', () => {
    const part = addPart(db, flipId, { name: 'Typo part' });
    assert.equal(deletePart(db, part.id), true);
    assert.ok(!partsForFlip(db, flipId).some((p) => p.id === part.id));
  });

  test('deleting something that is not there is not an error', () => {
    assert.equal(deletePart(db, 999999), false);
  });

  test('parts changes bump the flip so the board reorders', () => {
    const before = getFlip(db, flipId).updated_at;
    addPart(db, flipId, { name: 'Radiator', costCents: 9000 });
    assert.notEqual(getFlip(db, flipId).updated_at, before);
  });

  test('partsForFlips batches without a query per card', () => {
    const flips = queryFlips(db, {});
    const grouped = partsForFlips(db, flips.map((f) => f.id));
    assert.equal(grouped.size, flips.length);
    assert.ok(Array.isArray(grouped.get(flipId)));
  });

  test('parts are deleted with their car', () => {
    upsertListing(db, { fb_id: 'crm4', title: '2004 Nissan Altima', price_cents: 120000, status: 'passed' });
    const doomed = openFlip(db, getListing(db, 'crm4').id).flip;
    addPart(db, doomed.id, { name: 'Ignition coil' });
    db.prepare('DELETE FROM flips WHERE id = ?').run(doomed.id);
    assert.deepEqual(partsForFlip(db, doomed.id), []);
  });
});

describe('deleteFlip', () => {
  let flipId;
  let fbId;

  before(() => {
    fbId = 'crm_del';
    upsertListing(db, { fb_id: fbId, title: '2009 Mazda 3', price_cents: 190000, status: 'passed' });
    const listing = getListing(db, fbId);
    flipId = openFlip(db, listing.id).flip.id;
    setListingStatus(db, fbId, 'interested');
    addPart(db, flipId, { name: 'Wheel bearing', costCents: 8000 });
  });

  test('removes the flip and its parts', () => {
    const result = deleteFlip(db, flipId);
    assert.equal(result.deleted, true);
    assert.equal(getFlip(db, flipId), undefined);
    assert.deepEqual(partsForFlip(db, flipId), []);
  });

  test('returns the car to the listings page', () => {
    // Otherwise it is invisible everywhere: `interested` keeps it off the
    // listings page, and with no flip it is not on the board either.
    assert.equal(getListing(db, fbId).status, 'passed');
  });

  test('the car can be picked up again afterwards', () => {
    const listing = getListing(db, fbId);
    const { created } = openFlip(db, listing.id);
    assert.equal(created, true, 'the unique index must not block a fresh flip');
  });

  test('deleting something that is not there is not an error', () => {
    assert.deepEqual(deleteFlip(db, 999999), { deleted: false, listingId: null });
  });

  test('it does not disturb a listing you had hidden', () => {
    upsertListing(db, { fb_id: 'crm_hid', title: '2006 Kia Rio', price_cents: 90000, status: 'passed' });
    const listing = getListing(db, 'crm_hid');
    const flip = openFlip(db, listing.id).flip;
    setListingStatus(db, 'crm_hid', 'hidden');

    deleteFlip(db, flip.id);
    assert.equal(getListing(db, 'crm_hid').status, 'hidden');
  });
});

describe('queryFlips', () => {
  test('joins the listing so the board can show the car', () => {
    const rows = queryFlips(db, {});
    const row = rows.find((r) => r.listing_id === listingId);
    assert.equal(row.title, '2010 Toyota Camry');
    assert.equal(row.asking_price_cents, 200000);
  });

  test('filters by status', () => {
    const sold = queryFlips(db, { status: 'sold' });
    assert.ok(sold.length > 0);
    assert.ok(sold.every((r) => r.status === 'sold'));
  });

  test('filters by owner', () => {
    const mine = queryFlips(db, { owner: 'ibrahim' });
    assert.ok(mine.every((r) => r.owner === 'ibrahim'));
  });
});

describe('backfillMissingFlips', () => {
  // This is a real bug that happened: while the CRM lived on its own branch,
  // the dashboard set status='interested' but had no openFlip to call. The
  // sticky status kept those cars off the listings page and the missing flip
  // kept them off the board, so clicking Interested looked like the car simply
  // vanished. Two cars were lost that way before anyone noticed.
  const strand = (fbId, title) => {
    upsertListing(db, { fb_id: fbId, title, price_cents: 90000, metro: 'dfw', status: 'passed' });
    const id = getListing(db, fbId).id;
    setListingStatus(db, fbId, 'interested');
    return id;
  };

  test('finds a car marked Interested that has no flip', () => {
    strand('stranded1', '2010 Chevrolet Cobalt');
    const found = backfillMissingFlips(db, { dryRun: true });
    assert.ok(found.some((c) => c.fbId === 'stranded1'), 'stranded car not found');
  });

  test('a dry run writes nothing', () => {
    const before = queryFlips(db, {}).length;
    backfillMissingFlips(db, { dryRun: true });
    assert.equal(queryFlips(db, {}).length, before);
  });

  test('opens flips for them, and they land on the board', () => {
    const id = strand('stranded2', '2003 Honda Accord');
    assert.equal(getFlipByListing(db, id), undefined);

    backfillMissingFlips(db);

    const flip = getFlipByListing(db, id);
    assert.ok(flip, 'no flip was opened');
    assert.equal(flip.status, 'interested');
    assert.ok(queryFlips(db, {}).some((f) => f.listing_id === id));
  });

  test('leaves nothing stranded afterwards', () => {
    assert.deepEqual(backfillMissingFlips(db, { dryRun: true }), []);
  });

  test('is safe to run twice — no duplicate flips', () => {
    const before = queryFlips(db, {}).length;
    backfillMissingFlips(db);
    backfillMissingFlips(db);
    assert.equal(queryFlips(db, {}).length, before);
  });

  test('ignores cars that are hidden or still passed', () => {
    upsertListing(db, { fb_id: 'nothanks', title: 'Hidden car', metro: 'dfw', status: 'passed' });
    setListingStatus(db, 'nothanks', 'hidden');
    const found = backfillMissingFlips(db, { dryRun: true });
    assert.ok(!found.some((c) => c.fbId === 'nothanks'));
  });
});
