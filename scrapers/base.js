// The provider contract, plus the pure parsing helpers every provider shares.
//
// Nothing above this layer knows which provider is in use. That's the insurance
// policy: when Facebook breaks our selectors badly enough that maintaining them
// isn't worth it, `PROVIDER=apify` is the entire migration. See docs/SCRAPER.md.
//
// A provider implements:
//   name: string
//   async searchListings({ metro, citySlug, maxPages }) -> RawCard[]
//   async fetchDetail(fbId)                             -> RawDetail | null
//   async close()
//
// RawCard   = { fbId, url, title, priceCents, locationText, imageUrl, raw }
// RawDetail = { description, mileage, transmission, titleStatus, sellerName,
//               sellerUrl, year, make, model, postedAt, raw }

import { config, radiusKm } from '../lib/config.js';

export const MARKETPLACE_ITEM_RE = /\/marketplace\/item\/(\d+)/;

/** Build the Marketplace vehicle search URL. Params documented in docs/SCRAPER.md. */
export function buildSearchUrl(citySlug) {
  const params = new URLSearchParams({
    minPrice: String(Math.round(config.filterMinPriceCents / 100)),
    maxPrice: String(Math.round(config.scrapeMaxPriceCents / 100)),
    topLevelVehicleType: 'car_truck',
    sortBy: 'creation_time_descend',
    radiusKM: String(radiusKm()),
    exact: 'false',
  });
  return `https://www.facebook.com/marketplace/${citySlug}/vehicles?${params}`;
}

export function itemUrl(fbId) {
  return `https://www.facebook.com/marketplace/item/${fbId}/`;
}

/** Pull the numeric listing id out of any Marketplace URL. This is the dedup key. */
export function extractFbId(url) {
  if (!url) return null;
  const match = String(url).match(MARKETPLACE_ITEM_RE);
  return match ? match[1] : null;
}

/**
 * "$2,499" / "$2,499.00" / "2499" -> 249900. Returns null for "Free", empty, or junk.
 * Money is cents-as-integer everywhere; see lib/config.js.
 */
export function parsePriceToCents(text) {
  if (text === null || text === undefined) return null;
  if (typeof text === 'number' && Number.isFinite(text)) return Math.round(text * 100);

  const cleaned = String(text).replace(/[^\d.]/g, '');
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

export function parseMileage(text) {
  if (text === null || text === undefined) return null;
  if (typeof text === 'number' && Number.isFinite(text)) return Math.round(text);

  const str = String(text).toLowerCase();
  // "120k miles" -> 120000
  const kMatch = str.match(/([\d.]+)\s*k\b/);
  if (kMatch) {
    const value = Number.parseFloat(kMatch[1]);
    if (Number.isFinite(value)) return Math.round(value * 1000);
  }
  const digits = str.replace(/[^\d]/g, '');
  if (!digits) return null;
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Facebook only gives fuzzy relative times ("about 3 days ago"). Convert to an
 * approximate absolute ISO timestamp. Approximate is fine — the dashboard groups
 * by first_seen_at, which is exact; posted_at is context only (docs/DATA.md).
 */
export function parseRelativeTime(text, base = new Date()) {
  if (!text) return null;
  const str = String(text).toLowerCase();

  // "just listed", "a minute ago", "an hour ago" — Facebook's wording for very
  // recent posts, none of which carry a digit for the numeric branch to find.
  if (/just (?:now|listed|posted)|moments ago|a few seconds/.test(str)) {
    return base.toISOString();
  }
  const article = str.match(/\ba[n]?\s+(minute|hour|day|week|month|year)\s+ago/);
  if (article) {
    const unitMs = {
      minute: 60_000, hour: 3_600_000, day: 86_400_000,
      week: 604_800_000, month: 2_592_000_000, year: 31_536_000_000,
    }[article[1]];
    return new Date(base.getTime() - unitMs).toISOString();
  }

  const match = str.match(/(\d+)\s*(minute|min|hour|hr|day|week|month|year)/);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  const unitMs = {
    minute: 60_000, min: 60_000,
    hour: 3_600_000, hr: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000,
    year: 31_536_000_000,
  }[match[2]];
  if (!unitMs) return null;
  return new Date(base.getTime() - amount * unitMs).toISOString();
}

/**
 * A seller name has to be a name, not the heading above it.
 *
 * The first selector captured the literal text "Seller details" for every
 * listing — 453 of them — and the dashboard printed "seller: Seller details"
 * on every card. It also made the field useless for ever matching a Messenger
 * thread back to a car, which is what it would be needed for.
 *
 * Null is the right answer when we can't tell: a missing name shows nothing,
 * a wrong one shows nonsense that looks like data.
 */
export function cleanSellerName(raw) {
  if (!raw) return null;
  const name = String(raw).replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 60) return null;

  const junk = [
    /^seller (details|information|info)$/i,
    /^(details|information|about|message|profile|seller)$/i,
    /^joined facebook/i,
    /^\d/,                        // "5 listings", timestamps
    /^(view|see|send|message)\b/i,
    /\brat(ed|ing)\b|review|response rate|listings?$|\bseller$/i,
  ];
  return junk.some((re) => re.test(name)) ? null : name;
}

export function parseTitleStatus(text) {
  if (!text) return 'unknown';
  const str = String(text).toLowerCase();
  if (/\bsalvage\b/.test(str)) return 'salvage';
  if (/\brebuilt\b|\breconstructed\b/.test(str)) return 'rebuilt';
  if (/\bclean title\b|\bclear title\b/.test(str)) return 'clean';
  return 'unknown';
}

/** Randomized pause. Jitter matters — fixed intervals are a bot signature. */
export function sleep(minMs, maxMs = minMs) {
  const ms = Math.round(minMs + Math.random() * Math.max(0, maxMs - minMs));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classify a page we couldn't parse. Getting this right is what keeps a broken
 * scraper from masquerading as a slow market.
 * @returns {'login_wall'|'blocked'|null}
 */
export function classifyPageProblem({ url = '', html = '' } = {}) {
  const lowerUrl = url.toLowerCase();
  const lowerHtml = html.toLowerCase();

  if (
    lowerUrl.includes('/login') ||
    lowerUrl.includes('/checkpoint') ||
    lowerHtml.includes('name="pass"') ||
    lowerHtml.includes('log in to facebook') ||
    lowerHtml.includes('you must log in')
  ) {
    return lowerUrl.includes('/checkpoint') ? 'blocked' : 'login_wall';
  }
  if (
    lowerHtml.includes('temporarily blocked') ||
    lowerHtml.includes('suspicious activity') ||
    lowerHtml.includes('confirm your identity') ||
    lowerHtml.includes('security check')
  ) {
    return 'blocked';
  }
  return null;
}
