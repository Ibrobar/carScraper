// Pure parsing helpers from scrapers/base.js. No Playwright, no network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePriceToCents, parseMileage, parseRelativeTime, parseTitleStatus,
  extractFbId, buildSearchUrl, classifyPageProblem, cleanSellerName,
} from '../scrapers/base.js';

describe('parsePriceToCents', () => {
  test('handles the formats Facebook actually renders', () => {
    assert.equal(parsePriceToCents('$2,499'), 249900);
    assert.equal(parsePriceToCents('$2,499.00'), 249900);
    assert.equal(parsePriceToCents('2499'), 249900);
    assert.equal(parsePriceToCents(2499), 249900);
  });

  test('returns null rather than 0 for non-prices', () => {
    // 0 would silently become "free car" and trip the price_too_low filter.
    assert.equal(parsePriceToCents('Free'), null);
    assert.equal(parsePriceToCents(''), null);
    assert.equal(parsePriceToCents(null), null);
  });
});

describe('parseMileage', () => {
  test('expands k notation', () => {
    assert.equal(parseMileage('120k miles'), 120000);
    assert.equal(parseMileage('98.5k'), 98500);
  });

  test('strips separators', () => {
    assert.equal(parseMileage('143,000 miles'), 143000);
    assert.equal(parseMileage(143000), 143000);
  });

  test('is safe on junk', () => {
    assert.equal(parseMileage('unknown'), null);
    assert.equal(parseMileage(null), null);
  });
});

describe('parseRelativeTime', () => {
  const base = new Date('2026-07-27T12:00:00Z');

  test('converts Facebook fuzzy times to approximate absolutes', () => {
    assert.equal(parseRelativeTime('3 days ago', base), '2026-07-24T12:00:00.000Z');
    assert.equal(parseRelativeTime('about 2 hours ago', base), '2026-07-27T10:00:00.000Z');
  });

  test('handles "just now" and Facebook\'s "just listed"', () => {
    assert.equal(parseRelativeTime('just now', base), base.toISOString());
    assert.equal(parseRelativeTime('Just listed', base), base.toISOString());
    assert.equal(parseRelativeTime('just posted', base), base.toISOString());
  });

  test('handles worded quantities with no digit', () => {
    // "an hour ago" / "a week ago" have no number for the numeric branch.
    assert.equal(parseRelativeTime('an hour ago', base), '2026-07-27T11:00:00.000Z');
    assert.equal(parseRelativeTime('a day ago', base), '2026-07-26T12:00:00.000Z');
    assert.equal(parseRelativeTime('about a week ago', base), '2026-07-20T12:00:00.000Z');
  });

  test('returns null when it cannot tell', () => {
    assert.equal(parseRelativeTime('a while back', base), null);
    assert.equal(parseRelativeTime(null), null);
  });
});

describe('parseTitleStatus', () => {
  test('detects the statuses that matter', () => {
    assert.equal(parseTitleStatus('Salvage title'), 'salvage');
    assert.equal(parseTitleStatus('rebuilt title, drives fine'), 'rebuilt');
    assert.equal(parseTitleStatus('clean title in hand'), 'clean');
  });

  test('defaults to unknown rather than assuming clean', () => {
    assert.equal(parseTitleStatus('nice car'), 'unknown');
    assert.equal(parseTitleStatus(''), 'unknown');
  });
});

describe('cleanSellerName', () => {
  test('rejects the page heading it used to capture', () => {
    // 453 listings stored the literal "Seller details" as the seller's name,
    // and the dashboard printed it on every card.
    assert.equal(cleanSellerName('Seller details'), null);
    assert.equal(cleanSellerName('Seller information'), null);
    assert.equal(cleanSellerName('SELLER DETAILS'), null);
  });

  test('rejects other chrome that sits near the name', () => {
    for (const junk of [
      'Joined Facebook in 2015', '5 listings', 'View profile',
      'Message seller', 'Highly rated seller', 'Profile',
    ]) {
      assert.equal(cleanSellerName(junk), null, `should reject "${junk}"`);
    }
  });

  test('keeps an actual name', () => {
    assert.equal(cleanSellerName('Maria Gonzalez'), 'Maria Gonzalez');
    assert.equal(cleanSellerName('  Dave  '), 'Dave');
  });

  test('is safe on empty input', () => {
    assert.equal(cleanSellerName(null), null);
    assert.equal(cleanSellerName(''), null);
  });
});

describe('extractFbId', () => {
  test('pulls the id out of any marketplace URL shape', () => {
    assert.equal(
      extractFbId('https://www.facebook.com/marketplace/item/1234567890123/'),
      '1234567890123',
    );
    assert.equal(extractFbId('/marketplace/item/999/?ref=search'), '999');
  });

  test('returns null for anything else', () => {
    assert.equal(extractFbId('https://www.facebook.com/groups/123'), null);
    assert.equal(extractFbId(null), null);
  });
});

describe('buildSearchUrl', () => {
  const url = buildSearchUrl('dallas');

  test('pins to cars and trucks', () => {
    assert.match(url, /topLevelVehicleType=car_truck/);
  });

  test('sorts newest first — the entire point', () => {
    assert.match(url, /sortBy=creation_time_descend/);
  });

  test('uses the scrape ceiling, which sits above the display cap', () => {
    // Scraping above the cap is what makes price-drop detection possible.
    assert.match(url, /maxPrice=3200/);
  });

  test('converts miles to the km the URL wants', () => {
    // 150 mi. Facebook largely ignores this — it serves the account's saved
    // Marketplace location instead — so the real enforcement is the per-metro
    // radius in lib/geo.js. We still ask for the right thing.
    assert.match(url, /radiusKM=241/);
  });
});

describe('classifyPageProblem', () => {
  test('detects a login wall', () => {
    assert.equal(
      classifyPageProblem({ url: 'https://facebook.com/login/?next=', html: '' }),
      'login_wall',
    );
    assert.equal(
      classifyPageProblem({ url: '', html: '<input name="pass" type="password">' }),
      'login_wall',
    );
  });

  test('detects a block, which is a different response', () => {
    assert.equal(
      classifyPageProblem({ url: 'https://facebook.com/checkpoint/123', html: '' }),
      'blocked',
    );
    assert.equal(
      classifyPageProblem({ url: '', html: '<p>You are temporarily blocked</p>' }),
      'blocked',
    );
  });

  test('a healthy page reports no problem', () => {
    assert.equal(
      classifyPageProblem({
        url: 'https://facebook.com/marketplace/dallas/vehicles',
        html: '<div>listings</div>',
      }),
      null,
    );
  });
});
