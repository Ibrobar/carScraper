import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { offerPriceCents, formatMoney, draftOfferMessage } from '../lib/offers.js';

describe('offerPriceCents', () => {
  test('15% off, rounded down to $25', () => {
    assert.equal(offerPriceCents(200000), 170000); // $2000 -> $1700
    assert.equal(offerPriceCents(250000), 212500); // $2500 -> $2125
  });

  test('rounds DOWN, not to nearest', () => {
    // $1895 * 0.85 = $1610.75. "$1,610.75" reads like a robot wrote it.
    assert.equal(offerPriceCents(189500), 160000); // -> $1600
  });

  test('honors an override discount', () => {
    assert.equal(offerPriceCents(200000, { discountPct: 20 }), 160000);
  });

  test('never rounds a cheap car to zero', () => {
    const result = offerPriceCents(1000, { roundToCents: 100000 });
    assert.ok(result > 0);
  });

  test('returns null on junk input', () => {
    assert.equal(offerPriceCents(0), null);
    assert.equal(offerPriceCents(null), null);
    assert.equal(offerPriceCents(NaN), null);
  });
});

describe('formatMoney', () => {
  test('formats with a thousands separator', () => {
    assert.equal(formatMoney(170000), '$1,700');
    assert.equal(formatMoney(50000), '$500');
  });

  test('is safe on null', () => {
    assert.equal(formatMoney(null), '');
    assert.equal(formatMoney(undefined), '');
  });
});

describe('draftOfferMessage', () => {
  const listing = {
    year: 2010, make_norm: 'toyota', model: 'Camry', price_cents: 200000,
  };

  test('names the car and the number', () => {
    const message = draftOfferMessage(listing);
    assert.match(message, /2010 Toyota Camry/);
    assert.match(message, /\$1,700/);
  });

  test('stays short — long friendly messages read as scripted', () => {
    assert.ok(draftOfferMessage(listing).length < 200);
  });

  test('falls back gracefully with no vehicle details', () => {
    const message = draftOfferMessage({ price_cents: 100000 });
    assert.match(message, /the vehicle/);
  });

  test('returns null when there is no price to work from', () => {
    assert.equal(draftOfferMessage({ price_cents: null }), null);
  });
});
