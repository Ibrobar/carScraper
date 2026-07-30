// Offer price + the drafted message.
//
// NOTHING HERE SENDS ANYTHING. This module produces a string that the dashboard
// copies to the clipboard; Ibrahim pastes and sends it himself. See Core rule 1
// in CLAUDE.md before adding anything to this file.

import { config } from './config.js';

/**
 * Asking price minus the discount, rounded DOWN to the nearest increment.
 *
 * Down, not nearest: $1,895 * 0.85 = $1,610.75, and "$1,610.75" reads like a
 * robot generated it. $1,600 reads like a person who thought about it.
 */
export function offerPriceCents(askingCents, opts = {}) {
  const pct = opts.discountPct ?? config.offerDiscountPct;
  const roundTo = opts.roundToCents ?? config.offerRoundToCents;
  if (!Number.isFinite(askingCents) || askingCents <= 0) return null;

  const raw = askingCents * (1 - pct / 100);
  if (roundTo > 0) {
    const rounded = Math.floor(raw / roundTo) * roundTo;
    // Never round all the way to zero on a cheap car.
    return rounded > 0 ? rounded : Math.floor(raw);
  }
  return Math.floor(raw);
}

export function formatMoney(cents) {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '';
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

/**
 * Draft a short, plain offer message.
 *
 * Deliberately boring. Long, friendly, over-explained messages read as
 * scripted — which is the exact impression to avoid when you're one of several
 * people messaging a seller the same day.
 */
export function draftOfferMessage(listing, opts = {}) {
  const offer = opts.offerPriceCents ?? offerPriceCents(listing.price_cents, opts);
  if (offer === null) return null;

  const descriptor = [listing.year, titleCase(listing.make_norm), listing.model]
    .filter(Boolean)
    .join(' ')
    .trim();
  const subject = descriptor || 'the vehicle';

  return (
    `Hi, is the ${subject} still available? ` +
    `I can do ${formatMoney(offer)} cash today and pick it up. Let me know.`
  );
}

function titleCase(str) {
  if (!str) return '';
  return str
    .split(/[\s-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
