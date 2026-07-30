// Distance filtering. Exists because Facebook's radius is decorative: a DFW
// search with radiusKM=97 returned 148 Houston listings, 146 San Antonio and
// 297 from Oklahoma, against 83 from Dallas.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMiles, normalizeLocation, coordsFor, milesFromCenter } from '../lib/geo.js';
import { METROS } from '../lib/config.js';

const IRVING = METROS.dfw.center;
const HOUSTON = METROS.houston.center;

describe('haversineMiles', () => {
  test('Dallas to Houston is about 225 miles', () => {
    const miles = haversineMiles([32.7767, -96.7970], [29.7604, -95.3698]);
    assert.ok(miles > 210 && miles < 245, `got ${miles}`);
  });

  test('a point to itself is zero', () => {
    assert.equal(Math.round(haversineMiles(IRVING, IRVING)), 0);
  });
});

describe('normalizeLocation', () => {
  test('normalizes the shapes Facebook writes', () => {
    assert.equal(normalizeLocation('Fort Worth, TX'), 'fort worth,tx');
    assert.equal(normalizeLocation('  DALLAS ,  tx '), 'dallas,tx');
  });

  test('assumes Texas when no state is given', () => {
    // Facebook writes a bare "Houston" on some rows; these searches are
    // Texas-centred so a bare name is nearly always in-state.
    assert.equal(normalizeLocation('Houston'), 'houston,tx');
  });

  test('is safe on junk', () => {
    assert.equal(normalizeLocation(null), null);
    assert.equal(normalizeLocation(''), null);
  });
});

describe('the actual offenders are now out of range', () => {
  const tooFar = [
    ['Houston, TX', 200], ['San Antonio, TX', 240], ['Austin, TX', 170],
    ['Oklahoma City, OK', 180], ['Tulsa, OK', 220], ['Shreveport, LA', 170],
    ['Fort Smith, AR', 250], ['Conroe, TX', 190], ['Katy, TX', 210],
    ['Spring, TX', 200], ['Channelview, TX', 210], ['Lubbock, TX', 280],
  ];

  for (const [city, atLeast] of tooFar) {
    test(`${city} is beyond 150 mi from Irving`, () => {
      const miles = milesFromCenter(city, IRVING);
      assert.ok(miles !== null, `${city} missing from the table`);
      assert.ok(miles > 150, `${city} measured ${Math.round(miles)} mi`);
      assert.ok(miles > atLeast * 0.8, `${city} suspiciously close: ${Math.round(miles)} mi`);
    });
  }
});

describe('real DFW cities stay in range', () => {
  const near = [
    'Dallas, TX', 'Fort Worth, TX', 'Arlington, TX', 'Irving, TX', 'Plano, TX',
    'Garland, TX', 'Grand Prairie, TX', 'Denton, TX', 'McKinney, TX',
    'Mesquite, TX', 'Waxahachie, TX', 'Cleburne, TX', 'Weatherford, TX',
    'Sherman, TX', 'Corsicana, TX', 'Tyler, TX', 'Waco, TX',
    'Wichita Falls, TX', 'Mineral Wells, TX', 'Kilgore, TX',
  ];
  for (const city of near) {
    test(`${city} is within 150 mi`, () => {
      const miles = milesFromCenter(city, IRVING);
      assert.ok(miles !== null, `${city} missing from the table`);
      assert.ok(miles <= 150, `${city} measured ${Math.round(miles)} mi`);
    });
  }
});

describe('the Houston metro measures from Houston', () => {
  test('its own suburbs are in range', () => {
    for (const city of ['Katy, TX', 'Conroe, TX', 'Pasadena, TX', 'Galveston, TX', 'Spring, TX']) {
      const miles = milesFromCenter(city, HOUSTON);
      assert.ok(miles !== null && miles <= 150, `${city}: ${miles}`);
    }
  });

  test('Dallas is out of range from Houston', () => {
    assert.ok(milesFromCenter('Dallas, TX', HOUSTON) > 150);
  });

  test('the two metros do not overlap', () => {
    assert.ok(milesFromCenter('Houston, TX', IRVING) > 150);
    assert.ok(milesFromCenter('Dallas, TX', HOUSTON) > 150);
  });
});

describe('a bare city name with no state', () => {
  // Facebook writes "Oklahoma City" and "Fort Smith" with no state. Assuming
  // Texas would put them 200 miles from where they actually are, so an
  // unambiguous name resolves to the one state it exists in.
  test('resolves out of state when the name is unique', () => {
    for (const [city, atLeast] of [['Oklahoma City', 150], ['Tulsa', 200],
      ['Fort Smith', 200], ['Muskogee', 150], ['Yukon', 150], ['Edmond', 150]]) {
      const miles = milesFromCenter(city, IRVING);
      assert.ok(miles !== null, `${city} did not resolve`);
      assert.ok(miles > atLeast, `${city} measured ${Math.round(miles)} mi`);
    }
  });

  test('still assumes Texas when the name exists in several states', () => {
    // Cleveland, Paris, Converse and Chandler are all both TX and elsewhere.
    // For those the Texas guess is the better one on a Texas-centred search.
    assert.deepEqual(coordsFor('Paris'), coordsFor('Paris, TX'));
    assert.deepEqual(coordsFor('Cleveland'), coordsFor('Cleveland, TX'));
  });

  test('an explicit state is never overridden', () => {
    assert.deepEqual(coordsFor('Paris, AR'), coordsFor('paris,ar'));
    assert.notDeepEqual(coordsFor('Paris, AR'), coordsFor('Paris, TX'));
  });

  test('an explicit but unknown state does not fall back', () => {
    // "Springfield, MO" must stay unknown rather than quietly matching some
    // Springfield we happen to have in another state.
    assert.equal(coordsFor('Dallas, GA'), null);
  });
});

describe('the table covers the towns these searches actually return', () => {
  // The first version had 118 cities and missed 497 towns across 899 listings,
  // which meant the filter mostly was not running at all. These are the towns
  // that were slipping through onto the dashboard.
  const wereLeaking = [
    'New Braunfels, TX', 'Kyle, TX', 'Georgetown, TX', 'Round Rock, TX',
    'Pflugerville, TX', 'Cedar Park, TX', 'Buda, TX', 'San Marcos, TX',
    'Converse, TX', 'Schertz, TX', 'New Caney, TX', 'Cleveland, TX',
    'Magnolia, TX', 'Livingston, TX', 'Huntsville, TX', 'Snyder, TX',
    'Sallisaw, OK', 'Van Buren, AR', 'Stilwell, OK', 'McAlester, OK',
    'Waldron, AR', 'Shawnee, OK', 'Moore, OK', 'Mena, AR', 'Deridder, LA',
  ];
  for (const city of wereLeaking) {
    test(`${city} now measures and drops`, () => {
      const miles = milesFromCenter(city, IRVING);
      assert.ok(miles !== null, `${city} still missing from the table`);
      assert.ok(miles > 150, `${city} measured ${Math.round(miles)} mi`);
    });
  }
});

describe('unknown cities', () => {
  test('return null rather than a guess', () => {
    assert.equal(milesFromCenter('Nowheresville, TX', IRVING), null);
    assert.equal(coordsFor('Nowheresville, TX'), null);
  });

  test('null must be treated as keep by callers — see lib/filters.js', () => {
    // Rejecting what we cannot identify is how the origin filter once cut 142
    // of 219 listings. A town missing from the table is more likely a nearby
    // suburb than a distant city.
    assert.equal(milesFromCenter(null, IRVING), null);
  });
});
