// The renderer is a pure function of rows, so it's testable without a browser
// or a server. The escaping test matters most: listing titles are attacker-ish
// text from strangers on the internet, dropped straight into HTML.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderPage, escapeHtml, dayLabel, groupByDay, pageUrl, truncate,
} from '../dashboard/render.js';

const row = (over = {}) => ({
  fb_id: '1001',
  url: 'https://www.facebook.com/marketplace/item/1001/',
  title: '2010 Toyota Camry LE',
  price_cents: 200000,
  first_price_cents: 200000,
  metro: 'dfw',
  status: 'passed',
  first_seen_at: new Date().toISOString(),
  make_norm: 'toyota',
  model: 'Camry',
  year: 2010,
  reject_reasons: '[]',
  defect_flags: '[]',
  ...over,
});

describe('escapeHtml', () => {
  test('escapes every dangerous character', () => {
    assert.equal(
      escapeHtml('<script>alert("x")</script>'),
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    assert.equal(escapeHtml("it's"), 'it&#39;s');
  });

  test('is safe on null', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });
});

describe('dayLabel', () => {
  const now = new Date('2026-07-27T12:00:00');

  test('labels today and yesterday by name', () => {
    assert.equal(dayLabel('2026-07-27T08:00:00', now), 'Today');
    assert.equal(dayLabel('2026-07-26T23:00:00', now), 'Yesterday');
  });

  test('older days get a date', () => {
    assert.match(dayLabel('2026-07-20T08:00:00', now), /Jul 20/);
  });

  test('handles garbage timestamps', () => {
    assert.equal(dayLabel(null, now), 'Unknown');
    assert.equal(dayLabel('not a date', now), 'Unknown');
  });
});

describe('truncate', () => {
  test('leaves short text alone', () => {
    assert.equal(truncate('Cold ac, clean title'), 'Cold ac, clean title');
  });

  test('cuts on a word boundary, not mid-word', () => {
    const result = truncate('a'.repeat(10) + ' ' + 'b'.repeat(300), 50);
    assert.ok(result.endsWith('…'));
    assert.ok(result.length <= 51);
  });

  test('collapses newlines so the preview stays one block', () => {
    assert.equal(truncate('line one\n\nline two'), 'line one line two');
  });

  test('is safe on empty input', () => {
    assert.equal(truncate(null), '');
    assert.equal(truncate(''), '');
  });
});

describe('description on the card', () => {
  const long = 'Runs and drives great. '.repeat(30);

  test('shows the seller description', () => {
    const html = renderPage({
      listings: [row({ description: 'Cold ac, clean title, 140k miles.' })], runs: [],
    });
    assert.match(html, /Cold ac, clean title, 140k miles\./);
  });

  test('long descriptions get a preview plus a full-text toggle', () => {
    const html = renderPage({ listings: [row({ description: long })], runs: [] });
    assert.match(html, /<details class="more">/);
    assert.match(html, /Full description/);
  });

  test('short descriptions get no toggle', () => {
    const html = renderPage({ listings: [row({ description: 'Short one.' })], runs: [] });
    assert.ok(!html.includes('<details class="more">'));
  });

  test('says so plainly when there is no description', () => {
    const html = renderPage({ listings: [row({ description: null })], runs: [] });
    assert.match(html, /No description scraped/);
  });

  test('escapes a hostile description', () => {
    // Descriptions are attacker-controlled text from strangers.
    const html = renderPage({
      listings: [row({ description: '<script>alert(1)</script>' })], runs: [],
    });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;/);
  });

  test('renders the spec line', () => {
    const html = renderPage({
      listings: [row({
        mileage: 143000, transmission: 'Automatic',
        title_status: 'salvage', seller_name: 'Dave',
      })],
      runs: [],
    });
    assert.match(html, /143,000 mi/);
    assert.match(html, /automatic/);
    assert.match(html, /SALVAGE title/);
    assert.match(html, /seller: Dave/);
  });

  test('omits the spec line when nothing is known', () => {
    const html = renderPage({ listings: [row()], runs: [] });
    assert.ok(!html.includes('class="specs"'));
  });

  test('still links out to Facebook', () => {
    const html = renderPage({ listings: [row()], runs: [] });
    assert.match(html, /Open on Facebook/);
  });
});

describe('pageUrl', () => {
  test('carries filters across pages', () => {
    // Losing the filter on page 2 would silently widen the results mid-review.
    const url = pageUrl({ metro: 'dfw', q: 'honda', max: 2000 }, { page: 3 });
    assert.match(url, /metro=dfw/);
    assert.match(url, /q=honda/);
    assert.match(url, /max=2000/);
    assert.match(url, /page=3/);
  });

  test('omits page 1 and empty filters for a clean URL', () => {
    assert.equal(pageUrl({ metro: null, q: '' }, { page: 1 }), '/');
  });

  test('keeps the rejected view when paging', () => {
    assert.match(pageUrl({ rejected: true }, { page: 2 }), /rejected=1/);
  });
});

describe('groupByDay', () => {
  test('groups by posted date and preserves order within a group', () => {
    const now = new Date('2026-07-27T12:00:00');
    const groups = groupByDay(
      [
        row({ fb_id: 'a', posted_at: '2026-07-27T09:00:00' }),
        row({ fb_id: 'b', posted_at: '2026-07-27T08:00:00' }),
        row({ fb_id: 'c', posted_at: '2026-07-26T08:00:00' }),
      ],
      now,
    );
    assert.equal(groups.length, 2);
    assert.equal(groups[0].label, 'Today');
    assert.equal(groups[0].listings.length, 2);
    assert.equal(groups[1].label, 'Yesterday');
  });

  test('undated listings get their own bucket instead of a wrong day', () => {
    const groups = groupByDay([row({ posted_at: null })], new Date());
    assert.equal(groups[0].label, 'Posted date unknown');
  });

  test('can still group by another field when asked', () => {
    const groups = groupByDay(
      [row({ posted_at: null, first_seen_at: new Date().toISOString() })],
      new Date(),
      'first_seen_at',
    );
    assert.equal(groups[0].label, 'Today');
  });
});

describe('renderPage', () => {
  test('renders a card with price and offer', () => {
    const html = renderPage({ listings: [row()], runs: [] });
    assert.match(html, /2010 Toyota Camry/);
    assert.match(html, /\$2,000/);
    assert.match(html, /\$1,700/); // 15% off, rounded down
  });

  test('escapes a hostile listing title', () => {
    const html = renderPage({
      listings: [row({ title: '<img src=x onerror=alert(1)>' })],
      runs: [],
    });
    assert.ok(!html.includes('<img src=x onerror'));
    assert.match(html, /&lt;img src=x/);
  });

  test('shows a price drop with the original struck through', () => {
    const html = renderPage({
      listings: [row({ price_cents: 170000, first_price_cents: 230000 })],
      runs: [],
    });
    assert.match(html, /price dropped/);
    assert.match(html, /<s>\$2,300<\/s>/);
  });

  test('renders reject reasons as readable chips', () => {
    const html = renderPage({
      listings: [row({ status: 'rejected', reject_reasons: '["defect_transmission"]' })],
      runs: [],
      filters: { rejected: true },
    });
    assert.match(html, /transmission trouble/);
  });

  test('a failed run is surfaced loudly, not buried', () => {
    const html = renderPage({
      listings: [],
      runs: [{
        metro: 'houston', status: 'login_wall', listings_seen: 0, listings_new: 0,
        details_fetched: 0, started_at: new Date().toISOString(),
        error: 'session expired', debug_path: 'data/debug/x.html',
      }],
    });
    assert.match(html, /run bad/);
    assert.match(html, /login_wall/);
    assert.match(html, /session expired/);
  });

  test('surfaces the unchecked backlog', () => {
    // These cars are hidden on purpose — nobody has read their descriptions —
    // so the count is the only signal the user gets that they exist.
    const html = renderPage({ listings: [row()], runs: [], unchecked: 115 });
    assert.match(html, /115 awaiting check/);
    assert.match(html, /description not read yet/);
  });

  test('no backlog tile when there is no backlog', () => {
    const html = renderPage({ listings: [row()], runs: [], unchecked: 0 });
    assert.ok(!html.includes('awaiting check'));
  });

  test('prompts toward the rejected view when nothing matches', () => {
    const html = renderPage({ listings: [], runs: [] });
    assert.match(html, /Show rejected/);
  });

  test('offers the sort control and marks the active one', () => {
    const html = renderPage({ listings: [row()], runs: [], filters: { sort: 'posted' } });
    assert.match(html, /<select name="sort">/);
    assert.match(html, /Most recent/);
    assert.match(html, /value="posted" selected/);
  });

  test('"most recent" is selected when no sort is given', () => {
    const html = renderPage({ listings: [row()], runs: [] });
    assert.match(html, /value="posted" selected/);
  });

  test('the scraper-order option is gone from the dropdown', () => {
    const html = renderPage({ listings: [row()], runs: [] });
    assert.ok(!html.includes('Newest to me'));
    assert.ok(!html.includes('value="seen"'));
  });

  test('groups by posted date when sorting by it', () => {
    const html = renderPage({
      // Midday UTC so the local-time date can't slip to the previous day.
      listings: [row({ posted_at: '2020-01-15T18:00:00Z', first_seen_at: new Date().toISOString() })],
      runs: [],
      groupField: 'posted_at',
      filters: { sort: 'posted' },
    });
    // Grouped on the posted date (2020), not on today's first-seen date.
    assert.match(html, /Jan 15/);
    assert.ok(!/<h2>Today/.test(html));
  });

  test('says how many listings have no posted date', () => {
    const html = renderPage({
      listings: [row({ posted_at: null }), row({ fb_id: 'b', posted_at: null })],
      runs: [],
      groupField: 'posted_at',
      filters: { sort: 'posted' },
    });
    assert.match(html, /2 of these have no\s+posted date/);
    assert.match(html, /Posted date unknown/);
  });

  test('no such note when every listing has a posted date', () => {
    const html = renderPage({
      listings: [row({ posted_at: '2026-07-27T12:00:00Z' })],
      runs: [],
    });
    assert.ok(!html.includes('Posted date unknown'));
    assert.ok(!html.includes('posted date &mdash;'));
  });

  test('states the age window and that interested cars are exempt', () => {
    const html = renderPage({ listings: [row()], runs: [], filters: { days: 2 } });
    assert.match(html, /from the last 2 days/);
    assert.match(html, /age off automatically/);
  });

  test('offers a way back to older cars', () => {
    const html = renderPage({ listings: [row()], runs: [], filters: { days: 2 } });
    assert.match(html, /<select name="days">/);
    assert.match(html, /All time/);
    assert.match(html, /value="2" selected/);
  });

  test('no window note when showing all time', () => {
    const html = renderPage({ listings: [row()], runs: [], filters: { days: 0 } });
    assert.ok(!html.includes('from the last'));
  });

  test('shows a pager when there is more than one page', () => {
    const listings = Array.from({ length: 10 }, (_, i) => row({ fb_id: `p${i}` }));
    const html = renderPage({ listings, runs: [], page: 1, pageSize: 10, total: 44 });
    assert.match(html, /1&ndash;10 of 44/);
    assert.match(html, /Next/);
  });

  test('the position counts rows actually rendered, not a full page', () => {
    // Last page, or rows hidden between the count and the query.
    const html = renderPage({
      listings: [row(), row({ fb_id: 'b' })], runs: [], page: 5, pageSize: 10, total: 42,
    });
    assert.match(html, /41&ndash;42 of 42/);
  });

  test('no pager when everything fits on one page', () => {
    const html = renderPage({ listings: [row()], runs: [], page: 1, pageSize: 10, total: 1 });
    assert.ok(!html.includes('class="pager"'));
  });

  test('previous is disabled on page one, enabled after', () => {
    const first = renderPage({ listings: [row()], runs: [], page: 1, pageSize: 10, total: 44 });
    assert.match(first, /<span class="btn disabled">&larr; Previous/);

    // Page 1 drops the param entirely, so Previous points at a clean "/".
    const second = renderPage({ listings: [row()], runs: [], page: 2, pageSize: 10, total: 44 });
    assert.match(second, /<a class="btn" href="\/">&larr; Previous/);
  });

  test('the count reflects everything matching, not just this page', () => {
    const html = renderPage({ listings: [row()], runs: [], page: 1, pageSize: 10, total: 44 });
    assert.match(html, /44 good listings/);
  });

  test('an empty deep page offers a way back', () => {
    const html = renderPage({ listings: [], runs: [], page: 7, pageSize: 10, total: 44 });
    assert.match(html, /Back to the first page/);
  });

  test('makes clear that nothing is sent automatically', () => {
    const html = renderPage({ listings: [row()], runs: [] });
    assert.match(html, /nothing here messages anyone/i);
  });

  test('the offer message is embedded for the clipboard, not posted anywhere', () => {
    const html = renderPage({ listings: [row()], runs: [] });
    assert.match(html, /data-message="[^"]*\$1,700/);
    assert.match(html, /navigator\.clipboard\.writeText/);
  });
});
