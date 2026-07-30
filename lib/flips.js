// The flip pipeline: one car from "worth chasing" through to sold, with the
// money attached. This is the business half of the project — the scraper only
// exists to feed it.
//
// Pure logic, no I/O. See docs/CRM.md.

/**
 * Pipeline stages, in order.
 *
 * `contacted` and `replied` mirror how Ibrahim described it: after he sends an
 * offer the ball is with the seller ("unanswered"), and once they write back
 * it's with him ("waiting for response" — his response).
 *
 * Nothing here sends or reads a Facebook message; the status is set by hand.
 * See Core rule 1 in CLAUDE.md.
 */
export const FLIP_STATUSES = [
  'interested',    // in the pipeline, no offer sent yet
  'contacted',     // offer sent, waiting on the seller
  'replied',       // seller wrote back, your move
  'bought',        // purchased — needs a purchase price
  'repairing',     // parts going in
  'ready_to_sell', // repaired, ready to list
  'sold',          // gone — needs a sale price
  'dead',          // fell through, or you passed
];

export const FLIP_STATUS_LABELS = {
  interested: 'Interested',
  contacted: 'Offer sent',
  replied: 'They replied',
  bought: 'Bought',
  repairing: 'Repairing',
  ready_to_sell: 'Ready to sell',
  sold: 'Sold',
  dead: 'Dead',
};

/**
 * Stages where the car is money out the door but not yet money back in.
 * This is a MONEY grouping — it drives "tied up in unsold" — and is separate
 * from how the board is laid out. `ready_to_sell` is still your cash.
 */
export const ACTIVE_STATUSES = ['bought', 'repairing', 'ready_to_sell'];

/** Stages where you're still chasing rather than committed. */
export const CHASING_STATUSES = ['interested', 'contacted', 'replied'];

/**
 * Columns on the CRM board, in order.
 *
 * Kept separate from ACTIVE_STATUSES on purpose: `ready_to_sell` gets its own
 * column because it's the one stage that needs an action from you today, but
 * it still counts as money tied up.
 */
export const BOARD_COLUMNS = [
  { label: 'Chasing', statuses: CHASING_STATUSES },
  { label: 'In progress', statuses: ['bought', 'repairing'] },
  { label: 'Ready to sell', statuses: ['ready_to_sell'] },
  { label: 'Closed', statuses: ['sold', 'dead'] },
];

/**
 * Statuses that can't be entered without a number attached, because the whole
 * point of the CRM is knowing what you spent and made. Enforced in
 * `validateTransition` rather than at the database, so the UI can prompt.
 */
export const REQUIRES_AMOUNT = {
  bought: 'purchase_price_cents',
  sold: 'sale_price_cents',
};

export function isValidStatus(status) {
  return FLIP_STATUSES.includes(status);
}

/**
 * Reconcile a requested status with the money being recorded.
 *
 * The update form carries a status dropdown and the price fields together, so
 * it's easy to type what you paid and leave the dropdown alone — which saved
 * cars sitting at "Interested" with a purchase price attached. If you've paid
 * for it, you own it.
 *
 * Only ever moves forward out of the chasing stages; it will not touch a car
 * that's already `repairing`, `sold`, or `dead`.
 */
export function inferStatus(flip, requestedStatus, values = {}) {
  const status = requestedStatus ?? flip?.status;
  if (!CHASING_STATUSES.includes(status)) return status;

  const purchase = values.purchase_price_cents ?? flip?.purchase_price_cents;
  if (Number.isFinite(purchase) && purchase > 0) return 'bought';

  return status;
}

/**
 * Can this flip move to `next`?
 *
 * Deliberately permissive about ORDER — a car can go straight from `interested`
 * to `bought` if you met the seller at a gas station, and deals fall through
 * from any stage. What's enforced is that money-bearing stages carry money.
 *
 * @returns {{ ok: boolean, error?: string, needs?: string }}
 */
export function validateTransition(flip, next, values = {}) {
  if (!isValidStatus(next)) {
    return { ok: false, error: `Unknown status "${next}"` };
  }

  const needed = REQUIRES_AMOUNT[next];
  if (needed) {
    const supplied = values[needed] ?? flip?.[needed];
    if (!Number.isFinite(supplied) || supplied <= 0) {
      return {
        ok: false,
        needs: needed,
        error: next === 'bought'
          ? 'How much did you pay for it?'
          : 'How much did it sell for?',
      };
    }
  }

  // Selling something you never recorded buying makes the profit meaningless.
  if (next === 'sold') {
    const purchase = values.purchase_price_cents ?? flip?.purchase_price_cents;
    if (!Number.isFinite(purchase) || purchase <= 0) {
      return {
        ok: false,
        needs: 'purchase_price_cents',
        error: 'Record what you paid for it before marking it sold.',
      };
    }
  }

  return { ok: true };
}

/**
 * Money for one flip.
 *
 * Only parts marked bought count as spent — a parts list is a shopping list
 * until you've actually paid, and counting planned parts as spend would make
 * every in-progress car look like it's losing money.
 *
 * @returns {{
 *   purchaseCents: number, partsCents: number, plannedPartsCents: number,
 *   investedCents: number, saleCents: number|null,
 *   profitCents: number|null, marginPct: number|null
 * }}
 */
export function flipTotals(flip, parts = []) {
  const purchaseCents = num(flip?.purchase_price_cents);
  const saleCents = Number.isFinite(flip?.sale_price_cents) && flip.sale_price_cents > 0
    ? flip.sale_price_cents
    : null;

  let partsCents = 0;
  let plannedPartsCents = 0;
  for (const part of parts) {
    if (part.status === 'bought') partsCents += num(part.cost_cents);
    else plannedPartsCents += num(part.cost_cents);
  }

  const investedCents = purchaseCents + partsCents;
  const profitCents = saleCents === null ? null : saleCents - investedCents;
  const marginPct = profitCents === null || saleCents === 0
    ? null
    : Math.round((profitCents / saleCents) * 100);

  return {
    purchaseCents, partsCents, plannedPartsCents,
    investedCents, saleCents, profitCents, marginPct,
  };
}

/**
 * Portfolio-level numbers for the CRM header.
 *
 * `atRisk` is money spent on cars that haven't sold — the number that actually
 * tells you whether you can afford the next one.
 */
export function portfolioTotals(rows) {
  let invested = 0;
  let realized = 0;
  let profit = 0;
  let atRisk = 0;
  let sold = 0;
  let active = 0;

  for (const { flip, parts } of rows) {
    const totals = flipTotals(flip, parts);
    invested += totals.investedCents;

    if (flip.status === 'sold') {
      sold++;
      realized += totals.saleCents ?? 0;
      profit += totals.profitCents ?? 0;
    } else if (ACTIVE_STATUSES.includes(flip.status)) {
      active++;
      atRisk += totals.investedCents;
    }
  }

  return { invested, realized, profit, atRisk, sold, active };
}

function num(value) {
  return Number.isFinite(value) ? value : 0;
}
