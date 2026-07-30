// The CRM is a module the core doesn't know about. These tests pin that seam,
// because the refactor that created it broke the dashboard in a way the whole
// suite still passed: dashboard/crm/render.js moved a directory deeper, its
// relative imports silently pointed at nothing, and no test imported it.
//
// If main ever ships without the CRM, these are the assertions that say the
// listings half still stands on its own.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { renderCrm } from '../dashboard/crm/render.js';
import { renderPage } from '../dashboard/render.js';
import { NAV_LINK } from '../dashboard/crm/routes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

describe('the CRM module loads', () => {
  // Importing at all is most of the value here — a bad relative path throws
  // at import time, which is exactly what the suite missed before.
  test('renders a board with no flips', () => {
    const html = renderCrm({ rows: [] });
    assert.match(html, /<html/i);
  });

  test('renders a flip with its parts', () => {
    const html = renderCrm({
      rows: [{
        flip: {
          id: 1, listing_id: 1, status: 'bought', owner: 'me',
          purchase_price_cents: 120_000, sale_price_cents: null,
          title: '2004 Honda Accord', year: 2004, make_norm: 'honda', model: 'Accord',
          fb_id: '123',
          asking_price_cents: 150_000, created_at: '2026-07-27T12:00:00Z',
          updated_at: '2026-07-27T12:00:00Z',
        },
        parts: [{ id: 1, flip_id: 1, name: 'Alternator', status: 'bought', cost_cents: 8000 }],
      }],
    });
    assert.match(html, /Honda Accord/);
    assert.match(html, /Alternator/);
  });
});

describe('the listings page does not depend on the CRM', () => {
  test('renders with no nav links and shows no /crm link', () => {
    const html = renderPage({ listings: [], runs: [] });
    assert.doesNotMatch(html, /href="\/crm"/);
  });

  test('shows the link only when the module contributes one', () => {
    const html = renderPage({ listings: [], runs: [], navLinks: [NAV_LINK] });
    assert.match(html, /href="\/crm"/);
  });
});

describe('the core does not reach into the CRM', () => {
  test('lib/db.js holds no flip or part queries', () => {
    const source = read('lib/db.js');
    // The schema import is the one permitted mention; queries are not.
    assert.doesNotMatch(source, /FROM flips|INSERT INTO flips|FROM flip_parts/);
  });

  test('dashboard/render.js never names the CRM', () => {
    const source = read('dashboard/render.js');
    assert.doesNotMatch(source, /\/crm|renderCrm|flips\.js/);
  });

  test('the CRM owns its own schema and migrations', () => {
    const schema = read('lib/crm/schema.js');
    assert.match(schema, /CREATE TABLE IF NOT EXISTS flips/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS flip_parts/);
    assert.doesNotMatch(read('lib/db.js'), /CREATE TABLE IF NOT EXISTS flips/);
  });

  test('migration ids keep their original numbers', () => {
    // Databases in the wild already recorded 003-007. Renumbering re-runs them.
    const schema = read('lib/crm/schema.js');
    for (const id of ['003-flip-thread-id', '004-flip-thread-url',
      '005-flip-thread-matched-by', '006-flip-last-reply', '007-flip-replies-checked']) {
      assert.match(schema, new RegExp(id), `${id} missing or renumbered`);
    }
  });
});
