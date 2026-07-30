// Applies the rules to a listing. Two entry points, matching the two-phase
// scrape (docs/SCRAPER.md):
//
//   evaluateCard  — price + make/origin only. Runs on search-card data, so it
//                   decides whether a detail fetch is worth spending.
//   evaluateFull  — everything, including defect detection. Needs a description.
//
// Reason codes are stable strings; the dashboard renders them and the tests
// assert on them. See docs/DATA.md.

import { config, METROS } from './config.js';
import { milesFromCenter } from './geo.js';
import { classifyMake, parseTitle, looksLikeNonCar } from './makes.js';
import { scanDefects } from './defects.js';
import { offerPriceCents } from './offers.js';

/**
 * Cheap pass over search-card data.
 * @returns {{ verdict: 'pending_detail'|'rejected', reasons: string[], derived: object }}
 */
export function evaluateCard(card, opts = {}) {
  const cfg = { ...config, ...opts };
  const reasons = [];

  // Prefer a make Facebook gave us structurally; fall back to the title.
  const parsed = parseTitle(card.title);
  const explicit = card.make ? classifyMake(card.make) : null;
  const make = explicit?.make ?? parsed.make;
  const origin = explicit?.make ? explicit.origin : parsed.origin;

  const derived = {
    year: card.year ?? parsed.year ?? null,
    make_raw: card.make ?? (parsed.make ? parsed.make : null),
    make_norm: make,
    model: card.model ?? parsed.model ?? null,
    origin,
  };

  if (looksLikeNonCar(card.title)) reasons.push('not_a_car');

  // Distance. Facebook ignores the radius we ask for and serves the account's
  // saved Marketplace location, so a DFW search returns Houston, San Antonio,
  // Austin and Oklahoma. This is the filter that actually enforces it.
  //
  // Runs on card data, before any detail fetch — roughly 60% of a DFW search is
  // out of range, so rejecting here also stops that budget being spent on cars
  // four hours away.
  //
  // An unknown city is KEPT (milesFromCenter returns null): a town missing from
  // the table is far more likely to be a nearby suburb than a distant city.
  const metro = METROS[card.metro];
  if (metro?.center) {
    const miles = milesFromCenter(card.locationText ?? card.location_text, metro.center);
    if (miles !== null && miles > metro.radiusMiles) reasons.push('too_far');
  }

  const price = card.priceCents ?? card.price_cents;
  if (!Number.isFinite(price) || price <= 0) {
    // No parseable price. Keep it and let the detail pass sort it out rather
    // than throwing away a listing over a formatting quirk.
  } else if (price > cfg.filterMaxPriceCents) {
    reasons.push('price_too_high');
  } else if (price < cfg.filterMinPriceCents) {
    reasons.push('price_too_low');
  }

  // Blocklist, not allowlist: only cut makes we positively identified as
  // blocked. `unknown` stays in. Rejecting unparseable titles cut 142 of the
  // first 219 listings, most of them real cars whose title we simply failed to
  // parse — a filter that aggressive hides more than it saves.
  if (origin !== 'unknown' && cfg.blockedOrigins.includes(origin)) {
    reasons.push('origin_not_allowed');
  }

  return {
    verdict: reasons.length ? 'rejected' : 'pending_detail',
    reasons,
    derived,
  };
}

/**
 * Full pass, once the detail page has been fetched.
 * @returns {{ verdict: 'passed'|'rejected', reasons: string[], flags: string[], derived: object }}
 */
export function evaluateFull(listing, opts = {}) {
  const cfg = { ...config, ...opts };

  const card = {
    title: listing.title,
    make: listing.make_raw ?? listing.make ?? null,
    model: listing.model ?? null,
    year: listing.year ?? null,
    priceCents: listing.price_cents ?? listing.priceCents,
    metro: listing.metro,
    locationText: listing.location_text ?? listing.locationText,
  };
  const cheap = evaluateCard(card, opts);
  const reasons = [...cheap.reasons];
  const flags = [];

  const text = [listing.title, listing.description].filter(Boolean).join('. ');
  const defects = scanDefects(text);
  reasons.push(...defects.reasons);
  flags.push(...defects.flags);

  if (looksLikeNonCar(listing.description)) {
    if (!reasons.includes('not_a_car')) reasons.push('not_a_car');
  }

  // The AI verdict is advisory and only rejects when it's confident. An AI
  // rejection you can't audit is worse than no AI at all, so ai_evidence is
  // stored alongside and shown on the card.
  if (listing.ai_verdict === 'bad' && (listing.ai_confidence ?? 0) >= 0.7) {
    if (!reasons.includes('ai_flagged')) reasons.push('ai_flagged');
  } else if (listing.ai_verdict === 'questionable') {
    flags.push('ai_questionable');
  }

  if (listing.title_status === 'salvage') flags.push('salvage_title');
  if (listing.title_status === 'rebuilt') flags.push('rebuilt_title');

  const derived = {
    ...cheap.derived,
    offer_price_cents: offerPriceCents(card.priceCents, opts),
  };

  return {
    verdict: reasons.length ? 'rejected' : 'passed',
    reasons: [...new Set(reasons)],
    flags: [...new Set(flags)],
    derived,
  };
}

/** Does this listing's description need a second look from the AI stage? */
export function needsAiReview(listing) {
  if (!config.aiKey) return false;
  if (listing.ai_verdict) return false;
  const description = listing.description || '';
  // Too short to say anything meaningful; nothing for the model to judge.
  if (description.length < 40) return false;
  return true;
}
