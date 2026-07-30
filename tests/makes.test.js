// Make classification. The German cases matter most: a German car that slips
// through as `unknown` or, worse, fuzzy-matches to Mercury, is exactly the car
// we're trying not to buy.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMake, parseTitle, looksLikeNonCar, normalizeMakeString } from '../lib/makes.js';

describe('normalizeMakeString', () => {
  test('lowercases, strips punctuation, collapses space', () => {
    assert.equal(normalizeMakeString('  CHEVY!  '), 'chevy');
    assert.equal(normalizeMakeString('Mercedes.Benz'), 'mercedes benz');
  });

  test('handles null and non-strings', () => {
    assert.equal(normalizeMakeString(null), '');
    assert.equal(normalizeMakeString(42), '');
  });
});

describe('exact matches', () => {
  const cases = [
    ['ford', 'american'], ['chevrolet', 'american'], ['jeep', 'american'],
    ['tesla', 'american'], ['ram', 'american'],
    ['toyota', 'japanese'], ['honda', 'japanese'], ['lexus', 'japanese'],
    ['hyundai', 'korean'], ['kia', 'korean'],
    ['bmw', 'german'], ['audi', 'german'], ['porsche', 'german'],
    ['volvo', 'other'], ['ferrari', 'other'],
  ];
  for (const [input, origin] of cases) {
    test(`${input} -> ${origin}`, () => {
      assert.equal(classifyMake(input).origin, origin);
    });
  }
});

describe('aliases — how sellers actually type it', () => {
  const cases = [
    ['Chevy', 'chevrolet', 'american'],
    ['chev', 'chevrolet', 'american'],
    ['Chevorlet', 'chevrolet', 'american'],
    ['VW', 'volkswagen', 'german'],
    ['Volkswagon', 'volkswagen', 'german'],
    ['benz', 'mercedes-benz', 'german'],
    ['Mercedes', 'mercedes-benz', 'german'],
    ['Mercedes Benz', 'mercedes-benz', 'german'],
    ['mecedes', 'mercedes-benz', 'german'],
    ['Beemer', 'bmw', 'german'],
    ['toyta', 'toyota', 'japanese'],
    ['Infinity', 'infiniti', 'japanese'],
    ['suburu', 'subaru', 'japanese'],
    ['hundai', 'hyundai', 'korean'],
    ['Caddy', 'cadillac', 'american'],
  ];
  for (const [input, make, origin] of cases) {
    test(`${input} -> ${make} (${origin})`, () => {
      const result = classifyMake(input);
      assert.equal(result.make, make);
      assert.equal(result.origin, origin);
    });
  }
});

describe('fuzzy fallback is deliberately tight', () => {
  test('catches a near-miss typo', () => {
    const result = classifyMake('Toyot');
    assert.equal(result.make, 'toyota');
    assert.equal(result.matchedBy, 'fuzzy');
  });

  test('refuses to guess on short strings', () => {
    // "rav" is one edit from several real makes. Alias-or-nothing under 4 chars.
    assert.equal(classifyMake('rav').make, null);
  });

  test('refuses a distant match rather than guessing wrong', () => {
    assert.equal(classifyMake('Blahmobile').make, null);
    assert.equal(classifyMake('Blahmobile').origin, 'unknown');
  });

  test('does not collapse Mercury and Mercedes', () => {
    // The expensive failure mode: a German car classified as American.
    assert.equal(classifyMake('mercury').origin, 'american');
    assert.equal(classifyMake('mercedes').origin, 'german');
    assert.equal(classifyMake('benz').origin, 'german');
  });
});

describe('parseTitle', () => {
  test('pulls year, make, model from the standard pattern', () => {
    const result = parseTitle('2008 Chevy Silverado 1500');
    assert.equal(result.year, 2008);
    assert.equal(result.make, 'chevrolet');
    assert.equal(result.origin, 'american');
    assert.equal(result.model, 'Silverado 1500');
  });

  test("does not absorb the seller's blurb into the model", () => {
    const result = parseTitle('2008 Chevy Silverado 1500 - runs great');
    assert.equal(result.model, 'Silverado 1500');
  });

  test('cuts at the middot Facebook uses in vehicle titles', () => {
    // Real title from a live scrape. Leaving the "·" in produced the offer
    // message "is the 2007 Chevrolet Tahoe · still available?"
    const result = parseTitle('2007 Chevrolet Tahoe · Z71 Sport Utility 4D');
    assert.equal(result.year, 2007);
    assert.equal(result.make, 'chevrolet');
    assert.equal(result.model, 'Tahoe');
  });

  test('middot with no spaces around it also cuts', () => {
    assert.equal(parseTitle('2004 Honda Accord·EX Coupe 2D').model, 'Accord');
  });

  test('keeps hyphenated model names intact', () => {
    const result = parseTitle('2012 Ford F-150 XLT');
    assert.equal(result.make, 'ford');
    assert.match(result.model, /F-150/);
  });

  test('handles two-word makes', () => {
    const result = parseTitle('2005 Mercedes Benz C230');
    assert.equal(result.make, 'mercedes-benz');
    assert.equal(result.origin, 'german');
  });

  test('handles a missing year', () => {
    const result = parseTitle('Honda Civic');
    assert.equal(result.year, null);
    assert.equal(result.make, 'honda');
  });

  test('rejects implausible years', () => {
    assert.equal(parseTitle('1899 Ford Model T').year, null);
  });

  test('returns unknown rather than guessing on junk', () => {
    const result = parseTitle('great deal must go today');
    assert.equal(result.origin, 'unknown');
  });

  test('is safe on empty input', () => {
    const result = parseTitle('');
    assert.equal(result.make, null);
    assert.equal(result.origin, 'unknown');
  });
});

describe('looksLikeNonCar', () => {
  test('catches things the car_truck URL filter lets slip', () => {
    assert.equal(looksLikeNonCar('16ft utility trailer'), true);
    assert.equal(looksLikeNonCar('2015 Honda dirt bike'), true);
    assert.equal(looksLikeNonCar('golf cart, runs great'), true);
    assert.equal(looksLikeNonCar('jet ski with trailer'), true);
  });

  test('does not fire on ordinary cars', () => {
    assert.equal(looksLikeNonCar('2010 Toyota Camry LE'), false);
    assert.equal(looksLikeNonCar('Chevy Silverado, tow package'), false);
  });
});
