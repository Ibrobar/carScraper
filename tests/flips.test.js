// The money math is the whole reason the CRM exists — if these numbers are
// wrong, the project actively misleads rather than merely failing.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLIP_STATUSES, BOARD_COLUMNS, ACTIVE_STATUSES,
  isValidStatus, validateTransition, inferStatus, flipTotals, portfolioTotals,
} from '../lib/crm/flips.js';

const flip = (over = {}) => ({ status: 'interested', ...over });
const part = (over = {}) => ({ status: 'needed', cost_cents: 0, ...over });

describe('statuses', () => {
  test('the pipeline runs interested -> sold', () => {
    assert.deepEqual(FLIP_STATUSES.slice(0, 3), ['interested', 'contacted', 'replied']);
    assert.ok(FLIP_STATUSES.includes('bought'));
    assert.ok(FLIP_STATUSES.includes('repairing'));
    assert.ok(FLIP_STATUSES.includes('ready_to_sell'));
    assert.ok(FLIP_STATUSES.includes('sold'));
  });

  test('unknown statuses are rejected', () => {
    assert.equal(isValidStatus('bought'), true);
    assert.equal(isValidStatus('lightly_pondered'), false);
  });
});

describe('board columns', () => {
  test('"Ready to sell" is its own column', () => {
    const ready = BOARD_COLUMNS.find((c) => c.label === 'Ready to sell');
    assert.ok(ready, 'expected a Ready to sell column');
    assert.deepEqual(ready.statuses, ['ready_to_sell']);
  });

  test('every status lands in exactly one column', () => {
    // A status in no column would make cars silently vanish from the board.
    for (const status of FLIP_STATUSES) {
      const hits = BOARD_COLUMNS.filter((c) => c.statuses.includes(status));
      assert.equal(hits.length, 1, `${status} appears in ${hits.length} columns`);
    }
  });

  test('ready_to_sell still counts as money tied up', () => {
    // The board grouping is presentation; the money grouping is separate.
    assert.ok(ACTIVE_STATUSES.includes('ready_to_sell'));
  });
});

describe('validateTransition', () => {
  test('moving through the chasing stages needs no money', () => {
    assert.equal(validateTransition(flip(), 'contacted').ok, true);
    assert.equal(validateTransition(flip({ status: 'contacted' }), 'replied').ok, true);
  });

  test('bought requires a purchase price', () => {
    const result = validateTransition(flip(), 'bought');
    assert.equal(result.ok, false);
    assert.equal(result.needs, 'purchase_price_cents');
  });

  test('bought succeeds once the price is supplied', () => {
    assert.equal(
      validateTransition(flip(), 'bought', { purchase_price_cents: 150000 }).ok,
      true,
    );
  });

  test('an existing purchase price counts — you only enter it once', () => {
    const bought = flip({ status: 'bought', purchase_price_cents: 150000 });
    assert.equal(validateTransition(bought, 'repairing').ok, true);
    assert.equal(validateTransition(bought, 'ready_to_sell').ok, true);
  });

  test('sold requires a sale price', () => {
    const result = validateTransition(flip({ purchase_price_cents: 150000 }), 'sold');
    assert.equal(result.ok, false);
    assert.equal(result.needs, 'sale_price_cents');
  });

  test('sold also requires knowing what you PAID', () => {
    // Otherwise the profit figure is fiction.
    const result = validateTransition(flip(), 'sold', { sale_price_cents: 300000 });
    assert.equal(result.ok, false);
    assert.equal(result.needs, 'purchase_price_cents');
  });

  test('a complete sale passes', () => {
    const result = validateTransition(
      flip({ purchase_price_cents: 150000 }), 'sold', { sale_price_cents: 300000 },
    );
    assert.equal(result.ok, true);
  });

  test('zero and negative amounts are not amounts', () => {
    assert.equal(validateTransition(flip(), 'bought', { purchase_price_cents: 0 }).ok, false);
    assert.equal(validateTransition(flip(), 'bought', { purchase_price_cents: -5 }).ok, false);
  });

  test('skipping stages is allowed — deals do not follow a script', () => {
    // Met the seller, bought it on the spot.
    assert.equal(
      validateTransition(flip({ status: 'interested' }), 'bought', { purchase_price_cents: 90000 }).ok,
      true,
    );
    // Fell through from anywhere.
    assert.equal(validateTransition(flip({ status: 'repairing' }), 'dead').ok, true);
  });

  test('an unknown status is refused', () => {
    assert.equal(validateTransition(flip(), 'sold_ish').ok, false);
  });
});

describe('inferStatus', () => {
  test('recording a price on a chasing car marks it bought', () => {
    // A real flip ended up at "Interested" with $1,500 paid against it,
    // because the price was typed without touching the dropdown.
    assert.equal(
      inferStatus(flip({ status: 'interested' }), 'interested', { purchase_price_cents: 150000 }),
      'bought',
    );
    assert.equal(
      inferStatus(flip({ status: 'contacted' }), 'contacted', { purchase_price_cents: 150000 }),
      'bought',
    );
  });

  test('an already-recorded price counts too', () => {
    assert.equal(
      inferStatus(flip({ status: 'interested', purchase_price_cents: 150000 }), 'interested'),
      'bought',
    );
  });

  test('no price means no change', () => {
    assert.equal(inferStatus(flip({ status: 'interested' }), 'contacted'), 'contacted');
  });

  test('it never drags a car backwards or overrides a later stage', () => {
    for (const status of ['repairing', 'ready_to_sell', 'sold', 'dead']) {
      assert.equal(
        inferStatus(flip({ status, purchase_price_cents: 150000 }), status, {}),
        status,
      );
    }
  });

  test('an explicit move to dead is respected even with money recorded', () => {
    assert.equal(
      inferStatus(flip({ status: 'interested' }), 'dead', { purchase_price_cents: 150000 }),
      'dead',
    );
  });
});

describe('flipTotals', () => {
  test('counts only parts actually bought', () => {
    // A parts list is a shopping list until you've paid. Counting planned
    // spend would make every in-progress car look like it's losing money.
    const totals = flipTotals(flip({ purchase_price_cents: 150000 }), [
      part({ status: 'bought', cost_cents: 20000 }),
      part({ status: 'needed', cost_cents: 50000 }),
    ]);
    assert.equal(totals.partsCents, 20000);
    assert.equal(totals.plannedPartsCents, 50000);
    assert.equal(totals.investedCents, 170000);
  });

  test('profit is null until it sells', () => {
    const totals = flipTotals(flip({ purchase_price_cents: 150000 }), []);
    assert.equal(totals.profitCents, null);
    assert.equal(totals.marginPct, null);
  });

  test('profit is sale minus everything spent', () => {
    const totals = flipTotals(
      flip({ purchase_price_cents: 150000, sale_price_cents: 300000 }),
      [part({ status: 'bought', cost_cents: 25000 })],
    );
    assert.equal(totals.investedCents, 175000);
    assert.equal(totals.profitCents, 125000);
  });

  test('a loss is reported as a negative, not hidden', () => {
    const totals = flipTotals(
      flip({ purchase_price_cents: 200000, sale_price_cents: 150000 }), [],
    );
    assert.equal(totals.profitCents, -50000);
    assert.equal(totals.marginPct, -33);
  });

  test('margin is a percentage of the sale price', () => {
    const totals = flipTotals(
      flip({ purchase_price_cents: 150000, sale_price_cents: 300000 }), [],
    );
    assert.equal(totals.marginPct, 50);
  });

  test('an empty flip produces zeroes, not NaN', () => {
    const totals = flipTotals(flip(), []);
    assert.equal(totals.investedCents, 0);
    assert.equal(totals.purchaseCents, 0);
    assert.equal(totals.profitCents, null);
  });

  test('parts with no cost recorded do not poison the total', () => {
    const totals = flipTotals(flip({ purchase_price_cents: 100000 }), [
      part({ status: 'bought', cost_cents: null }),
      part({ status: 'bought', cost_cents: 5000 }),
    ]);
    assert.equal(totals.partsCents, 5000);
    assert.equal(Number.isFinite(totals.investedCents), true);
  });
});

describe('portfolioTotals', () => {
  const rows = [
    // sold at a profit
    { flip: flip({ status: 'sold', purchase_price_cents: 100000, sale_price_cents: 200000 }),
      parts: [part({ status: 'bought', cost_cents: 20000 })] },
    // money currently tied up
    { flip: flip({ status: 'repairing', purchase_price_cents: 150000 }),
      parts: [part({ status: 'bought', cost_cents: 30000 })] },
    // still just chasing — no money committed
    { flip: flip({ status: 'contacted' }), parts: [] },
  ];

  test('realized profit counts sold cars only', () => {
    // 200000 - (100000 + 20000)
    assert.equal(portfolioTotals(rows).profit, 80000);
  });

  test('at-risk is money in unsold cars — what limits the next buy', () => {
    assert.equal(portfolioTotals(rows).atRisk, 180000);
  });

  test('chasing cars contribute nothing to either', () => {
    const totals = portfolioTotals(rows);
    assert.equal(totals.active, 1);
    assert.equal(totals.sold, 1);
  });

  test('total invested spans sold and unsold', () => {
    assert.equal(portfolioTotals(rows).invested, 300000);
  });

  test('an empty portfolio is all zeroes', () => {
    const totals = portfolioTotals([]);
    assert.deepEqual(
      [totals.invested, totals.realized, totals.profit, totals.atRisk],
      [0, 0, 0, 0],
    );
  });
});
