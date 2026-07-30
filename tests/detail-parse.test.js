// Detail-page text parsing, against the real shape of a Marketplace listing.
//
// This file exists because description extraction has broken twice, and both
// times it failed SILENTLY: listings kept getting fetched, stored nothing, and
// sat invisible on the dashboard. The fixture below is copied verbatim from a
// live page.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FacebookProvider } from '../scrapers/facebook.js';
import { cleanSellerName, parseMileage, parseRelativeTime, parseTitleStatus } from '../scrapers/base.js';

// Verbatim from facebook.com/marketplace/item/1555907452853195 on 2026-07-29.
const REAL_PAGE = `
Marketplace
Browse all
Categories
Vehicles
2000 Honda accord EX Sedan 4D
$1,800
Listed 2 weeks ago in San Antonio, TX
Message
About this vehicle
Driven 100,000 miles
Automatic transmission
Exterior color: Grey · Interior color: Grey
Fuel type: Gasoline
2 owners
This vehicle is paid off
Seller's description
2000 honda accord runs and drives. Just fixed the ac and got a new set of tires. Was involved in an accident a while back.
Helping my brother by posting it See less
San Antonio, TX · Location is approximate
Seller information
Seller details
Jesse GT
(5)
Joined Facebook in 2022
`;

describe('extractDescription against the real page', () => {
  const description = FacebookProvider.extractDescription(REAL_PAGE);

  test('finds it under the "Seller\'s description" heading', () => {
    // Requiring the bare word "Description" matched nothing on 500 consecutive
    // fetches, and every listing scraped after that was stuck unchecked.
    assert.ok(description, 'no description extracted');
    assert.match(description, /2000 honda accord runs and drives/);
  });

  test('keeps the whole description, not just the first line', () => {
    assert.match(description, /Helping my brother by posting it/);
  });

  test('strips the "See less" expander control', () => {
    assert.ok(!/see (less|more)/i.test(description), `leaked: ${description}`);
  });

  test('stops before the seller block', () => {
    assert.ok(!/Jesse GT/.test(description));
    assert.ok(!/Seller information/i.test(description));
  });

  test('drops the trailing location line', () => {
    assert.ok(!/Location is approximate/i.test(description));
  });

  test('returns null when there is no description heading at all', () => {
    assert.equal(FacebookProvider.extractDescription('Marketplace\nVehicles\n$500\n'), null);
  });

  test('never falls back to grabbing the longest paragraph', () => {
    // That fallback grabbed the sidebar and mis-attributed another seller's ad
    // to 113 cars. Null is the correct answer here.
    const noHeading = 'Marketplace\nSOME OTHER LISTING that is very long indeed and quite chatty about nothing\n';
    assert.equal(FacebookProvider.extractDescription(noHeading), null);
  });
});

describe('the other fields on that page', () => {
  test('seller name is the person, not the sub-heading', () => {
    // "Seller information" is followed by "Seller details", THEN the name.
    // Taking the line after the first heading stored "Seller details" for 453
    // listings and rendered it on every card.
    const name = [
      /\n\s*seller details\s*\n\s*(.+)/i,
      /\n\s*seller information\s*\n\s*(?:seller details\s*\n\s*)?(.+)/i,
    ].map((re) => cleanSellerName(REAL_PAGE.match(re)?.[1])).find(Boolean) ?? null;
    assert.equal(name, 'Jesse GT');
  });

  test('mileage comes off "Driven 100,000 miles"', () => {
    assert.equal(parseMileage(REAL_PAGE.match(/([\d,.]+\s*k?)\s*miles/i)?.[1]), 100000);
  });

  test('transmission is read from the spec block', () => {
    assert.equal(REAL_PAGE.match(/\b(automatic|manual)\s*transmission/i)?.[1], 'Automatic');
  });

  test('posted date comes off "Listed 2 weeks ago"', () => {
    const raw = REAL_PAGE.match(/(?:listed|posted)\s+(?:about\s+)?([^\n]{0,30}?\bago)/i)?.[1];
    const base = new Date('2026-07-29T12:00:00Z');
    assert.equal(parseRelativeTime(raw, base), '2026-07-15T12:00:00.000Z');
  });

  test('no title status claimed when the page does not say', () => {
    assert.equal(parseTitleStatus(REAL_PAGE), 'unknown');
  });
});
