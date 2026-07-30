import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCard, evaluateFull } from '../lib/filters.js';

const card = (over = {}) => ({
  title: '2010 Toyota Camry LE',
  priceCents: 200000,
  ...over,
});

describe('evaluateCard — the cheap pass', () => {
  test('a good card queues a detail fetch', () => {
    const result = evaluateCard(card());
    assert.equal(result.verdict, 'pending_detail');
    assert.deepEqual(result.reasons, []);
    assert.equal(result.derived.origin, 'japanese');
  });

  test('over the cap', () => {
    const result = evaluateCard(card({ priceCents: 400000 }));
    assert.equal(result.verdict, 'rejected');
    assert.ok(result.reasons.includes('price_too_high'));
  });

  test('suspiciously cheap', () => {
    const result = evaluateCard(card({ priceCents: 5000 }));
    assert.ok(result.reasons.includes('price_too_low'));
  });

  test('German is rejected without ever opening the listing', () => {
    // This is the whole point of the cheap pass — no detail fetch spent.
    const result = evaluateCard(card({ title: '2009 BMW 328i' }));
    assert.equal(result.verdict, 'rejected');
    assert.ok(result.reasons.includes('origin_not_allowed'));
  });

  test('every German make is caught, however it was spelled', () => {
    for (const title of [
      '2009 BMW 328i', '2007 Mercedes C230', '2008 mercedes benz E350',
      '2010 Audi A4', '2006 VW Jetta', '2005 Volkswagon Passat',
      '2011 Mini Cooper', '2004 Porsche Boxster', '2009 benz ml350',
    ]) {
      const result = evaluateCard(card({ title }));
      assert.equal(result.verdict, 'rejected', `${title} should be rejected`);
      assert.ok(result.reasons.includes('origin_not_allowed'), title);
    }
  });

  test('Korean is kept — only blocked origins are cut', () => {
    const result = evaluateCard(card({ title: '2011 Hyundai Sonata' }));
    assert.equal(result.derived.origin, 'korean');
    assert.equal(result.verdict, 'pending_detail');
  });

  test('an unparseable title is KEPT, not rejected', () => {
    // The allowlist version rejected 142 of the first 219 listings this way,
    // most of them real cars whose title we simply failed to parse.
    const result = evaluateCard(card({ title: 'great car cheap' }));
    assert.equal(result.verdict, 'pending_detail');
    assert.deepEqual(result.reasons, []);
  });

  test('a card whose title came through as a badge is kept', () => {
    const result = evaluateCard(card({ title: 'Just listed' }));
    assert.equal(result.verdict, 'pending_detail');
  });

  test('blocking more origins is one config change', () => {
    const result = evaluateCard(card({ title: '2011 Hyundai Sonata' }), {
      blockedOrigins: ['german', 'korean'],
    });
    assert.equal(result.verdict, 'rejected');
  });

  test('non-cars are cut', () => {
    const result = evaluateCard(card({ title: '2010 utility trailer' }));
    assert.ok(result.reasons.includes('not_a_car'));
  });

  test('an unparseable price is kept, not thrown away', () => {
    // Don't lose a listing over a formatting quirk — the detail pass can sort it out.
    const result = evaluateCard(card({ priceCents: null }));
    assert.ok(!result.reasons.includes('price_too_high'));
    assert.ok(!result.reasons.includes('price_too_low'));
  });

  test('a car four hours away is cut before any detail fetch', () => {
    // Facebook served 148 Houston listings into a DFW search. Rejecting on
    // card data also stops detail budget being spent on them.
    const result = evaluateCard(card({ metro: 'dfw', locationText: 'Houston, TX' }));
    assert.equal(result.verdict, 'rejected');
    assert.ok(result.reasons.includes('too_far'));
  });

  test('DFW suburbs are kept', () => {
    for (const city of ['Arlington, TX', 'Denton, TX', 'Waxahachie, TX']) {
      const result = evaluateCard(card({ metro: 'dfw', locationText: city }));
      assert.equal(result.verdict, 'pending_detail', `${city} was cut`);
    }
  });

  test('an unrecognised town is kept, not guessed at', () => {
    const result = evaluateCard(card({ metro: 'dfw', locationText: 'Pottsboro, TX' }));
    assert.ok(!result.reasons.includes('too_far'));
  });

  test('no location means no distance rejection', () => {
    const result = evaluateCard(card({ metro: 'dfw', locationText: null }));
    assert.ok(!result.reasons.includes('too_far'));
  });

  test('Houston listings are fine when the metro IS Houston', () => {
    const result = evaluateCard(card({ metro: 'houston', locationText: 'Katy, TX' }));
    assert.equal(result.verdict, 'pending_detail');
  });

  test('a structured make beats the title', () => {
    const result = evaluateCard(card({ title: 'clean car must sell', make: 'Honda' }));
    assert.equal(result.derived.origin, 'japanese');
  });
});

describe('evaluateFull — after the detail fetch', () => {
  const listing = (over = {}) => ({
    title: '2010 Toyota Camry LE',
    price_cents: 200000,
    description: 'Clean title, cold ac, 140k miles.',
    ...over,
  });

  test('a clean listing passes and gets an offer price', () => {
    const result = evaluateFull(listing());
    assert.equal(result.verdict, 'passed');
    assert.deepEqual(result.reasons, []);
    assert.equal(result.derived.offer_price_cents, 170000);
  });

  test('drivetrain trouble in the description rejects', () => {
    const result = evaluateFull(listing({ description: 'Transmission slipping badly.' }));
    assert.equal(result.verdict, 'rejected');
    assert.ok(result.reasons.includes('defect_transmission'));
  });

  test('negated trouble in the description still passes', () => {
    const result = evaluateFull(listing({ description: 'Runs great, no transmission problems.' }));
    assert.equal(result.verdict, 'passed');
  });

  test('title status becomes a badge, not a rejection', () => {
    const result = evaluateFull(listing({ title_status: 'salvage' }));
    assert.equal(result.verdict, 'passed');
    assert.ok(result.flags.includes('salvage_title'));
  });

  test('a confident AI "bad" verdict rejects', () => {
    const result = evaluateFull(listing({ ai_verdict: 'bad', ai_confidence: 0.9 }));
    assert.ok(result.reasons.includes('ai_flagged'));
  });

  test('a low-confidence AI verdict does not reject', () => {
    const result = evaluateFull(listing({ ai_verdict: 'bad', ai_confidence: 0.4 }));
    assert.equal(result.verdict, 'passed');
  });

  test('an AI "questionable" verdict only flags', () => {
    const result = evaluateFull(listing({ ai_verdict: 'questionable', ai_confidence: 0.8 }));
    assert.equal(result.verdict, 'passed');
    assert.ok(result.flags.includes('ai_questionable'));
  });

  test('reasons are deduplicated', () => {
    const result = evaluateFull(listing({
      title: '2010 utility trailer',
      description: 'trailer for sale',
    }));
    assert.equal(result.reasons.filter((r) => r === 'not_a_car').length, 1);
  });
});
